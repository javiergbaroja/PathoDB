#!/usr/bin/env python3
"""
PathoDB ETL Import Script
=========================
Loads PathoWin CSV exports into the PathoDB PostgreSQL database.

Import order (respects foreign key dependencies):
  1. patients      — derived from submissions.csv
  2. submissions   — from submissions.csv
  3. reports       — from submissions.csv (Diagnose + Makro columns)
  4. probes        — derived from blocks.csv (unique Probe values)
  5. blocks        — from blocks.csv
  6. stains        — pre-populated from known vocabulary, then auto-created
  7. scans         — from scans.csv, linked via submission → probe → block

All inserts are idempotent (ON CONFLICT DO NOTHING).
Re-running the script on the same data is safe.

Usage:
    python etl.py \\
        --submissions path/to/submissions.csv \\
        --blocks      path/to/blocks.csv \\
        --scans       path/to/scans.csv

    # Dry run (parse and validate without writing to DB):
    python etl.py --submissions ... --blocks ... --scans ... --dry-run

Requirements:
    pip install -r requirements.txt
"""

import argparse
import json
import logging
import os
import sys
from pathlib import Path
from typing import Optional

import pandas as pd
import psycopg2
from dotenv import load_dotenv
from tqdm import tqdm

# ─── Logging ──────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("pathodb_etl")


# ─── Constants ────────────────────────────────────────────────────────────────

# Pre-populate these stains on every run (idempotent).
# Add more entries here as the team's vocabulary grows.
# Format: (canonical_name, category, [aliases])
KNOWN_STAINS = [
    ("H&E",              "HE",            ["HE", "H+E", "H and E", "Hematoxylin Eosin", "Haematoxylin Eosin", "H&E"]),
    ("PAS",              "special_stain", ["PAS", "PAS stain", "Periodic acid-Schiff"]),
    ("PAS-D",            "special_stain", ["PASD", "PAS-diastase", "PAS diastase"]),
    ("Masson",           "special_stain", ["Masson", "Masson trichrome", "Trichrome", "MT", "Masson-Tri"]),
    ("Sirius Red",       "special_stain", ["Sirius Red", "Sirius red", "SR"]),
    ("Giemsa",           "special_stain", ["Giemsa", "Giemsa stain"]),
    ("Alcian Blue",      "special_stain", ["AB", "Alcian Blue", "Alcian blue"]),
    ("Congo Red",        "special_stain", ["Congo Red", "Congo red", "CR"]),
    ("Ziehl-Neelsen",    "special_stain", ["Ziehl-Neelsen", "ZN", "Ziehl Neelsen", "AFB"]),
    ("Gomori",           "special_stain", ["Gomori", "GMS", "Grocott", "Gomori methenamine silver"]),
    ("Elastica",         "special_stain", ["Elastica", "EVG", "Elastica van Gieson", "Elastic"]),
    ("DAB",              "special_stain", ["DAB"]),
    ("Prussian Blue",    "special_stain", ["Prussian Blue", "PB", "Fe"]),
    ("Reticulin",        "special_stain", ["Reticulin", "Ret", "Retic"]),

    ("CD3",              "IHC",           ["CD3"]),
    ("CD4",              "IHC",           ["CD4"]),
    ("CD8",              "IHC",           ["CD8"]),
    ("CD20",             "IHC",           ["CD20", "L26"]),
    ("CD31",             "IHC",           ["CD31"]),
    ("CD34",             "IHC",           ["CD34"]),
    ("CD45",             "IHC",           ["CD45"]),
    ("CD56",             "IHC",           ["CD56"]),
    ("CD68",             "IHC",           ["CD68", "PGM1", "KP1"]),
    ("CD138",            "IHC",           ["CD138"]),

    ("Ki67",             "IHC",           ["Ki67", "MIB-1", "MIB1", "Ki-67"]),
    ("p53",              "IHC",           ["p53", "TP53"]),
    ("p16",              "IHC",           ["p16"]),

    ("AE1/AE3",          "IHC",           ["AE1/AE3", "AE1AE3", "AE1-AE3", "AE1_AE3", "Pan-CK", "Pan-Keratin", "Pan Keratin", "CKAE1", "CKPan"]),
    ("CK7",              "IHC",           ["CK7", "Keratin 7"]),
    ("CK20",             "IHC",           ["CK20", "Keratin 20"]),
    ("SMA",              "IHC",           ["SMA", "Alpha-SMA", "Smooth muscle actin", "ASMA"]),
    ("Vimentin",         "IHC",           ["Vimentin"]),
    ("S100",             "IHC",           ["S100", "S-100"]),
    ("SOX10",            "IHC",           ["SOX10"]),
    ("Desmin",           "IHC",           ["Desmin"]),
    ("TTF1",             "IHC",           ["TTF1", "TTF-1", "NKX2.1"]),
    ("Synaptophysin",    "IHC",           ["Synaptophysin", "SYN", "Syn", "Synap"]),
    ("Chromogranin",     "IHC",           ["Chromogranin", "CgA", "Chromogranin A", "Chromo"]),

    ("MLH1",             "IHC",           ["MLH1"]),
    ("MSH2",             "IHC",           ["MSH2"]),
    ("MSH6",             "IHC",           ["MSH6"]),
    ("PMS2",             "IHC",           ["PMS2"]),

    ("Ber-EP4",          "IHC",           ["Ber-EP4"]),
    ("TWIST1",           "IHC",           ["TWIST1"]),
    ("D2-40",            "IHC",           ["D2-40", "D240"]),
    ("Calretinin",       "IHC",           ["Calretinin", "Calret"]),
    ("Melan-A",          "IHC",           ["Melan-A", "MelA"]),
    ("ER",               "IHC",           ["ER"]),
    ("PR",               "IHC",           ["PR"]),
    ("HER2",             "IHC",           ["HER2"]),
    ("CDX2",             "IHC",           ["CDX2"]),
    ("ALK",              "IHC",           ["ALK"]),
    ("IL33",             "IHC",           ["IL33"]),
    ("COX2",             "IHC",           ["COX2"]),
    # add empty string as special stain
    ("unmatched",                 "special_stain",       [""]),
]

