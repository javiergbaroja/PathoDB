#!/usr/bin/env python3
"""
PathoDB ETL — Radboud lymph-node slides (Complexity cohort)
===========================================================
Registers the additional lymph-node H&E slides from the "Scans_Complexity"
archive onto the ALREADY-LOADED Radboud patients (source_id = RADBOUD), under a
NEW lymph-node probe. It adds NO patients, submissions, clinical data or reports
— only a lymph-node probe + block + scan per linked slide.

Linkage (all IDs normalised for zero-padding)
---------------------------------------------
  image file  : TD_S01_P<num>_C0001_B###.mrxs  (one file per lymph-node block)
  P<num>      == Study_ID in the new sheet     (P000001 <-> P00001, drop zeros)
  Study_ID    -> T_number  (new sheet 'Complexity_..._survivaldata.xlsx', col
                            'T_number', e.g. T89-000385)
  T_number    == an existing submission's lis_submission_id after normalising
                 the number after the dash (T89-000385 <-> T89-00385).
Only slides whose T_number resolves to an existing Radboud submission are
registered; the rest (Complexity cases not in the loaded cohort) are skipped.

New probe / block / scan
------------------------
  probe : one per submission, lis_probe_id='2' (primary is '1'), snomed_topo_code='T08000',
          topo_description = the master description of T08000 ("lymph node").
  block : one per slide, block_label = the .mrxs filename stem.
  scan  : the .mrxs, stain H&E, format MRXS.

Idempotent (ON CONFLICT). --dry-run reads + resolves but writes nothing.

Usage
-----
  python etl_radboud_ln.py --dry-run
  python etl_radboud_ln.py
"""

import argparse
import logging
import os
import re
import sys
from pathlib import Path
from typing import Optional

import pandas as pd
import psycopg2
from dotenv import load_dotenv
from tqdm import tqdm

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s  %(levelname)-8s  %(message)s",
                    datefmt="%Y-%m-%d %H:%M:%S")
log = logging.getLogger("pathodb_etl_radboud_ln")

DEFAULT_CLINICAL = "/storage/research/igmp_dp_research_dataset_archive/Brower Nelleke/Scans_Complexity_Nelleke_Radboudumc/Complexity_completecohort_Radb_survivaldata.xlsx"
DEFAULT_IMAGE_ROOT = "/storage/research/igmp_dp_research_dataset_archive/Brower Nelleke/Scans_Complexity_Nelleke_Radboudumc/images"
CLINICAL_SHEET = "Blad1"
SOURCE_CODE = "RADBOUD"
LN_PROBE = "2"          # primary tumour probe is '1'; lymph node is '2'
LN_TOPO_CODE = "T08000"


# ── Normalisation ─────────────────────────────────────────────────────────────

def norm_t(t) -> Optional[tuple]:
    """'T90-010111' / 'T90-10111' -> (90, 10111). Drops zero-padding on the number."""
    m = re.match(r"[Tt]\s*(\d+)\s*-\s*(\d+)", str(t).strip())
    return (int(m.group(1)), int(m.group(2))) if m else None


def norm_p(s) -> Optional[int]:
    """'P00001' / 'P000001' -> 1."""
    m = re.search(r"[Pp]0*(\d+)", str(s))
    return int(m.group(1)) if m else None


def image_study_id(filename: str) -> Optional[int]:
    m = re.search(r"_P0*(\d+)_", filename)
    return int(m.group(1)) if m else None


# ── DB helpers ────────────────────────────────────────────────────────────────

def fetch_he_stain_id(cur) -> int:
    cur.execute("SELECT id FROM stains WHERE stain_category = 'HE' ORDER BY id LIMIT 1")
    row = cur.fetchone()
    if not row:
        raise RuntimeError("No H&E stain found in `stains`.")
    return row[0]


def fetch_radboud_submissions(cur) -> dict:
    """normalised T-number -> submission_id, for existing RADBOUD patients."""
    cur.execute("""
        SELECT s.id, s.lis_submission_id
        FROM submissions s
        JOIN patients p ON p.id = s.patient_id
        JOIN data_sources d ON d.id = p.source_id
        WHERE d.code = %s
    """, (SOURCE_CODE,))
    out = {}
    for sub_id, lis in cur.fetchall():
        key = norm_t(lis)
        if key is not None:
            out[key] = sub_id
    return out


def fetch_topo_description(cur, code: str) -> Optional[str]:
    cur.execute("SELECT description FROM snomed_codes WHERE code = %s AND category = 'topography'", (code,))
    row = cur.fetchone()
    return row[0] if row else None


def get_or_create_ln_probe(cur, submission_id: int, topo_desc: str, dry: bool, stats: dict) -> Optional[int]:
    if dry:
        return -abs(submission_id)
    cur.execute("""
        INSERT INTO probes (submission_id, lis_probe_id, submission_type,
                            topo_description, snomed_topo_code)
        VALUES (%s, %s, %s, %s, %s)
        ON CONFLICT (submission_id, lis_probe_id) DO UPDATE
            SET topo_description = EXCLUDED.topo_description,
                snomed_topo_code = EXCLUDED.snomed_topo_code
        RETURNING id, (xmax = 0) AS inserted
    """, (submission_id, LN_PROBE, f"{SOURCE_CODE} lymph node", topo_desc, LN_TOPO_CODE))
    pid, inserted = cur.fetchone()
    if inserted:
        stats["ln_probes"] += 1
    return pid


