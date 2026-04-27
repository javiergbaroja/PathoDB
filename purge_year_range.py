#!/usr/bin/env python3
"""
PathoDB — JSON-driven submission purge
=======================================
Reads a JSON file of probe-level records, extracts the unique submission IDs,
and deletes all associated data in a single transaction.

The JSON format is a list of probe-level objects, each containing at minimum
a "lis_submission_id" field. All other fields are ignored.

Deletion order (respects FK constraints, no cascades defined in schema):
  1. scans              (leaf — no dependants)
  2. report_embeddings  (skipped if table does not exist)
  3. reports
  4. blocks
  5. probes
  6. submissions
  7. orphan patients    (skip with --keep-patients)

All deletes run inside a single transaction. Any failure rolls everything back.
Row counts for every entity are reported after the commit from the DELETE
return values — no separate COUNT queries are run beforehand.

Usage:
    # Dry-run: shows submission count only, makes no changes
    python purge_from_json.py --json path/to/probes.json --dry-run

    # Live delete with interactive confirmation
    python purge_from_json.py --json path/to/probes.json

    # Non-interactive (SLURM / scripted)
    python purge_from_json.py --json path/to/probes.json --yes

    # Keep patient records even if they become orphaned
    python purge_from_json.py --json path/to/probes.json --yes --keep-patients

Requirements:
    pip install psycopg2-binary python-dotenv
"""

import argparse
import json
import logging
import os
import sys
from pathlib import Path

import psycopg2
import psycopg2.extras
from dotenv import load_dotenv

# ─── Logging ──────────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("pathodb_purge_json")


# ─── Database ─────────────────────────────────────────────────────────────────

def get_connection(db_url: str):
    try:
        conn = psycopg2.connect(db_url)
        conn.autocommit = False
        log.info("Database connection established.")
        return conn
    except psycopg2.OperationalError as e:
        log.error(f"Cannot connect to database: {e}")
        sys.exit(1)


# ─── JSON loading ─────────────────────────────────────────────────────────────

def load_submission_ids(json_path: str) -> list[str]:
    """
    Parse the probe-level JSON and return the list of unique lis_submission_id
    values. Exits with an error if the file is missing or malformed.
    """
    path = Path(json_path)
    if not path.exists():
        log.error(f"JSON file not found: {json_path}")
        sys.exit(1)

    try:
        records = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        log.error(f"Invalid JSON: {e}")
        sys.exit(1)

    if not isinstance(records, list):
        log.error("JSON must be a list of objects.")
        sys.exit(1)

    ids = []
    missing = 0
    for i, rec in enumerate(records):
        sid = rec.get("lis_submission_id")
        if sid and str(sid).strip():
            ids.append(str(sid).strip())
        else:
            missing += 1
            log.warning(f"Record {i} has no lis_submission_id — skipped")

    unique_ids = list(dict.fromkeys(ids))   # deduplicate, preserve order

    log.info(
        f"JSON: {len(records)} records -> "
        f"{len(unique_ids)} unique submission IDs"
        + (f" ({missing} skipped for missing ID)" if missing else "")
    )
    return unique_ids


# ─── Temp table ───────────────────────────────────────────────────────────────

def create_temp_table(cur, submission_ids: list[str]) -> int:
    """
    Bulk-load the target submission IDs into a temporary table so all
    downstream deletes can join against it using the existing index on
    lis_submission_id. The temp table is dropped automatically on commit.

    Returns the number of IDs that were actually found in the database.
    """
    cur.execute("""
        CREATE TEMP TABLE _purge_submissions (
            lis_submission_id TEXT PRIMARY KEY
        ) ON COMMIT DROP
    """)
    psycopg2.extras.execute_values(
        cur,
        "INSERT INTO _purge_submissions (lis_submission_id) VALUES %s",
        [(sid,) for sid in submission_ids],
        page_size=1000,
    )
    cur.execute("""
        SELECT COUNT(*) FROM submissions s
        JOIN _purge_submissions t ON s.lis_submission_id = t.lis_submission_id
    """)
    found = cur.fetchone()[0]
    not_found = len(submission_ids) - found
    if not_found:
        log.warning(
            f"{not_found} submission ID(s) from the JSON were not found "
            f"in the database and will be skipped."
        )
    log.info(f"Submissions confirmed in database: {found:,}")
    return found


