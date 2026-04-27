"""
PathoDB API — Cohorts Router
Adds POST /cohorts/query_list for list-based querying by patient code or B-number.
Also updates scan-level extraction to include all requested fields.
"""
import csv
import io
import json
import re
from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session
from sqlalchemy import and_, or_, func, exists
from typing import Literal

from ..database import get_db
from ..models import Patient, Submission, Probe, Block, Scan, Stain, Cohort, Report, User
from ..schemas import CohortFilter, CohortSave, CohortResponse
from ..auth import get_current_active_user

router = APIRouter(prefix="/cohorts", tags=["cohorts"])

# ─── B-number era resolution (exact match) ────────────────────────────────────

B_PATTERN = re.compile(r'^[Bb]\.?(\d{4})\.(\d+)(?:/(\d+))?$')
VIEWER_FORMATS = {'SVS', 'NDPI', 'TIF', 'TIFF', 'MRXS', 'SCN', 'VSI', 'BIF'}


def _resolve_b_number_exact(b_str: str, db: Session):
    """
    Resolve a B-number to (patient, submission) pairs using exact era-aware matching.

    Era 1 (< Sept 2011):   submission ID = B{year}.{num}  — exact match
    Era 2 (Sept 2011-2017): b_case = probe ID = B{year}.{num} — match probe exactly
    Era 3 (>= Sept 2017):  submission ID = B{year}.{num}/{probes} — match with trailing /
    """
    m = B_PATTERN.match(b_str.strip())
    if not m:
        return []

    year      = int(m.group(1))
    num_part  = m.group(2)
    b_exact   = f"B{year}.{num_part}"

    results = []
    seen_sub_ids = set()

    def _add(patient, sub):
        if sub.id not in seen_sub_ids:
            seen_sub_ids.add(sub.id)
            results.append((patient, sub))

    def _via_submission_exact():
        # Era 1: submission ID is exactly B{year}.{num}
        subs = db.query(Submission).filter(
            Submission.lis_submission_id == b_exact
        ).all()
        for sub in subs:
            patient = db.get(Patient, sub.patient_id)
            if patient:
                _add(patient, sub)

    def _via_probe_exact():
        # Era 2: b_case IS the probe ID, exact match
        probes = db.query(Probe).filter(
            Probe.lis_probe_id == b_exact
        ).all()
        for probe in probes:
            sub = db.get(Submission, probe.submission_id)
            if sub:
                patient = db.get(Patient, sub.patient_id)
                if patient:
                    _add(patient, sub)

    def _via_submission_slash():
        # Era 3: submission ID starts with B{year}.{num}/
        subs = db.query(Submission).filter(
            Submission.lis_submission_id.like(f"{b_exact}/%")
        ).all()
        for sub in subs:
            patient = db.get(Patient, sub.patient_id)
            if patient:
                _add(patient, sub)

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

    for strategy in strategies:
        if strategy == 'submission_exact': _via_submission_exact()
        elif strategy == 'probe_exact':    _via_probe_exact()
        elif strategy == 'submission_slash': _via_submission_slash()

    return results


# ─── Shared formatting ────────────────────────────────────────────────────────

def _get_reports_for_submission(db: Session, submission_id: int) -> dict:
    reports = db.query(Report).filter(Report.submission_id == submission_id).all()
    result = {'macro': None, 'microscopy': None}
    for r in reports:
        if r.report_type in result:
            result[r.report_type] = r.report_text
    return result


def _get_stains_for_block(db: Session, block_id: int) -> str:
    scans = (
        db.query(Scan)
        .join(Stain, Scan.stain_id == Stain.id)
        .filter(Scan.block_id == block_id)
        .all()
    )
    names = sorted(set(sc.stain.stain_name for sc in scans if sc.stain))
    return ', '.join(names) if names else ''


