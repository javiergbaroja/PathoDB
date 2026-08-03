"""
PathoDB API — Stats Router
Aggregate statistics, optionally filtered by the same search params as /patients.
"""
from typing import Literal
from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session
from sqlalchemy import func, cast, Integer, exists, case

from ..database import get_db
from ..models import Patient, Submission, Probe, Block, Scan, Stain, SnomedCode, User, DataSource
from ..auth import get_current_active_user

router = APIRouter(prefix="/stats", tags=["stats"])

# Re-import the B-number resolver from patients router
from .patients import resolve_b_number


def _submission_year_col():
    """Diagnosis / accession year for a submission, as an Integer column expression.

    Internal accession IDs encode the year as the 4-digit group *before a dot*
    (e.g. 'B2019.14823', 'E.2019.14823' -> 2019). External cohorts (e.g. TCGA)
    use a non-accession lis_submission_id like 'TCGA-A6-2671' whose first 4-digit
    run is the case number, not a year — so fall back to the actual report_date
    year instead of mis-parsing it. Verified to leave every internal submission's
    year unchanged (0 rows differ from the old first-4-digit parse).
    """
    return func.coalesce(
        cast(func.substring(Submission.lis_submission_id, r'(\d{4})\.'), Integer),
        cast(func.extract('year', Submission.report_date), Integer),
    )


def _submission_modality_col():
    """Modality letter (B=histology, Z=cytology, S=autopsy) from the internal
    accession prefix, or NULL for external / non-conforming ids. Mirrors the
    frontend getModality(): the letter must be immediately followed by a digit
    (the Bern 'B/Z/S20YY.nnnn' format), so external SP-/SR/T/TCGA ids never
    match. See frontend/src/lib/modality.js."""
    return case(
        (
            Submission.lis_submission_id.op("~")(r"^[BZSbzs][0-9]"),
            func.upper(func.substring(Submission.lis_submission_id, 1, 1)),
        ),
        else_=None,
    )


def _patient_id_set(
    patient_code: str | None,
    b_number: str | None,
    db: Session,
) -> list[int] | None:
    """
    Return a list of patient IDs matching the search params,
    or None if no search params (meaning: all patients).
    """
    if b_number:
        matches = resolve_b_number(b_number, db)
        return [p.id for p in matches]
    if patient_code:
        ids = db.query(Patient.id).filter(
            Patient.patient_code.ilike(f"%{patient_code}%")
        ).all()
        return [r[0] for r in ids]
    return None


@router.get("")
def get_stats(
    patient_code: str | None = Query(None),
    b_number:     str | None = Query(None),
    db: Session              = Depends(get_db),
    _: User                  = Depends(get_current_active_user),
):
    patient_ids = _patient_id_set(patient_code, b_number, db)

    # ── Patient count ────────────────────────────────────────────────────────
    pq = db.query(func.count(Patient.id))
    if patient_ids is not None:
        pq = pq.filter(Patient.id.in_(patient_ids))
    patient_count = pq.scalar() or 0

    # ── Year range (diagnosis/accession year — see _submission_year_col) ──────
    year_col = _submission_year_col()
    yq = db.query(func.min(year_col), func.max(year_col))
    if patient_ids is not None:
        yq = yq.filter(Submission.patient_id.in_(patient_ids))
    year_min, year_max = yq.first() or (None, None)

    # ── Block count ───────────────────────────────────────────────────────────
    bq = (
        db.query(func.count(Block.id))
        .join(Probe,      Block.probe_id      == Probe.id)
        .join(Submission, Probe.submission_id == Submission.id)
    )
    if patient_ids is not None:
        bq = bq.filter(Submission.patient_id.in_(patient_ids))
    block_count = bq.scalar() or 0

    # ── Malignancy rate ───────────────────────────────────────────────────────
    sq = db.query(func.count(Submission.id))
    if patient_ids is not None:
        sq = sq.filter(Submission.patient_id.in_(patient_ids))
    total_submissions = sq.scalar() or 0

    mq = db.query(func.count(Submission.id)).filter(Submission.malignancy_flag == True)
    if patient_ids is not None:
        mq = mq.filter(Submission.patient_id.in_(patient_ids))
    malignant_count = mq.scalar() or 0

    malignancy_rate = (
        round(malignant_count / total_submissions * 100, 1)
        if total_submissions > 0 else 0.0
    )

    # ── Scanned blocks percentage ─────────────────────────────────────────────
    scanned_q = (
        db.query(func.count(Block.id))
        .join(Probe,      Block.probe_id      == Probe.id)
        .join(Submission, Probe.submission_id == Submission.id)
        .filter(exists().where(Scan.block_id == Block.id))
    )
    if patient_ids is not None:
        scanned_q = scanned_q.filter(Submission.patient_id.in_(patient_ids))
    scanned_blocks = scanned_q.scalar() or 0

    scanned_pct = (
        round(scanned_blocks / block_count * 100, 1)
        if block_count > 0 else 0.0
    )

    return {
        "patient_count":   patient_count,
        "year_min":        year_min,
        "year_max":        year_max,
        "block_count":     block_count,
        "malignancy_rate": malignancy_rate,
        "scanned_pct":     scanned_pct,
        "scanned_blocks":  scanned_blocks,
        "total_blocks":    block_count,
    }


