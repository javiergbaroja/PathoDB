"""
PathoDB API — Patients Router
Accession-number matching (B = histology, Z = cytology) reverted to substring
(non-exact) as of patch 4. Bold highlighting is handled on the frontend side.
"""
import re
from collections import defaultdict
from natsort import natsorted
from datetime import date
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session, selectinload
from sqlalchemy import text

from ..database import get_db
from ..models import (
    Patient, Submission, Probe, 
    Block, Scan, Report, 
    User, SnomedCode
)
from ..schemas import (
    PatientResponse, PatientWithSubmissions,
    HierarchySubmission, HierarchyProbe, HierarchyBlock, ScanSummary,
    ReportSummary, PatientUpdate, ProbeResponse, SubmissionUpdate, ReportUpdate,
    ProbeCreate, ProbeUpdate,
    BlockCreate, BlockUpdate,
)
from ..auth import get_current_active_user, require_admin

router = APIRouter(prefix="/patients", tags=["patients"])

ERA_1_END = date(2011, 9, 1)
ERA_2_END = date(2017, 9, 1)
B_PATTERN = re.compile(r'^([BbZz])\.?(\d{4})\.(\d+)(?:/(\d+))?$')


def resolve_b_number(b_str: str, db: Session) -> list:
    """
    Resolve an accession number (B = histology, Z = cytology) to matching
    patients using substring matching. Tries the era-appropriate field
    (submission vs probe) based on year, but uses ILIKE '%value%' so partial
    matches are included. The prefix is kept in the search value so a 'Z' query
    never matches 'B' rows (and vice versa).
    """
    m = B_PATTERN.match(b_str.strip())
    if not m:
        return []

    prefix    = m.group(1).upper()
    year      = int(m.group(2))
    num_part  = m.group(3)
    probe_num = m.group(4)

    b_full   = f"{prefix}{year}.{num_part}"
    b_slash  = f"{b_full}/{probe_num}" if probe_num else None

    results = set()

    def _via_submission(val):
        subs = db.query(Submission).filter(
            Submission.lis_submission_id.ilike(f"%{val}%")
        ).all()
        return [s.patient_id for s in subs]

    def _via_probe(val):
        probes = db.query(Probe).filter(
            Probe.lis_probe_id.ilike(f"%{val}%")
        ).all()
        pids = []
        for p in probes:
            sub = db.get(Submission, p.submission_id)
            if sub:
                pids.append(sub.patient_id)
        return pids

    if year < 2011:
        strategies = ['submission']
    elif year == 2011:
        strategies = ['submission', 'probe']
    elif year < 2017:
        strategies = ['probe']
    elif year == 2017:
        strategies = ['probe', 'submission']
    else:
        strategies = ['submission']

    for strategy in strategies:
        if strategy == 'submission':
            results.update(_via_submission(b_full))
        elif strategy == 'probe':
            search_val = b_slash if b_slash else b_full
            results.update(_via_probe(search_val))

    if not results:
        return []
    return db.query(Patient).filter(Patient.id.in_(results)).all()


def enrich_snomed_codes(db: Session, codes: list[str] | None) -> list[dict]:
    """['M-81403', 'M-09000'] -> [{'code': 'M-81403', 'description': '...'}, ...]
    Looked up from the snomed_codes master vocabulary. Order of `codes` is preserved."""
    if not codes:
        return []
    descs = dict(db.query(SnomedCode.code, SnomedCode.description)
                 .filter(SnomedCode.code.in_(codes)).all())
    return [{"code": c, "description": descs.get(c)} for c in codes]

def _validated_codes(db: Session, category: str, codes) -> list[str] | None:
    """De-dupe + validate against snomed_codes. None means 'field omitted, leave untouched'."""
    if codes is None:
        return None
    codes = list(dict.fromkeys(c.strip() for c in codes if c.strip()))
    if codes:
        found = {c for (c,) in db.query(SnomedCode.code)
                 .filter(SnomedCode.code.in_(codes), SnomedCode.category == category).all()}
        missing = [c for c in codes if c not in found]
        if missing:
            raise HTTPException(400, f"Unknown {category} code(s): {', '.join(missing)}")
    return codes

def _probe_response(db: Session, probe: Probe) -> dict:
    return {
        "id": probe.id,
        "submission_id": probe.submission_id,
        "lis_probe_id": probe.lis_probe_id,
        "submission_type": probe.submission_type,
        "snomed_topo_code": probe.snomed_topo_code,
        "topo_description": probe.topo_description,
        "location_additional": probe.location_additional,
        "snomed_morph_codes": enrich_snomed_codes(db, probe.snomed_morph_codes),
        "snomed_etio_codes": enrich_snomed_codes(db, probe.snomed_etio_codes),
        "blocks": probe.blocks,
    }