def upsert_block(cur, probe_id: int, label: str, dry: bool, stats: dict) -> Optional[int]:
    if dry:
        stats["blocks"] += 1
        return -abs(hash((probe_id, label)))
    cur.execute("""
        INSERT INTO blocks (probe_id, block_label, block_info) VALUES (%s, %s, %s)
        ON CONFLICT (probe_id, block_label) DO NOTHING
    """, (probe_id, label, f"Lymph node H&E ({SOURCE_CODE} Complexity cohort)"))
    if cur.rowcount:
        stats["blocks"] += 1
    cur.execute("SELECT id FROM blocks WHERE probe_id = %s AND block_label = %s", (probe_id, label))
    return cur.fetchone()[0]


def upsert_scan(cur, block_id: int, stain_id: int, file_path: str, dry: bool, stats: dict):
    if dry:
        stats["scans"] += 1
        return
    cur.execute("""
        INSERT INTO scans (block_id, stain_id, file_path, file_format)
        VALUES (%s, %s, %s, 'MRXS')
        ON CONFLICT (file_path) DO UPDATE SET block_id = EXCLUDED.block_id
        RETURNING (xmax = 0) AS inserted
    """, (block_id, stain_id, file_path))
    if cur.fetchone()[0]:
        stats["scans"] += 1


# ── Main load ─────────────────────────────────────────────────────────────────

def load(clinical, image_root, conn, dry):
    cur = conn.cursor()
    stain_id = fetch_he_stain_id(cur)
    db_sub = fetch_radboud_submissions(cur)
    topo_desc = fetch_topo_description(cur, LN_TOPO_CODE)
    if not topo_desc:
        raise RuntimeError(f"{LN_TOPO_CODE} not found in snomed_codes (topography).")
    log.info(f"H&E stain_id={stain_id} | {len(db_sub)} existing RADBOUD submissions | "
             f"{LN_TOPO_CODE}='{topo_desc}'")

    # Study_ID(norm) -> normalised T_number, from the new sheet.
    df = pd.read_excel(clinical, sheet_name=CLINICAL_SHEET, dtype=str)
    df.columns = [str(c).strip() for c in df.columns]
    sid_to_nt = {}
    for _, r in df.iterrows():
        sid = norm_p(r.get("Study_ID"))
        nt = norm_t(r.get("T_number"))
        if sid is not None:
            sid_to_nt[sid] = nt
    log.info(f"New sheet: {len(df)} rows, {sum(1 for v in sid_to_nt.values() if v)} with a T-number")

    files = sorted(f for f in os.listdir(image_root) if f.lower().endswith(".mrxs"))
    stats = {k: 0 for k in ("ln_probes", "blocks", "scans",
                            "slides_linked", "slides_no_sheet", "slides_no_match")}
    probe_cache: dict = {}          # submission_id -> ln probe_id
    patients_linked = set()

    for fn in tqdm(files, desc="  LN slides"):
        sid = image_study_id(fn)
        if sid is None:
            continue
        nt = sid_to_nt.get(sid)
        if nt is None:
            stats["slides_no_sheet"] += 1            # image Study_ID absent from sheet / no T-number
            continue
        sub_id = db_sub.get(nt)
        if sub_id is None:
            stats["slides_no_match"] += 1            # T-number not in loaded Radboud cohort
            continue

        # link it
        if sub_id not in probe_cache:
            probe_cache[sub_id] = get_or_create_ln_probe(cur, sub_id, topo_desc, dry, stats)
        probe_id = probe_cache[sub_id]
        label = Path(fn).name.rsplit(".", 1)[0]
        block_id = upsert_block(cur, probe_id, label, dry, stats)
        upsert_scan(cur, block_id, stain_id, str(Path(image_root) / fn), dry, stats)
        stats["slides_linked"] += 1
        patients_linked.add(sub_id)

        if not dry and stats["slides_linked"] % 100 == 0:
            conn.commit()

    if not dry:
        conn.commit()
    cur.close()

    log.info("=" * 60)
    log.info("RADBOUD LYMPH-NODE IMPORT" + ("  (DRY RUN — nothing written)" if dry else ""))
    log.info("=" * 60)
    log.info(f"  total .mrxs found       : {len(files)}")
    log.info(f"  patients linked         : {len(patients_linked)}")
    log.info(f"  LN probes created       : {stats['ln_probes']}")
    log.info(f"  blocks created          : {stats['blocks']}")
    log.info(f"  scans registered        : {stats['scans']}")
    log.info(f"  slides linked           : {stats['slides_linked']}")
    log.info(f"  skipped (Study_ID not in sheet / no T-number): {stats['slides_no_sheet']}")
    log.info(f"  skipped (T-number not in loaded cohort)      : {stats['slides_no_match']}")
    log.info("=" * 60)
    return stats


def main():
    ap = argparse.ArgumentParser(description="Register Radboud lymph-node slides onto existing patients")
    ap.add_argument("--clinical", default=DEFAULT_CLINICAL)
    ap.add_argument("--image-root", default=DEFAULT_IMAGE_ROOT)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    if not Path(args.clinical).exists():
        log.error(f"Sheet not found: {args.clinical}"); sys.exit(1)
    if not Path(args.image_root).is_dir():
        log.error(f"Image root not found: {args.image_root}"); sys.exit(1)
    if args.dry_run:
        log.info("DRY RUN — no data will be written")

    load_dotenv()
    db_url = os.getenv("DATABASE_URL")
    if not db_url:
        log.error("DATABASE_URL not set"); sys.exit(1)
    conn = psycopg2.connect(db_url)
    try:
        load(args.clinical, args.image_root, conn, args.dry_run)
    except Exception as exc:
        conn.rollback()
        log.error(f"LN import failed: {exc}", exc_info=True)
        sys.exit(1)
    finally:
        conn.close()


if __name__ == "__main__":
    main()