@router.get("/dashboard")
def get_dashboard_stats(
    db: Session = Depends(get_db),
    _: User    = Depends(get_current_active_user),
):
    """Enriched stats for the dashboard: totals + chart data.

    Headline counts (patient/submission/block/scan_count) are INTERNAL
    (IGMP/Bern — patients.source_id IS NULL) by default, with the matching
    "_external"/"_total" figures alongside so the UI can show composition
    rather than a single blended number that silently includes collaborator/
    public cohorts (TCGA, Radboud, …) a Bern-only audience wouldn't expect.
    See [[external-cohort-ingestion]] — external is a few thousand patients
    against ~540k internal, so we get the external side (small) via a join
    filtered to `source_id IS NOT NULL` and derive internal = total - external,
    rather than scanning the large internal-majority side.
    """
    patient_count_total    = db.query(func.count(Patient.id)).scalar() or 0
    submission_count_total = db.query(func.count(Submission.id)).scalar() or 0
    block_count_total      = db.query(func.count(Block.id)).scalar() or 0
    scan_count_total       = db.query(func.count(Scan.id)).scalar() or 0

    patient_count_external = (
        db.query(func.count(Patient.id))
        .filter(Patient.source_id.isnot(None))
        .scalar() or 0
    )
    submission_count_external = (
        db.query(func.count(Submission.id))
        .join(Patient, Submission.patient_id == Patient.id)
        .filter(Patient.source_id.isnot(None))
        .scalar() or 0
    )
    block_count_external = (
        db.query(func.count(Block.id))
        .join(Probe,      Block.probe_id      == Probe.id)
        .join(Submission, Probe.submission_id == Submission.id)
        .join(Patient,    Submission.patient_id == Patient.id)
        .filter(Patient.source_id.isnot(None))
        .scalar() or 0
    )
    scan_count_external = (
        db.query(func.count(Scan.id))
        .join(Block,      Scan.block_id        == Block.id)
        .join(Probe,      Block.probe_id       == Probe.id)
        .join(Submission, Probe.submission_id  == Submission.id)
        .join(Patient,    Submission.patient_id == Patient.id)
        .filter(Patient.source_id.isnot(None))
        .scalar() or 0
    )

    patient_count    = patient_count_total    - patient_count_external
    submission_count = submission_count_total - submission_count_external
    block_count      = block_count_total      - block_count_external
    scan_count       = scan_count_total       - scan_count_external

    # ── Year range + submissions-by-year — internal accessions only ──────────
    # Plotting other institutions' historical diagnosis years next to Bern's
    # real accession cadence would misrepresent both; see the dashboard
    # discussion in [[external-cohort-ingestion]].
    year_col = _submission_year_col()
    year_min, year_max = (
        db.query(func.min(year_col), func.max(year_col))
        .join(Patient, Submission.patient_id == Patient.id)
        .filter(Patient.source_id.is_(None))
        .first() or (None, None)
    )

    modality_col = _submission_modality_col()
    submissions_by_year_rows = (
        db.query(
            year_col.label("year"),
            modality_col.label("modality"),
            func.count(Submission.id).label("count"),
        )
        .join(Patient, Submission.patient_id == Patient.id)
        .filter(year_col.isnot(None), Patient.source_id.is_(None))
        .group_by(year_col, modality_col)
        .order_by(year_col)
        .all()
    )

    # Reshape (year, modality, count) rows into one object per year carrying the
    # per-modality split plus the total, and derive the internal modality totals
    # for the Submissions stat card — all internal accessions are B/Z/S, so this
    # sums to submission_count (bar the vanishingly rare null-year row).
    _year_map: dict[int, dict] = {}
    submission_by_modality = {"B": 0, "Z": 0, "S": 0}
    for r in submissions_by_year_rows:
        y = _year_map.setdefault(r.year, {"year": r.year, "B": 0, "Z": 0, "S": 0, "count": 0})
        y["count"] += r.count
        if r.modality in submission_by_modality:
            y[r.modality] += r.count
            submission_by_modality[r.modality] += r.count
    submissions_by_year = [_year_map[y] for y in sorted(_year_map)]

    # ── Malignancy rate / scanned% — internal-only, derived from the counts above ─
    malignant_count_total = (
        db.query(func.count(Submission.id))
        .filter(Submission.malignancy_flag == True)
        .scalar() or 0
    )
    malignant_count_external = (
        db.query(func.count(Submission.id))
        .join(Patient, Submission.patient_id == Patient.id)
        .filter(Submission.malignancy_flag == True, Patient.source_id.isnot(None))
        .scalar() or 0
    )
    malignant_count = malignant_count_total - malignant_count_external
    malignancy_rate = (
        round(malignant_count / submission_count * 100, 1) if submission_count > 0 else 0.0
    )

    scanned_blocks_total = (
        db.query(func.count(Block.id))
        .filter(exists().where(Scan.block_id == Block.id))
        .scalar() or 0
    )
    scanned_blocks_external = (
        db.query(func.count(Block.id))
        .join(Probe,      Block.probe_id      == Probe.id)
        .join(Submission, Probe.submission_id == Submission.id)
        .join(Patient,    Submission.patient_id == Patient.id)
        .filter(exists().where(Scan.block_id == Block.id), Patient.source_id.isnot(None))
        .scalar() or 0
    )
    scanned_blocks = scanned_blocks_total - scanned_blocks_external
    scanned_pct = round(scanned_blocks / block_count * 100, 1) if block_count > 0 else 0.0

    # Stain taxonomy is a methodology property, not a population one — left global.
    stain_type_count = (
        db.query(func.count(func.distinct(Stain.stain_category))).scalar() or 0
    )

    stain_dist_rows = (
        db.query(Stain.stain_category, func.count(Scan.id).label("count"))
        .join(Scan, Scan.stain_id == Stain.id)
        .group_by(Stain.stain_category)
        .order_by(func.count(Scan.id).desc())
        .all()
    )

    return {
        "patient_count":          patient_count,
        "patient_count_external": patient_count_external,
        "patient_count_total":    patient_count_total,
        "submission_count":          submission_count,
        "submission_count_external": submission_count_external,
        "submission_count_total":    submission_count_total,
        "block_count":          block_count,
        "block_count_external": block_count_external,
        "block_count_total":    block_count_total,
        "scan_count":          scan_count,
        "scan_count_external": scan_count_external,
        "scan_count_total":    scan_count_total,
        "year_min":            year_min,
        "year_max":            year_max,
        "malignancy_rate":     malignancy_rate,
        "scanned_pct":         scanned_pct,
        "stain_type_count":    stain_type_count,
        "submissions_by_year":    submissions_by_year,
        "submission_by_modality": submission_by_modality,
        "stain_distribution":  [{"category": r.stain_category or "Unknown", "count": r.count} for r in stain_dist_rows],
    }


