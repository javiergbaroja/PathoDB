#!/usr/bin/env python3
"""
load_snomed_vocab.py
=====================
Loads the morphology/etiology SNOMED master dict into snomed_codes.
Topography is intentionally excluded — it is not modeled in this table.

Expects a JSON file shaped like:
    {"morphology": {"code1": "desc1", ...}, "topography": {...}, "etiology": {...}}
(the "topography" key, if present, is ignored entirely)

Usage:
    python load_snomed_vocab.py --dict snomed_dict.json --env-file .env --mode report
    python load_snomed_vocab.py --dict snomed_dict.json --env-file .env --mode run
"""
import argparse
import json
import logging
import os

import psycopg2
from dotenv import load_dotenv

log = logging.getLogger("load_snomed_vocab")
logging.basicConfig(level=logging.INFO, format="%(message)s")

CATEGORIES = ("morphology", "etiology")


def get_connection() -> psycopg2.extensions.connection:
    """
    Always builds the connection from individual env vars — never from
    DATABASE_URL. DATABASE_URL's host is whatever was true when .env was
    written (here, literally "localhost"), which is only correct if this
    worker happens to run on the same node as Postgres. This worker is
    scheduled onto a SLURM-assigned compute node that may be a different
    one, so the host must come from POSTGRES_HOST, which run_etl.sh sets
    dynamically per job from the API process's own hostname (see
    api/routers/etl.py's context_data["db_host"]).
    """
    return psycopg2.connect(
        host=os.getenv("POSTGRES_HOST", "localhost"),
        port=int(os.getenv("POSTGRES_PORT", "5432")),
        dbname=os.getenv("POSTGRES_DB", "pathodb"),
        user=os.getenv("APP_PGUSER", os.getenv("POSTGRES_USER", "jgbaroja")),
        password=os.getenv("POSTGRES_PASSWORD", ""),
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dict", required=True, help="Path to the SNOMED code->description JSON dict")
    ap.add_argument("--env-file", required=True)
    ap.add_argument("--mode", choices=["report", "run"], default="report")
    args = ap.parse_args()

    with open(args.dict, encoding="utf-8") as f:
        vocab = json.load(f)

    load_dotenv(args.env_file)
    conn = get_connection()
    cur = conn.cursor()

    total = 0
    for category in CATEGORIES:
        bucket = vocab.get(category, {})
        log.info(f"{category}: {len(bucket)} code(s) in dict")
        for code, description in bucket.items():
            desc_clean = (description or "").strip().lower() or None
            if args.mode == "run":
                cur.execute(
                    """
                    INSERT INTO snomed_codes (code, category, description)
                    VALUES (%s, %s, %s)
                    ON CONFLICT (code) DO UPDATE
                        SET description = EXCLUDED.description,
                            category    = EXCLUDED.category
                    """,
                    (code, category, desc_clean),
                )
            total += 1

    if args.mode == "run":
        conn.commit()
    cur.close()

    log.info("=" * 50)
    log.info(f"Mode: {args.mode}")
    log.info(f"{'Upserted' if args.mode == 'run' else 'Would upsert'}: {total} code(s)")
    log.info("=" * 50)


if __name__ == "__main__":
    main()