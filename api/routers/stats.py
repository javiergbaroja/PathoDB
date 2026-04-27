"""
PathoDB API — Stats Router
Aggregate statistics, optionally filtered by the same search params as /patients.
"""
from typing import Literal
from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session
from sqlalchemy import func, cast, Integer, exists

from ..database import get_db
from ..models import Patient, Submission, Probe, Block, Scan, Stain, User
from ..auth import get_current_active_user

router = APIRouter(prefix="/stats", tags=["stats"])

# Re-import the B-number resolver from patients router
from .patients import resolve_b_number


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

    # ── Year range from lis_submission_id ─────────────────────────────────────
    # submission IDs look like E.2019.14823 — extract first 4-digit run as year
    year_col = cast(
        func.substring(Submission.lis_submission_id, r'(\d{4})'),
        Integer
    )
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


@router.get("/lookup/{field}")
def lookup_values(
    field: Literal["snomed_topo_code", "topo_description", "stain_name"],
    q: str = Query(..., min_length=1),
    db: Session = Depends(get_db),
    _: User = Depends(get_current_active_user),
):
    """Returns unique values from the database for autocomplete suggestions."""
    if field == "stain_name":
        # Search stain names
        results = db.query(Stain.stain_name).filter(Stain.stain_name.ilike(f"%{q}%")).distinct().limit(15).all()
    elif field == "snomed_topo_code":
        # Search by code
        results = db.query(Probe.snomed_topo_code).filter(Probe.snomed_topo_code.ilike(f"%{q}%")).distinct().limit(15).all()
    else:
        # Search topo descriptions
        results = db.query(Probe.topo_description).filter(Probe.topo_description.ilike(f"%{q}%")).distinct().limit(15).all()
    
    return [r[0] for r in results if r[0]]