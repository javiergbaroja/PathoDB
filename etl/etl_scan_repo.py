#!/usr/bin/env python3
"""
register_slides.py — Bulk-register non-standard slides from a research Excel file.

Usage:
    python register_slides.py --excel /path/to/slides.xlsx [--dry-run] [--verbose]

Requirements:
    pip install pandas openpyxl psycopg2-binary python-dotenv

Environment:
    DATABASE_URL must be set (or a .env file present), e.g.:
    DATABASE_URL=postgresql://user:pass@localhost:15432/pathodb
"""

import argparse
import csv
import json
import os
import re
import sys
from datetime import datetime
from pathlib import Path

import pandas as pd
import psycopg2
import psycopg2.extras
from dotenv import load_dotenv

# ── Constants ────────────────────────────────────────────────────────────────

STAIN_NAME   = "H&E"          # all slides in this dataset
STAIN_HE_ALIASES = {"HE", "H&E", "H+E", "Haematoxylin & Eosin", "Hematoxylin & Eosin"}

ERA_1_END_YEAR = 2011          # exclusive upper bound for Era 1
ERA_2_END_YEAR = 2017          # exclusive upper bound for Era 2

B_YEAR_RE = re.compile(r'[Bb](\d{4})\.')

# Slide extensions we expect. A B-number filename like "B2017.69594_5_A" has a
# dot in it, so Path.suffix alone would invent a format of ".69594_5_A".
SLIDE_EXTENSIONS = {"mrxs", "ndpi", "svs", "tif", "tiff", "czi", "scn", "bif", "vms", "vmu"}

# Folders that have moved since the sheet was written. Applied to the Folder
# column before the path is built.
PATH_REMAP = {
    "/storage/research/pathology_tru/WSIs/bern_cohort_clean":
        "/storage/research/igmp_dp_research_dataset_archive/bern_cohort_clean",
}

# The LIS sometimes stores a probe the sheet calls "I" as arabic "1" (and vice
# versa). Only used as a fallback after an exact lis_probe_id match fails, and
# only when it resolves to exactly one probe — see resolve_probe_in_submission.
ROMAN_ARABIC = {
    "I": "1", "II": "2", "III": "3", "IV": "4", "V": "5",
    "VI": "6", "VII": "7", "VIII": "8", "IX": "9", "X": "10",
}
ARABIC_ROMAN = {v: k for k, v in ROMAN_ARABIC.items()}

# Blocks this run had to create because the sheet references a block the LIS
# import never produced. Written out by write_summary().
BLOCKS_CREATED: list[dict] = []
# block_id -> its BLOCKS_CREATED entry, so main() can both flag the scan that
# triggered the creation and backfill the submission/probe labels that
# get_or_create_block has no visibility into.
BLOCKS_CREATED_BY_ID: dict[int, dict] = {}
# Stains created on the fly (should normally stay empty — H&E already exists).
STAINS_CREATED: list[dict] = []
# Rows resolved only via the roman/arabic probe alias. Not a write, but it is a
# judgement call the summary should expose for review.
PROBE_FALLBACKS: list[dict] = []
# Scan rows actually inserted.
SCANS_REGISTERED: list[dict] = []


# ── Helpers ──────────────────────────────────────────────────────────────────

def parse_year(einsendung: str) -> int | None:
    """Extract the 4-digit year from a B-number Einsendung string."""
    m = B_YEAR_RE.search(str(einsendung))
    return int(m.group(1)) if m else None


def build_file_path(folder: str, filename: str) -> str | None:
    """
    Combine folder + filename into a normalised full path.
    Returns None if either side is missing — a blank Folder cell would
    otherwise yield a bogus relative path like 'nan/slide.mrxs'.
    """
    folder, filename = str(folder).strip(), str(filename).strip()
    if folder in ("", "nan", "None") or filename in ("", "nan", "None"):
        return None
    folder = folder.rstrip("/")
    for old, new in PATH_REMAP.items():
        if folder == old or folder.startswith(old + "/"):
            folder = new + folder[len(old):]
            break
    return str(Path(folder) / filename)


def slide_format(filename: str) -> str | None:
    """
    Return the upper-cased slide extension, or None when the filename carries no
    recognised one — B-number filenames contain dots, so Path.suffix on its own
    happily returns junk like '.69594_5_A'.
    """
    ext = Path(filename).suffix.lstrip(".").lower()
    return ext.upper() if ext in SLIDE_EXTENSIONS else None


