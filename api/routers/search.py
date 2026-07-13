"""
PathoDB API — Search Router
Exact-match lookup by patient code, accession number (B = histology,
Z = cytology), submission ID, or probe ID.
Returns a single best match or an empty list if nothing found.
"""
import re
from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import Patient, Submission, Probe, User
from ..auth import get_current_active_user

router = APIRouter(prefix="/search", tags=["search"])

# Accession numbers share one era-based grammar across modalities:
#   B = histology, Z = cytology. Group 1 captures the prefix so resolution
#   stays scoped to the matched modality (a 'Z' query never matches 'B' rows).
B_PATTERN = re.compile(r'^([BbZz])\.?(\d{4})\.(\d+)(?:/(\d+))?$')


def _is_b_number(term: str) -> bool:
    return bool(B_PATTERN.match(term.strip()))


def _resolve_b_number(term: str, db: Session) -> list[dict]:
    """Exact era-aware accession-number resolution (B/Z) → list of result dicts."""
    m = B_PATTERN.match(term.strip())
    if not m:
        return []

    prefix    = m.group(1).upper()
    year      = int(m.group(2))
    num_part  = m.group(3)
    b_exact   = f"{prefix}{year}.{num_part}"

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
                # patient_code is the key downstream patient tools (e.g.
                # get_patient_history) expect. It is a DIFFERENT namespace from
                # patient_id and the two can collide, so always surface both.
                "patient_code":  patient.patient_code,
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
    Priority order: accession number (B/Z) → patient code → submission ID → probe ID.
    """
    term    = q.strip()
    results = []

    # ── Accession number, era-aware exact (B = histology, Z = cytology) ────────
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
            "patient_code": patient.patient_code,
            "url":        f"/patients/{patient.id}",
        })
        return results

    # ── Submission ID (exact) ─────────────────────────────────────────────────
    sub = db.query(Submission).filter(
        Submission.lis_submission_id == term
    ).first()
    if sub:
        sub_patient = db.get(Patient, sub.patient_id)
        results.append({
            "type":          "submission",
            "label":         sub.lis_submission_id,
            "sub_label":     f"Report: {sub.report_date or '—'}" + (" · Malignant" if sub.malignancy_flag else ""),
            "patient_id":    sub.patient_id,
            "patient_code":  sub_patient.patient_code if sub_patient else None,
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
            probe_patient = db.get(Patient, sub.patient_id)
            results.append({
                "type":       "probe",
                "label":      probe.lis_probe_id,
                "sub_label":  probe.topo_description or probe.snomed_topo_code or "Unknown site",
                "patient_id": sub.patient_id,
                "patient_code": probe_patient.patient_code if probe_patient else None,
                "url":        f"/patients/{sub.patient_id}",
            })
        return results

    return []