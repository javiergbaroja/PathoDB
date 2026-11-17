"""
PathoDB API — Search Router
Search-as-you-type over patient codes, accession numbers (B = histology,
Z = cytology), submission IDs, probe IDs and slide filenames. Returns the
closest matches of every category, grouped patients → submissions → probes →
slides.
"""
import os
import re
from datetime import date
from fastapi import APIRouter, Depends, Query
from sqlalchemy import and_, func, not_, or_
from sqlalchemy.orm import Session, selectinload

from ..database import get_db
from ..models import Patient, Submission, Probe, Block, Scan, User
from ..auth import get_current_active_user

router = APIRouter(prefix="/search", tags=["search"])

# Accession numbers share one era-based grammar across modalities:
#   B = histology, Z = cytology. Group 1 captures the prefix so resolution
#   stays scoped to the matched modality (a 'Z' query never matches 'B' rows).
#   The year may be written in full (B2010.123) or short (B10.123); a short
#   year is expanded to every century that has a match (see _resolve_accession).
B_PATTERN = re.compile(r'^([BbZz])\.?(\d{2}|\d{4})\.(\d+)(?:/(\d+))?$')


def _is_b_number(term: str) -> bool:
    return bool(B_PATTERN.match(term.strip()))


def _resolve_accession(term: str, db: Session) -> list[dict]:
    """
    Accession lookup accepting full (B2010.123) or short (B10.123) years.

    A short year is tried as 19yy and 20yy (future years skipped).
    """
    m = B_PATTERN.match(term.strip())
    if not m:
        return []
    if len(m.group(2)) == 4:
        return _resolve_b_number(term, db)

    prefix, yy, num_part, slash_num = m.groups()
    tail = f".{num_part}" + (f"/{slash_num}" if slash_num else "")
    return [r for year in _expand_year(yy)
              for r in _resolve_b_number(f"{prefix}{year}{tail}", db)]


def _expand_year(yy: str) -> list[int]:
    """Short year → candidate full years, newest century first, never future."""
    return [c + int(yy) for c in (2000, 1900) if c + int(yy) <= date.today().year]


# ─── Prefix (search-as-you-type) matching ────────────────────────────────────
# A partially typed accession: letter, then a year as typed so far, then
# optionally a dot and any start of the number ("B02", "B200", "B2002",
# "B02.2", "B2021.300/0"). Two digits are a short year ("B02" → B2002./B1902.);
# three are a full year still being typed ("B200" → B2000–B2009).
PARTIAL_ACCESSION = re.compile(r'^([BbZz])\.?(\d{2,4})(?:\.(\S*))?$')

# Closest matches shown per category (patients / submissions / probes).
PREFIX_LIMIT = 5


def _like_prefix(prefix: str) -> str:
    """LIKE pattern matching `prefix` literally ('_' and '%' escaped)."""
    return prefix.replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_') + '%'


def _accession_prefixes(term: str) -> list[str]:
    """ID prefixes for a partial accession; a short year yields one per century."""
    m = PARTIAL_ACCESSION.match(term)
    if not m:
        return []
    letter, year, rest = m.group(1).upper(), m.group(2), m.group(3)
    if len(year) == 3:
        # Half-typed full year: only valid before the dot.
        return [f"{letter}{year}"] if rest is None else []
    years = [int(year)] if len(year) == 4 else _expand_year(year)
    return [f"{letter}{y}.{rest or ''}" for y in years]


def _patient_result(patient) -> dict:
    return {
        "type":         "patient",
        "label":        patient.patient_code,
        "sub_label":    f"{patient.sex or '?'} · {patient.date_of_birth or 'DOB unknown'}",
        "patient_id":   patient.id,
        "patient_code": patient.patient_code,
        "url":          f"/patients/{patient.id}",
    }