SEX_MAP = {
    "männlich": "M",
    "weiblich":  "F",
    "unbekannt": "U",
    "male":      "M",
    "female":    "F",
    "unknown":   "U",
    "m":         "M",
    "f":         "F",
    "w":         "F",   # German abbreviation for weiblich
    "divers":    "U",
}


# ─── Database helpers ──────────────────────────────────────────────────────────

class NullCursor:
    """A no-op cursor used in dry-run mode. All DB calls are silently ignored."""
    rowcount = 0
    def execute(self, *a, **kw): pass
    def fetchone(self): return None
    def fetchall(self): return []
    def close(self): pass
    def __enter__(self): return self
    def __exit__(self, *a): pass


class NullConnection:
    """A no-op connection used in dry-run mode. Absorbs all DB operations."""
    def cursor(self): return NullCursor()
    def commit(self): pass
    def rollback(self): pass
    def close(self): pass

def get_connection(db_url: str):
    try:
        conn = psycopg2.connect(db_url)
        log.info("Database connection established.")
        return conn
    except psycopg2.OperationalError as e:
        log.error(f"Cannot connect to database: {e}")
        sys.exit(1)


def read_csv(filepath: str) -> pd.DataFrame:
    """Read CSV trying common encodings for German-language content."""
    for enc in ("utf-8", "utf-8-sig", "latin-1", "cp1252"):
        try:
            df = pd.read_csv(filepath, encoding=enc, dtype=str) if filepath.endswith(".csv") else pd.read_excel(filepath)
            df.columns = df.columns.str.strip()
            log.info(f"Read {Path(filepath).name!r} — encoding={enc}, {len(df)} rows")
            return df
        except UnicodeDecodeError:
            continue
    raise ValueError(f"Could not read {filepath!r} with any known encoding")


def clean(val) -> Optional[str]:
    """Return stripped string or None for blank/NaN values."""
    if val is None:
        return None
    s = str(val).strip()
    return None if s.lower() in ("nan", "none", "") else s


def parse_date(val) -> Optional[str]:
    """Parse PathoWin date strings ('01/01/2020  00:00:00') to ISO date."""
    s = clean(val)
    if s is None:
        return None
    from datetime import datetime
    for fmt in (
        "%d/%m/%Y  %H:%M:%S",
        "%d/%m/%Y %H:%M:%S",
        "%d/%m/%Y",
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%d",
    ):
        try:
            return datetime.strptime(s, fmt).strftime("%Y-%m-%d")
        except ValueError:
            continue
    log.warning(f"  Could not parse date value: {s!r}")
    return None


def clean_format(val) -> Optional[str]:
    """Strip leading dot from file format string."""
    s = clean(val)
    return s.lstrip(".").upper() if s else None


def normalize_stain(name: str) -> str:
    """Normalize stain name for fuzzy matching (uppercase, strip punctuation)."""
    return (
        name.strip().upper()
        .replace("&", "").replace("+", "").replace("-", "")
        .replace(" ", "").replace("_", "")
    )


# ─── Phase 0: Stains ──────────────────────────────────────────────────────────