def clean_probe(raw: str | float) -> str | None:
    """Return stripped probe string, or None if empty/NaN."""
    if pd.isna(raw) or str(raw).strip() == "":
        return None
    return str(raw).strip()


def resolve_probe_in_submission(cur, sub_id: int, probe_raw: str) -> int | None:
    """
    Return the probe.id for probe_raw within sub_id, falling back to the
    roman/arabic equivalent of the label when the exact match misses.
    """
    cur.execute(
        "SELECT id FROM probes WHERE submission_id = %s AND lis_probe_id = %s",
        (sub_id, probe_raw),
    )
    probe = cur.fetchone()
    if probe:
        return probe["id"]

    alt = ROMAN_ARABIC.get(probe_raw.upper()) or ARABIC_ROMAN.get(probe_raw)
    if not alt:
        return None
    cur.execute(
        "SELECT id FROM probes WHERE submission_id = %s AND lis_probe_id = %s",
        (sub_id, alt),
    )
    probe = cur.fetchone()
    if not probe:
        return None
    PROBE_FALLBACKS.append(
        {"submission_id": sub_id, "probe_id": probe["id"], "sheet_probe": probe_raw, "db_probe": alt}
    )
    return probe["id"]


def get_or_create_stain(cur, stain_name: str) -> int:
    """
    Return the stain.id for stain_name, trying aliases if needed.
    Creates a new stain with needs_review=TRUE if not found.
    """
    cur.execute("SELECT id FROM stains WHERE stain_name = %s", (stain_name,))
    row = cur.fetchone()
    if row: return row["id"]

    cur.execute("SELECT id FROM stains WHERE %s = ANY(aliases)", (stain_name,))
    row = cur.fetchone()
    if row: return row["id"]

    if stain_name.upper().replace(" ", "") in {a.upper().replace(" ", "") for a in STAIN_HE_ALIASES}:
        cur.execute("SELECT id FROM stains WHERE stain_category = 'HE' ORDER BY id LIMIT 1")
        row = cur.fetchone()
        if row: return row["id"]

    cur.execute(
        """
        INSERT INTO stains (stain_name, stain_category, needs_review)
        VALUES (%s, 'HE', TRUE)
        RETURNING id
        """,
        (stain_name,),
    )
    stain_id = cur.fetchone()["id"]
    STAINS_CREATED.append({"stain_id": stain_id, "stain_name": stain_name})
    return stain_id


def get_or_create_block(cur, probe_id: int, block_label: str) -> int:
    """
    Return the block.id for block_label under probe_id.
    Creates a new block if it does not exist.
    """
    cur.execute(
        "SELECT id FROM blocks WHERE probe_id = %s AND block_label = %s",
        (probe_id, block_label),
    )
    block = cur.fetchone()
    if block:
        return block["id"]

    # If not found, create it!
    cur.execute(
        """
        INSERT INTO blocks (probe_id, block_label)
        VALUES (%s, %s)
        RETURNING id
        """,
        (probe_id, block_label),
    )
    block_id = cur.fetchone()["id"]
    entry = {"block_id": block_id, "probe_id": probe_id, "block_label": block_label,
             "einsendung": None, "sheet_probe": None}
    BLOCKS_CREATED.append(entry)
    BLOCKS_CREATED_BY_ID[block_id] = entry
    return block_id


# ── Era-aware block resolution ───────────────────────────────────────────────

def resolve_block_era1(cur, einsendung: str, probe_raw: str | None, block_label: str):
    # Find submission
    cur.execute(
        "SELECT id FROM submissions WHERE lis_submission_id = %s",
        (einsendung,),
    )
    sub = cur.fetchone()
    if not sub:
        return None, f"Submission not found: '{einsendung}'"
    sub_id = sub["id"]

    if probe_raw:
        # Find probe within submission
        probe_id = resolve_probe_in_submission(cur, sub_id, probe_raw)
        if probe_id is None:
            return None, f"Probe '{probe_raw}' not found in submission '{einsendung}'"
    else:
        # Probe column is empty — try to find the single probe for this submission
        cur.execute("SELECT id FROM probes WHERE submission_id = %s", (sub_id,))
        probes = cur.fetchall()
        if len(probes) == 0:
            return None, f"No probes found for submission '{einsendung}'"
        if len(probes) > 1:
            return None, f"Probe column empty but submission '{einsendung}' has {len(probes)} probes — cannot disambiguate"
        probe_id = probes[0]["id"]

    # Find or create block
    return get_or_create_block(cur, probe_id, block_label), None