def _enrich_patients(patient_list: list, db: Session) -> list[dict]:
    if not patient_list:
        return []

    patient_ids = [p.id for p in patient_list]

    subs = (
        db.query(
            Submission.patient_id,
            Submission.lis_submission_id,
            Submission.report_date,
            Submission.malignancy_flag,
        )
        .filter(Submission.patient_id.in_(patient_ids))
        .order_by(Submission.report_date.desc().nullslast())
        .all()
    )

    sub_ids_by_patient      = defaultdict(list)
    last_report_by_patient  = {}
    malignancy_by_patient   = {}   # True if ANY submission is malignant

    for row in subs:
        sub_ids_by_patient[row.patient_id].append(row.lis_submission_id)
        if row.report_date and row.patient_id not in last_report_by_patient:
            last_report_by_patient[row.patient_id] = row.report_date
        if row.malignancy_flag:
            malignancy_by_patient[row.patient_id] = True

    enriched = []
    for p in patient_list:
        enriched.append({
            "id":               p.id,
            "patient_code":     p.patient_code,
            "date_of_birth":    p.date_of_birth,
            "sex":              p.sex,
            "created_at":       p.created_at,
            "submission_ids":   sub_ids_by_patient.get(p.id, []),
            "last_report_date": last_report_by_patient.get(p.id),
            "has_malignancy":   malignancy_by_patient.get(p.id, False),
        })
    return enriched



@router.get("")
def search_patients(
    patient_code: str | None = Query(None),
    b_number:     str | None = Query(None),
    sex:          str | None = Query(None),
    page:         int        = Query(1, ge=1),
    page_size:    int        = Query(50, ge=1, le=200),
    db: Session              = Depends(get_db),
    _: User                  = Depends(get_current_active_user),
):
    if b_number:
        matches = resolve_b_number(b_number, db)
        return _enrich_patients(matches[:page_size], db)

    q = db.query(Patient)
    if patient_code:
        q = q.filter(Patient.patient_code.ilike(f"%{patient_code}%"))
    if sex:
        q = q.filter(Patient.sex == sex.upper())

    patient_list = (
        q.order_by(Patient.patient_code)
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )
    return _enrich_patients(patient_list, db)


@router.get("/{patient_id}", response_model=PatientWithSubmissions)
def get_patient(
    patient_id: int,
    db: Session = Depends(get_db),
    _: User     = Depends(get_current_active_user),
):
    patient = db.get(Patient, patient_id)
    if not patient:
        raise HTTPException(status_code=404, detail="Patient not found")
    return patient


@router.get("/{patient_id}/hierarchy")
def get_patient_hierarchy(
    patient_id: int,
    db: Session = Depends(get_db),
    _: User     = Depends(get_current_active_user),
):
    patient = (
        db.query(Patient)
        .options(
            selectinload(Patient.submissions).selectinload(Submission.reports),
            selectinload(Patient.submissions)
            .selectinload(Submission.probes)
            .selectinload(Probe.blocks)
            .selectinload(Block.scans)
            .selectinload(Scan.stain),
        )
        .filter(Patient.id == patient_id)
        .first()
    )
    if not patient:
        raise HTTPException(status_code=404, detail="Patient not found")

    submissions_out = []
    for sub in patient.submissions:
        probes_out = []
        for probe in sub.probes:
            blocks_out = []
            for block in probe.blocks:
                scans_out = [
                    ScanSummary(
                        id=sc.id,
                        stain_id=sc.stain_id,
                        stain_name=sc.stain.stain_name if sc.stain else None,
                        stain_category=sc.stain.stain_category if sc.stain else None,
                        file_path=sc.file_path,
                        file_format=sc.file_format,
                        magnification=sc.magnification,
                        created_at=sc.created_at,
                    )
                    for sc in block.scans
                ]
                blocks_out.append(
                    HierarchyBlock(
                        id=block.id,
                        block_label=block.block_label,
                        block_sequence=block.block_sequence,
                        block_info=block.block_info,
                        tissue_count=block.tissue_count,
                        scans=scans_out,
                    )
                )
            probes_out.append(
                HierarchyProbe(
                    id=probe.id,
                    lis_probe_id=probe.lis_probe_id,
                    submission_type=probe.submission_type,
                    snomed_topo_code=probe.snomed_topo_code,
                    topo_description=probe.topo_description,
                    location_additional=probe.location_additional,
                    snomed_morph_codes=enrich_snomed_codes(db, probe.snomed_morph_codes),
                    snomed_etio_codes=enrich_snomed_codes(db, probe.snomed_etio_codes),
                    blocks=blocks_out,
                )
            )
        submissions_out.append(
            HierarchySubmission(
                id=sub.id,
                lis_submission_id=sub.lis_submission_id,
                report_date=sub.report_date,
                malignancy_flag=sub.malignancy_flag,
                consent=sub.consent,
                reports=[
                    ReportSummary(
                        id=r.id,
                        report_type=r.report_type,
                        report_date=r.report_date,
                        report_text=r.report_text,
                    )
                    for r in sub.reports
                ],
                probes=probes_out,
            )
        )

    submissions_out = natsorted(
        submissions_out, 
        key=lambda s: s.lis_submission_id or "", 
        reverse=True
    )

    return {
        "id":            patient.id,
        "patient_code":  patient.patient_code,
        "date_of_birth": patient.date_of_birth,
        "sex":           patient.sex,
        "created_at":    patient.created_at,
        "submissions":   submissions_out,
    }