def load_stains(conn, dry_run: bool) -> dict:
    """
    Pre-populate stains controlled vocabulary.
    Returns a normalized_name → stain_id lookup map including all aliases.
    """
    """
    Pre-populate stains controlled vocabulary.
    Returns a normalized_name → stain_id lookup map including all aliases.
    """
    cur = conn.cursor()
    inserted = 0

    for name, category, aliases in KNOWN_STAINS:
        cur.execute(
            """
            INSERT INTO stains (stain_name, stain_category, aliases, needs_review)
            VALUES (%s, %s, %s, FALSE)
            ON CONFLICT (stain_name) DO NOTHING
            """,
            (name, category, aliases),
        )
        if cur.rowcount:
            inserted += 1

    conn.commit()

    # Build lookup map from DB (returns [] in dry-run via NullCursor)
    stain_map = {}
    cur.execute("SELECT id, stain_name, aliases FROM stains")
    for sid, sname, aliases in cur.fetchall():
        stain_map[normalize_stain(sname)] = sid
        for alias in (aliases or []):
            stain_map[normalize_stain(alias)] = sid

    cur.close()
    log.info(f"Stains: {inserted} inserted from known vocabulary | {len(stain_map)} lookup entries")
    return stain_map


def resolve_stain(name: str, stain_map: dict, conn, dry_run: bool) -> tuple:
    """
    Resolve a raw stain string to a stain_id.
    Creates a new stain with needs_review=TRUE if not found.
    Returns (stain_id, was_created).
    """
    if not name:
        return None, False

    key = normalize_stain(name)
    if key in stain_map:
        return stain_map[key], False

    if dry_run:
        log.warning(f"  [DRY RUN] Would auto-create unreviewed stain: {name!r}")
        return None, True

    cur = conn.cursor()
    cur.execute(
        """
        INSERT INTO stains (stain_name, stain_category, aliases, needs_review)
        VALUES (%s, 'other', '{}', TRUE)
        ON CONFLICT (stain_name) DO UPDATE SET needs_review = TRUE
        RETURNING id
        """,
        (name.strip(),),
    )
    sid = cur.fetchone()[0]
    conn.commit()
    stain_map[key] = sid
    cur.close()
    return sid, True


# ─── Phase 1: Submissions ─────────────────────────────────────────────────────

def load_submissions(filepath: str, conn, dry_run: bool) -> tuple:
    """
    Parse submissions CSV → insert patients, submissions, reports.
    Returns:
        submission_map: {lis_submission_id → submission_id}
        stats dict
    """
    df = read_csv(filepath)
    submission_map = {}
    stats = {
        "patients_inserted":     0,
        "submissions_inserted":  0,
        "reports_inserted":      0,
        "rows_skipped":          0,
        "warnings":              [],
    }

    cur = conn.cursor()
    BATCH_SIZE = 500

    for idx, row in tqdm(df.iterrows(), total=len(df), desc="  Submissions"):

        # ── Patient ──────────────────────────────────────────────────────────
        patient_code = clean(row.get("Patienten-ID"))
        if not patient_code:
            msg = f"Row {idx}: missing Patienten-ID — skipped"
            stats["warnings"].append(msg)
            stats["rows_skipped"] += 1
            continue

        dob      = parse_date(row.get("Geburtsdatum"))
        sex_raw  = clean(row.get("Geschlecht")) or ""
        sex      = SEX_MAP.get(sex_raw.lower(), "U")

        if not dry_run:
            cur.execute(
                """
                INSERT INTO patients (patient_code, date_of_birth, sex)
                VALUES (%s, %s, %s)
                ON CONFLICT (patient_code) DO NOTHING
                """,
                (patient_code, dob, sex),
            )
            if cur.rowcount:
                stats["patients_inserted"] += 1

            cur.execute("SELECT id FROM patients WHERE patient_code = %s", (patient_code,))
            patient_id = cur.fetchone()[0]
        else:
            patient_id = -1  # placeholder for dry run

        # ── Submission ───────────────────────────────────────────────────────
        lis_sub_id = clean(row.get("Einsendung"))
        if not lis_sub_id:
            msg = f"Row {idx}: missing Einsendung for patient {patient_code} — skipped"
            stats["warnings"].append(msg)
            stats["rows_skipped"] += 1
            continue

        report_date    = parse_date(row.get("Freigabedatum"))
        malignancy_raw = clean(row.get("Malignom auf Einsendung")) or ""
        malignancy     = (
            True  if malignancy_raw.lower() == "ja"   else
            False if malignancy_raw.lower() == "nein" else
            None
        )
        consent = clean(row.get("Konsens"))

        if not dry_run:
            cur.execute(
                """
                INSERT INTO submissions
                    (patient_id, lis_submission_id, report_date, malignancy_flag, consent)
                VALUES (%s, %s, %s, %s, %s)
                ON CONFLICT (lis_submission_id) DO NOTHING
                RETURNING id
                """,
                (patient_id, lis_sub_id, report_date, malignancy, consent),
            )
            result = cur.fetchone()
            if result:
                stats["submissions_inserted"] += 1

            cur.execute(
                "SELECT id FROM submissions WHERE lis_submission_id = %s",
                (lis_sub_id,),
            )
            sub_id = cur.fetchone()[0]
            submission_map[lis_sub_id] = sub_id
        else:
            submission_map[lis_sub_id] = -1

        # ── Reports ──────────────────────────────────────────────────────────
        for col, rtype in [("Diagnose", "microscopy"), ("Makro", "macro")]:
            text = clean(row.get(col))
            if text:
                if not dry_run:
                    cur.execute(
                        """
                        INSERT INTO reports
                            (submission_id, report_type, report_text, report_date)
                        VALUES (%s, %s, %s, %s)
                        ON CONFLICT (submission_id, report_type) DO NOTHING
                        """,
                        (sub_id, rtype, text, report_date),
                    )
                    if cur.rowcount:
                        stats["reports_inserted"] += 1

        # Commit every BATCH_SIZE rows to avoid large in-memory transactions
        if not dry_run and idx % BATCH_SIZE == 0:
            conn.commit()

    if not dry_run:
        conn.commit()
    cur.close()

    log.info(
        f"  Patients: {stats['patients_inserted']} inserted | "
        f"Submissions: {stats['submissions_inserted']} inserted | "
        f"Reports: {stats['reports_inserted']} inserted | "
        f"Skipped rows: {stats['rows_skipped']}"
    )
    _log_warnings(stats["warnings"])
    return submission_map, stats