def resolve_block_era2(cur, einsendung: str, probe_raw: str | None, block_label: str):
    if not probe_raw:
        return resolve_block_era1(cur, einsendung, probe_raw, block_label)

    # Resolve probe directly by its B-number
    cur.execute(
        "SELECT id, submission_id FROM probes WHERE lis_probe_id = %s",
        (probe_raw,),
    )
    probes = cur.fetchall()
    if not probes:
        return None, f"Probe '{probe_raw}' not found in database (Era 2 exact probe match)"

    if len(probes) > 1:
        sub_ids = [p["submission_id"] for p in probes]
        cur.execute(
            "SELECT id FROM submissions WHERE id = ANY(%s) AND lis_submission_id = %s",
            (sub_ids, einsendung),
        )
        sub_match = cur.fetchone()
        if sub_match:
            probe_id = next(p["id"] for p in probes if p["submission_id"] == sub_match["id"])
        else:
            probe_id = probes[0]["id"]
    else:
        probe_id = probes[0]["id"]

    # Find or create block
    return get_or_create_block(cur, probe_id, block_label), None


def resolve_block_era3(cur, einsendung: str, probe_raw: str | None, block_label: str):
    if not probe_raw:
        return None, f"Probe column is empty for Era 3 Einsendung '{einsendung}' — cannot resolve"

    # Find submission by exact match
    cur.execute(
        "SELECT id FROM submissions WHERE lis_submission_id = %s",
        (einsendung,),
    )
    sub = cur.fetchone()
    if not sub:
        return None, f"Submission not found: '{einsendung}'"
    sub_id = sub["id"]

    # Find probe within submission
    probe_id = resolve_probe_in_submission(cur, sub_id, probe_raw)
    if probe_id is None:
        return None, f"Probe '{probe_raw}' not found in submission '{einsendung}'"

    # Find or create block
    return get_or_create_block(cur, probe_id, block_label), None


def resolve_block(cur, einsendung: str, probe_raw: str | None, block_label: str, year: int):
    strategies = []
    if year < ERA_1_END_YEAR:
        strategies = ["era1"]
    elif year == ERA_1_END_YEAR:
        strategies = ["era1", "era2"]
    elif year < ERA_2_END_YEAR:
        strategies = ["era2"]
    elif year == ERA_2_END_YEAR:
        strategies = ["era2", "era3"]
    else:
        strategies = ["era3"]

    last_error = None
    for strategy in strategies:
        if strategy == "era1":
            block_id, err = resolve_block_era1(cur, einsendung, probe_raw, block_label)
        elif strategy == "era2":
            block_id, err = resolve_block_era2(cur, einsendung, probe_raw, block_label)
        else:
            block_id, err = resolve_block_era3(cur, einsendung, probe_raw, block_label)

        if block_id is not None:
            return block_id, None
        last_error = err

    return None, last_error


