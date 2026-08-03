"""
PathoDB API — Search Router
Exact-match lookup by patient code, accession number (B = histology,
Z = cytology), submission ID, or probe ID.
Returns a single best match or an empty list if nothing found.
"""
import os
import re
from fastapi import APIRouter, Depends, Query
from sqlalchemy import case, func
from sqlalchemy.orm import Session, joinedload

from ..database import get_db
from ..models import Patient, Submission, Probe, Block, Scan, User
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
    slash_num = m.group(4)                                   # e.g. '002' in B2022.36178/002
    b_exact   = f"{prefix}{year}.{num_part}"
    b_full    = f"{b_exact}/{slash_num}" if slash_num else None

    results = []
    seen    = set()                                          # dedup keys (patient_id, probe_id|None)

    def _add_from_sub(sub, probe=None):
        """Emit a result. With `probe`, it is a probe-level hit (navigates to
        that exact probe); otherwise a submission-level hit."""
        if not sub:
            return
        patient = db.get(Patient, sub.patient_id)
        if not patient:
            return
        key = (patient.id, probe.id if probe else None)
        if key in seen:
            return
        seen.add(key)
        # patient_code is the key downstream patient tools (e.g.
        # get_patient_history) expect. It is a DIFFERENT namespace from
        # patient_id and the two can collide, so always surface both.
        if probe is not None:
            results.append({
                "type":          "probe",
                "label":         probe.lis_probe_id,
                "sub_label":     probe.topo_description or probe.snomed_topo_code or "Unknown site",
                "patient_id":    sub.patient_id,
                "patient_code":  patient.patient_code,
                "probe_id":      probe.id,
                "url":           f"/patients/{sub.patient_id}",
            })
        else:
            results.append({
                "type":          "submission",
                "label":         sub.lis_submission_id,
                "sub_label":     f"Report: {sub.report_date or '—'}" + (" · Malignant" if sub.malignancy_flag else ""),
                "patient_id":    sub.patient_id,
                "patient_code":  patient.patient_code,
                "url":           f"/patients/{sub.patient_id}",
            })

    # ── Pinpoint a specific probe ─────────────────────────────────────────────
    # When the query carries a slash-number (B2022.36178/002), the user is
    # naming one probe. Resolve to that exact probe so the UI lands on it rather
    # than the (often range-labelled) parent submission.
    if b_full:
        probes = db.query(Probe).filter(Probe.lis_probe_id == b_full).all()
        if probes:
            for probe in probes:
                _add_from_sub(db.get(Submission, probe.submission_id), probe)
            return results

    def _via_submission_exact():
        # Era 1: B{year}.{num} is the full submission ID
        for sub in db.query(Submission).filter(
            Submission.lis_submission_id == b_exact
        ).all():
            _add_from_sub(sub)

    def _via_probe_exact():
        # Era 2: b_case is the probe ID — resolve to the probe itself.
        for probe in db.query(Probe).filter(
            Probe.lis_probe_id == b_exact
        ).all():
            _add_from_sub(db.get(Submission, probe.submission_id), probe)

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


def _resolve_filenames(term: str, db: Session, limit: int = 10) -> list[dict]:
    """
    Match registered scans by their file *basename* (name + extension).

    file_path stores an absolute path, so we strip the directory portion with a
    regexp and match the remaining basename case-insensitively. Exact basename
    matches rank first, then prefix, then any substring. Each hit carries the
    owning block_id so the frontend can deep-link into the patient hierarchy and
    open that block's scan panel.
    """
    base_expr  = func.regexp_replace(Scan.file_path, r'^.*/', '')
    base_lower = func.lower(base_expr)
    tl         = term.lower()
    # Filenames are full of '_' and may contain '%' — both are LIKE wildcards,
    # so escape them to keep the match literal.
    esc = tl.replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_')
    rank = case(
        (base_lower == tl, 0),
        (base_lower.like(f"{esc}%", escape='\\'), 1),
        else_=2,
    )

    # The same basename can appear at several storage paths for one block
    # (duplicate copies). Over-fetch so post-dedup we can still fill `limit`.
    scans = (
        db.query(Scan)
        .join(Scan.block)
        .join(Block.probe)
        .join(Probe.submission)
        .join(Submission.patient)
        .options(
            joinedload(Scan.stain),
            joinedload(Scan.block).joinedload(Block.probe)
                .joinedload(Probe.submission).joinedload(Submission.patient),
        )
        .filter(base_expr.ilike(f"%{esc}%", escape='\\'))
        .order_by(rank, base_expr.asc())
        .limit(limit * 5)
        .all()
    )

    results = []
    seen    = set()
    for sc in scans:
        block = sc.block
        probe = block.probe if block else None
        sub   = probe.submission if probe else None
        pat   = sub.patient if sub else None
        if not (block and probe and sub and pat):
            continue
        basename = os.path.basename(sc.file_path)
        # Collapse duplicate copies of the same file under the same block; keep
        # the same basename distinct when it lives under a different block.
        dedup_key = (basename.lower(), block.id)
        if dedup_key in seen:
            continue
        seen.add(dedup_key)
        stain    = sc.stain.stain_name if sc.stain else None
        results.append({
            "type":         "scan",
            "label":        basename,
            "sub_label":    " · ".join(filter(None, [
                pat.patient_code,
                f"Block {block.block_label}",
                stain,
            ])),
            "patient_id":   pat.id,
            "patient_code": pat.patient_code,
            "block_id":     block.id,
            "scan_id":      sc.id,
            "url":          f"/patients/{pat.id}",
        })
        if len(results) >= limit:
            break
    return results


@router.get("")
def universal_search(
    q:  str     = Query(..., min_length=2),
    db: Session = Depends(get_db),
    _:  User    = Depends(get_current_active_user),
):
    """
    Exact-match search. Returns matching results or empty list.
    Priority order: accession number (B/Z) → patient code → submission ID →
    probe ID → scan filename (basename substring).
    """
    term    = q.strip()
    results = []

    # ── Accession number, era-aware exact (B = histology, Z = cytology) ────────
    if _is_b_number(term):
        b_results = _resolve_b_number(term, db)
        if b_results:
            return b_results
        # No accession match — fall through to the filename fallback below.

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
                "probe_id":   probe.id,
                "url":        f"/patients/{sub.patient_id}",
            })
        return results

    # ── Scan filename (basename substring) ────────────────────────────────────
    return _resolve_filenames(term, db)