#!/usr/bin/env python3
"""
PathoDB Cytology ETL — Report text registration
=================================================
Companion to etl_cytology_submissions.py, whose docstring flagged this as the
deferred step: "Reports (macro / microscopy) — being translated, will be
loaded later." This script loads that translated, consolidated file:

    Einsendung | Sequenz | Malignom auf Einsendung | Patienten-ID |
    Geburtsdatum | Freigabedatum | Konsens | Diagnose | Makro | ...

For each row:
  * Diagnose -> reports.report_text WHERE report_type = 'microscopy'
  * Makro    -> reports.report_text WHERE report_type = 'macro'

Behaviour, per submission (Einsendung / Z-number):
  * ALREADY IN DB      -> only the report rows are touched: report_text is
                          OVERWRITTEN; report_date is overwritten only when
                          Freigabedatum is present in this file (a blank
                          Freigabedatum never clobbers a date already in the
                          DB — see COALESCE in UPSERT_REPORTS_SQL). patient /
                          submission fields (malignancy_flag, consent, dob)
                          are left exactly as they are.
  * NOT YET IN DB       -> the full chain is created: patient (if missing),
                          submission, then the report row(s).

Both directions upsert through the same ON CONFLICT (submission_id, report_type)
clause, so re-running this script is always safe / idempotent.

Additionally (Phase 3), submissions.report_date is backfilled from Freigabedatum
for any matched submission where it is currently NULL — a pure gap-fill, never
an overwrite of an existing submission-level date.

Note: overwriting report_text on an already-embedded report makes its RAG
chunks (report_embeddings) stale. Pass --clear-embeddings to delete the
report_embeddings rows for every report touched by this run (keyed by
report_id, precise to the reports actually upserted) so they don't serve
stale chunks; re-embed afterwards with
  python api/workers/embed_reports.py --refresh-metadata

Usage:
    python etl_cytology_reports.py --file /…/cytology_2017-2026_en_consolidated.xlsx
    python etl_cytology_reports.py --file … --dry-run
    python etl_cytology_reports.py --file … --clear-embeddings
"""

import argparse
import logging
import os
import sys
from datetime import datetime
from pathlib import Path
from typing import Optional

import pandas as pd
import psycopg2
from psycopg2.extras import execute_values
from dotenv import load_dotenv
from tqdm import tqdm

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("pathodb_etl_cyto_reports")

BATCH_SIZE = 1000

MALIGNANCY_MAP = {"ja": True, "yes": True, "nein": False, "no": False}

INSERT_PATIENTS_SQL = """
INSERT INTO patients (patient_code, date_of_birth)
VALUES %s
ON CONFLICT (patient_code) DO NOTHING
"""

INSERT_SUBMISSIONS_SQL = """
INSERT INTO submissions (patient_id, lis_submission_id, report_date, malignancy_flag, consent)
VALUES %s
ON CONFLICT (lis_submission_id) DO NOTHING
"""

UPSERT_REPORTS_SQL = """
INSERT INTO reports (submission_id, report_type, report_text, report_date)
VALUES %s
ON CONFLICT (submission_id, report_type) DO UPDATE SET
    report_text = EXCLUDED.report_text,
    report_date = COALESCE(EXCLUDED.report_date, reports.report_date)
RETURNING id
"""

DELETE_EMBEDDINGS_SQL = "DELETE FROM report_embeddings WHERE report_id = ANY(%s)"

BACKFILL_SUBMISSION_DATE_SQL = """
UPDATE submissions AS s SET report_date = v.report_date
FROM (VALUES %s) AS v (sub_id, report_date)
WHERE s.id = v.sub_id AND s.report_date IS NULL
RETURNING s.id
"""


def get_connection(db_url: str):
    try:
        conn = psycopg2.connect(db_url)
        log.info("Database connection established.")
        return conn
    except psycopg2.OperationalError as e:
        log.error(f"Cannot connect to database: {e}")
        sys.exit(1)


def read_table(filepath: str) -> pd.DataFrame:
    df = pd.read_excel(filepath, dtype=str)
    df.columns = df.columns.str.strip()
    log.info(f"Read {Path(filepath).name!r} — {len(df)} rows")
    return df


def clean(val) -> Optional[str]:
    if val is None:
        return None
    s = str(val).strip()
    return None if s.lower() in ("nan", "none", "") else s