# ── Main ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Bulk-register non-standard slides into PathoDB")
    parser.add_argument("--excel",    required=True, help="Path to the slides Excel file")
    parser.add_argument("--dry-run",  action="store_true", help="Parse and resolve everything but do not write to DB")
    parser.add_argument("--verbose",  action="store_true", help="Print every row's outcome")
    parser.add_argument("--env-file", default=".env",      help="Path to .env file (default: .env)")
    parser.add_argument("--out-dir",  default=None,        help="Where to write the log + alterations summary (default: alongside the Excel)")
    parser.add_argument("--check-files", action=argparse.BooleanOptionalAction, default=True,
                        help="Skip rows whose slide file is not on disk (default: on)")
    args = parser.parse_args()

    load_dotenv(args.env_file)
    db_url = os.getenv("DATABASE_URL")
    if not db_url:
        print("ERROR: DATABASE_URL not set. Set it in your .env file or environment.")
        sys.exit(1)

    excel_path = Path(args.excel)
    if not excel_path.exists():
        print(f"ERROR: Excel file not found: {excel_path}")
        sys.exit(1)

    print(f"Loading Excel: {excel_path}")
    df = pd.read_excel(excel_path, dtype=str)

    df.columns = [c.strip() for c in df.columns]

    # Added 'Scanned' to required columns
    required_cols = {"Einsendung", "Probe", "Blockbezeichnung", "Filename", "Folder", "Scanned"}
    missing = required_cols - set(df.columns)
    if missing:
        print(f"ERROR: Missing required columns: {missing}")
        sys.exit(1)

    print(f"Rows to process: {len(df)}")
    if args.dry_run:
        print("DRY RUN — no changes will be written to the database.\n")

    conn = psycopg2.connect(db_url)
    conn.autocommit = False
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    registered  = 0
    skipped_dup = 0
    failed      = 0
    log_rows    = []

    for idx, row in df.iterrows():
        # --- NEW LOGIC: Only iterate over scanned rows ---
        if str(row["Scanned"]).strip() != "1":
            continue
        # -------------------------------------------------

        einsendung  = str(row["Einsendung"]).strip()
        probe_raw   = clean_probe(row.get("Probe"))
        block_label = str(row["Blockbezeichnung"]).strip()
        filename    = str(row["Filename"]).strip()
        folder      = str(row["Folder"]).strip()

        if block_label in ("", "nan", "None"):
            err = f"Blockbezeichnung is empty — refusing to create a block for '{filename}'"
            if args.verbose: print(f"  ROW {idx+2} FAIL: {err}")
            log_rows.append({"row": idx + 2, "einsendung": einsendung, "probe": probe_raw, "block": block_label, "file_path": "", "outcome": "FAIL", "detail": err})
            failed += 1
            continue

        magnification_raw = row.get("Magnification") or row.get("resolution_mpp")
        magnification = None
        if magnification_raw and str(magnification_raw).strip() not in ("", "nan", "None"):
            mag_str = str(magnification_raw).strip().rstrip("x").rstrip("X")
            try:
                magnification = float(mag_str)
            except ValueError:
                pass

        file_format = slide_format(filename)
        file_path = build_file_path(folder, filename)
        if file_path is None:
            err = f"Missing Folder/Filename (folder='{folder}', filename='{filename}')"
            if args.verbose: print(f"  ROW {idx+2} FAIL: {err}")
            log_rows.append({"row": idx + 2, "einsendung": einsendung, "probe": probe_raw, "block": block_label, "file_path": "", "outcome": "FAIL", "detail": err})
            failed += 1
            continue

        year = parse_year(einsendung)
        if year is None:
            err = f"Cannot parse year from Einsendung '{einsendung}'"
            if args.verbose: print(f"  ROW {idx+2} FAIL: {err}")
            log_rows.append({"row": idx + 2, "einsendung": einsendung, "probe": probe_raw, "block": block_label, "file_path": file_path, "outcome": "FAIL", "detail": err})
            failed += 1
            continue

        # is_file(), not exists(): an .mrxs slide sits next to a same-named data
        # directory, and the sheet sometimes points at the directory instead.
        if args.check_files and not Path(file_path).is_file():
            err = "File does not exist on disk"
            if args.verbose: print(f"  ROW {idx+2} FAIL: {err}: {file_path}")
            log_rows.append({"row": idx + 2, "einsendung": einsendung, "probe": probe_raw, "block": block_label, "file_path": file_path, "outcome": "FAIL", "detail": err})
            failed += 1
            continue

        cur.execute("SELECT id FROM scans WHERE file_path = %s", (file_path,))
        if cur.fetchone():
            if args.verbose: print(f"  ROW {idx+2} SKIP (already registered): {file_path}")
            log_rows.append({"row": idx + 2, "einsendung": einsendung, "probe": probe_raw, "block": block_label, "file_path": file_path, "outcome": "SKIP", "detail": "file_path already in database"})
            skipped_dup += 1
            continue

        block_id, err = resolve_block(cur, einsendung, probe_raw, block_label, year)
        if block_id is None:
            if args.verbose: print(f"  ROW {idx+2} FAIL: {err}")
            log_rows.append({"row": idx + 2, "einsendung": einsendung, "probe": probe_raw, "block": block_label, "file_path": file_path, "outcome": "FAIL", "detail": err})
            failed += 1
            continue

        # Did this row's block already exist, or did resolve_block have to make it?
        block_entry = BLOCKS_CREATED_BY_ID.get(block_id)
        block_created = block_entry is not None
        if block_created and block_entry["einsendung"] is None:
            block_entry["einsendung"] = einsendung
            block_entry["sheet_probe"] = probe_raw

        stain_id = get_or_create_stain(cur, STAIN_NAME)

        if args.dry_run:
            SCANS_REGISTERED.append({
                "scan_id": None, "block_id": block_id, "stain_id": stain_id,
                "file_path": file_path, "file_format": file_format,
                "magnification": magnification, "einsendung": einsendung,
                "probe": probe_raw, "block_label": block_label,
                "block_created": block_created,
            })
            if args.verbose: print(f"  ROW {idx+2} DRY OK: block_id={block_id}  {file_path}")
            log_rows.append({"row": idx + 2, "einsendung": einsendung, "probe": probe_raw, "block": block_label, "file_path": file_path, "outcome": "DRY_OK", "detail": f"block_id={block_id}" + (" (new block)" if block_created else "")})
            registered += 1
        else:
            # ON CONFLICT rather than a plain INSERT: the pre-flight SELECT above
            # can go stale if someone registers the same slide through the UI
            # while this batch runs, and a unique violation would abort the whole
            # transaction rather than just the one row.
            cur.execute(
                """
                INSERT INTO scans (block_id, stain_id, file_path, file_format, magnification)
                VALUES (%s, %s, %s, %s, %s)
                ON CONFLICT (file_path) DO NOTHING
                RETURNING id
                """,
                (block_id, stain_id, file_path, file_format, magnification),
            )
            inserted = cur.fetchone()
            if inserted is None:
                if args.verbose: print(f"  ROW {idx+2} SKIP (registered concurrently): {file_path}")
                log_rows.append({"row": idx + 2, "einsendung": einsendung, "probe": probe_raw, "block": block_label, "file_path": file_path, "outcome": "SKIP", "detail": "registered concurrently by another writer"})
                skipped_dup += 1
                continue
            SCANS_REGISTERED.append({
                "scan_id": inserted["id"], "block_id": block_id, "stain_id": stain_id,
                "file_path": file_path, "file_format": file_format,
                "magnification": magnification, "einsendung": einsendung,
                "probe": probe_raw, "block_label": block_label,
                "block_created": block_created,
            })
            if args.verbose: print(f"  ROW {idx+2} OK: block_id={block_id}  {file_path}")
            log_rows.append({"row": idx + 2, "einsendung": einsendung, "probe": probe_raw, "block": block_label, "file_path": file_path, "outcome": "OK", "detail": f"block_id={block_id}" + (" (new block)" if block_created else "")})
            registered += 1

    if args.dry_run:
        conn.rollback()
    else:
        conn.commit()

    cur.close()
    conn.close()

    total = len(df)
    print("\n" + "=" * 60)
    print(f"  Total rows      : {total}")
    print(f"  Registered      : {registered}")
    print(f"  Skipped (dup)   : {skipped_dup}")
    print(f"  Failed          : {failed}")
    print(f"  Blocks created  : {len(BLOCKS_CREATED)}")
    # Note: total will include skipped Un-scanned rows, so Registered + Dup + Failed will be <= Total
    print("=" * 60)

    stamp = f"{datetime.now():%Y%m%d_%H%M%S}"
    out_dir = Path(args.out_dir) if args.out_dir else excel_path.parent

    log_path = out_dir / f"register_slides_log_{stamp}.csv"
    with open(log_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=["row", "einsendung", "probe", "block", "file_path", "outcome", "detail"])
        writer.writeheader()
        writer.writerows(log_rows)
    print(f"\n  Log written to: {log_path}")

    summary_path = write_summary(
        out_dir, stamp, args, excel_path,
        {"total_rows": total, "registered": registered, "skipped_dup": skipped_dup, "failed": failed},
        [r for r in log_rows if r["outcome"] == "FAIL"],
    )
    print(f"  Alterations summary: {summary_path}")


def write_summary(out_dir, stamp, args, excel_path, counts, failures) -> Path:
    """
    Write a machine-readable record of every row this run touched: the scans it
    inserted, plus the blocks/stains it had to create as a side effect and the
    probe labels it matched only via the roman/arabic alias.
    """
    summary = {
        "run": {
            "timestamp": datetime.now().isoformat(timespec="seconds"),
            "excel": str(excel_path),
            "dry_run": bool(args.dry_run),
            "stain": STAIN_NAME,
        },
        "counts": {
            **counts,
            "blocks_created": len(BLOCKS_CREATED),
            "stains_created": len(STAINS_CREATED),
            "probe_alias_fallbacks": len(PROBE_FALLBACKS),
        },
        "alterations": {
            "scans_registered": SCANS_REGISTERED,
            "blocks_created": BLOCKS_CREATED,
            "stains_created": STAINS_CREATED,
        },
        "review": {
            "probe_alias_fallbacks": PROBE_FALLBACKS,
            "failures": failures,
        },
    }
    path = out_dir / f"register_slides_summary_{stamp}.json"
    with open(path, "w", encoding="utf-8") as f:
        json.dump(summary, f, indent=2, ensure_ascii=False, default=str)
    return path


if __name__ == "__main__":
    main()