def _submission_result(sub, patient) -> dict:
    return {
        "type":          "submission",
        "label":         sub.lis_submission_id,
        "sub_label":     f"Report: {sub.report_date or '—'}" + (" · Malignant" if sub.malignancy_flag else ""),
        "patient_id":    sub.patient_id,
        "patient_code":  patient.patient_code if patient else None,
        "url":           f"/patients/{sub.patient_id}",
    }


def _probe_result(probe, sub, patient) -> dict:
    # Before 2011 a probe ID is only a numeral within its submission ("I",
    # "II"), so it is shown qualified by the submission ID.
    label = probe.lis_probe_id
    if not PARTIAL_ACCESSION.match(label or ""):
        label = f"{sub.lis_submission_id} · {label}"
    return {
        "type":         "probe",
        "label":        label,
        "sub_label":    probe.topo_description or probe.snomed_topo_code or "Unknown site",
        "patient_id":   sub.patient_id,
        "patient_code": patient.patient_code if patient else None,
        "probe_id":     probe.id,
        "url":          f"/patients/{sub.patient_id}",
    }


def _closest(query, column, prefixes: list[str]):
    """Rows whose `column` starts with any prefix, shortest (closest) first."""
    return (
        query.filter(or_(*(column.like(_like_prefix(p), escape='\\') for p in prefixes)))
        .order_by(func.length(column), column)
        .limit(PREFIX_LIMIT)
        .all()
    )


def _resolve_prefixes(term: str, db: Session) -> list[dict]:
    """
    Closest prefix matches per category. Patient codes match the term as typed;
    submission and probe IDs only once it reads as a partial accession, so a
    bare "B2" never ranks a million IDs.
    """
    results = [_patient_result(p) for p in _closest(db.query(Patient), Patient.patient_code, [term])]

    prefixes = _accession_prefixes(term)
    if not prefixes:
        return results

    # selectinload, not joinedload: a join inside the sorted LIMIT query makes
    # Postgres sort the joined rows (5x slower on broad prefixes like "B200").
    subs = _closest(
        db.query(Submission).options(selectinload(Submission.patient)),
        Submission.lis_submission_id, prefixes,
    )
    results += [_submission_result(sub, sub.patient) for sub in subs]

    # Probes whose own ID matches (2011 onwards), plus the probes of the matched
    # submissions — the only way to reach pre-2011 probes, whose IDs are numerals.
    probe_opts = selectinload(Probe.submission).selectinload(Submission.patient)
    probes = _closest(db.query(Probe).options(probe_opts), Probe.lis_probe_id, prefixes)
    if subs:
        probes += (
            db.query(Probe).options(probe_opts)
            .filter(Probe.submission_id.in_([sub.id for sub in subs]))
            .all()
        )
    probe_results = {}
    for probe in probes:
        probe_results.setdefault(probe.id, _probe_result(probe, probe.submission, probe.submission.patient))
    # Closest owning ID first; probes of one submission keep their stored order
    # (I, II, III, … rather than by label length).
    by_closeness = lambda r: (len(r["label"].split(" · ")[0]), r["label"].split(" · ")[0], r["probe_id"])
    results += sorted(probe_results.values(), key=by_closeness)[:PREFIX_LIMIT]
    return results