@router.patch("/{patient_id}", response_model=PatientResponse)
def update_patient(
    patient_id: int,
    req: PatientUpdate,
    db: Session = Depends(get_db),
    _: User = Depends(require_admin),
):
    patient = db.get(Patient, patient_id)
    if not patient:
        raise HTTPException(status_code=404, detail="Patient not found")
    if req.date_of_birth is not None:
        patient.date_of_birth = req.date_of_birth
    if req.sex is not None:
        patient.sex = req.sex
    db.commit()
    db.refresh(patient)
    return patient


@router.patch("/{patient_id}/submissions/{submission_id}")
def update_submission(
    patient_id: int,
    submission_id: int,
    req: SubmissionUpdate,
    db: Session = Depends(get_db),
    _: User = Depends(require_admin),
):
    sub = db.query(Submission).filter(
        Submission.id == submission_id,
        Submission.patient_id == patient_id,
    ).first()
    if not sub:
        raise HTTPException(status_code=404, detail="Submission not found")
    if req.report_date     is not None: sub.report_date     = req.report_date
    if req.malignancy_flag is not None: sub.malignancy_flag = req.malignancy_flag
    if req.consent         is not None: sub.consent         = req.consent
    db.commit()
    db.refresh(sub)
    return sub


@router.patch("/{patient_id}/submissions/{submission_id}/reports/{report_id}")
def update_report(
    patient_id: int,
    submission_id: int,
    report_id: int,
    req: ReportUpdate,
    db: Session = Depends(get_db),
    _: User = Depends(require_admin),
):
    sub = db.query(Submission).filter(
        Submission.id == submission_id,
        Submission.patient_id == patient_id,
    ).first()
    if not sub:
        raise HTTPException(status_code=404, detail="Submission not found")
    report = db.query(Report).filter(
        Report.id == report_id,
        Report.submission_id == submission_id,
    ).first()
    if not report:
        raise HTTPException(status_code=404, detail="Report not found")
    if req.report_text is not None: report.report_text = req.report_text
    if req.report_date is not None: report.report_date = req.report_date
    db.commit()
    # Invalidate stale embedding so the next embed job re-processes this report
    db.execute(text("DELETE FROM report_embeddings WHERE report_id = :rid"), {"rid": report_id})
    db.commit()
    db.refresh(report)
    return report


# ── Probes ────────────────────────────────────────────────────────────────────
@router.post("/{patient_id}/submissions/{submission_id}/probes", status_code=201, response_model=ProbeResponse)
def create_probe(
    patient_id: int,
    submission_id: int,
    req: ProbeCreate,
    db: Session = Depends(get_db),
    _: User = Depends(require_admin),
):
    sub = db.query(Submission).filter(
        Submission.id == submission_id, Submission.patient_id == patient_id
    ).first()
    if not sub:
        raise HTTPException(404, "Submission not found")
    if db.query(Probe).filter(
        Probe.submission_id == submission_id, Probe.lis_probe_id == req.lis_probe_id
    ).first():
        raise HTTPException(409, "A probe with this ID already exists in this submission")
    probe = Probe(
        submission_id=submission_id,
        lis_probe_id=req.lis_probe_id,
        submission_type=req.submission_type,
        snomed_topo_code=req.snomed_topo_code,
        topo_description=req.topo_description,
        location_additional=req.location_additional,
        snomed_morph_codes=_validated_codes(db, "morphology", req.snomed_morph_codes) or [],
        snomed_etio_codes=_validated_codes(db, "etiology", req.snomed_etio_codes) or [],
    )
    db.add(probe)
    db.commit()
    db.refresh(probe)
    return _probe_response(db, probe)


