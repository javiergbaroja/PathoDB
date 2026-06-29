#!/usr/bin/env python3
"""
fix_probe_block_mismatch.py
=============================
Supersedes fix_single_block_fallback.py — broader in scope.

The earlier script only handled the case where a scan's PROBE was
correct but its BLOCK wasn't (the "single block fallback" in
run_scans() silently used the only available block even when the
filename's parsed block letter disagreed with it). That assumed the
probe could always be trusted as ground truth. It can't: sometimes the
probe itself is wrong too (e.g. a filename like "B2010.04622IV_A.mrxs"
ending up linked under probe "I" / block "X" when it should be probe
"IV" / block "A" — a different probe entirely, not just a different
block under the same one).

This script re-parses every scan's filename from scratch and compares
BOTH the probe and the block independently against where the scan is
CURRENTLY linked — rather than trusting the current probe and only
checking the block underneath it.

A broader structural issue is also resolved here, specific to era-1
filenames: a parsed probe token should never be trusted at face value.
Two distinct problems show up in practice:
  - "Bare letter" ambiguity: a single letter "I", "V", or "X" is
    syntactically indistinguishable as a probe versus a block — both
    interpretations are valid Roman numerals AND valid single-letter
    block labels.
  - "Probe claim doesn't fit the submission": even when a probe AND a
    block both parse cleanly (e.g. "I-M"), the claimed probe might not
    reflect anything real — e.g. a submission with only one probe (the
    sentinel "1") doesn't need a probe in its filenames at all, so any
    Roman numeral some technician included anyway should be disregarded,
    not used to spin up a phantom second probe. Separately, some era-1
    filenames use a plain arabic digit instead of a Roman numeral for
    the probe position (e.g. "2-L" meaning "the 2nd probe" — should be
    read as probe "II", not literally probe "2").
None of this can be resolved by the regex alone; it requires checking
what's actually in the database for that submission. See
_disambiguate_probe_or_block() for the exact rules, and
_parse_slide_filename() in etl_worker.py for the arabic-digit capture.

Mismatch types
--------------
  - probe_mismatch:       filename's parsed probe disagrees with the
                           scan's current probe. The new block under the
                           correct probe always starts blank — metadata
                           is never carried across a probe change (see
                           _compute_relabel_carryover for why).
  - block_mismatch:       probe agrees, but the parsed block letter
                           doesn't match the current block's label. The
                           correct block under the SAME probe is
                           found-or-created, and the old block's
                           block_sequence/block_info/tissue_count are
                           carried over to it when this qualifies as a
                           pure relabel (see _compute_relabel_carryover).
  - submission_mismatch:  the filename's own B-number doesn't even match
                           the submission the scan is currently linked
                           under. NOT auto-fixed — flagged for manual
                           review.
  - ambiguous_needs_review: an era-1 probe claim couldn't be safely
                           resolved from database context alone (see
                           disambiguation rules below). NOT auto-fixed.
  - new_empty_probe:       a probe created purely from Roman-numeral
                           sequence inference (e.g. probes III and VII
                           exist, implying I, II, IV, V, VI must have
                           too) — has no scan of its own, reported
                           against whichever scan's resolution triggered
                           the inference, for traceability.

Disambiguation rules for an era-1 probe claim (see _disambiguate_probe_or_block)
---------------------------------------------------------------------------------
The "letter" below is the CANONICAL probe candidate — an arabic digit
("2") is converted to its Roman equivalent ("II") before any of this
runs, since the database stores era-1 probes as Roman numerals. Any
already-parsed block info ("original_block") is preserved as-is once a
probe interpretation is confirmed — it's never discarded in favor of a
fallback unless the filename genuinely had no block information at all.

  - Exactly one probe on the submission:
      - that probe is already named with the letter -> confirms the
        probe; original_block (if any) used as-is.
      - that probe's label is NOT a genuine Roman numeral (most often
        the "1" sentinel meaning no real probe info was ever recorded)
        -> the claim is disregarded, since a Roman/numeric token in the
        filename is almost certainly just redundant notation for "the
        one probe", not evidence of a second one: if there was real
        block info, it's used as-is under the existing probe; if there
        wasn't (a bare letter), that letter was naming the block all
        along.
      - that probe's label IS a genuine Roman numeral, just a DIFFERENT
        one than the filename claims -> NOT disregarded — this is real
        evidence of a probe that doesn't exist yet, handled as an
        ordinary probe claim by the ordinary probe_mismatch comparison.
  - More than one probe, and a probe matching the letter exists:
      - original_block already parsed -> confirms the probe; that block
        used as-is.
      - otherwise, exactly one block under it -> confirms the probe;
        that one block is reused via the existing single-block fallback.
      - otherwise, zero blocks under it -> confirms the probe; a brand
        new BLANK ("") block is created under it (this is NOT the same
        as "no information" — it's an explicit blank, never falls back
        to the scan's old block label).
      - otherwise, more than one block under it -> probe confirmed, but
        block cannot be safely guessed -> ambiguous_needs_review.
  - More than one probe, no probe matches the letter:
      - if at least one OTHER probe on the submission is ALSO named
        with a recognized Roman numeral (I-XX), and the letter's value
        is LESS than the highest such confirmed value -> the submission
        clearly uses Roman probe naming; the letter is confirmed as a
        new probe (original_block used as-is if present, otherwise a
        forced blank block), and every Roman numeral strictly below that
        highest confirmed value that doesn't already exist is backfilled
        too (new_empty_probe), since probes are numbered sequentially
        with no real gaps. Never extrapolates ABOVE the highest
        confirmed value.
      - otherwise (no Roman-numbered probe at all, the letter isn't a
        recognized Roman value even after digit conversion, or it would
        extrapolate past the highest confirmed one) -> ambiguous_needs_review.

Usage
-----
    python3 fix_probe_block_mismatch.py --mode report [--types TYPES] [--output report.csv]
    python3 fix_probe_block_mismatch.py --mode run    [--types TYPES] [--output report.csv]

    report : analyze only, write what would change. No DB writes.
    run    : analyze AND apply the fix. One transaction per scan/backfill.
    --types : comma-separated subset of {probe_mismatch, block_mismatch,
              submission_mismatch, ambiguous_needs_review, new_empty_probe}
              to include. Default: all five. submission_mismatch and
              ambiguous_needs_review are reported only regardless of this
              filter — never auto-applied in --mode run, even if you
              explicitly ask for them via --types.

Run from inside the etl/ directory (or with etl/ on PYTHONPATH) — it
imports the parser and DB connection helper straight from etl_worker.py,
deliberately, so this can never drift out of sync with how scans
actually get matched during a normal sync.
"""

