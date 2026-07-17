#!/usr/bin/env python3
"""
load_snomed_vocab.py
=====================
Loads the SNOMED master dict into snomed_codes, for the three axes the probes
table actually references: topography (probes.snomed_topo_code), morphology
(probes.snomed_morph_codes) and etiology (probes.snomed_etio_codes).

Expects a JSON file shaped like:
    {"morphology": {"code1": "desc1", ...}, "topography": {...}, "etiology": {...}}

The dict may carry further axes (procedure, disease, axis_8, axis_Z, ...). They
are skipped: no column references them, and snomed_codes' CHECK constraint only
admits the three loaded here. Adding one means widening that CHECK first.

Usage:
    python load_snomed_vocab.py --dict snomed_dict_en.json --env-file .env --mode report
    python load_snomed_vocab.py --dict snomed_dict_en.json --env-file .env --mode run

`report` mode is a true dry-run diff against the live table (new / changed /
unchanged / orphaned) and writes nothing.
"""
import argparse
import json
import logging
import os
import sys

import psycopg2
from psycopg2.extras import execute_values
from dotenv import load_dotenv

log = logging.getLogger("load_snomed_vocab")
logging.basicConfig(level=logging.INFO, format="%(message)s")

# The axes snomed_codes models. Anything else in the dict is ignored — see the
# module docstring. Must stay in sync with the CHECK constraint in db/schema.sql.
CATEGORIES = ("morphology", "topography", "etiology")


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


def flatten(vocab: dict) -> dict:
    """dict-of-axes -> {code: (category, description)}, loadable axes only.

    `code` is snomed_codes' primary key, so a code appearing under two axes
    would make the load order-dependent (last writer wins, silently). Fail
    instead — it means the source dict is wrong.
    """
    flat: dict = {}
    for category in CATEGORIES:
        bucket = vocab.get(category) or {}
        log.info(f"  {category:12} {len(bucket):5} code(s) in dict")
        for code, description in bucket.items():
            code = (code or "").strip()
            if not code:
                continue
            # Preserve the dict's casing: descriptions are user-facing, and
            # meaningful case ("adenocarcinoma, NOS") is not ours to flatten.
            desc = (description or "").strip() or None
            if code in flat and flat[code] != (category, desc):
                raise SystemExit(
                    f"Code {code!r} appears under two axes: {flat[code][0]} and "
                    f"{category}. snomed_codes.code is a primary key — fix the dict."
                )
            flat[code] = (category, desc)
    skipped = [k for k in vocab if k not in CATEGORIES]
    if skipped:
        log.info(f"  (skipped non-modeled axes: {', '.join(skipped)})")
    return flat


def diff(cur, flat: dict) -> tuple[list, list, list]:
    """Compare the dict against the live table -> (new, changed, orphaned)."""
    cur.execute("SELECT code, category, description FROM snomed_codes")
    live = {r[0]: (r[1], r[2]) for r in cur.fetchall()}
    new = [(c, *flat[c]) for c in flat if c not in live]
    changed = [(c, *flat[c], *live[c]) for c in flat
               if c in live and live[c] != flat[c]]
    orphaned = [(c, *live[c]) for c in live if c not in flat]
    return new, changed, orphaned


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dict", required=True, help="Path to the SNOMED code->description JSON dict")
    ap.add_argument("--env-file", required=True)
    ap.add_argument("--mode", choices=["report", "run"], default="report")
    args = ap.parse_args()

    with open(args.dict, encoding="utf-8") as f:
        vocab = json.load(f)

    log.info(f"Reading {args.dict}")
    flat = flatten(vocab)
    log.info(f"  {'total':12} {len(flat):5} code(s) loadable")

    load_dotenv(args.env_file)
    conn = get_connection()
    cur = conn.cursor()

    new, changed, orphaned = diff(cur, flat)

    log.info("=" * 60)
    log.info(f"New       : {len(new):5}  (in dict, not in DB)")
    log.info(f"Changed   : {len(changed):5}  (description or category differs)")
    log.info(f"Unchanged : {len(flat) - len(new) - len(changed):5}")
    log.info(f"Orphaned  : {len(orphaned):5}  (in DB, not in dict — left untouched)")
    for code, cat, desc, old_cat, old_desc in changed[:20]:
        log.info(f"  ~ {code} [{old_cat}] {old_desc!r} -> [{cat}] {desc!r}")
    if len(changed) > 20:
        log.info(f"  ... and {len(changed) - 20} more")
    for code, cat, desc in orphaned[:20]:
        log.info(f"  ? {code} [{cat}] {desc!r} — used by probes but absent from the dict")
    if len(orphaned) > 20:
        log.info(f"  ... and {len(orphaned) - 20} more")
    log.info("=" * 60)

    if args.mode != "run":
        log.info("Mode: report — nothing written. Re-run with --mode run to apply.")
        cur.close()
        conn.close()
        return

    if not new and not changed:
        log.info("Mode: run — already up to date, nothing to write.")
        cur.close()
        conn.close()
        return

    execute_values(
        cur,
        """
        INSERT INTO snomed_codes (code, category, description)
        VALUES %s
        ON CONFLICT (code) DO UPDATE
            SET description = EXCLUDED.description,
                category    = EXCLUDED.category
        """,
        [(c, cat, desc) for c, (cat, desc) in flat.items()],
        page_size=500,
    )
    conn.commit()

    cur.execute("SELECT category, count(*) FROM snomed_codes GROUP BY category ORDER BY 1")
    log.info("Mode: run — upserted "
             f"{len(new)} new + {len(changed)} changed code(s). Table now holds:")
    for category, count in cur.fetchall():
        log.info(f"  {category:12} {count:5}")
    cur.close()
    conn.close()


if __name__ == "__main__":
    main()