def parse_date(val) -> Optional[str]:
    """Handles both PathoWin strings and this file's ISO-8601-with-offset dates."""
    s = clean(val)
    if s is None:
        return None
    try:
        return datetime.fromisoformat(s).strftime("%Y-%m-%d")
    except ValueError:
        pass
    for fmt in ("%d/%m/%Y  %H:%M:%S", "%d/%m/%Y %H:%M:%S", "%d/%m/%Y",
                "%Y-%m-%d %H:%M:%S", "%Y-%m-%d"):
        try:
            return datetime.strptime(s, fmt).strftime("%Y-%m-%d")
        except ValueError:
            continue
    log.warning(f"  Could not parse date value: {s!r}")
    return None


def main():
    ap = argparse.ArgumentParser(
        description="PathoDB Cytology ETL — register report text (overwrite existing, insert new)"
    )
    ap.add_argument("--file", required=True,
                    help="cytology_YYYY-YYYY_en_consolidated.xlsx")
    ap.add_argument("--dry-run", action="store_true",
                    help="Report what WOULD change without writing")
    ap.add_argument("--clear-embeddings", action="store_true",
                    help="Delete report_embeddings rows for every report touched by this run "
                         "(so stale chunks from the old report_text aren't served until re-embedded)")
    args = ap.parse_args()

    if not Path(args.file).exists():
        log.error(f"File not found: {args.file!r}")
        sys.exit(1)

    load_dotenv()
    db_url = os.getenv("DATABASE_URL")
    if not db_url:
        log.error("DATABASE_URL not set. Check .env.")
        sys.exit(1)
    if args.dry_run:
        log.info("DRY RUN MODE — reading DB for real counts, no writes will be issued")
    conn = get_connection(db_url)
    cur = conn.cursor()

    stats = {
        "rows_missing_key": 0,
        "patients_inserted": 0,
        "submissions_inserted": 0,
        "submissions_existing": 0,
        "reports_upserted": 0,
        "reports_skipped_empty": 0,
        "embeddings_cleared": 0,
        "submission_dates_backfilled": 0,
    }

    try:
        df = read_table(args.file)

        # ── Preload every existing Z-submission ──────────────────────────────
        cur.execute("SELECT lis_submission_id, id FROM submissions WHERE lis_submission_id LIKE 'Z%'")
        submission_map = dict(cur.fetchall())
        log.info(f"Existing Z-submissions in DB: {len(submission_map)}")

        # ── Parse rows ────────────────────────────────────────────────────────
        rows = []
        for idx, r in df.iterrows():
            lis_sub = clean(r.get("Einsendung"))
            patient_code = clean(r.get("Patienten-ID"))
            if not lis_sub or not patient_code:
                stats["rows_missing_key"] += 1
                continue
            malignancy_raw = (clean(r.get("Malignom auf Einsendung")) or "").lower()
            rows.append({
                "lis_sub": lis_sub,
                "patient_code": patient_code,
                "dob": parse_date(r.get("Geburtsdatum")),
                "report_date": parse_date(r.get("Freigabedatum")),
                "malignancy_flag": MALIGNANCY_MAP.get(malignancy_raw),
                "consent": clean(r.get("Konsens")),
                "micro_text": clean(r.get("Diagnose")),
                "macro_text": clean(r.get("Makro")),
            })
        log.info(f"Parsed rows: {len(rows)} (skipped for missing key: {stats['rows_missing_key']})")

        # ── Phase 1: create the chain for submissions NOT yet in the DB ───────
        new_rows = [row for row in rows if row["lis_sub"] not in submission_map]
        stats["submissions_existing"] = len(rows) - len(new_rows)
        log.info(f"Submissions already present (reports will be overwritten): {stats['submissions_existing']}")
        log.info(f"Submissions not yet in DB (full chain will be inserted): {len(new_rows)}")

        if new_rows:
            # 1a. Patients
            needed_codes = sorted({row["patient_code"] for row in new_rows})
            cur.execute("SELECT patient_code, id FROM patients WHERE patient_code = ANY(%s)", (needed_codes,))
            patient_map = dict(cur.fetchall())
            missing_codes = [c for c in needed_codes if c not in patient_map]

            if missing_codes:
                dob_by_code = {}
                for row in new_rows:
                    dob_by_code.setdefault(row["patient_code"], row["dob"])
                patient_rows = [(code, dob_by_code.get(code)) for code in missing_codes]
                if not args.dry_run:
                    execute_values(cur, INSERT_PATIENTS_SQL, patient_rows)
                    conn.commit()
                    cur.execute("SELECT patient_code, id FROM patients WHERE patient_code = ANY(%s)", (missing_codes,))
                    patient_map.update(cur.fetchall())
                stats["patients_inserted"] = len(missing_codes)

            # 1b. Submissions
            sub_rows = []
            for row in new_rows:
                pid = patient_map.get(row["patient_code"], -1)
                sub_rows.append((pid, row["lis_sub"], row["report_date"],
                                  row["malignancy_flag"], row["consent"]))
            if not args.dry_run:
                execute_values(cur, INSERT_SUBMISSIONS_SQL, sub_rows)
                conn.commit()
                new_ids = {row["lis_sub"] for row in new_rows}
                cur.execute("SELECT lis_submission_id, id FROM submissions WHERE lis_submission_id = ANY(%s)",
                            (list(new_ids),))
                submission_map.update(cur.fetchall())
            stats["submissions_inserted"] = len(new_rows)

        # ── Phase 2: upsert report text (overwrite existing / insert new) ─────
        def flush(batch):
            report_ids = execute_values(cur, UPSERT_REPORTS_SQL, batch, fetch=True)
            conn.commit()
            stats["reports_upserted"] += len(batch)
            if args.clear_embeddings and report_ids:
                ids = [r[0] for r in report_ids]
                cur.execute(DELETE_EMBEDDINGS_SQL, (ids,))
                stats["embeddings_cleared"] += cur.rowcount
                conn.commit()

        pending = []
        for row in tqdm(rows, desc="  Reports"):
            sub_id = submission_map.get(row["lis_sub"], -1)
            for text, rtype in ((row["micro_text"], "microscopy"), (row["macro_text"], "macro")):
                if not text:
                    stats["reports_skipped_empty"] += 1
                    continue
                pending.append((sub_id, rtype, text, row["report_date"]))
            if not args.dry_run and len(pending) >= BATCH_SIZE:
                flush(pending)
                pending = []

        if not args.dry_run and pending:
            flush(pending)
        elif args.dry_run:
            stats["reports_upserted"] += len(pending)

        # ── Phase 3: backfill submissions.report_date where currently NULL ────
        backfill_rows = [
            (submission_map[row["lis_sub"]], row["report_date"])
            for row in rows
            if row["report_date"] and row["lis_sub"] in submission_map
        ]
        if backfill_rows:
            if args.dry_run:
                sub_ids = [r[0] for r in backfill_rows]
                cur.execute("SELECT count(*) FROM submissions WHERE id = ANY(%s) AND report_date IS NULL", (sub_ids,))
                stats["submission_dates_backfilled"] = cur.fetchone()[0]
            else:
                # fetch=True: execute_values pages large VALUES lists (default page_size=100),
                # so cur.rowcount would only reflect the LAST page — RETURNING + fetch
                # aggregates the true total across every page.
                updated = execute_values(cur, BACKFILL_SUBMISSION_DATE_SQL, backfill_rows,
                                          template="(%s::integer, %s::date)", fetch=True)
                stats["submission_dates_backfilled"] = len(updated)
                conn.commit()

        log.info("")
        log.info("=" * 60)
        log.info("CYTOLOGY REPORTS REGISTRATION" + ("  (DRY RUN — nothing written)" if args.dry_run else ""))
        log.info("=" * 60)
        log.info(f"  Rows parsed:                  {len(rows)}")
        log.info(f"  Rows skipped (missing key):   {stats['rows_missing_key']}")
        log.info(f"  Submissions existing (overwritten): {stats['submissions_existing']}")
        log.info(f"  Submissions newly inserted:    {stats['submissions_inserted']}")
        log.info(f"  Patients newly inserted:       {stats['patients_inserted']}")
        log.info(f"  Report rows upserted:          {stats['reports_upserted']}")
        log.info(f"  Report cells skipped (empty):  {stats['reports_skipped_empty']}")
        log.info(f"  Submission report_date backfilled (was NULL): {stats['submission_dates_backfilled']}")
        if args.clear_embeddings:
            log.info(f"  Stale embeddings cleared:      {stats['embeddings_cleared']}")
        log.info("=" * 60)

    except Exception as exc:
        conn.rollback()
        log.error(f"Reports registration failed: {exc}", exc_info=True)
        sys.exit(1)
    finally:
        cur.close()
        conn.close()


if __name__ == "__main__":
    main()