import argparse
import csv
import logging
from datetime import datetime
from pathlib import Path

from etl_worker import _parse_slide_filename, get_connection

log = logging.getLogger("fix_probe_block_mismatch")
log.setLevel(logging.INFO)
if not log.handlers:
    handler = logging.StreamHandler()
    handler.setFormatter(logging.Formatter(
        "%(asctime)s  %(levelname)-8s  %(message)s", datefmt="%Y-%m-%d %H:%M:%S",
    ))
    log.addHandler(handler)

FIELDNAMES = [
    "scan_id", "file_path", "mismatch_type", "b_case",
    "old_lis_probe_id", "old_block_label",
    "re_probe", "re_block",
    "new_probe_id", "new_block_id",
    "block_info_carried_over",
    "notes",
    "status",
]

# ── Roman numeral I-XX, both directions — only single-character entries
# (I, V, X) can ever collide with a block label, since the block pattern
# in etl_worker.py only ever allows exactly one real letter.
_ROMAN_NUMERALS_1_TO_20 = [
    (1, "I"), (2, "II"), (3, "III"), (4, "IV"), (5, "V"),
    (6, "VI"), (7, "VII"), (8, "VIII"), (9, "IX"), (10, "X"),
    (11, "XI"), (12, "XII"), (13, "XIII"), (14, "XIV"), (15, "XV"),
    (16, "XVI"), (17, "XVII"), (18, "XVIII"), (19, "XIX"), (20, "XX"),
]
ROMAN_TO_INT = {r: n for n, r in _ROMAN_NUMERALS_1_TO_20}
INT_TO_ROMAN = {n: r for n, r in _ROMAN_NUMERALS_1_TO_20}