def _format_results(rows, return_level: str, db: Session, f=None) -> list[dict]:
    """Format query rows (block, probe, sub, patient) into result dicts."""
    seen = set()
    results = []

    for block, probe, sub, patient in rows:
        if return_level == "patient":
            key = patient.id
            if key not in seen:
                seen.add(key)
                results.append({
                    "patient_code":  patient.patient_code,
                    "date_of_birth": str(patient.date_of_birth) if patient.date_of_birth else None,
                    "sex":           patient.sex,
                })

        elif return_level == "submission":
            key = sub.id
            if key not in seen:
                seen.add(key)
                reps = _get_reports_for_submission(db, sub.id)
                results.append({
                    "patient_code":      patient.patient_code,
                    "lis_submission_id": sub.lis_submission_id,
                    "report_date":       str(sub.report_date) if sub.report_date else None,
                    "malignancy_flag":   sub.malignancy_flag,
                    "consent":           sub.consent,
                    "report_macro":      reps['macro'],
                    "report_microscopy": reps['microscopy'],
                })

        elif return_level == "probe":
            key = probe.id
            if key not in seen:
                seen.add(key)
                results.append({
                    "patient_code":       patient.patient_code,
                    "lis_submission_id":  sub.lis_submission_id,
                    "lis_probe_id":       probe.lis_probe_id,
                    "snomed_topo_code":   probe.snomed_topo_code,
                    "topo_description":   probe.topo_description,
                    "submission_type":    probe.submission_type,
                    "location_additional": probe.location_additional,
                })

        elif return_level == "block":
            key = block.id
            if key not in seen:
                seen.add(key)
                stains = _get_stains_for_block(db, block.id)
                results.append({
                    "patient_code":      patient.patient_code,
                    "lis_submission_id": sub.lis_submission_id,
                    "lis_probe_id":      probe.lis_probe_id,
                    "snomed_topo_code":  probe.snomed_topo_code,
                    "topo_description":  probe.topo_description,
                    "submission_type":   probe.submission_type,
                    "block_label":       block.block_label,
                    "block_info":        block.block_info,
                    "stains":            stains,
                    "scan_count":        len(block.scans) if hasattr(block, 'scans') else 0,
                })

        elif return_level == "scan":
            # REPLACED THIS SECTION:
            scan_query = db.query(Scan).filter(Scan.block_id == block.id)
            
            # Re-apply scan-specific filters if they exist
            if f:
                if f.stain_names or f.stain_categories:
                    scan_query = scan_query.join(Stain, Scan.stain_id == Stain.id)
                    if f.stain_names:
                        scan_query = scan_query.filter(Stain.stain_name.in_(f.stain_names))
                    if f.stain_categories:
                        scan_query = scan_query.filter(Stain.stain_category.in_(f.stain_categories))
                if f.file_formats:
                    scan_query = scan_query.filter(Scan.file_format.in_([x.upper() for x in f.file_formats]))
                if f.magnification_min:
                    scan_query = scan_query.filter(Scan.magnification >= f.magnification_min)
                if f.magnification_max:
                    scan_query = scan_query.filter(Scan.magnification <= f.magnification_max)
                    
            scans = scan_query.all()
            for sc in scans:
                key = sc.id
                if key not in seen:
                    seen.add(key)
                    stain_name     = sc.stain.stain_name     if sc.stain else None
                    stain_category = sc.stain.stain_category if sc.stain else None
                    fmt            = (sc.file_format or '').upper()
                    results.append({
                        "patient_code":      patient.patient_code,
                        "lis_submission_id": sub.lis_submission_id,
                        "lis_probe_id":      probe.lis_probe_id,
                        "snomed_topo_code":  probe.snomed_topo_code,
                        "topo_description":  probe.topo_description,
                        "submission_type":   probe.submission_type,
                        "block_label":       block.block_label,
                        "block_info":        block.block_info,
                        "stain_name":        stain_name,
                        "stain_category":    stain_category,
                        "file_path":         sc.file_path,
                        "scan_id":           sc.id,
                        "viewer_available":  fmt in VIEWER_FORMATS,
                    })

    return results