@router.get("/data-sources")
def get_data_sources(
    db: Session = Depends(get_db),
    _: User    = Depends(get_current_active_user),
):
    """Provenance breakdown: IGMP (internal) + every external cohort, with
    patient counts and governance. Single source of truth for both the
    dashboard's "Data Sources" panel and the cohort builder's source filter —
    see [[external-cohort-ingestion]]."""
    internal_count = (
        db.query(func.count(Patient.id)).filter(Patient.source_id.is_(None)).scalar() or 0
    )

    rows = (
        db.query(
            DataSource.code, DataSource.name, DataSource.institution, DataSource.governance,
            func.count(Patient.id).label("patient_count"),
        )
        .join(Patient, Patient.source_id == DataSource.id)
        .group_by(DataSource.id, DataSource.code, DataSource.name, DataSource.institution, DataSource.governance)
        .order_by(func.count(Patient.id).desc())
        .all()
    )

    return [
        {
            "code": "INTERNAL",
            "name": "IGMP (internal)",
            "institution": "Institute of Tissue Medicine and Pathology, University of Bern",
            "governance": None,
            "patient_count": internal_count,
        },
        *[
            {
                "code": r.code, "name": r.name, "institution": r.institution,
                "governance": r.governance, "patient_count": r.patient_count,
            }
            for r in rows
        ],
    ]