VALID_TYPES = {
    "probe_mismatch", "block_mismatch", "submission_mismatch",
    "ambiguous_needs_review", "new_empty_probe",
}
REVIEW_ONLY_TYPES = {"submission_mismatch", "ambiguous_needs_review"}


def _build_probe_context(conn, submission_ids: set) -> dict:
    """
    For each submission_id, returns:
        {"probes": {LIS_PROBE_ID: {"id": probe_id, "block_count": n}},
         "roman_values": [int, ...]}   # values among probes named I-XX

    Only fetched for submissions known to have an era-1 scan whose probe
    claim needs cross-checking — not run for every submission.
    """
    if not submission_ids:
        return {}

    cur = conn.cursor()
    cur.execute(
        """
        SELECT p.submission_id, p.id, p.lis_probe_id, COUNT(b.id)
        FROM probes p
        LEFT JOIN blocks b ON b.probe_id = p.id
        WHERE p.submission_id = ANY(%s)
        GROUP BY p.submission_id, p.id, p.lis_probe_id
        """,
        (list(submission_ids),),
    )
    rows = cur.fetchall()
    cur.close()

    context = {}
    for submission_id, probe_id, lis_probe_id, block_count in rows:
        ctx = context.setdefault(submission_id, {"probes": {}, "roman_values": []})
        label = (lis_probe_id or "").upper()
        ctx["probes"][label] = {"id": probe_id, "block_count": block_count}
        roman_val = ROMAN_TO_INT.get(label)
        if roman_val is not None:
            ctx["roman_values"].append(roman_val)

    return context