# ─── Purge ────────────────────────────────────────────────────────────────────

def purge(cur, keep_patients: bool) -> dict:
    """
    Execute all DELETEs using the _purge_submissions temp table.
    Runs within the caller's open transaction.
    Returns a dict of entity -> rows deleted (sourced from DELETE rowcounts,
    so no separate COUNT queries are needed).
    """
    deleted = {}

    target_mb = 256
    cur.execute("SHOW work_mem")
    raw = cur.fetchone()[0].strip().upper()
    if raw.endswith("GB"):
        current_mb = float(raw[:-2]) * 1024
    elif raw.endswith("MB"):
        current_mb = float(raw[:-2])
    elif raw.endswith("KB"):
        current_mb = float(raw[:-2]) / 1024
    else:
        current_mb = 0
    if current_mb < target_mb:
        cur.execute(f"SET LOCAL work_mem = '{target_mb}MB'")
        log.info(f"  work_mem raised from {raw} to {target_mb}MB for this transaction")
    else:
        log.info(f"  work_mem already at {raw} -- no change needed")

    # 1. Scans
    cur.execute("""
        DELETE FROM scans
        WHERE block_id IN (
            SELECT b.id FROM blocks b
            JOIN probes p ON b.probe_id = p.id
            JOIN submissions s ON p.submission_id = s.id
            JOIN _purge_submissions t ON s.lis_submission_id = t.lis_submission_id
        )
    """)
    deleted["scans"] = cur.rowcount
    log.info(f"  Deleted {deleted['scans']:>8,}  scans")

    # 2. Report embeddings (only if table exists)
    cur.execute("""
        SELECT EXISTS (
            SELECT 1 FROM information_schema.tables
            WHERE table_schema = 'public' AND table_name = 'report_embeddings'
        )
    """)
    if cur.fetchone()[0]:
        cur.execute("""
            DELETE FROM report_embeddings
            WHERE report_id IN (
                SELECT r.id FROM reports r
                JOIN submissions s ON r.submission_id = s.id
                JOIN _purge_submissions t ON s.lis_submission_id = t.lis_submission_id
            )
        """)
        deleted["report_embeddings"] = cur.rowcount
        log.info(f"  Deleted {deleted['report_embeddings']:>8,}  report_embeddings")

    # 3. Reports
    cur.execute("""
        DELETE FROM reports
        WHERE submission_id IN (
            SELECT s.id FROM submissions s
            JOIN _purge_submissions t ON s.lis_submission_id = t.lis_submission_id
        )
    """)
    deleted["reports"] = cur.rowcount
    log.info(f"  Deleted {deleted['reports']:>8,}  reports")

    # 4. Blocks
    cur.execute("""
        DELETE FROM blocks
        WHERE probe_id IN (
            SELECT p.id FROM probes p
            JOIN submissions s ON p.submission_id = s.id
            JOIN _purge_submissions t ON s.lis_submission_id = t.lis_submission_id
        )
    """)
    deleted["blocks"] = cur.rowcount
    log.info(f"  Deleted {deleted['blocks']:>8,}  blocks")

    # 5. Probes
    cur.execute("""
        DELETE FROM probes
        WHERE submission_id IN (
            SELECT s.id FROM submissions s
            JOIN _purge_submissions t ON s.lis_submission_id = t.lis_submission_id
        )
    """)
    deleted["probes"] = cur.rowcount
    log.info(f"  Deleted {deleted['probes']:>8,}  probes")

    # 6. Submissions
    cur.execute("""
        DELETE FROM submissions
        WHERE lis_submission_id IN (SELECT lis_submission_id FROM _purge_submissions)
    """)
    deleted["submissions"] = cur.rowcount
    log.info(f"  Deleted {deleted['submissions']:>8,}  submissions")

    # 7. Orphan patients
    if not keep_patients:
        cur.execute("""
            DELETE FROM patients
            WHERE id NOT IN (SELECT DISTINCT patient_id FROM submissions)
        """)
        deleted["patients"] = cur.rowcount
        log.info(f"  Deleted {deleted['patients']:>8,}  orphan patients")
    else:
        log.info("  Skipping orphan patient deletion (--keep-patients)")

    return deleted


