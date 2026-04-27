"""
PathoDB API — Search Router
Exact-match lookup by patient code, B-number, submission ID, or probe ID.
Returns a single best match or an empty list if nothing found.
"""
import re
from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import Patient, Submission, Probe, User
from ..auth import get_current_active_user

router = APIRouter(prefix="/search", tags=["search"])

B_PATTERN = re.compile(r'^[Bb]\.?(\d{4})\.(\d+)(?:/(\d+))?$')


def _is_b_number(term: str) -> bool:
    return bool(B_PATTERN.match(term.strip()))


def _resolve_b_number(term: str, db: Session) -> list[dict]:
    """Exact era-aware B-number resolution → list of result dicts."""
    m = B_PATTERN.match(term.strip())
    if not m:
        return []

    year      = int(m.group(1))
    num_part  = m.group(2)
    b_exact   = f"B{year}.{num_part}"

    results = []
    seen_patient_ids = set()

    def _add_from_sub(sub):
        if not sub:
            return
        patient = db.get(Patient, sub.patient_id)
        if patient and patient.id not in seen_patient_ids:
            seen_patient_ids.add(patient.id)
            results.append({
                "type":          "submission",
                "label":         sub.lis_submission_id,
                "sub_label":     f"Report: {sub.report_date or '—'}" + (" · Malignant" if sub.malignancy_flag else ""),
                "patient_id":    sub.patient_id,
                "url":           f"/patients/{sub.patient_id}",
            })

    def _via_submission_exact():
        # Era 1: B{year}.{num} is the full submission ID
        for sub in db.query(Submission).filter(
            Submission.lis_submission_id == b_exact
        ).all():
            _add_from_sub(sub)

    def _via_probe_exact():
        # Era 2: b_case is the probe ID
        for probe in db.query(Probe).filter(
            Probe.lis_probe_id == b_exact
        ).all():
            _add_from_sub(db.get(Submission, probe.submission_id))

    def _via_submission_slash():
        # Era 3: submission ID starts with B{year}.{num}/
        for sub in db.query(Submission).filter(
            Submission.lis_submission_id.like(f"{b_exact}/%")
        ).all():
            _add_from_sub(sub)

    if year < 2011:
        strategies = ['submission_exact']
    elif year == 2011:
        strategies = ['submission_exact', 'probe_exact']
    elif year < 2017:
        strategies = ['probe_exact']
    elif year == 2017:
        strategies = ['probe_exact', 'submission_slash']
    else:
        strategies = ['submission_slash']

    for s in strategies:
        if s == 'submission_exact': _via_submission_exact()
        elif s == 'probe_exact':    _via_probe_exact()
        elif s == 'submission_slash': _via_submission_slash()

    return results


@router.get("")
def universal_search(
    q:  str     = Query(..., min_length=2),
    db: Session = Depends(get_db),
    _:  User    = Depends(get_current_active_user),
):
    """
    Exact-match search. Returns matching results or empty list.
    Priority order: patient code → B-number → submission ID → probe ID.
    """
    term    = q.strip()
    results = []

    # ── B-number (era-aware exact) ────────────────────────────────────────────
    if _is_b_number(term):
        return _resolve_b_number(term, db)

    # ── Patient code (exact) ──────────────────────────────────────────────────
    patient = db.query(Patient).filter(
        Patient.patient_code == term
    ).first()
    if patient:
        results.append({
            "type":       "patient",
            "label":      patient.patient_code,
            "sub_label":  f"{patient.sex or '?'} · {patient.date_of_birth or 'DOB unknown'}",
            "patient_id": patient.id,
            "url":        f"/patients/{patient.id}",
        })
        return results

    # ── Submission ID (exact) ─────────────────────────────────────────────────
    sub = db.query(Submission).filter(
        Submission.lis_submission_id == term
    ).first()
    if sub:
        results.append({
            "type":          "submission",
            "label":         sub.lis_submission_id,
            "sub_label":     f"Report: {sub.report_date or '—'}" + (" · Malignant" if sub.malignancy_flag else ""),
            "patient_id":    sub.patient_id,
            "url":           f"/patients/{sub.patient_id}",
        })
        return results

    # ── Probe ID (exact) ──────────────────────────────────────────────────────
    probe = db.query(Probe).filter(
        Probe.lis_probe_id == term
    ).first()
    if probe:
        sub = db.get(Submission, probe.submission_id)
        if sub:
            results.append({
                "type":       "probe",
                "label":      probe.lis_probe_id,
                "sub_label":  probe.topo_description or probe.snomed_topo_code or "Unknown site",
                "patient_id": sub.patient_id,
                "url":        f"/patients/{sub.patient_id}",
            })
        return results

    return []