def _disambiguate_probe_or_block(ctx, letter: str, original_block):
    """
    Resolves an era-1 probe claim using only what's already in the
    database for this submission. `letter` is the CANONICAL probe
    candidate — already converted from a stray arabic digit to its Roman
    equivalent by the caller if that's what the filename actually had
    (e.g. "2" -> "II"). `original_block` is whatever block letter, if
    any, was ALREADY parsed directly from the filename — this is always
    preserved as-is once a probe interpretation is confirmed; the
    "defer to single-block fallback" / "force a blank block" behaviors
    below only ever apply when original_block is None, i.e. the filename
    gave no separate block information at all.

    See the module docstring for the full rule set. Returns
    (resolved_probe, re_block, force_block_label, review_reason, backfills) —
    same shape as before.
    """
    if ctx is None:
        ctx = {"probes": {}, "roman_values": []}

    probes = ctx["probes"]
    backfills: list[str] = []

    if len(probes) <= 1:
        existing_label = next(iter(probes.keys()), None)
        if existing_label == letter:
            return letter, original_block, None, None, backfills
        elif existing_label not in ROMAN_TO_INT:
            # The existing (only) probe isn't using genuine Roman
            # numbering at all (most commonly the "1" sentinel meaning
            # "no real probe info was ever recorded") — so a Roman or
            # numeric token in the filename is almost certainly just
            # redundant notation for "the one probe", not evidence of a
            # second one. The claim is disregarded.
            if original_block:
                return None, original_block, None, None, backfills
            else:
                return None, letter, None, None, backfills
        else:
            # The existing probe DOES carry a genuine Roman numeral, and
            # the filename claims a DIFFERENT one — that's real evidence
            # of a probe that doesn't exist yet, not redundant notation.
            # Let it flow through as an ordinary probe claim; the normal
            # probe_mismatch comparison upstream handles creating it.
            return letter, original_block, None, None, backfills

    match = probes.get(letter)
    if match is not None:
        if original_block:
            return letter, original_block, None, None, backfills
        if match["block_count"] == 1:
            return letter, None, None, None, backfills
        elif match["block_count"] == 0:
            return letter, None, "", None, backfills
        else:
            return None, None, None, (
                f"probe '{letter}' exists but has {match['block_count']} blocks — "
                f"cannot tell which one without more information"
            ), backfills

    if not ctx["roman_values"]:
        return None, None, None, (
            f"no probe named '{letter}' and no other Roman-numbered probe on this "
            f"submission to confirm the naming convention"
        ), backfills

    letter_value = ROMAN_TO_INT.get(letter)
    highest_value = max(ctx["roman_values"])

    if letter_value is None or letter_value >= highest_value:
        # letter_value can't legitimately EQUAL highest_value here (a
        # probe named `letter` would already have been found above) —
        # so reaching this means it's strictly greater (or not a
        # recognized Roman value at all): extrapolation past confirmed
        # evidence, which we don't do.
        return None, None, None, (
            f"Roman probe naming is used on this submission, but '{letter}' would "
            f"extrapolate past the highest confirmed probe — not auto-resolved"
        ), backfills

    existing_values = set(ctx["roman_values"])
    for v in range(1, highest_value):
        if v not in existing_values:
            backfills.append(INT_TO_ROMAN[v])

    if original_block:
        return letter, original_block, None, None, backfills
    else:
        return letter, None, "", None, backfills