# ─── Phase 2: Blocks (and derived probes) ─────────────────────────────────────

def load_blocks(filepath: str, conn, submission_map: dict, dry_run: bool) -> tuple:
    """
    Parse blocks CSV → insert probes (derived) and blocks.
    Returns:
        probe_map:  {(lis_submission_id, lis_probe_id) → probe_id}
        block_map:  {probe_id → {block_label → block_id}}
        stats dict
    """
    df = read_csv(filepath)
    probe_map = {}
    block_map = {}
    stats = {
        "probes_inserted": 0,
        "blocks_inserted": 0,
        "warnings":        [],
    }

    cur = conn.cursor()
    BATCH_SIZE = 500

    # ── Pass 1: derive unique probes ──────────────────────────────────────────
    probe_cols = [
        "Probe", "Einsendung",
        "Art des Materials - Bezeichnung",
        "Topographie - Code",
        "Topographie - Bezeichnung",
        "Zusatzinformation Lokalisation",
    ]
    probes_df = df[probe_cols].drop_duplicates(subset=["Probe", "Einsendung"])

    for _, prow in tqdm(probes_df.iterrows(), total=len(probes_df), desc="  Probes"):
        lis_probe_id = clean(prow.get("Probe"))
        lis_sub_id   = clean(prow.get("Einsendung"))

        if not lis_probe_id or not lis_sub_id:
            stats["warnings"].append(f"Probe row missing Probe or Einsendung — skipped: {prow.to_dict()}")
            continue

        sub_id = submission_map.get(lis_sub_id)
        if sub_id is None:
            stats["warnings"].append(
                f"Probe {lis_probe_id!r}: submission {lis_sub_id!r} not found — skipped"
            )
            continue

        submission_type     = clean(prow.get("Art des Materials - Bezeichnung"))
        snomed_topo_code    = clean(prow.get("Topographie - Code"))
        topo_description    = clean(prow.get("Topographie - Bezeichnung"))
        location_additional = clean(prow.get("Zusatzinformation Lokalisation"))

        if not dry_run:
            cur.execute(
                """
                INSERT INTO probes
                    (submission_id, lis_probe_id, submission_type,
                     snomed_topo_code, topo_description, location_additional)
                VALUES (%s, %s, %s, %s, %s, %s)
                ON CONFLICT (submission_id, lis_probe_id) DO NOTHING
                RETURNING id
                """,
                (sub_id, lis_probe_id, submission_type,
                 snomed_topo_code, topo_description, location_additional),
            )
            if cur.rowcount:
                stats["probes_inserted"] += 1

            cur.execute(
                "SELECT id FROM probes WHERE submission_id = %s AND lis_probe_id = %s",
                (sub_id, lis_probe_id),
            )
            probe_id = cur.fetchone()[0]
        else:
            probe_id = -abs(hash((lis_sub_id, lis_probe_id)))  # stable placeholder

        probe_map[(lis_sub_id, lis_probe_id)] = probe_id
        block_map[probe_id] = {}

    if not dry_run:
        conn.commit()

    # ── Pass 2: blocks ────────────────────────────────────────────────────────
    for idx, brow in tqdm(df.iterrows(), total=len(df), desc="  Blocks"):
        lis_probe_id = clean(brow.get("Probe"))
        lis_sub_id   = clean(brow.get("Einsendung"))
        block_label  = clean(brow.get("Blockbezeichnung"))
        block_info   = clean(brow.get("Blockinfo_Expanded"))

        block_seq = None
        try:
            raw_seq = clean(brow.get("Block"))
            if raw_seq:
                block_seq = int(float(raw_seq))
        except (ValueError, TypeError):
            pass

        tissue_count = None
        try:
            raw_tc = clean(brow.get("Anzahl Gewebe"))
            if raw_tc:
                tissue_count = int(float(raw_tc))
        except (ValueError, TypeError):
            pass

        # Fallback: use sequence number as label if label is absent
        if not block_label:
            block_label = str(block_seq) if block_seq is not None else "A"
            stats["warnings"].append(
                f"Row {idx}: no Blockbezeichnung for probe {lis_probe_id!r} — using {block_label!r}"
            )

        probe_id = probe_map.get((lis_sub_id, lis_probe_id))
        if probe_id is None:
            stats["warnings"].append(
                f"Row {idx}: block {block_label!r} references unknown probe {lis_probe_id!r} — skipped"
            )
            continue

        if not dry_run:
            cur.execute(
                """
                INSERT INTO blocks
                    (probe_id, block_label, block_sequence, block_info, tissue_count)
                VALUES (%s, %s, %s, %s, %s)
                ON CONFLICT (probe_id, block_label) DO NOTHING
                RETURNING id
                """,
                (probe_id, block_label, block_seq, block_info, tissue_count),
            )
            if cur.rowcount:
                stats["blocks_inserted"] += 1
                block_id = cur.fetchone() or None
                if block_id:
                    block_map.setdefault(probe_id, {})[block_label] = block_id[0]
            else:
                # Already exists — fetch and cache
                cur.execute(
                    "SELECT id FROM blocks WHERE probe_id = %s AND block_label = %s",
                    (probe_id, block_label),
                )
                result = cur.fetchone()
                if result:
                    block_map.setdefault(probe_id, {})[block_label] = result[0]

        # Commit every BATCH_SIZE rows
        if not dry_run and idx % BATCH_SIZE == 0:
            conn.commit()

    if not dry_run:
        conn.commit()
    cur.close()

    log.info(
        f"  Probes: {stats['probes_inserted']} inserted | "
        f"Blocks: {stats['blocks_inserted']} inserted"
    )
    _log_warnings(stats["warnings"])
    return probe_map, block_map, stats