def _apply_filters(db: Session, f: CohortFilter):
    q = (
        db.query(Block, Probe, Submission, Patient)
        .join(Probe,      Block.probe_id       == Probe.id)
        .join(Submission, Probe.submission_id  == Submission.id)
        .join(Patient,    Submission.patient_id == Patient.id)
    )
    # if f.topo_description_search:
    #     q = q.filter(Probe.topo_description.ilike(f.topo_description_search))
    if f.topo_description_search:
        if isinstance(f.topo_description_search, list):
            # Matches any of the specific descriptions selected in the UI
            q = q.filter(Probe.topo_description.in_(f.topo_description_search))
        else:
            # Traditional partial search fallback
            q = q.filter(Probe.topo_description.ilike(f"%{f.topo_description_search}%"))
    if f.snomed_topo_codes:
        q = q.filter(Probe.snomed_topo_code.in_(f.snomed_topo_codes))
    if f.submission_types:
        q = q.filter(Probe.submission_type.in_(f.submission_types))
    if f.malignancy_flag is not None:
        q = q.filter(Submission.malignancy_flag == f.malignancy_flag)
    if f.submission_date_from:
        q = q.filter(Submission.report_date >= f.submission_date_from)
    if f.submission_date_to:
        q = q.filter(Submission.report_date <= f.submission_date_to)
    if f.block_info_search:
        q = q.filter(Block.block_info.ilike(f"%{f.block_info_search}%"))
    if f.has_scan is True:
        q = q.filter(exists().where(Scan.block_id == Block.id))
    elif f.has_scan is False:
        q = q.filter(~exists().where(Scan.block_id == Block.id))
    if f.stain_names or f.stain_categories or f.file_formats or f.magnification_min or f.magnification_max:
        scan_q = db.query(Scan.block_id)
        if f.stain_names or f.stain_categories:
            scan_q = scan_q.join(Stain, Scan.stain_id == Stain.id)
            if f.stain_names:
                scan_q = scan_q.filter(Stain.stain_name.in_(f.stain_names))
            if f.stain_categories:
                scan_q = scan_q.filter(Stain.stain_category.in_(f.stain_categories))
        if f.file_formats:
            scan_q = scan_q.filter(Scan.file_format.in_([x.upper() for x in f.file_formats]))
        if f.magnification_min:
            scan_q = scan_q.filter(Scan.magnification >= f.magnification_min)
        if f.magnification_max:
            scan_q = scan_q.filter(Scan.magnification <= f.magnification_max)
        q = q.filter(Block.id.in_(scan_q))
    return q


# ─── List query request schema ────────────────────────────────────────────────

class ListQueryRequest(BaseModel):
    id_type:      Literal["patient_code", "b_number"]
    b_scope:      Literal["all", "matched"] = "all"
    ids:          list[str]
    return_level: str = "scan"


# ─── Shared helper: run whichever query mode is encoded in a CohortFilter ─────

def _get_results_for_cohort(f: "CohortFilter", db: Session) -> tuple[list[dict], list[str]]:
    """
    Execute a saved cohort filter and return (results, not_found).
    Handles both filter-mode and list-mode cohorts transparently.
    not_found is only populated for list-mode queries.
    """
    if f.is_list_query and f.ids:
        ids = list(set(i.strip() for i in f.ids if i.strip()))
        all_rows: list = []
        seen_block_ids: set = set()
        not_found: list[str] = []

        for id_str in ids:
            if f.id_type == "patient_code":
                patient = db.query(Patient).filter(
                    Patient.patient_code == id_str
                ).first()
                if not patient:
                    not_found.append(id_str)
                    continue
                patients_subs = [(patient, sub) for sub in patient.submissions]
            else:  # b_number
                matched = _resolve_b_number_exact(id_str, db)
                if not matched:
                    not_found.append(id_str)
                    continue
                if f.b_scope == "all":
                    patients_subs = []
                    seen_patient_ids: set = set()
                    for patient, _sub in matched:
                        if patient.id not in seen_patient_ids:
                            seen_patient_ids.add(patient.id)
                            for sub in patient.submissions:
                                patients_subs.append((patient, sub))
                else:
                    patients_subs = matched

            for patient, sub in patients_subs:
                for probe in sub.probes:
                    for block in probe.blocks:
                        if block.id not in seen_block_ids:
                            seen_block_ids.add(block.id)
                            all_rows.append((block, probe, sub, patient))

        return _format_results(all_rows, f.return_level, db), not_found

    # Filter mode
    rows = _apply_filters(db, f).all()
    return _format_results(rows, f.return_level, db, f), []


# ─── Endpoints ────────────────────────────────────────────────────────────────

@router.post("/query")
def query_cohort(
    f: CohortFilter,
    db: Session = Depends(get_db),
    _: User     = Depends(get_current_active_user),
):
    rows    = _apply_filters(db, f).all()
    results = _format_results(rows, f.return_level, db, f)
    return {"return_level": f.return_level, "count": len(results), "results": results}