def find_candidates(conn) -> list[dict]:
    """
    Re-parses every scan's filename and compares it against where the
    scan is CURRENTLY linked. Returns one dict per scan that disagrees in
    some way — probe, block, submission — plus ambiguous-letter review
    flags and probe-backfill side effects.
    """
    cur = conn.cursor()
    cur.execute("""
        SELECT
            s.id, s.file_path,
            b.id AS old_block_id, b.block_label AS old_block_label,
            p.id AS old_probe_id, p.lis_probe_id AS old_lis_probe_id,
            p.submission_id, sub.lis_submission_id
        FROM scans s
        JOIN blocks b ON b.id = s.block_id
        JOIN probes p ON p.id = b.probe_id
        JOIN submissions sub ON sub.id = p.submission_id
    """)
    rows = cur.fetchall()
    cur.close()

    # Pass 1: parse every filename. For era-1 scans with ANY probe claim
    # at all (not just the structurally-ambiguous bare I/V/X), the claim
    # gets cross-checked against the submission's real probe structure —
    # a stray arabic digit (e.g. "2" meant as "the 2nd probe") is first
    # converted to its Roman equivalent so it can be compared like any
    # other probe token. Collect which submissions need that extra DB
    # context, fetched once per submission, not once per scan.
    parsed_rows = []
    crosscheck_submission_ids = set()

    for (scan_id, file_path, old_block_id, old_block_label,
         old_probe_id, old_lis_probe_id, submission_id, lis_submission_id) in rows:

        filename = Path(file_path).name
        parsed = _parse_slide_filename(filename)
        if parsed is None:
            continue  # doesn't even parse — out of scope here

        b_year = parsed.get("b_year")
        re_probe = parsed.get("probe")
        re_block = parsed.get("block")
        if b_year > 2011:
            continue
        elif b_year == 2011 and old_lis_probe_id.startswith("B"):
            continue

        needs_crosscheck = bool(re_probe) and b_year is not None and b_year <= 2011
        canonical_probe = re_probe
        if needs_crosscheck and re_probe.isdigit():
            canonical_probe = INT_TO_ROMAN.get(int(re_probe), re_probe)

        parsed_rows.append((
            scan_id, file_path, old_block_id, old_block_label, old_probe_id,
            old_lis_probe_id, submission_id, lis_submission_id,
            parsed["b_case"], canonical_probe, re_block, needs_crosscheck,
        ))
        if needs_crosscheck:
            crosscheck_submission_ids.add(submission_id)

    probe_context = _build_probe_context(conn, crosscheck_submission_ids)

    candidates = []
    seen_backfills = set()  # (submission_id, lis_probe_id) — dedupe across scans

    for (scan_id, file_path, old_block_id, old_block_label, old_probe_id,
         old_lis_probe_id, submission_id, lis_submission_id,
         re_b_case, re_probe, re_block, needs_crosscheck) in parsed_rows:

        base = {
            "scan_id": scan_id, "file_path": file_path, "b_case": lis_submission_id,
            "old_block_id": old_block_id,
            "old_lis_probe_id": old_lis_probe_id, "old_block_label": old_block_label,
            "new_probe_id": "", "new_block_id": "",
        }

        # The filename's own B-number should agree with the submission
        # the scan is currently under. If it doesn't, something deeper
        # than a probe/block slip is going on.
        if re_b_case != lis_submission_id:
            candidates.append({
                **base, "re_probe": re_probe or "", "re_block": re_block or "",
                "mismatch_type": "submission_mismatch", "status": "needs_manual_review",
                "notes": f"filename's own B-number ({re_b_case}) doesn't match this submission",
            })
            continue

        force_block_label = None

        if needs_crosscheck:
            resolved_probe, disamb_block, force_block_label, review_reason, backfills = \
                _disambiguate_probe_or_block(probe_context.get(submission_id), re_probe, re_block)

            if review_reason:
                candidates.append({
                    **base, "submission_id": submission_id, "old_probe_id": old_probe_id,
                    "re_probe": re_probe or "", "re_block": re_block or "",
                    "mismatch_type": "ambiguous_needs_review", "status": "needs_manual_review",
                    "notes": review_reason,
                })
                continue

            for lis_probe_id in backfills:
                key = (submission_id, lis_probe_id)
                if key in seen_backfills:
                    continue
                seen_backfills.add(key)
                candidates.append({
                    **base, "submission_id": submission_id, "old_probe_id": old_probe_id,
                    "re_probe": lis_probe_id, "re_block": "",
                    "mismatch_type": "new_empty_probe", "status": "would_create",
                    "notes": f"inferred from Roman-numeral sequence while resolving scan {scan_id}",
                })

            re_probe = resolved_probe
            re_block = disamb_block

        probe_mismatch = bool(re_probe) and re_probe.upper() != (old_lis_probe_id or "").upper()
        block_mismatch = (force_block_label is not None) or (
            bool(re_block) and re_block.upper() != (old_block_label or "").upper()
        )

        if not probe_mismatch and not block_mismatch:
            continue  # everything already agrees

        candidates.append({
            **base,
            "submission_id": submission_id,
            "old_probe_id": old_probe_id,
            "re_probe": re_probe or "", "re_block": re_block or "",
            "_force_block_label": force_block_label,
            "mismatch_type": "probe_mismatch" if probe_mismatch else "block_mismatch",
            "status": "would_fix", "notes": "",
        })

    return candidates


def _resolve_target_block_label(c: dict) -> str:
    """
    The block label apply_fix will actually use for this candidate. A
    forced blank label (from probe disambiguation) takes priority over
    the filename's parsed letter, which itself takes priority over
    keeping the scan's current label. Shared between
    _compute_relabel_carryover and apply_fix so they can never disagree
    about what's actually about to happen.
    """
    force_label = c.get("_force_block_label")
    if force_label is not None:
        return force_label
    return c["re_block"] or c["old_block_label"]