# ─── Display ──────────────────────────────────────────────────────────────────

def print_summary(deleted: dict):
    w = 56
    print()
    print("=" * w)
    print("  PURGE COMPLETE")
    print("-" * w)
    for entity, count in deleted.items():
        label = entity.replace("_", " ").capitalize()
        print(f"  {label:<26}: {count:>8,}  rows deleted")
    print("=" * w)
    print()


# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="PathoDB -- delete submissions and all related data from a JSON list",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Dry-run: confirms submission count, makes no changes
  python purge_from_json.py --json probes_to_delete.json --dry-run

  # Interactive confirmation
  python purge_from_json.py --json probes_to_delete.json

  # Non-interactive (SLURM)
  python purge_from_json.py --json probes_to_delete.json --yes

  # Keep patient records intact
  python purge_from_json.py --json probes_to_delete.json --yes --keep-patients
        """,
    )
    parser.add_argument(
        "--json", required=True, metavar="FILE",
        help="Path to the probe-level JSON file",
    )
    parser.add_argument(
        "--dry-run", action="store_true",
        help="Confirm submission count only -- makes no changes to the database",
    )
    parser.add_argument(
        "--yes", action="store_true",
        help="Skip the interactive confirmation prompt",
    )
    parser.add_argument(
        "--keep-patients", action="store_true",
        help="Do not delete patients that become orphaned after the purge",
    )
    args = parser.parse_args()

    # ── Load JSON ─────────────────────────────────────────────────────────────
    submission_ids = load_submission_ids(args.json)
    if not submission_ids:
        log.error("No valid submission IDs found in the JSON file. Aborting.")
        sys.exit(1)

    # ── Connect ───────────────────────────────────────────────────────────────
    load_dotenv()
    db_url = os.getenv("DATABASE_URL")
    if not db_url:
        log.error("DATABASE_URL not set in environment or .env file.")
        sys.exit(1)

    conn = get_connection(db_url)
    cur = conn.cursor()

    # ── Load temp table + confirm submission count ────────────────────────────
    log.info("Loading submission IDs into temporary table...")
    found = create_temp_table(cur, submission_ids)

    if found == 0:
        log.info("None of the submission IDs in the JSON exist in the database. Nothing to do.")
        conn.close()
        sys.exit(0)

    if args.dry_run:
        log.info("Dry run complete -- no data was modified.")
        conn.close()
        sys.exit(0)

    # ── Confirmation ──────────────────────────────────────────────────────────
    if not args.yes:
        print()
        print(f"  {found:,} submissions and all related data will be permanently deleted.")
        print("  Ensure you have a recent database backup before proceeding.")
        print()
        answer = input('  Type "YES" to confirm: ').strip()
        print()
        if answer != "YES":
            log.info("Aborted by user.")
            conn.close()
            sys.exit(0)

    # ── Execute ───────────────────────────────────────────────────────────────
    log.info("Starting purge (single transaction)...")
    try:
        deleted = purge(cur, args.keep_patients)
        conn.commit()
        log.info("Transaction committed successfully.")
    except Exception as exc:
        conn.rollback()
        log.error(f"Purge failed -- all changes rolled back. Reason: {exc}", exc_info=True)
        conn.close()
        sys.exit(1)

    conn.close()
    print_summary(deleted)
    log.info("Done.")


if __name__ == "__main__":
    main()