@router.post("/query_list")
def query_cohort_list(
    req: ListQueryRequest,
    db: Session = Depends(get_db),
    _: User     = Depends(get_current_active_user),
):
    """
    Query by a list of patient codes or B-numbers.
    Returns results in the same format as /cohorts/query.
    """
    ids = list(set(i.strip() for i in req.ids if i.strip()))
    if not ids:
        return {"return_level": req.return_level, "count": 0, "results": []}

    # Collect (block, probe, sub, patient) rows
    all_rows = []
    seen_block_ids = set()
    not_found = []

    for id_str in ids:
        if req.id_type == "patient_code":
            patient = db.query(Patient).filter(
                Patient.patient_code == id_str
            ).first()
            if not patient:
                not_found.append(id_str)
                continue
            patients_subs = [(patient, sub) for sub in patient.submissions]

        else:  # b_number
            matched = _resolve_b_number_exact(id_str, db)
            if not matched:
                not_found.append(id_str)
                continue
            if req.b_scope == "all":
                # All submissions for the matched patient(s)
                patients_subs = []
                seen_patient_ids = set()
                for patient, _sub in matched:
                    if patient.id not in seen_patient_ids:
                        seen_patient_ids.add(patient.id)
                        for sub in patient.submissions:
                            patients_subs.append((patient, sub))
            else:
                # Only the matched submission(s)
                patients_subs = matched

        # For each (patient, submission), get all blocks
        for patient, sub in patients_subs:
            for probe in sub.probes:
                for block in probe.blocks:
                    if block.id not in seen_block_ids:
                        seen_block_ids.add(block.id)
                        all_rows.append((block, probe, sub, patient))

    results = _format_results(all_rows, req.return_level, db)
    response = {
        "return_level": req.return_level,
        "count":        len(results),
        "results":      results,
    }
    if not_found:
        response["not_found"] = not_found
    return response


@router.get("", response_model=list[CohortResponse])
def list_cohorts(
    db: Session  = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    return (
        db.query(Cohort)
        .filter(Cohort.user_id == current_user.id)
        .order_by(Cohort.created_at.desc())
        .all()
    )


@router.post("", response_model=CohortResponse, status_code=201)
def save_cohort(
    req: CohortSave,
    db: Session  = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    results, _ = _get_results_for_cohort(req.filter_json, db)
    cohort  = Cohort(
        user_id=current_user.id,
        name=req.name,
        description=req.description,
        filter_json=req.filter_json.model_dump(),
        result_count=len(results),
        last_run_at=datetime.now(timezone.utc),
    )
    db.add(cohort)
    db.commit()
    db.refresh(cohort)
    return cohort


@router.get("/{cohort_id}/export")
def export_cohort(
    cohort_id: int,
    fmt: str       = Query("csv", pattern="^(csv|json)$"),
    db: Session    = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    cohort = db.get(Cohort, cohort_id)
    if not cohort:
        raise HTTPException(status_code=404, detail="Cohort not found")
    if cohort.user_id != current_user.id:
        raise HTTPException(status_code=403, detail="Not your cohort")

    f       = CohortFilter(**cohort.filter_json)
    results, _ = _get_results_for_cohort(f, db)

    # Strip viewer_available from exports
    for r in results:
        r.pop("scan_id", None)
        r.pop("viewer_available", None)

    cohort.result_count = len(results)
    cohort.last_run_at  = datetime.now(timezone.utc)
    db.commit()

    if fmt == "json":
        return StreamingResponse(
            io.StringIO(json.dumps(results, indent=2, default=str)),
            media_type="application/json",
            headers={"Content-Disposition": f'attachment; filename="cohort_{cohort_id}.json"'},
        )

    if not results:
        raise HTTPException(status_code=404, detail="No results to export")

    buf = io.StringIO()
    writer = csv.DictWriter(buf, fieldnames=results[0].keys())
    writer.writeheader()
    writer.writerows(results)
    buf.seek(0)
    return StreamingResponse(
        buf,
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="cohort_{cohort_id}.csv"'},
    )

@router.delete("/{cohort_id}", status_code=204)
def delete_cohort(
    cohort_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    cohort = db.get(Cohort, cohort_id)
    if not cohort:
        raise HTTPException(status_code=404, detail="Cohort not found")
    if cohort.user_id != current_user.id:
        raise HTTPException(status_code=403, detail="Not your cohort")
    db.delete(cohort)
    db.commit()
    return None


@router.get("/{cohort_id}/results")
def get_cohort_results(
    cohort_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_active_user),
):
    cohort = db.get(Cohort, cohort_id)
    if not cohort:
        raise HTTPException(status_code=404, detail="Cohort not found")
    if cohort.user_id != current_user.id:
        raise HTTPException(status_code=403, detail="Not your cohort")
 
    f       = CohortFilter(**cohort.filter_json)
    results, not_found = _get_results_for_cohort(f, db)
 
    # Update cached count
    cohort.result_count = len(results)
    cohort.last_run_at  = datetime.now(timezone.utc)
    db.commit()
 
    response = {
        "cohort_id":    cohort_id,
        "name":         cohort.name,
        "return_level": f.return_level,
        "count":        len(results),
        "results":      results,
    }
    if not_found:
        response["not_found"] = not_found
    return response