def _compute_relabel_carryover(conn, candidates: list[dict]) -> dict:
    """
    Decides, for each old block involved in a fix, whether this is a pure
    relabeling (the old block's metadata should follow it to the new
    block) or a genuine new block being introduced (metadata should NOT
    be carried over).

    The test: does this old block lose ALL of its scans — not just the
    ones in this batch, every scan currently on it — to exactly ONE new
    (probe, label) destination? If even one scan on that block sits
    outside this batch, or its scans are splitting across more than one
    destination, the old block still has a legitimate claim to its own
    metadata, and any new block being created here starts blank.

    Mutates each block_mismatch candidate with a "_target_key" =
    (submission_id, target_lis_probe_id, target_block_label).

    Deliberately scoped to block_mismatch only — NOT probe_mismatch.
    When a scan moves to a DIFFERENT probe entirely, the old block (under
    the old, rejected probe) and the new block (under the new, correct
    probe) are not reliably the same physical entity just because the old
    one ends up empty. Carrying metadata across a probe change risks
    attributing one block's real, independently-correct data to an
    unrelated block under a different probe. Only same-probe relabeling —
    where there's no ambiguity about which probe is involved, only about
    what the block should be called — gets this treatment.

    Returns: {target_key: (block_sequence, block_info, tissue_count)}
    for every target that qualifies as a pure relabel.
    """
    fixable = [c for c in candidates if c["mismatch_type"] == "block_mismatch"]
    if not fixable:
        return {}

    for c in fixable:
        c["_target_key"] = (c["submission_id"], c["old_lis_probe_id"], _resolve_target_block_label(c))

    by_old_block: dict[int, list[dict]] = {}
    for c in fixable:
        by_old_block.setdefault(c["old_block_id"], []).append(c)

    old_block_ids = list(by_old_block.keys())
    cur = conn.cursor()
    cur.execute(
        "SELECT block_id, COUNT(*) FROM scans WHERE block_id = ANY(%s) GROUP BY block_id",
        (old_block_ids,),
    )
    total_scans_on_block = dict(cur.fetchall())

    cur.execute(
        "SELECT id, block_sequence, block_info, tissue_count FROM blocks WHERE id = ANY(%s)",
        (old_block_ids,),
    )
    old_block_meta = {row[0]: (row[1], row[2], row[3]) for row in cur.fetchall()}
    cur.close()

    carryover = {}
    for old_block_id, members in by_old_block.items():
        target_keys = {m["_target_key"] for m in members}
        if len(target_keys) != 1:
            continue  # this old block's scans are splitting across multiple destinations
        if len(members) != total_scans_on_block.get(old_block_id, 0):
            continue  # old block keeps at least one scan that isn't part of this fix
        (target_key,) = target_keys
        carryover[target_key] = old_block_meta.get(old_block_id, (None, None, None))

    return carryover


def _find_or_create(cur, table: str, match_cols: dict, insert_cols: dict) -> int:
    """Generic find-or-create: SELECT first, INSERT ON CONFLICT DO NOTHING if missing."""
    where_clause = " AND ".join(f"{c} = %s" for c in match_cols)
    cur.execute(f"SELECT id FROM {table} WHERE {where_clause}", tuple(match_cols.values()))
    row = cur.fetchone()
    if row:
        return row[0]

    cols = ", ".join(insert_cols.keys())
    placeholders = ", ".join(["%s"] * len(insert_cols))
    conflict_cols = ", ".join(match_cols.keys())
    cur.execute(
        f"INSERT INTO {table} ({cols}) VALUES ({placeholders}) "
        f"ON CONFLICT ({conflict_cols}) DO NOTHING RETURNING id",
        tuple(insert_cols.values()),
    )
    row = cur.fetchone()
    if row:
        return row[0]

    # Someone else inserted it between our SELECT and INSERT — fetch it.
    cur.execute(f"SELECT id FROM {table} WHERE {where_clause}", tuple(match_cols.values()))
    return cur.fetchone()[0]


