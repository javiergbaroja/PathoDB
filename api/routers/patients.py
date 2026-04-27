"""
PathoDB API — Patients Router
B-number matching reverted to substring (non-exact) as of patch 4.
Bold highlighting is handled on the frontend side.
"""
import re
from collections import defaultdict
from natsort import natsorted
from datetime import date
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session, selectinload

from ..database import get_db
from ..models import Patient, Submission, Probe, Block, Scan, Stain, Report
from ..schemas import (
    PatientResponse, PatientWithSubmissions, HierarchyResponse,
    HierarchySubmission, HierarchyProbe, HierarchyBlock, ScanSummary,
    ReportSummary,
)
from ..auth import get_current_active_user
from ..models import User

router = APIRouter(prefix="/patients", tags=["patients"])

ERA_1_END = date(2011, 9, 1)
ERA_2_END = date(2017, 9, 1)
B_PATTERN = re.compile(r'^[Bb]\.?(\d{4})\.(\d+)(?:/(\d+))?$')


def resolve_b_number(b_str: str, db: Session) -> list:
    """
    Resolve a B-number to matching patients using substring matching.
    Tries era-appropriate field (submission vs probe) based on year,
    but uses ILIKE '%value%' so partial matches are included.
    """
    m = B_PATTERN.match(b_str.strip())
    if not m:
        return []

    year      = int(m.group(1))
    num_part  = m.group(2)
    probe_num = m.group(3)

    b_full   = f"{year}.{num_part}"
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
            selectinload(Patient.submissions)
            .selectinload(Submission.reports),
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