@router.patch("/{patient_id}/submissions/{submission_id}/probes/{probe_id}", response_model=ProbeResponse)
def update_probe(
    patient_id: int,
    submission_id: int,
    probe_id: int,
    req: ProbeUpdate,
    db: Session = Depends(get_db),
    _: User = Depends(require_admin),
):
    sub = db.query(Submission).filter(
        Submission.id == submission_id, Submission.patient_id == patient_id
    ).first()
    if not sub:
        raise HTTPException(404, "Submission not found")
    probe = db.query(Probe).filter(
        Probe.id == probe_id, Probe.submission_id == submission_id
    ).first()
    if not probe:
        raise HTTPException(404, "Probe not found")
    if req.lis_probe_id      is not None: probe.lis_probe_id      = req.lis_probe_id
    if req.submission_type   is not None: probe.submission_type   = req.submission_type
    if req.snomed_topo_code  is not None: probe.snomed_topo_code  = req.snomed_topo_code
    if req.topo_description  is not None: probe.topo_description  = req.topo_description
    if req.location_additional is not None: probe.location_additional = req.location_additional
    morph_codes = _validated_codes(db, "morphology", req.snomed_morph_codes)
    etio_codes  = _validated_codes(db, "etiology", req.snomed_etio_codes)
    if morph_codes is not None: probe.snomed_morph_codes = morph_codes
    if etio_codes  is not None: probe.snomed_etio_codes  = etio_codes
    db.commit()
    db.refresh(probe)
    return _probe_response(db, probe)


@router.delete("/{patient_id}/submissions/{submission_id}/probes/{probe_id}", status_code=204)
def delete_probe(
    patient_id: int,
    submission_id: int,
    probe_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(require_admin),
):
    sub = db.query(Submission).filter(
        Submission.id == submission_id, Submission.patient_id == patient_id
    ).first()
    if not sub:
        raise HTTPException(404, "Submission not found")
    probe = db.query(Probe).filter(
        Probe.id == probe_id, Probe.submission_id == submission_id
    ).first()
    if not probe:
        raise HTTPException(404, "Probe not found")
    db.delete(probe)
    db.commit()


# ── Blocks ────────────────────────────────────────────────────────────────────

@router.post("/{patient_id}/submissions/{submission_id}/probes/{probe_id}/blocks", status_code=201)
def create_block(
    patient_id: int,
    submission_id: int,
    probe_id: int,
    req: BlockCreate,
    db: Session = Depends(get_db),
    _: User = Depends(require_admin),
):
    sub = db.query(Submission).filter(
        Submission.id == submission_id, Submission.patient_id == patient_id
    ).first()
    if not sub:
        raise HTTPException(404, "Submission not found")
    probe = db.query(Probe).filter(
        Probe.id == probe_id, Probe.submission_id == submission_id
    ).first()
    if not probe:
        raise HTTPException(404, "Probe not found")
    if db.query(Block).filter(
        Block.probe_id == probe_id, Block.block_label == req.block_label
    ).first():
        raise HTTPException(409, "A block with this label already exists in this probe")
    block = Block(
        probe_id=probe_id,
        block_label=req.block_label,
        block_sequence=req.block_sequence,
        block_info=req.block_info,
        tissue_count=req.tissue_count,
    )
    db.add(block)
    db.commit()
    db.refresh(block)
    return block


@router.patch("/{patient_id}/submissions/{submission_id}/probes/{probe_id}/blocks/{block_id}")
def update_block(
    patient_id: int,
    submission_id: int,
    probe_id: int,
    block_id: int,
    req: BlockUpdate,
    db: Session = Depends(get_db),
    _: User = Depends(require_admin),
):
    # ownership chain check
    sub = db.query(Submission).filter(
        Submission.id == submission_id, Submission.patient_id == patient_id
    ).first()
    if not sub:
        raise HTTPException(404, "Submission not found")
    block = db.query(Block).filter(
        Block.id == block_id, Block.probe_id == probe_id
    ).first()
    if not block:
        raise HTTPException(404, "Block not found")
    if req.block_label    is not None: block.block_label    = req.block_label
    if req.block_sequence is not None: block.block_sequence = req.block_sequence
    if req.block_info     is not None: block.block_info     = req.block_info
    if req.tissue_count   is not None: block.tissue_count   = req.tissue_count
    db.commit()
    db.refresh(block)
    return block


@router.delete("/{patient_id}/submissions/{submission_id}/probes/{probe_id}/blocks/{block_id}", status_code=204)
def delete_block(
    patient_id: int,
    submission_id: int,
    probe_id: int,
    block_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(require_admin),
):
    sub = db.query(Submission).filter(
        Submission.id == submission_id, Submission.patient_id == patient_id
    ).first()
    if not sub:
        raise HTTPException(404, "Submission not found")
    block = db.query(Block).filter(
        Block.id == block_id, Block.probe_id == probe_id
    ).first()
    if not block:
        raise HTTPException(404, "Block not found")
    db.delete(block)
    db.commit()