def _find_or_create_block(cur, probe_id: int, block_label: str, carryover: dict, target_key) -> int:
    """
    Like _find_or_create, but specifically for blocks: if this is a
    genuinely NEW block (not found existing) and target_key qualifies as
    a pure relabel per `carryover`, the old block's block_sequence /
    block_info / tissue_count are carried over instead of left blank.
    An already-existing block's metadata is never touched either way.
    """
    cur.execute(
        "SELECT id FROM blocks WHERE probe_id = %s AND block_label = %s",
        (probe_id, block_label),
    )
    row = cur.fetchone()
    if row:
        return row[0]

    meta = carryover.get(target_key)
    if meta:
        block_sequence, block_info, tissue_count = meta
        cur.execute(
            "INSERT INTO blocks (probe_id, block_label, block_sequence, block_info, tissue_count) "
            "VALUES (%s, %s, %s, %s, %s) "
            "ON CONFLICT (probe_id, block_label) DO NOTHING RETURNING id",
            (probe_id, block_label, block_sequence, block_info, tissue_count),
        )
    else:
        cur.execute(
            "INSERT INTO blocks (probe_id, block_label) VALUES (%s, %s) "
            "ON CONFLICT (probe_id, block_label) DO NOTHING RETURNING id",
            (probe_id, block_label),
        )

    row = cur.fetchone()
    if row:
        return row[0]

    cur.execute(
        "SELECT id FROM blocks WHERE probe_id = %s AND block_label = %s",
        (probe_id, block_label),
    )
    return cur.fetchone()[0]


def apply_fix(conn, candidates: list[dict], carryover: dict) -> list[dict]:
    """
    Applies every actionable candidate:
      - new_empty_probe: creates the bare probe plus its one blank block.
        No scan is reassigned — this is a pure side effect, traceable via
        the triggering scan_id/file_path but not touching that scan.
      - probe_mismatch / block_mismatch: resolves or creates the correct
        probe under the same submission, then resolves or creates the
        correct block under THAT probe — carrying over the old block's
        metadata when `carryover` says this is a pure relabel — then
        repoints the scan.
      - submission_mismatch / ambiguous_needs_review: always skipped —
        never auto-applied regardless of --types.
    One transaction per scan or per backfill.
    """
    cur = conn.cursor()

    for c in candidates:
        if c["mismatch_type"] == "new_empty_probe":
            try:
                new_probe_id = _find_or_create(
                    cur, "probes",
                    match_cols={"submission_id": c["submission_id"], "lis_probe_id": c["re_probe"]},
                    insert_cols={"submission_id": c["submission_id"], "lis_probe_id": c["re_probe"]},
                )
                new_block_id = _find_or_create_block(cur, new_probe_id, "", carryover, None)
                conn.commit()
                c["new_probe_id"] = new_probe_id
                c["new_block_id"] = new_block_id
                c["status"] = "backfilled"
            except Exception as e:
                conn.rollback()
                log.error(f"Failed to backfill probe '{c['re_probe']}' for submission {c['submission_id']}: {e}")
                c["status"] = f"error: {e}"
            continue

        if c["mismatch_type"] not in ("probe_mismatch", "block_mismatch"):
            continue  # submission_mismatch / ambiguous_needs_review — left for manual review

        try:
            if c["mismatch_type"] == "probe_mismatch":
                target_probe_id = _find_or_create(
                    cur, "probes",
                    match_cols={"submission_id": c["submission_id"], "lis_probe_id": c["re_probe"]},
                    insert_cols={"submission_id": c["submission_id"], "lis_probe_id": c["re_probe"]},
                )
            else:
                target_probe_id = c["old_probe_id"]

            target_block_label = _resolve_target_block_label(c)

            target_block_id = _find_or_create_block(
                cur, target_probe_id, target_block_label, carryover, c.get("_target_key"),
            )

            cur.execute("UPDATE scans SET block_id = %s WHERE id = %s", (target_block_id, c["scan_id"]))
            conn.commit()

            c["new_probe_id"] = target_probe_id
            c["new_block_id"] = target_block_id
            c["status"] = "fixed"

        except Exception as e:
            conn.rollback()
            log.error(f"Failed to fix scan {c['scan_id']}: {e}")
            c["status"] = f"error: {e}"

    cur.close()
    return candidates