# ─── Phase 3: Scans ───────────────────────────────────────────────────────────

def extract_year(b_case: str) -> int:
    """
    Extract the year from a b_case string.
    Handles formats: B2004.123, B2012.456, B2018.789
    Returns 0 if not parseable.
    """
    import re
    m = re.search(r'B(\d{4})\.', b_case or "", re.IGNORECASE)
    return int(m.group(1)) if m else 0


def resolve_probe_for_scan(
    b_case: str,
    probe_raw: str,
    submission_map: dict,
    probe_map: dict,
    sub_to_probes: dict,
) -> tuple:
    """
    Resolve a scan row to a (sub_id, probe_id) pair using era-aware logic.

    Three strategies are tried in order, falling back to the next if no match:

    Strategy 1 — Pre-2011 (b_case is a submission ID):
        b_case → submission, then probe from submission context.
        Used for year <= 2011.

    Strategy 2 — 2011-2017 (b_case IS the probe's lis_probe_id):
        b_case → lis_probe_id directly in probe_map.
        Used for year 2011-2017.

    Strategy 3 — Post-2017 (composite: b_case + zero-padded probe numeral):
        f"{b_case}/{int(probe_raw):03d}" → lis_probe_id.
        Used for year >= 2017.

    Boundary years 2011 and 2017 are handled by trying both adjacent
    strategies, so mid-year format changes are covered automatically.

    Returns (sub_id, probe_id) or (None, None) if no strategy succeeds.
    """
    year = extract_year(b_case)

    # ── Strategy 1: b_case matches submission ID ──────────────────────────────
    def try_submission_match():
        sub_id = submission_map.get(b_case)
        if sub_id is None:
            return None, None
        # If probe_raw given, look for it within this submission
        if probe_raw:
            pid = probe_map.get((b_case, probe_raw))
            if pid:
                return sub_id, pid
            # Case-insensitive fallback
            for (sk, pk), pid in probe_map.items():
                if sk == b_case and pk.upper() == probe_raw.upper():
                    return sub_id, pid
        # No probe_raw or not found — auto-resolve if only one probe
        probe_ids = sub_to_probes.get(sub_id, [])
        if len(probe_ids) == 1:
            return sub_id, probe_ids[0]
        return sub_id, None  # sub found but probe ambiguous

    # ── Strategy 2: b_case matches lis_probe_id directly ─────────────────────
    def try_probe_direct_match():
        # Search probe_map for any entry whose lis_probe_id == b_case
        for (sk, pk), pid in probe_map.items():
            if pk == b_case:
                return submission_map.get(sk), pid
        return None, None

    # ── Strategy 3: composite b_case/NNN matches lis_probe_id ────────────────
    def try_composite_match():
        if not probe_raw:
            return None, None
        try:
            padded = f"{int(probe_raw):03d}"
        except (ValueError, TypeError):
            return None, None
        composite = f"{b_case}/{padded}"
        for (sk, pk), pid in probe_map.items():
            if pk == composite:
                return submission_map.get(sk), pid
        return None, None

    # ── Try strategies based on era, with overlap at boundaries ──────────────
    if year <= 2011:
        strategies = [try_submission_match, try_probe_direct_match]
    elif year <= 2017:
        strategies = [try_probe_direct_match, try_submission_match, try_composite_match]
    else:
        strategies = [try_composite_match, try_probe_direct_match]

    for strategy in strategies:
        sub_id, probe_id = strategy()
        if probe_id is not None:
            return sub_id, probe_id

    # Nothing worked — return sub_id only if we at least found the submission
    sub_id = submission_map.get(b_case)
    return sub_id, None