@router.get("/lookup/{field}")
def lookup_values(
    field: Literal[
        "snomed_topo_code", "topo_description", "stain_name", "stain_category",
        "submission_type", "file_format",
        "snomed_morph_code", "morph_description",
        "snomed_etiology_code", "etiology_description",
    ],
    q: str = Query(..., min_length=1),
    db: Session = Depends(get_db),
    _: User = Depends(get_current_active_user),
):
    """Returns unique values from the database for autocomplete suggestions."""
    if field == "stain_name":
        results = db.query(Stain.stain_name).filter(Stain.stain_name.ilike(f"%{q}%")).distinct().limit(15).all()
    elif field == "stain_category":
        results = db.query(Stain.stain_category).filter(Stain.stain_category.ilike(f"%{q}%")).distinct().limit(15).all()
    elif field == "submission_type":
        results = db.query(Probe.submission_type).filter(Probe.submission_type.ilike(f"%{q}%")).distinct().limit(15).all()
    elif field == "file_format":
        results = db.query(Scan.file_format).filter(Scan.file_format.ilike(f"%{q}%")).distinct().limit(15).all()
    elif field == "snomed_topo_code":
        results = db.query(Probe.snomed_topo_code).filter(Probe.snomed_topo_code.ilike(f"%{q}%")).distinct().limit(15).all()
    elif field == "snomed_morph_code":
        results = db.query(SnomedCode.code).filter(
            SnomedCode.category == "morphology", SnomedCode.code.ilike(f"%{q}%")
        ).distinct().limit(15).all()
    elif field == "morph_description":
        results = db.query(SnomedCode.description).filter(
            SnomedCode.category == "morphology", SnomedCode.description.ilike(f"%{q}%")
        ).distinct().limit(15).all()
    elif field == "snomed_etiology_code":
        results = db.query(SnomedCode.code).filter(
            SnomedCode.category == "etiology", SnomedCode.code.ilike(f"%{q}%")
        ).distinct().limit(15).all()
    elif field == "etiology_description":
        results = db.query(SnomedCode.description).filter(
            SnomedCode.category == "etiology", SnomedCode.description.ilike(f"%{q}%")
        ).distinct().limit(15).all()
    else:
        results = db.query(Probe.topo_description).filter(Probe.topo_description.ilike(f"%{q}%")).distinct().limit(15).all()

    return [r[0] for r in results if r[0]]