def write_report(candidates: list[dict], output_path: str):
    with open(output_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=FIELDNAMES)
        writer.writeheader()
        for c in candidates:
            writer.writerow({k: c.get(k, "") for k in FIELDNAMES})


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--mode", choices=["report", "run"], required=True)
    parser.add_argument(
        "--types", default=",".join(sorted(VALID_TYPES)),
        help="Comma-separated subset of mismatch types to include: "
             + ", ".join(sorted(VALID_TYPES)) + ". Default: all five. "
             "submission_mismatch and ambiguous_needs_review are reported only — "
             "never auto-applied in --mode run regardless of this filter.",
    )
    parser.add_argument("--output", default=None,
                         help="CSV output path (default: probe_block_mismatch_<mode>_<timestamp>.csv)")
    args = parser.parse_args()

    requested_types = {t.strip() for t in args.types.split(",") if t.strip()}
    unknown = requested_types - VALID_TYPES
    if unknown:
        parser.error(f"Unknown mismatch type(s) in --types: {', '.join(sorted(unknown))}. "
                     f"Valid values: {', '.join(sorted(VALID_TYPES))}")

    output_path = args.output or f"probe_block_mismatch_{args.mode}_{datetime.now():%Y%m%d_%H%M%S}.csv"

    conn = get_connection()
    log.info("Database connection established")

    all_candidates = find_candidates(conn)
    candidates = [c for c in all_candidates if c["mismatch_type"] in requested_types]

    counts = {t: sum(1 for c in candidates if c["mismatch_type"] == t) for t in VALID_TYPES}
    review_n = sum(counts[t] for t in REVIEW_ONLY_TYPES)
    applicable_n = len(candidates) - review_n
    excluded_n = len(all_candidates) - len(candidates)

    breakdown = ", ".join(f"{counts[t]} {t}" for t in sorted(VALID_TYPES) if counts[t])
    log.info(f"Found {len(all_candidates)} scan(s)/probe(s) disagreeing with their filename overall; "
             f"{len(candidates)} match --types ({breakdown or 'none'}) — {excluded_n} excluded by the filter")

    if not candidates:
        log.info("Nothing to do for the requested --types.")
        conn.close()
        return

    # Computed (and previewed) in BOTH modes — report mode shows exactly
    # what run mode would actually do, since it's the same calculation.
    carryover = _compute_relabel_carryover(conn, candidates)
    for c in candidates:
        c["block_info_carried_over"] = "yes" if c.get("_target_key") in carryover else ""
    if carryover:
        log.info(f"{len(carryover)} target block(s) qualify as a pure relabel — "
                 f"old block_sequence/block_info/tissue_count will be carried over")

    if args.mode == "report":
        write_report(candidates, output_path)
        log.info(f"Report written to {output_path} — no changes made. Re-run with --mode run to apply.")
    else:
        log.info(f"Applying {applicable_n} actionable item(s)"
                 + (f" ({review_n} excluded — review-only types are never auto-applied)" if review_n else "")
                 + "...")
        results = apply_fix(conn, candidates, carryover)
        write_report(results, output_path)
        fixed = sum(1 for r in results if r["status"] in ("fixed", "backfilled"))
        errors = sum(1 for r in results if r["status"].startswith("error"))
        log.info(f"Done: {fixed} applied, {errors} error(s), "
                 f"{review_n} still need manual review. Full detail in {output_path}")

    conn.close()


if __name__ == "__main__":
    main()