def load_scans(
    filepath: str,
    conn,
    submission_map: dict,
    probe_map: dict,
    block_map: dict,
    stain_map: dict,
    dry_run: bool,
    year: Optional[int] = None,
) -> dict:
    """
    Parse scans CSV → insert scans, resolving to block_id via era-aware
    probe resolution and then block matching within that probe.

    Era logic (based on year in b_case):
      ≤ 2011 : b_case = submission ID
      2011-17: b_case = probe lis_probe_id directly
      ≥ 2017 : b_case + zero-padded probe numeral = composite lis_probe_id
    """
    df = read_csv(filepath)
    # if b_year is larger than 2017 and probe is empty, fill with a 1
    na_or_empty_probe_mask = df["probe"].isna() | (df["probe"].str.strip() == "")
    df.loc[na_or_empty_probe_mask & (df["b_case"].apply(extract_year) > 2017), "probe"] = "1"
    # b_case can be 'B2025.00042', we need to remove trailing zeros to match correctly with the probe lis_probe_id in probe_map
    df["b_case"] = df["b_case"].str.replace(r'\.(0+)(\d+)$', r'.\2', regex=True)
    # keep only rows belonging to year if specified
    if year:
        df = df[df["b_case"].apply(lambda x: extract_year(x) == year)].reset_index(drop=True)
    stats = {
        "scans_inserted":    0,
        "stains_created":    0,
        "unlinked":          0,
        "unlinked_no_sub":   0,
        "unlinked_no_probe": 0,
        "unlinked_no_block": 0,
        "warnings":          [],
    }

    cur = conn.cursor()
    BATCH_SIZE = 100

    # probe_id → [block_id, ...] ordered by sequence then id
    probe_to_blocks: dict = {}
    # submission lis_id → [probe_id, ...]
    sub_to_probes: dict = {}

    cur.execute("SELECT id, submission_id FROM probes ORDER BY id")
    for pid, sid in cur.fetchall():
        sub_to_probes.setdefault(sid, []).append(pid)

    cur.execute(
        "SELECT id, probe_id FROM blocks ORDER BY block_sequence NULLS LAST, id"
    )
    for bid, pid in cur.fetchall():
        probe_to_blocks.setdefault(pid, []).append(bid)

    for idx, row in tqdm(df.iterrows(), total=len(df), desc="  Scans"):

        b_case    = clean(row.get("b_case"))
        probe_raw = clean(row.get("probe")) or ""
        block_raw = clean(row.get("block")) or ""
        stain_raw = clean(row.get("stain")) or ""
        filename  = clean(row.get("filename"))
        folder    = clean(row.get("folder")) or ""
        fmt_raw   = clean(row.get("format"))

        if not b_case or not filename:
            stats["warnings"].append(f"Row {idx}: missing b_case or filename — skipped")
            stats["unlinked"] += 1
            continue
        if stain_raw == "":
            stats["warnings"].append(f"Row {idx}: empty stain value treated as missing — added as 'unmatched'")
            stats["unlinked"] += 1
            stain_raw = "unmatched"
        # ── Era-aware probe resolution ────────────────────────────────────────
        sub_id, probe_id = resolve_probe_for_scan(
            b_case, probe_raw, submission_map, probe_map, sub_to_probes
        )

        if sub_id is None:
            stats["warnings"].append(
                f"Row {idx}: {b_case!r} not found as submission or probe ID — skipped"
            )
            stats["unlinked"] += 1
            stats["unlinked_no_sub"] += 1
            continue

        if probe_id is None:
            stats["warnings"].append(
                f"Row {idx}: submission {b_case!r} found but probe could not be resolved "
                f"(probe_raw={probe_raw!r}, year={extract_year(b_case)}) — skipped"
            )
            stats["unlinked"] += 1
            stats["unlinked_no_probe"] += 1
            continue

        # ── Resolve block ─────────────────────────────────────────────────────
        block_id = None

        if block_raw:
            block_id = block_map.get(probe_id, {}).get(block_raw)
            if block_id is None:
                for blabel, bid in block_map.get(probe_id, {}).items():
                    if blabel.upper() == block_raw.upper():
                        block_id = bid
                        break

        if block_id is None:
            block_ids = probe_to_blocks.get(probe_id, [])
            if len(block_ids) == 1:
                block_id = block_ids[0]
            elif len(block_ids) == 0:
                stats["warnings"].append(
                    f"Row {idx}: no blocks found for probe_id {probe_id} — skipped"
                )
                stats["unlinked"] += 1
                stats["unlinked_no_block"] += 1
                continue
            else:
                stats["warnings"].append(
                    f"Row {idx}: block {block_raw!r} unmatched and probe_id "
                    f"{probe_id} has {len(block_ids)} blocks — cannot auto-resolve, skipped"
                )
                stats["unlinked"] += 1
                stats["unlinked_no_block"] += 1
                continue

        # ── Resolve stain ─────────────────────────────────────────────────────
        stain_id, was_created = resolve_stain(stain_raw, stain_map, conn, dry_run)
        if was_created:
            stats["stains_created"] += 1
        if stain_id is None and not dry_run:
            stats["warnings"].append(f"Row {idx}: could not resolve stain {stain_raw!r} — skipped")
            stats["unlinked"] += 1
            continue

        # ── Build file path ───────────────────────────────────────────────────
        file_path   = (folder.rstrip("/") + "/" + filename) if folder else filename
        file_format = clean_format(fmt_raw)

        # ── Insert scan ───────────────────────────────────────────────────────
        if not dry_run:
            cur.execute(
                """
                INSERT INTO scans
                    (block_id, stain_id, file_path, file_format, magnification, registered_by)
                VALUES (%s, %s, %s, %s, NULL, NULL)
                ON CONFLICT (file_path) DO NOTHING
                RETURNING id
                """,
                (block_id, stain_id, file_path, file_format),
            )
            if cur.fetchone():
                stats["scans_inserted"] += 1

        # Commit every BATCH_SIZE rows
        if not dry_run and idx % BATCH_SIZE == 0:
            conn.commit()

    if not dry_run:
        conn.commit()
    cur.close()

    log.info(
        f"  Scans: {stats['scans_inserted']} inserted | "
        f"Stains auto-created: {stats['stains_created']} (needs_review=TRUE) | "
        f"Unlinked: {stats['unlinked']}"
    )
    _log_warnings(stats["warnings"])
    return stats


