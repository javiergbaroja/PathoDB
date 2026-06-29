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
from sqlalchemy.orm import Session, joinedload
from sqlalchemy import and_, or_, func, exists, false, select
from datetime import date as DateType
from typing import Literal, Optional

from ..database import get_db
from ..models import Patient, Submission, Probe, Block, Scan, Stain, Cohort, Report, SnomedCode, User
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
    seen = set()
    results = []
    if not rows:
        return results

    all_codes = set()
    for block, probe, sub, patient in rows:
        all_codes.update(probe.snomed_morph_codes or [])
        all_codes.update(probe.snomed_etio_codes or [])
    desc_map = dict(db.query(SnomedCode.code, SnomedCode.description)
                     .filter(SnomedCode.code.in_(all_codes)).all()) if all_codes else {}

    def _enrich(codes):
        return [{"code": c, "description": desc_map.get(c)} for c in (codes or [])]

    if not rows:
        return results

    if return_level == "scan":
        # 1. Map all blocks to their parent data
        block_map = {block.id: (block, probe, sub, patient) for block, probe, sub, patient in rows}
        
        # 2. Fetch all scans for these blocks in ONE query, eager-loading the stains
        scan_query = db.query(Scan).options(joinedload(Scan.stain)).filter(Scan.block_id.in_(block_map.keys()))
        
        # 3. Re-apply scan-specific filters if they exist
        if f:
            if getattr(f, 'stain_names', None) or getattr(f, 'stain_categories', None):
                scan_query = scan_query.join(Stain, Scan.stain_id == Stain.id)
                if getattr(f, 'stain_names', None):
                    scan_query = scan_query.filter(Stain.stain_name.in_(f.stain_names))
                if getattr(f, 'stain_categories', None):
                    scan_query = scan_query.filter(Stain.stain_category.in_(f.stain_categories))
            if getattr(f, 'file_formats', None):
                scan_query = scan_query.filter(Scan.file_format.in_([x.upper() for x in f.file_formats]))
            if getattr(f, 'magnification_min', None):
                scan_query = scan_query.filter(Scan.magnification >= f.magnification_min)
            if getattr(f, 'magnification_max', None):
                scan_query = scan_query.filter(Scan.magnification <= f.magnification_max)

        scans = scan_query.all()

        # 4. Build the dictionaries using the pre-fetched data
        for sc in scans:
            if sc.id not in seen:
                seen.add(sc.id)
                block, probe, sub, patient = block_map[sc.block_id]
                
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
                    "consent":           sub.consent,
                    "block_id":          block.id,
                    "stain_name":        stain_name,
                    "stain_category":    stain_category,
                    "file_path":         sc.file_path,
                    "scan_id":           sc.id,
                    "viewer_available":  fmt in VIEWER_FORMATS,
                })
        
        return results

    # --- Aggregation helpers for multi-probe fields ---
    def _bracket_join(values):
        """Wrap each element in braces: ['a','b'] → '{a}{b}'."""
        return ''.join(f'{{{v}}}' for v in values if v) if values else ''

    def _bracket_join_multi(lists_of_codes):
        """For each probe's code list, semicolon-join inside braces.
        [[c1,c2],[c3]] → '{c1;c2}{c3}'."""
        parts = []
        for codes in lists_of_codes:
            if codes:
                parts.append('{' + ';'.join(codes) + '}')
        return ''.join(parts)

    def _bracket_join_descriptions(lists_of_codes):
        """Same as _bracket_join_multi but uses resolved descriptions."""
        parts = []
        for codes in lists_of_codes:
            if codes:
                descs = [desc_map.get(c, c) or c for c in codes]
                parts.append('{' + ';'.join(descs) + '}')
        return ''.join(parts)

    # --- Pre-aggregate probes per submission for submission-level export ---
    sub_probes = {}  # sub.id → list of Probe objects
    sub_patients = {}  # sub.id → Patient
    patient_subs = {}  # patient.id → list of Submission objects
    for block, probe, sub, patient in rows:
        sub_probes.setdefault(sub.id, [])
        if probe.id not in {p.id for p in sub_probes[sub.id]}:
            sub_probes[sub.id].append(probe)
        sub_patients[sub.id] = patient
        patient_subs.setdefault(patient.id, set())
        patient_subs[patient.id].add(sub.id)

    # --- Standard processing for patient/submission/probe/block levels ---
    for block, probe, sub, patient in rows:
        if return_level == "patient":
            key = patient.id
            if key not in seen:
                seen.add(key)
                pat_sub_ids = patient_subs.get(patient.id, set())
                pat_submissions = [s for s in [sub] if s.id in pat_sub_ids]
                # Count from all rows for this patient
                all_patient_subs = {}
                for _, _, s, p in rows:
                    if p.id == patient.id:
                        all_patient_subs[s.id] = s
                sub_list = list(all_patient_subs.values())
                results.append({
                    "patient_code":       patient.patient_code,
                    "date_of_birth":      str(patient.date_of_birth) if patient.date_of_birth else None,
                    "sex":                patient.sex,
                    "submission_count":   len(sub_list),
                    "malignant_count":    sum(1 for s in sub_list if s.malignancy_flag is True),
                    "consent":            sub.consent,
                })

        elif return_level == "submission":
            key = sub.id
            if key not in seen:
                seen.add(key)
                reps = _get_reports_for_submission(db, sub.id)
                probes = sub_probes.get(sub.id, [])

                # Count blocks across all probes in this submission
                block_count = sum(
                    1 for _, _, s, _ in rows if s.id == sub.id
                    for _ in [1]
                )
                # Actually count unique blocks
                sub_block_ids = set()
                for b, p, s, _ in rows:
                    if s.id == sub.id:
                        sub_block_ids.add(b.id)

                results.append({
                    "patient_code":           patient.patient_code,
                    "lis_submission_id":      sub.lis_submission_id,
                    "report_date":            str(sub.report_date) if sub.report_date else None,
                    "malignancy_flag":        sub.malignancy_flag,
                    "consent":                sub.consent,
                    "probe_count":            len(probes),
                    "block_count":            len(sub_block_ids),
                    "snomed_topo_codes":      _bracket_join([p.snomed_topo_code for p in probes]),
                    "topo_descriptions":      _bracket_join([p.topo_description for p in probes]),
                    "snomed_morph_codes":     _bracket_join_multi([p.snomed_morph_codes for p in probes]),
                    "morph_descriptions":     _bracket_join_descriptions([p.snomed_morph_codes for p in probes]),
                    "snomed_etio_codes":      _bracket_join_multi([p.snomed_etio_codes for p in probes]),
                    "etio_descriptions":      _bracket_join_descriptions([p.snomed_etio_codes for p in probes]),
                    "report_macro":           reps['macro'],
                    "report_microscopy":      reps['microscopy'],
                })

        elif return_level == "probe":
            key = probe.id
            if key not in seen:
                seen.add(key)
                morph = _enrich(probe.snomed_morph_codes)
                etio = _enrich(probe.snomed_etio_codes)
                results.append({
                    "patient_code":       patient.patient_code,
                    "lis_submission_id":  sub.lis_submission_id,
                    "lis_probe_id":       probe.lis_probe_id,
                    "snomed_topo_code":   probe.snomed_topo_code,
                    "topo_description":   probe.topo_description,
                    "snomed_morph_codes": '; '.join(c['code'] for c in morph) if morph else '',
                    "morph_descriptions": '; '.join(c['description'] or c['code'] for c in morph) if morph else '',
                    "snomed_etio_codes":  '; '.join(c['code'] for c in etio) if etio else '',
                    "etio_descriptions":  '; '.join(c['description'] or c['code'] for c in etio) if etio else '',
                    "submission_type":    probe.submission_type,
                    "location_additional":probe.location_additional,
                    "malignancy_flag":    sub.malignancy_flag,
                    "consent":            sub.consent,
                })

        elif return_level == "block":
            key = block.id
            if key not in seen:
                seen.add(key)
                stains = _get_stains_for_block(db, block.id)
                morph = _enrich(probe.snomed_morph_codes)
                etio = _enrich(probe.snomed_etio_codes)
                scan_count = db.query(func.count(Scan.id)).filter(Scan.block_id == block.id).scalar()
                results.append({
                    "patient_code":      patient.patient_code,
                    "lis_submission_id": sub.lis_submission_id,
                    "lis_probe_id":      probe.lis_probe_id,
                    "snomed_topo_code":  probe.snomed_topo_code,
                    "topo_description":  probe.topo_description,
                    "snomed_morph_codes": '; '.join(c['code'] for c in morph) if morph else '',
                    "morph_descriptions": '; '.join(c['description'] or c['code'] for c in morph) if morph else '',
                    "snomed_etio_codes":  '; '.join(c['code'] for c in etio) if etio else '',
                    "etio_descriptions":  '; '.join(c['description'] or c['code'] for c in etio) if etio else '',
                    "submission_type":   probe.submission_type,
                    "block_label":       block.block_label,
                    "block_info":        block.block_info,
                    "tissue_count":      block.tissue_count,
                    "scan_count":        scan_count,
                    "consent":           sub.consent,
                    "stains":            stains,
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
    if f.snomed_morph_codes:
        q = q.filter(Probe.snomed_morph_codes.op('&&')(f.snomed_morph_codes))
    if f.morph_description_search:
        morph_code_subq = (
            select(func.array_agg(SnomedCode.code))
            .where(
                SnomedCode.category == "morphology",
                SnomedCode.description.in_(f.morph_description_search),
            )
            .scalar_subquery()
        )
        q = q.filter(Probe.snomed_morph_codes.op('&&')(morph_code_subq))
    if f.snomed_etio_codes:
        q = q.filter(Probe.snomed_etio_codes.op('&&')(f.snomed_etio_codes))
    if f.etio_description_search:
        etio_code_subq = (
            select(func.array_agg(SnomedCode.code))
            .where(
                SnomedCode.category == "etiology",
                SnomedCode.description.in_(f.etio_description_search),
            )
            .scalar_subquery()
        )
        q = q.filter(Probe.snomed_etio_codes.op('&&')(etio_code_subq))
    if f.submission_types:
        q = q.filter(Probe.submission_type.in_(f.submission_types))
    if f.malignancy_flag is not None:
        q = q.filter(Submission.malignancy_flag == f.malignancy_flag)
    if f.consent_statuses:
        consent_conds = []
        named = [s for s in f.consent_statuses if s != 'unknown']
        if named:
            consent_conds.append(Submission.consent.in_(named))
        if 'unknown' in f.consent_statuses:
            consent_conds.append(Submission.consent.is_(None))
            consent_conds.append(Submission.consent == 'unknown')
        if consent_conds:
            q = q.filter(or_(*consent_conds))
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
    # ID resolution
    id_type:      Literal["patient_code", "b_number"]
    b_scope:      Literal["all", "matched"] = "all"
    ids:          list[str]
    return_level: str = "scan"
    # Standard filters — same fields as CohortFilter, applied at SQL level
    snomed_topo_codes:       Optional[list[str]] = None
    topo_description_search: Optional[list[str]] = None
    snomed_morph_codes:      Optional[list[str]] = None
    morph_description_search:Optional[list[str]] = None
    snomed_etio_codes:       Optional[list[str]] = None
    etio_description_search: Optional[list[str]] = None
    submission_types:        Optional[list[str]] = None
    malignancy_flag:         Optional[bool] = None
    consent_statuses:        Optional[list[str]] = None
    has_scan:                Optional[bool] = None
    block_info_search:       Optional[str] = None
    stain_names:             Optional[list[str]] = None
    stain_categories:        Optional[list[str]] = None
    file_formats:            Optional[list[str]] = None
    magnification_min:       Optional[float] = None
    magnification_max:       Optional[float] = None
    submission_date_from:    Optional[DateType] = None
    submission_date_to:      Optional[DateType] = None


# ─── Scan bulk-query helper ───────────────────────────────────────────────────

def _scan_results_from_block_ids(db: Session, block_ids: set, f=None) -> list[dict]:
    """
    Given a set of block IDs, return scan-level result dicts.
    Applies optional scan-level filters (stain, file format, magnification).
    Uses raw column projection to avoid ORM memory overhead.
    """
    results = []
    seen    = set()
    chunk_size = 2000
    block_ids_list = list(block_ids)

    for i in range(0, len(block_ids_list), chunk_size):
        chunk = block_ids_list[i:i + chunk_size]

        q = (
            db.query(
                Patient.patient_code,
                Submission.lis_submission_id,
                Submission.consent,
                Probe.lis_probe_id,
                Probe.snomed_topo_code,
                Probe.topo_description,
                Probe.submission_type,
                Block.id.label("block_id"),
                Block.block_label,
                Block.block_info,
                Scan.id.label("scan_id"),
                Scan.file_path,
                Scan.file_format,
                Stain.stain_name,
                Stain.stain_category,
            )
            .select_from(Scan)
            .join(Block,      Scan.block_id        == Block.id)
            .join(Probe,      Block.probe_id        == Probe.id)
            .join(Submission, Probe.submission_id   == Submission.id)
            .join(Patient,    Submission.patient_id == Patient.id)
            .outerjoin(Stain, Scan.stain_id         == Stain.id)
            .filter(Scan.block_id.in_(chunk))
        )

        if f:
            if getattr(f, 'stain_names', None):
                q = q.filter(Stain.stain_name.in_(f.stain_names))
            if getattr(f, 'stain_categories', None):
                q = q.filter(Stain.stain_category.in_(f.stain_categories))
            if getattr(f, 'file_formats', None):
                q = q.filter(Scan.file_format.in_([x.upper() for x in f.file_formats]))
            if getattr(f, 'magnification_min', None):
                q = q.filter(Scan.magnification >= f.magnification_min)
            if getattr(f, 'magnification_max', None):
                q = q.filter(Scan.magnification <= f.magnification_max)

        for row in q.all():
            if row.scan_id not in seen:
                seen.add(row.scan_id)
                results.append({
                    "patient_code":      row.patient_code,
                    "lis_submission_id": row.lis_submission_id,
                    "consent":           row.consent,
                    "lis_probe_id":      row.lis_probe_id,
                    "snomed_topo_code":  row.snomed_topo_code,
                    "topo_description":  row.topo_description,
                    "submission_type":   row.submission_type,
                    "block_label":       row.block_label,
                    "block_info":        row.block_info,
                    "block_id":          row.block_id,
                    "stain_name":        row.stain_name,
                    "stain_category":    row.stain_category,
                    "file_path":         row.file_path,
                    "scan_id":           row.scan_id,
                    "viewer_available":  (row.file_format or '').upper() in VIEWER_FORMATS,
                })

    return results


# ─── SQL-level list query helper ──────────────────────────────────────────────

def _run_list_query(
    db:       Session,
    f:        "CohortFilter",
    ids:      list[str],
    id_type:  str,
    b_scope:  str,
) -> tuple[list[dict], list[str]]:
    """
    Resolve a list of patient codes or B-numbers to a patient/submission ID set,
    then apply all standard CohortFilter filters at the SQL level.
    Returns (results, not_found).
    """
    ids = list(set(i.strip() for i in ids if i.strip()))
    if not ids:
        return [], []

    not_found:  list[str] = []
    valid_ids:  set[int]  = set()
    id_scope = "patient"  # default

    if id_type == "patient_code":
        for id_str in ids:
            patient = db.query(Patient).filter(Patient.patient_code == id_str).first()
            if not patient:
                not_found.append(id_str)
            else:
                valid_ids.add(patient.id)

    else:  # b_number
        for id_str in ids:
            matched = _resolve_b_number_exact(id_str, db)
            if not matched:
                not_found.append(id_str)
            elif b_scope == "all":
                for patient, _ in matched:
                    valid_ids.add(patient.id)
            else:
                for _, sub in matched:
                    valid_ids.add(sub.id)
        id_scope = "patient" if b_scope == "all" else "submission"

    if not valid_ids:
        return [], not_found

    # Build standard filter query and constrain to the resolved IDs
    q = _apply_filters(db, f)
    if id_scope == "patient":
        q = q.filter(Patient.id.in_(valid_ids))
    else:
        q = q.filter(Submission.id.in_(valid_ids))

    if f.return_level == "scan":
        block_ids = {row[0] for row in q.with_entities(Block.id).all()}
        if not block_ids:
            return [], not_found
        return _scan_results_from_block_ids(db, block_ids, f), not_found

    rows = q.all()
    return _format_results(rows, f.return_level, db, f), not_found


# ─── Client-side transform mirror ─────────────────────────────────────────────

def _apply_client_transforms(results: list[dict], f: "CohortFilter") -> list[dict]:
    """
    Mirror the two-stage client pipeline stored when a cohort is saved:
      1. Dedup — one row per (block_id, stain_name) pair (re-scan removal).
      2. Exclusions — drop rows whose topography or stain was excluded by the user.

    These transforms are no-ops when the fields carry their default values, so
    live /query calls (which never set these fields) are unaffected.
    """
    # Stage 1 — dedup
    if getattr(f, 'dedup_one_per_block', False) and f.return_level == 'scan':
        seen: set = set()
        deduped = []
        for row in results:
            key = (row.get('block_id'), row.get('stain_name') or '')
            if key not in seen:
                seen.add(key)
                deduped.append(row)
        results = deduped

    # Stage 2 — exclusions
    excl_topos = set(getattr(f, 'excluded_topos', None) or [])
    excl_stains = set(getattr(f, 'excluded_stains', None) or [])
    if excl_topos:
        results = [r for r in results if r.get('topo_description') not in excl_topos]
    if excl_stains:
        results = [r for r in results if r.get('stain_name') not in excl_stains]

    return results


# ─── Shared helper: run whichever query mode is encoded in a CohortFilter ─────
def _get_results_for_cohort(f: "CohortFilter", db: Session) -> tuple[list[dict], list[str]]:
    """Execute a saved cohort filter and return (results, not_found)."""

    # ── List query path (SQL-level) ───────────────────────────────────────────
    if getattr(f, 'is_list_query', False) and getattr(f, 'ids', None):
        results, not_found = _run_list_query(
            db, f, f.ids,
            id_type = f.id_type or "patient_code",
            b_scope = getattr(f, 'b_scope', 'all'),
        )
    else:
        # ── Filter query path ─────────────────────────────────────────────────
        q = _apply_filters(db, f)

        if f.return_level == "scan":
            block_ids = {row[0] for row in q.with_entities(Block.id).all()}
            if not block_ids:
                return [], []
            results = _scan_results_from_block_ids(db, block_ids, f)
        else:
            rows = q.all()
            results = _format_results(rows, f.return_level, db, f)
        not_found = []

    return _apply_client_transforms(results, f), not_found
# ─── Endpoints ────────────────────────────────────────────────────────────────

@router.post("/query")
def query_cohort(
    f: CohortFilter,
    db: Session = Depends(get_db),
    _: User     = Depends(get_current_active_user),
):
    # Route everything through the optimized engine
    results, not_found = _get_results_for_cohort(f, db)
    
    response = {
        "return_level": f.return_level, 
        "count": len(results), 
        "results": results
    }
    if not_found:
        response["not_found"] = not_found
        
    return response


@router.post("/query_list")
def query_cohort_list(
    req: ListQueryRequest,
    db: Session = Depends(get_db),
    _: User     = Depends(get_current_active_user),
):
    """
    Query by a list of patient codes or B-numbers with optional SQL-level filters.
    All standard CohortFilter fields are applied at the database level, not post-hoc.
    """
    if not req.ids:
        return {"return_level": req.return_level, "count": 0, "results": []}

    # Build a CohortFilter from the standard filter fields in the request
    filter_fields = req.model_dump(exclude={"id_type", "b_scope", "ids"})
    f = CohortFilter(**filter_fields)

    results, not_found = _run_list_query(db, f, req.ids, req.id_type, req.b_scope)

    response = {"return_level": f.return_level, "count": len(results), "results": results}
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