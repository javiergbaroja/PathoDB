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


# ── Helpers ──────────────────────────────────────────────────────────────────

def parse_year(einsendung: str) -> int | None:
    """Extract the 4-digit year from a B-number Einsendung string."""
    m = B_YEAR_RE.search(str(einsendung))
    return int(m.group(1)) if m else None


def build_file_path(folder: str, filename: str) -> str:
    """Combine folder + filename into a normalised full path."""
    return str(Path(folder.rstrip("/")) / filename.strip())


def clean_probe(raw: str | float) -> str | None:
    """Return stripped probe string, or None if empty/NaN."""
    if pd.isna(raw) or str(raw).strip() == "":
        return None
    return str(raw).strip()


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
    return cur.fetchone()["id"]


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
    return cur.fetchone()["id"]


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
        cur.execute(
            "SELECT id FROM probes WHERE submission_id = %s AND lis_probe_id = %s",
            (sub_id, probe_raw),
        )
        probe = cur.fetchone()
        if not probe:
            return None, f"Probe '{probe_raw}' not found in submission '{einsendung}'"
        probe_id = probe["id"]
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
    cur.execute(
        "SELECT id FROM probes WHERE submission_id = %s AND lis_probe_id = %s",
        (sub_id, probe_raw),
    )
    probe = cur.fetchone()
    if not probe:
        return None, f"Probe '{probe_raw}' not found in submission '{einsendung}'"
    probe_id = probe["id"]

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

        magnification_raw = row.get("Magnification") or row.get("resolution_mpp")
        magnification = None
        if magnification_raw and str(magnification_raw).strip() not in ("", "nan", "None"):
            mag_str = str(magnification_raw).strip().rstrip("x").rstrip("X")
            try:
                magnification = float(mag_str)
            except ValueError:
                pass

        ext = Path(filename).suffix.lstrip(".").upper()
        file_format = ext if ext else None
        file_path = build_file_path(folder, filename)

        year = parse_year(einsendung)
        if year is None:
            err = f"Cannot parse year from Einsendung '{einsendung}'"
            if args.verbose: print(f"  ROW {idx+2} FAIL: {err}")
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

        stain_id = get_or_create_stain(cur, STAIN_NAME)

        if args.dry_run:
            if args.verbose: print(f"  ROW {idx+2} DRY OK: block_id={block_id}  {file_path}")
            log_rows.append({"row": idx + 2, "einsendung": einsendung, "probe": probe_raw, "block": block_label, "file_path": file_path, "outcome": "DRY_OK", "detail": f"block_id={block_id}"})
            registered += 1
        else:
            cur.execute(
                """
                INSERT INTO scans (block_id, stain_id, file_path, file_format, magnification)
                VALUES (%s, %s, %s, %s, %s)
                """,
                (block_id, stain_id, file_path, file_format, magnification),
            )
            if args.verbose: print(f"  ROW {idx+2} OK: block_id={block_id}  {file_path}")
            log_rows.append({"row": idx + 2, "einsendung": einsendung, "probe": probe_raw, "block": block_label, "file_path": file_path, "outcome": "OK", "detail": f"block_id={block_id}"})
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
    # Note: total will include skipped Un-scanned rows, so Registered + Dup + Failed will be <= Total
    print("=" * 60)

    log_path = excel_path.parent / f"register_slides_log_{datetime.now():%Y%m%d_%H%M%S}.csv"
    with open(log_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=["row", "einsendung", "probe", "block", "file_path", "outcome", "detail"])
        writer.writeheader()
        writer.writerows(log_rows)
    print(f"\n  Log written to: {log_path}")

if __name__ == "__main__":
    main()