# ─── Import log ───────────────────────────────────────────────────────────────

def write_import_log(conn, all_stats: dict):
    """Write a summary record to the import_log table."""
    cur = conn.cursor()
    for source_file, entity_stats in all_stats.items():
        for entity_type, stats in entity_stats.items():
            cur.execute(
                """
                INSERT INTO import_log
                    (source_file, entity_type, records_processed,
                     records_inserted, records_skipped, warnings, errors)
                VALUES (%s, %s, %s, %s, %s, %s, %s)
                """,
                (
                    source_file,
                    entity_type,
                    stats.get("processed", 0),
                    stats.get("inserted", 0),
                    stats.get("skipped", 0),
                    json.dumps(stats.get("warnings", [])),
                    json.dumps(stats.get("errors", [])),
                ),
            )
    conn.commit()
    cur.close()


# ─── Helpers ──────────────────────────────────────────────────────────────────

def _log_warnings(warnings: list):
    if not warnings:
        return
    log.warning(f"  {len(warnings)} warning(s):")
    for w in warnings[:10]:
        log.warning(f"    • {w}")
    if len(warnings) > 10:
        log.warning(f"    ... and {len(warnings) - 10} more (run with --verbose to see all)")


def print_summary(sub_stats, block_stats, scan_stats):
    log.info("")
    log.info("=" * 60)
    log.info("IMPORT SUMMARY")
    log.info("=" * 60)
    log.info(f"  Patients inserted:      {sub_stats['patients_inserted']}")
    log.info(f"  Submissions inserted:   {sub_stats['submissions_inserted']}")
    log.info(f"  Reports inserted:       {sub_stats['reports_inserted']}")
    log.info(f"  Probes inserted:        {block_stats['probes_inserted']}")
    log.info(f"  Blocks inserted:        {block_stats['blocks_inserted']}")
    log.info(f"  Scans inserted:         {scan_stats['scans_inserted']}")
    log.info(f"  Stains auto-created:    {scan_stats['stains_created']}  ← review these in the Admin UI")
    log.info(f"  Scans unlinked:         {scan_stats['unlinked']}  ← see breakdown below")
    if scan_stats['unlinked'] > 0:
        log.info(f"    - No submission/probe found: {scan_stats.get('unlinked_no_sub', 0)}")
        log.info(f"    - Submission found, probe ambiguous: {scan_stats.get('unlinked_no_probe', 0)}")
        log.info(f"    - Probe found, block ambiguous: {scan_stats.get('unlinked_no_block', 0)}")
    total_warnings = (
        len(sub_stats.get("warnings", []))
        + len(block_stats.get("warnings", []))
        + len(scan_stats.get("warnings", []))
    )
    log.info(f"  Total warnings:         {total_warnings}")
    log.info("=" * 60)

    if scan_stats['stains_created'] > 0:
        log.info("")
        log.info("ACTION REQUIRED: Some stains were auto-created with needs_review=TRUE.")
        log.info("  Once the API is running, visit Admin → Stains to categorise them.")

    if scan_stats['unlinked'] > 0:
        log.info("")
        log.info("ACTION REQUIRED: Some scans could not be linked to a block.")
        log.info("  Check the warnings above and correct the source data, then re-run.")


# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="PathoDB ETL — import PathoWin CSV exports into PostgreSQL"
    )
    parser.add_argument("--submissions", required=True, help="Path to submissions CSV")
    parser.add_argument("--blocks",      required=True, help="Path to blocks CSV")
    parser.add_argument("--scans",       required=True, help="Path to scans CSV")
    parser.add_argument("--year",        required=True, help="Year of the data", type=int)
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Parse and validate files without writing to the database",
    )
    args = parser.parse_args()

    for label, path in [
        ("submissions", args.submissions),
        ("blocks",      args.blocks),
        ("scans",       args.scans),
    ]:
        if not Path(path).exists():
            log.error(f"File not found [{label}]: {path!r}")
            sys.exit(1)

    if args.dry_run:
        log.info("DRY RUN MODE — no data will be written to the database")

    if args.dry_run:
        conn = NullConnection()
    else:
        load_dotenv()
        db_url = os.getenv("DATABASE_URL")
        if not db_url:
            log.error("DATABASE_URL not set. Copy .env.example to .env and fill in your values.")
            sys.exit(1)
        conn = get_connection(db_url)

    try:
        log.info("=" * 60)
        log.info("PHASE 0 — Stains vocabulary")
        stain_map = load_stains(conn, args.dry_run)

        log.info("=" * 60)
        log.info("PHASE 1 — Submissions (patients + submissions + reports)")
        submission_map, sub_stats = load_submissions(args.submissions, conn, args.dry_run)

        log.info("=" * 60)
        log.info("PHASE 2 — Blocks (probes derived + blocks)")
        probe_map, block_map, block_stats = load_blocks(
            args.blocks, conn, submission_map, args.dry_run
        )

        log.info("=" * 60)
        log.info("PHASE 3 — Scans")
        scan_stats = load_scans(
            args.scans, conn, submission_map, probe_map, block_map, stain_map, args.dry_run, args.year
        )

        print_summary(sub_stats, block_stats, scan_stats)

        if conn and not args.dry_run:
            log.info("")
            log.info("Next step: once embeddings are generated, create the vector index:")
            log.info("  See the commented CREATE INDEX at the bottom of db/schema.sql")

    except Exception as exc:
        conn.rollback()
        log.error(f"Import failed: {exc}", exc_info=True)
        sys.exit(1)

    finally:
        conn.close()


if __name__ == "__main__":
    main()
