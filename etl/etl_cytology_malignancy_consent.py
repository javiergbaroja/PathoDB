#!/usr/bin/env python3
"""
PathoDB Cytology ETL — Malignancy flag + patient-level consent
================================================================
Companion to etl_cytology_reports.py, using the same consolidated file:

    Einsendung | ... | Malignom auf Einsendung | ... | Freigabedatum | Konsens | ...

Two independent updates:

1. MALIGNANCY (per submission)
   "Malignom auf Einsendung" (Ja/Nein) -> submissions.malignancy_flag (bool),
   overwritten unconditionally for every Z-submission matched in this file.

2. CONSENT (per PATIENT, not per submission)
   "Konsens" is German (einverstanden/informiert/abgelehnt/unbekannt) and is
   mapped to the DB's existing English vocabulary:
       einverstanden -> consented
       informiert    -> informed
       abgelehnt     -> refused
       unbekannt / blank -> SKIPPED (never a candidate decision)

   Consent reflects the patient's decision, which can change over time and
   then applies retroactively to their whole record. So for every patient
   appearing in this file:
     a. Gather every dated, valid (consented/informed/refused) decision for
        that patient — from this file's rows (dated by Freigabedatum) AND
        from every submission already in the DB (any type, not just
        cytology), dated by submissions.report_date.
     b. Take the single most recent one.
     c. Write it to submissions.consent for EVERY submission belonging to
        that patient, database-wide (histology included) — overwriting
        whatever was there before, since the newest decision governs the
        whole record.
   A patient with no dated valid decision at all (everything unbekannt/blank/
   undated) is left untouched and reported as unresolved.

Usage:
    python etl_cytology_malignancy_consent.py --file /…/cytology_2017-2026_en_consolidated.xlsx
    python etl_cytology_malignancy_consent.py --file … --dry-run
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

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("pathodb_etl_cyto_malig_consent")

MALIGNANCY_MAP = {"ja": True, "yes": True, "nein": False, "no": False}
CONSENT_MAP = {"einverstanden": "consented", "informiert": "informed", "abgelehnt": "refused"}
VALID_CONSENT_VALUES = tuple(CONSENT_MAP.values())  # ('consented', 'informed', 'refused')

UPDATE_MALIGNANCY_SQL = """
UPDATE submissions AS s SET malignancy_flag = v.malignancy_flag
FROM (VALUES %s) AS v (sub_id, malignancy_flag)
WHERE s.id = v.sub_id
RETURNING s.id
"""

UPDATE_CONSENT_SQL = """
UPDATE submissions AS s SET consent = v.consent
FROM (VALUES %s) AS v (patient_id, consent)
WHERE s.patient_id = v.patient_id
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
        description="PathoDB Cytology ETL — register malignancy_flag + patient-level consent"
    )
    ap.add_argument("--file", required=True,
                    help="cytology_YYYY-YYYY_en_consolidated.xlsx")
    ap.add_argument("--dry-run", action="store_true",
                    help="Report what WOULD change without writing")
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
        "malignancy_updated": 0,
        "patients_with_decision": 0,
        "patients_unresolved": 0,
        "consent_submissions_updated": 0,
    }

    try:
        df = read_table(args.file)

        cur.execute("SELECT lis_submission_id, id FROM submissions WHERE lis_submission_id LIKE 'Z%'")
        submission_map = dict(cur.fetchall())
        log.info(f"Existing Z-submissions in DB: {len(submission_map)}")

        # ── Parse rows ────────────────────────────────────────────────────────
        rows = []
        for _, r in df.iterrows():
            lis_sub = clean(r.get("Einsendung"))
            patient_code = clean(r.get("Patienten-ID"))
            if not lis_sub or not patient_code:
                stats["rows_missing_key"] += 1
                continue
            rows.append({
                "lis_sub": lis_sub,
                "patient_code": patient_code,
                "report_date": parse_date(r.get("Freigabedatum")),
                "malignancy_raw": (clean(r.get("Malignom auf Einsendung")) or "").lower(),
                "consent_raw": (clean(r.get("Konsens")) or "").lower(),
            })
        log.info(f"Parsed rows: {len(rows)} (skipped for missing key: {stats['rows_missing_key']})")

        # ── Patient map (all patients in this file already exist in DB) ───────
        patient_codes = sorted({row["patient_code"] for row in rows})
        cur.execute("SELECT patient_code, id FROM patients WHERE patient_code = ANY(%s)", (patient_codes,))
        patient_map = dict(cur.fetchall())
        unmatched_patients = [c for c in patient_codes if c not in patient_map]
        if unmatched_patients:
            log.warning(f"  {len(unmatched_patients)} patient code(s) from the file have no patient row — "
                        f"their rows are skipped for both updates (e.g. {unmatched_patients[:5]})")

        # ── 1) Malignancy flag — per submission, unconditional overwrite ──────
        malignancy_rows = []
        for row in rows:
            sub_id = submission_map.get(row["lis_sub"])
            flag = MALIGNANCY_MAP.get(row["malignancy_raw"])
            if sub_id is not None and flag is not None:
                malignancy_rows.append((sub_id, flag))

        if malignancy_rows:
            if args.dry_run:
                stats["malignancy_updated"] = len(malignancy_rows)
            else:
                updated = execute_values(cur, UPDATE_MALIGNANCY_SQL, malignancy_rows, fetch=True)
                stats["malignancy_updated"] = len(updated)
                conn.commit()

        # ── 2) Consent — per patient, most-recent-decision-wins ────────────────
        # Candidates keyed by patient_id: list of (report_date_or_None, consent)
        candidates: dict[int, list] = {}

        for row in rows:
            pid = patient_map.get(row["patient_code"])
            if pid is None:
                continue
            mapped = CONSENT_MAP.get(row["consent_raw"])
            if mapped is None:          # unbekannt / blank / unrecognised -> skip
                continue
            candidates.setdefault(pid, []).append((row["report_date"], mapped))

        all_pids = list(patient_map.values())
        cur.execute(
            f"SELECT patient_id, report_date, consent FROM submissions "
            f"WHERE patient_id = ANY(%s) AND consent IN %s",
            (all_pids, VALID_CONSENT_VALUES),
        )
        for pid, report_date, consent in cur.fetchall():
            candidates.setdefault(pid, []).append(
                (report_date.isoformat() if report_date else None, consent)
            )

        winners = {}   # patient_id -> consent
        for pid, cands in candidates.items():
            dated = [c for c in cands if c[0] is not None]
            if not dated:
                stats["patients_unresolved"] += 1
                continue
            dated.sort(key=lambda c: c[0], reverse=True)
            winners[pid] = dated[0][1]
            stats["patients_with_decision"] += 1

        if winners:
            consent_rows = list(winners.items())
            if args.dry_run:
                cur.execute(
                    "SELECT count(*) FROM submissions WHERE patient_id = ANY(%s)",
                    ([pid for pid, _ in consent_rows],),
                )
                stats["consent_submissions_updated"] = cur.fetchone()[0]
            else:
                updated = execute_values(cur, UPDATE_CONSENT_SQL, consent_rows,
                                          template="(%s::integer, %s)", fetch=True)
                stats["consent_submissions_updated"] = len(updated)
                conn.commit()

        log.info("")
        log.info("=" * 60)
        log.info("CYTOLOGY MALIGNANCY + CONSENT REGISTRATION" + ("  (DRY RUN)" if args.dry_run else ""))
        log.info("=" * 60)
        log.info(f"  Rows parsed:                       {len(rows)}")
        log.info(f"  Rows skipped (missing key):        {stats['rows_missing_key']}")
        log.info(f"  Malignancy flags updated:          {stats['malignancy_updated']}")
        log.info(f"  Patients with a resolved decision: {stats['patients_with_decision']}")
        log.info(f"  Patients left unresolved (no dated valid decision): {stats['patients_unresolved']}")
        log.info(f"  Submissions updated with consent (DB-wide, all types): {stats['consent_submissions_updated']}")
        log.info("=" * 60)

    except Exception as exc:
        conn.rollback()
        log.error(f"Malignancy/consent registration failed: {exc}", exc_info=True)
        sys.exit(1)
    finally:
        cur.close()
        conn.close()


if __name__ == "__main__":
    main()
