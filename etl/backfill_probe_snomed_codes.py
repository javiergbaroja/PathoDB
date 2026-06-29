#!/usr/bin/env python3
"""
backfill_probe_snomed_codes.py
================================
One-time backfill: associates morphology/etiology SNOMED codes to existing
probes, sourced from a per-probe codes CSV. Topography codes (prefix "T")
are ignored — topography is unaffected and stays exactly as already stored
on probes.snomed_topo_code / topo_description.

Classification of a non-topography code as 'morphology' or 'etiology' is
done by looking up which bucket of snomed_codes (loaded by
load_snomed_vocab.py) the code belongs to. A code genuinely absent from
BOTH buckets is logged and skipped — never guessed at.

Performance
-----------
probe_id lookup is a single upfront query into an in-memory dict (no
per-row SELECT); writes are batched via execute_values (no per-row UPDATE
round-trip). This turns ~2.6M DB round-trips into ~1 + (updates / 2000).

Usage:
    python backfill_probe_snomed_codes.py --csv codes.csv --env-file .env --mode report
    python backfill_probe_snomed_codes.py --csv codes.csv --env-file .env --mode run
"""
import argparse
import logging
import os
import re
import sys

import pandas as pd
import psycopg2
from psycopg2.extras import execute_values
from dotenv import load_dotenv
from tqdm import tqdm

log = logging.getLogger("backfill_snomed")
logging.basicConfig(level=logging.INFO, format="%(message)s")

CODE_SPLIT_RE = re.compile(r"[()\s]+")
WRITE_BATCH_SIZE = 2000

UPDATE_SQL = """
UPDATE probes AS p
SET snomed_morph_codes = v.morph_codes,
    snomed_etio_codes  = v.etio_codes
FROM (VALUES %s) AS v (probe_id, morph_codes, etio_codes)
WHERE p.id = v.probe_id
"""


def parse_codes(raw) -> list[str]:
    if raw is None or not str(raw).strip():
        return []
    tokens = [t for t in CODE_SPLIT_RE.split(str(raw).strip()) if t]
    return list(dict.fromkeys(tokens))  # de-dupe, preserve order


def get_connection():
    user = os.environ["POSTGRES_USER"]
    pwd  = os.environ["POSTGRES_PASSWORD"]
    host = os.environ.get("POSTGRES_HOST", "localhost")
    port = os.environ.get("POSTGRES_PORT", os.environ.get("PGPORT", "5432"))
    db   = os.environ["POSTGRES_DB"]
    return psycopg2.connect(f"postgresql://{user}:{pwd}@{host}:{port}/{db}")


def load_category_map(conn) -> dict[str, str]:
    cur = conn.cursor()
    cur.execute("SELECT code, category FROM snomed_codes")
    out = dict(cur.fetchall())
    cur.close()
    log.info(f"Loaded {len(out)} known SNOMED code(s) from snomed_codes")
    return out


def load_probe_id_map(conn) -> tuple[dict[str, int], set[str]]:
    """lis_probe_id -> id, loaded once for the whole table.

    Era-2 lis_probe_id values are the B-number itself, globally unique.
    Other eras can repeat the same lis_probe_id (e.g. bare '1') across many
    submissions — those collide and are excluded rather than silently
    picking one. Harmless as long as the CSV doesn't reference them.
    """
    cur = conn.cursor()
    cur.execute("SELECT lis_probe_id, id FROM probes")
    out: dict[str, int] = {}
    ambiguous: set[str] = set()
    for lis_probe_id, pid in cur.fetchall():
        if lis_probe_id in out:
            ambiguous.add(lis_probe_id)
        else:
            out[lis_probe_id] = pid
    cur.close()
    for key in ambiguous:
        out.pop(key, None)
    log.info(f"Loaded {len(out)} unique probe ID(s); {len(ambiguous)} ambiguous ref(s) excluded")
    return out, ambiguous