def _resolve_b_number(term: str, db: Session) -> list[dict]:
    """Exact era-aware accession-number resolution (B/Z, full year) → list of result dicts."""
    m = B_PATTERN.match(term.strip())
    if not m or len(m.group(2)) != 4:
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
            results.append(_probe_result(probe, sub, patient))
        else:
            results.append(_submission_result(sub, patient))

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
    regexp and match the remaining basename case-insensitively. Basenames that
    start with the term rank first (an exact match sorts first among them), then
    any substring. Each hit carries the owning block_id so the frontend can
    deep-link into the patient hierarchy and open that block's scan panel.
    """
    # Both expressions must stay identical to their indexes in db/schema.sql:
    # idx_scans_basename_trgm (substring) and idx_scans_basename_prefix (prefix,
    # read in index order so broad terms like "b2" stop after a few rows).
    base_expr   = func.regexp_replace(Scan.file_path, r'^.*/', '')
    base_prefix = func.lower(base_expr).collate("C")
    tl          = term.lower()
    # Filenames are full of '_' and may contain '%' — both are LIKE wildcards,
    # so escape them to keep the match literal.
    esc = tl.replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_')
    is_prefix = base_prefix.like(f"{esc}%", escape='\\')

    # The same basename can appear at several storage paths for one block
    # (duplicate copies). Over-fetch so post-dedup we can still fill `limit`.
    # Relations are selectin-loaded after the LIMIT: joining them into the
    # sorted query made Postgres sort the joined rows (slow on broad terms).
    # Scans missing part of the hierarchy are skipped in _scan_results.
    def fetch(match, order):
        return (
            db.query(Scan)
            .options(
                selectinload(Scan.stain),
                selectinload(Scan.block).selectinload(Block.probe)
                    .selectinload(Probe.submission).selectinload(Submission.patient),
            )
            .filter(Scan.block_id.isnot(None), match)
            .order_by(order)
            .limit(limit * 5)
            .all()
        )

    seen    = set()
    results = _scan_results(fetch(is_prefix, base_prefix), seen, limit)
    if len(results) < limit:
        substring = fetch(and_(base_expr.ilike(f"%{esc}%", escape='\\'), not_(is_prefix)), base_expr)
        results += _scan_results(substring, seen, limit - len(results))
    return results


def _scan_results(scans, seen: set, limit: int) -> list[dict]:
    """Scan rows → result dicts, collapsing duplicate copies (shared `seen`)."""
    results = []
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


# Dropdown order: results are grouped by category in this sequence.
CATEGORY_ORDER = {"patient": 0, "submission": 1, "probe": 2, "scan": 3}


@router.get("")
def universal_search(
    q:  str     = Query(..., min_length=2),
    db: Session = Depends(get_db),
    _:  User    = Depends(get_current_active_user),
):
    """
    Searches every category and returns the closest matches grouped as
    patients → submissions → probes → slides: exact hits first (accession
    numbers resolved era-aware), then prefix matches, then slides by filename
    (basename substring).
    """
    term    = q.strip()
    results = []

    # ── Exact hits ────────────────────────────────────────────────────────────
    if _is_b_number(term):
        results.extend(_resolve_accession(term, db))

    patient = db.query(Patient).filter(Patient.patient_code == term).first()
    if patient:
        results.append(_patient_result(patient))

    sub = db.query(Submission).filter(Submission.lis_submission_id == term).first()
    if sub:
        results.append(_submission_result(sub, db.get(Patient, sub.patient_id)))

    probe = db.query(Probe).filter(Probe.lis_probe_id == term).first()
    if probe:
        sub = db.get(Submission, probe.submission_id)
        if sub:
            results.append(_probe_result(probe, sub, db.get(Patient, sub.patient_id)))

    # ── Closest prefix matches, then slides by filename ───────────────────────
    results.extend(_resolve_prefixes(term, db))
    results.extend(_resolve_filenames(term, db))

    # Exact and prefix lookups overlap; keep the first (exact) occurrence.
    unique, seen = [], set()
    for r in results:
        key = (r["type"], r.get("probe_id") or r.get("scan_id") or r["label"])
        if key not in seen:
            seen.add(key)
            unique.append(r)

    # A short year (B10.123) matching in both centuries has no obvious default:
    # flag it so the UI refuses to auto-open the first hit on Enter.
    m = PARTIAL_ACCESSION.match(term)
    if m and len(m.group(2)) == 2:
        years = {r["label"][1:5] for r in unique if r["type"] in ("submission", "probe")}
        if len(years) > 1:
            for r in unique:
                r["ambiguous"] = True

    # Stable sort keeps each category's internal ranking (exact, then closest).
    return sorted(unique, key=lambda r: CATEGORY_ORDER.get(r["type"], len(CATEGORY_ORDER)))