def flush_batch(cur, batch: list[tuple]):
    if batch:
        execute_values(cur, UPDATE_SQL, batch, template="(%s, %s::text[], %s::text[])")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv", required=True)
    ap.add_argument("--env-file", required=True)
    ap.add_argument("--mode", choices=["report", "run"], default="report")
    args = ap.parse_args()

    load_dotenv(args.env_file)
    conn = get_connection()
    category_map = load_category_map(conn)
    if not category_map:
        log.error("snomed_codes is empty — run load_snomed_vocab.py first.")
        sys.exit(1)
    probe_id_map, ambiguous_refs = load_probe_id_map(conn)

    df = pd.read_csv(args.csv, dtype=str)
    df.columns = df.columns.str.strip()
    probe_refs = df["Probe"].fillna("").astype(str).str.strip().tolist()
    codes_raws = df["SNOMED Codes"].fillna("").tolist()

    cur = conn.cursor()
    stats = {"probes_seen": 0, "probes_not_found": 0, "assoc_count": 0,
              "codes_skipped_topo": 0, "codes_skipped_unknown": 0}
    unknown_codes = set()
    not_found_sample, not_found_count = [], 0
    pending_updates = []

    for probe_ref, codes_raw in tqdm(zip(probe_refs, codes_raws), total=len(probe_refs)):
        if not probe_ref:
            continue
        stats["probes_seen"] += 1

        probe_id = probe_id_map.get(probe_ref)
        if probe_id is None:
            stats["probes_not_found"] += 1
            not_found_count += 1
            # if len(not_found_sample) < 50:
            not_found_sample.append(probe_ref)
            continue

        morph_codes, etio_codes = [], []
        for code in parse_codes(codes_raw):
            if code.upper().startswith("T"):
                stats["codes_skipped_topo"] += 1
                continue
            category = category_map.get(code)
            if category == "morphology":
                morph_codes.append(code)
            elif category == "etiology":
                etio_codes.append(code)
            else:
                stats["codes_skipped_unknown"] += 1
                unknown_codes.add(code)

        stats["assoc_count"] += len(morph_codes) + len(etio_codes)
        if args.mode == "run" and (morph_codes or etio_codes):
            pending_updates.append((probe_id, morph_codes, etio_codes))
            if len(pending_updates) >= WRITE_BATCH_SIZE:
                flush_batch(cur, pending_updates)
                conn.commit()
                pending_updates = []

    if args.mode == "run":
        flush_batch(cur, pending_updates)
        conn.commit()
    cur.close()

    log.info("=" * 60)
    log.info(f"Mode: {args.mode}")
    log.info(f"Probes seen:                {stats['probes_seen']}")
    log.info(f"Probes not found in DB:     {stats['probes_not_found']}")
    log.info(f"Topography codes ignored:   {stats['codes_skipped_topo']}")
    log.info(f"Associations {'inserted' if args.mode == 'run' else 'would insert'}: {stats['assoc_count']}")
    log.info(f"Unrecognized codes skipped: {stats['codes_skipped_unknown']}")
    if unknown_codes:
        log.warning("  Codes not found in snomed_codes (any category) — review:")
        for c in sorted(unknown_codes)[:30]:
            log.warning(f"    {c}")
        if len(unknown_codes) > 30:
            log.warning(f"    ... and {len(unknown_codes) - 30} more")
    if not_found_count:
        log.warning(f"  {not_found_count} probe ref(s) not found, e.g.: {not_found_sample[:10]}")
        # save to txt
        with open("probes_not_found.txt", "w", encoding="utf-8") as f:
            for probe_ref in not_found_sample:
                f.write(probe_ref + "\n")
    if ambiguous_refs:
        log.warning(f"  {len(ambiguous_refs)} lis_probe_id value(s) are ambiguous across submissions "
                     f"and were excluded from matching (expected — these are non-era-2 sentinel IDs).")
    log.info("=" * 60)


if __name__ == "__main__":
    main()