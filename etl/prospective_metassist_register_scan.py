#!/usr/bin/env python3
"""
PathoDB ETL Worker
==================
Runs inside a SLURM job. Reads a context file, connects to PostgreSQL,
and dispatches to the correct import handler (submissions, blocks, scans).
Writes progress.json sidecar for real-time frontend polling.

Usage (called by run_etl.sh):
    python etl_worker.py /path/to/etl_context.json
"""
import openslide
import json
import logging
import os
import re
import shutil
import sys
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor
from pathlib import Path
from typing import Optional

import pandas as pd
import csv
import psycopg2

# ─── Logging ──────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("pathodb_etl_worker")


# ─── Constants ────────────────────────────────────────────────────────────────
BATCH_SIZE = 500

# Scan crawl — file extensions to include (no TIFF)
SCAN_EXTENSIONS = {".svs", ".ndpi", ".mrxs"}

# Commit mode (force-delete) — analysis result directories are only ever
# removed if they resolve inside this base. Guards against a corrupted or
# unexpected result_path value ever reaching shutil.rmtree on something it
# shouldn't. Override via ANALYSIS_RESULTS_DIR env var if the default moves.
ANALYSIS_RESULTS_DIR = Path(os.environ.get(
    "ANALYSIS_RESULTS_DIR",
    "/storage/research/igmp_dp_workspace/garciabaroja_javier/PW_reports/database/pathodb/analysis_results",
)).resolve()

# Scan crawl — filename keywords that indicate non-WSI files
NON_WSI_KEYWORDS = [
    "thumb", "thumbnail", "label", "overview", "map",
    "barcode", "preview", "histoqc", "tile", "prediction", "detection",
]

# Scan crawl — filename prefixes to exclude
EXCLUDE_PREFIXES = ("SS", "S", "E", "FSI")
EXCLUDE_STRINGS = ("TCGA", "TMA", "CRCHUG")


# Era-aware filename parsing — ported directly from build_slide_database_igmp.py
STAIN_EXCLUSIONS = r"(?:HE|PAS|SMA|EVG|AB|DAB|CKPAN|Calret|AFB|GMS|ER|PR)"
ROMAN_1_TO_20 = r"(?:XX|XIX|XVIII|XVII|XVI|XV|XIV|XIII|XII|XI|X|IX|VIII|VII|VI|V|IV|III|II|I)"
 
ERA1_PATTERN = re.compile(
    r"_(?=[A-Z])(?!" + STAIN_EXCLUSIONS + r"(?=_|$))"
    r"(?:(?P<probe>" + ROMAN_1_TO_20 + r")[_-]?)?"
    r"(?P<block>Z{0,2}[A-Z])?(?=_|$)"
)
ERA2_PATTERN = re.compile(r"_(?!" + STAIN_EXCLUSIONS + r"(?=_|$))(?P<block>[A-Z]{1,3})(?=_|$)")
ERA3_PATTERN = re.compile(
    r"_(?=[0-9A-Z])(?!" + STAIN_EXCLUSIONS + r"(?=_|$))"
    r"(?:(?P<probe>\d+)[_-]?)?(?P<block>[A-Z]{1,3})?(?=_|$)"
)
BNUMBER_PATTERN = re.compile(r"B(?P<year>\d{2,4})\.(?P<case>\d+)")


SEX_MAP = {"m": "M", "w": "F", "f": "F", "d": "O", "männlich": "M", "weiblich": "F"}

# Known stains — same as etl.py
KNOWN_STAINS = [
    ("HE",       "HE",            ["H&E", "H+E", "HES"]),
    ("Alcian Blue",       "special_stain", ["Alcian Blue", "AB", "Alcian blue"]),
    ("PAS",      "special_stain", ["PAS-D"]),
    ("EVG",      "special_stain", []),
    ("Masson",   "special_stain", ["Masson-Tri", "Masson Trichrome"]),
    ("Giemsa",      "special_stain",   ["Giemsa", "Gie"]),
    ("Helicobacter pylori", "IHC", ["hp"]),
    ("MLH1",     "IHC",           []),
    ("MSH2",     "IHC",           []),
    ("MSH6",     "IHC",           []),
    ("PMS2",     "IHC",           []),
    ("CK-Pan",   "IHC",           ["CKPan", "Pan-CK", "AE1AE3", "AE1/AE3"]),
    ("CD3",      "IHC",           []),
    ("CD8",      "IHC",           []),
    ("CD20",     "IHC",           []),
    ("CD31",     "IHC",           []),
    ("CD34",     "IHC",           []),
    ("CD56",     "IHC",           []),
    ("CD138",    "IHC",           []),
    ("Ki-67",    "IHC",           ["Ki67", "MIB1", "MIB-1"]),
    ("p53",      "IHC",           []),
    ("SMA",      "IHC",           []),
    ("S100",     "IHC",           ["S-100"]),
    ("SOX10",    "IHC",           []),
    ("HER2",     "IHC",           []),
    ("ER",       "IHC",           []),
    ("PR",       "IHC",           []),
    ("TTF-1",    "IHC",           ["TTF1"]),
    ("CDX2",     "IHC",           []),
    ("Calret",   "IHC",           ["Calretinin"]),
    ("D2-40",    "IHC",           ["D240"]),
    ("Ber-EP4",  "IHC",           ["BerEP4"]),
    ("ALK",      "IHC",           []),
]

# Stain detection list (ordered — first match wins)
POSSIBLE_STAINS = [
    "HE", "H&E", "PAS", "Masson-Tri", "EVG", "DAB", "AB",
    "MLH1", "MSH2", "MSH6", "PMS2",
    "CKPan", "Pan-CK", "AE1AE3", "AE1/AE3", "Ber-EP4",
    "SMA", "CD31", "D240", "Calret",
    "CD8", "CD138", "CD34", "CD3", "CD45", "CD20", "CD56",
    "MIB1", "Ki-67", "Ki67",
    "AFB", "GMS", "Prussian Blue", "Congo Red", "Reticulin", "ALK",
    "S100", "SOX10", "Melan-A",
    "ER", "PR", "HER2",
    "TTF-1", "TTF1", "CDX2", "Synaptophysin", "Chromogranin",
    "p53", "p16", "Gie", "hp",
]

# ─── Database Connection ─────────────────────────────────────────────────────

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


# ─── CSV Reader ──────────────────────────────────────────────────────────────

def read_csv(filepath: str) -> pd.DataFrame:
    """Read CSV or Excel, handling both ; and , separators."""
    path = Path(filepath)
    ext = path.suffix.lower()

    if ext in (".xlsx", ".xls"):
        return pd.read_excel(filepath, dtype=str)

    # Try semicolon first (PathoWin exports), fall back to comma
    try:
        df = pd.read_csv(filepath, sep=";", dtype=str, encoding="utf-8-sig")
        if len(df.columns) <= 1:
            df = pd.read_csv(filepath, sep=",", dtype=str, encoding="utf-8-sig")
    except Exception:
        df = pd.read_csv(filepath, dtype=str, encoding="utf-8-sig")

    return df


# ─── Helpers (shared with etl.py) ────────────────────────────────────────────

def clean(val) -> Optional[str]:
    if pd.isna(val) or val is None:
        return None
    s = str(val).strip()
    return s if s else None


def parse_date(val):
    if pd.isna(val) or val is None:
        return None
    s = str(val).strip()
    if not s:
        return None
    for fmt in ("%d.%m.%Y", "%Y-%m-%d", "%d/%m/%Y", "%m/%d/%Y"):
        try:
            from datetime import datetime
            return datetime.strptime(s, fmt).date()
        except ValueError:
            continue
    return None


def extract_year(lis_id: str) -> int:
    m = re.search(r"B(\d{4})\.", lis_id)
    return int(m.group(1)) if m else 0


def normalize_stain(name: str) -> str:
    return (
        name.strip().upper()
        .replace("&", "").replace("+", "").replace("-", "")
        .replace(" ", "").replace("_", "")
    )


def clean_format(fmt_raw):
    s = clean(fmt_raw)
    return s.upper().lstrip(".") if s else None


# ─── Phase 0: Stains ─────────────────────────────────────────────────────────

def load_stains(conn) -> dict:
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

    stain_map = {}
    cur.execute("SELECT id, stain_name, aliases FROM stains")
    for sid, sname, aliases in cur.fetchall():
        stain_map[normalize_stain(sname)] = sid
        for alias in (aliases or []):
            stain_map[normalize_stain(alias)] = sid

    cur.close()
    log.info(f"Stains: {inserted} new | {len(stain_map)} lookup entries")
    return stain_map


def resolve_stain(name: str, stain_map: dict, conn) -> tuple:
    if not name:
        return None, False
    key = normalize_stain(name)
    if key in stain_map:
        return stain_map[key], False

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


# ─── Phase 3: Scans (folder crawl) ───────────────────────────────────────────
def _normalize_filename(name: str) -> str:
    name = name.upper()
    name = name.replace("-", "_").replace(" ", "_")
    return re.sub(r"__+", "_", name)



def _expand_year(y: int, pivot: int = 30) -> int:
    return 2000 + y if y < pivot else 1900 + y


def _parse_slide_filename(filename: str) -> Optional[dict]:
    """
    Era-aware parser, with two additions for era-1 filenames:
      - glued probe: the probe roman numeral glued directly onto the
        case digits with no separator (e.g. "B2010.04622IV_A" — case
        "04622" runs straight into probe "IV").
      - numeric probe: some technicians used a plain arabic digit instead
        of a Roman numeral for the probe position (e.g. "B2007.489_2-L"
        instead of "B2007.489_II-L") — captured literally as a digit
        string here; whether "2" should be read as probe "II" depends on
        whether this submission actually uses Roman probe numbering at
        all, which only database context can answer (see
        fix_probe_block_mismatch.py's disambiguation layer).
    Both are checked before falling back to the normal underscore-anchored
    pattern.
 
    probe is never returned as an empty string — only None (no probe
    information could be extracted at all) or a real value. If parsing
    ever resolves a probe to "", it's normalized to "1", the same
    sentinel run_blocks() already uses for blocks-CSV rows with a
    missing probe column.
    """
    name = _normalize_filename(Path(filename).stem)
    m = BNUMBER_PATTERN.search(name)
    if m is None:
        return None
    year_raw, case = m.group("year"), m.group("case")
    year = _expand_year(int(year_raw)) if len(year_raw) == 2 else int(year_raw)
    probe, block = None, None
    r = None
    if year <= 2011:
        rest = name[m.end():]
        glued = re.match(r"^(" + ROMAN_1_TO_20 + r")(?=[_-]|$)", rest)
        if glued:
            probe = glued.group(1)
            after_probe = rest[glued.end():]
            block_match = re.match(r"^[_-]?(?P<block>Z{0,2}[A-Z])(?=_|$)", after_probe)
            block = block_match.group("block") if block_match else None
        else:
            numeric_probe = re.match(r"^_(?P<probe>\d+)[_-](?P<block>Z{0,2}[A-Z])(?=_|$)", rest)
            if numeric_probe:
                probe = numeric_probe.group("probe")
                block = numeric_probe.group("block")
            else:
                r = ERA1_PATTERN.search(name)
    elif year < 2017:
        r = ERA2_PATTERN.search(name)
    else:
        r = ERA3_PATTERN.search(name)
    if r:
        groups = r.groupdict()
        probe, block = groups.get("probe"), groups.get("block")
 
    if probe == "":
        probe = "1"
    # if case has left zeros, remove from left
    case = case.lstrip("0") or "0" 
    return {"b_year": year, "b_case": f"B{year}.{case}", "probe": probe, "block": block}




def _detect_stain(filename: str) -> Optional[str]:
    name_lower = filename.lower()
    for stain in POSSIBLE_STAINS:
        if stain.lower() in name_lower:
            return stain
    return None


def _crawl_worker(file_path_str: str, excel_sheet: pd.DataFrame) -> Optional[dict]:
    """Process a single file path (runs in subprocess)."""
    file_path = Path(file_path_str)
    name_upper = file_path.name.upper()

    # Prefix/string exclusions
    # if name_upper.startswith(EXCLUDE_PREFIXES):
    #     return None
    if any(s in name_upper for s in EXCLUDE_STRINGS):
        return None

    # Keyword filtering
    name_lower = file_path.name.lower()
    for kw in NON_WSI_KEYWORDS:
        if kw in name_lower:
            return None

    # Parse filename
    # correct name would be mapping " filename" to " pw_case", then changing forward slash for dash. " filename" includes extension
    # strip both columns of blank spaces using replace
    excel_sheet[" filename"] = excel_sheet[" filename"].str.replace(" ", "")
    excel_sheet["standard_scan_name"] = excel_sheet["standard_scan_name"].str.replace(" ", "")
    filename_mapping = dict(zip(excel_sheet[" filename"], excel_sheet["standard_scan_name"]))
    mapped_name = filename_mapping.get(file_path.name)
    # add extension from file_path.name to mapped_name
    mapped_name = f"{mapped_name}{file_path.suffix}" if mapped_name else None
    log.info(f"Mapping filename {file_path.name} to {mapped_name}")
    # print(filename_mapping)
    if mapped_name is None:
        log.warning(f"No mapping found for filename {file_path.name}")
        return {"status": "parse_failed", "filename": file_path.name}
    parsed = _parse_slide_filename(mapped_name)
    if parsed is None:
        return {"status": "parse_failed", "filename": file_path.name}

    stain = _detect_stain(mapped_name)

    return {
        "status": "ok",
        "b_year": parsed["b_year"],
        "b_case": parsed["b_case"],
        "probe": parsed["probe"],
        "block": parsed["block"],
        "stain": stain,
        "filename": file_path.name,
        "folder": str(file_path.parent),
        "format": file_path.suffix.lower().lstrip(".").upper(),
    }

def check_wsi_file(file_path: str) -> bool:
    """Check if a file is a valid WSI by attempting to open it with OpenSlide."""
    try:
        slide = openslide.open_slide(file_path)
        level_count = slide.level_count
        if level_count > 0:
            return True
        else:
            log.warning(f"WSI file {file_path} has no levels (level_count=0)")
            return False
    except Exception as e:
        log.warning(f"Failed to open WSI file {file_path}: {e}")
        return False

def run_scans(conn, result_dir=None) -> dict:
    """Crawl a folder for WSI files and register them as scans."""

    folder = "/storage/research/igmp_dp_workspace/tajbakhsh_kiarash/Dataset/Prospective_cases"
    folder = Path(folder).resolve()
    log.info(f"Crawling folder: {folder}")

    all_files = []
    for ext in SCAN_EXTENSIONS:
        all_files.extend(folder.rglob(f"*{ext}"))

    total_files = len(all_files)

    log.info(f"Checking {total_files} WSI files for validity...")
    valid_files = all_files
    # with ThreadPoolExecutor(max_workers=8) as executor:
    #     for file_path, is_valid in zip(all_files, executor.map(check_wsi_file, map(str, all_files))):
    #         if is_valid:
    #             valid_files.append(file_path)

    total_files = len(valid_files)
    all_files = valid_files
    log.info(f"Found {total_files} WSI files")

    report_rows = []  # one row per file, written to a CSV at the end

    if total_files == 0:
        return {
            "files_found": 0, "scans_inserted": 0, "parse_failed": 0,
            "unlinked": 0, "duplicate_skipped": 0, "stains_created": 0,
            "warnings": [],
        }

    cpu_count = os.cpu_count() or 4
    workers = min(cpu_count, total_files)
    file_paths = [str(f) for f in all_files]

    parsed_records = []
    parse_failed_files = []

    excel_sheet = Path(folder) / "V0ai_slides_26_09_2025_corrected_final_md.xlsx"
    excel_sheet = pd.read_excel(excel_sheet, sheet_name="Sheet1")
    # if forward slash missing in " pw_case", add at the end " pw_case"+"/1"
    excel_sheet[" pw_case"] = excel_sheet[" pw_case"].apply(lambda x: f"{x}/1" if "/" not in str(x) else str(x))
    excel_sheet["standard_scan_name"] = excel_sheet.apply(
        lambda row: f"{row[' pw_case'].replace('/', '-')}_{row[' pw_block']}_{row[' stain']}", axis=1
    )
    log.info(f"Loaded Excel sheet with {len(excel_sheet)} rows for filename mapping")

    for i, file_path in enumerate(file_paths):
        result = _crawl_worker(file_path, excel_sheet)
        if result is None:
            continue  # filtered out (keyword/prefix exclusion) — not reported, by design
        if result.get("status") == "parse_failed":
            parse_failed_files.append(result["filename"])
            log.warning(f"Could not parse filename: {result['filename']}")
            continue
        parsed_records.append(result)
        log.info(f"Parsed {i+1}/{total_files}: {result['filename']} -> {result['b_case']}, probe={result['probe']}, block={result['block']}, stain={result['stain']}")


    for fname in parse_failed_files:
        report_rows.append({
            "filename": fname, "folder": "", "status": "parse_failed",
            "reason": "could not extract a B-number from the filename",
            "b_case": "", "probe": "", "block": "", "stain": "", "format": "",
        })

    log.info(f"Parsed {len(parsed_records)} records, {len(parse_failed_files)} failed to parse")

    stain_map = load_stains(conn)

    cur = conn.cursor()

    cur.execute("SELECT lis_submission_id, id FROM submissions")
    submission_map = dict(cur.fetchall())
    id_to_lis_submission = {v: k for k, v in submission_map.items()}

    cur.execute("SELECT id, submission_id, lis_probe_id FROM probes")
    probe_rows = cur.fetchall()
    probe_map = {}
    probe_map_ci = {}
    probe_by_lis_probe_id = {}
    sub_to_probes = {}
    for pid, sid, lpid in probe_rows:
        lis_id = id_to_lis_submission.get(sid)
        if lis_id is not None:
            probe_map[(lis_id, lpid)] = pid
            probe_map_ci[(lis_id, lpid.upper())] = pid
            probe_by_lis_probe_id.setdefault(lpid, []).append((lis_id, pid))
        sub_to_probes.setdefault(sid, []).append(pid)

    cur.execute("SELECT id, probe_id, block_label FROM blocks")
    block_rows = cur.fetchall()
    block_map = {}
    probe_to_blocks = {}
    for bid, pid, blabel in block_rows:
        block_map.setdefault(pid, {})[blabel] = bid
        probe_to_blocks.setdefault(pid, []).append(bid)

    cur.close()

    stats = {
        "files_found": total_files,
        "scans_inserted": 0,
        "parse_failed": len(parse_failed_files),
        "unlinked": 0,
        "unlinked_no_sub": 0,
        "unlinked_no_probe": 0,
        "unlinked_no_block": 0,
        "unlinked_no_stain": 0,
        "duplicate_skipped": 0,
        "stains_created": 0,
        "warnings": [],
    }

    cur = conn.cursor()

    for i, rec in enumerate(parsed_records):
        b_case = rec["b_case"]
        probe_raw = rec["probe"]
        block_raw = rec["block"]
        stain_raw = rec["stain"]
        filename = rec["filename"]

        def _report(status, reason):
            report_rows.append({
                "filename": filename, "folder": rec["folder"], "status": status,
                "reason": reason, "b_case": b_case, "probe": probe_raw or "",
                "block": block_raw or "", "stain": stain_raw or "", "format": rec["format"],
            })

        sub_id, probe_id = _resolve_probe_for_scan(
            b_case, probe_raw, submission_map, probe_map, sub_to_probes,
            probe_map_ci, probe_by_lis_probe_id,
        )

        if sub_id is None:
            stats["unlinked"] += 1
            stats["unlinked_no_sub"] += 1
            reason = f"{b_case} not found as a submission"
            if len(stats["warnings"]) < 100:
                stats["warnings"].append(f"{filename}: {reason}")
            _report("unlinked", reason)
            continue

        if probe_id is None:
            stats["unlinked"] += 1
            stats["unlinked_no_probe"] += 1
            reason = f"probe ambiguous for {b_case}"
            if len(stats["warnings"]) < 100:
                stats["warnings"].append(f"{filename}: {reason}")
            _report("unlinked", reason)
            continue

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
                stats["unlinked"] += 1
                stats["unlinked_no_block"] += 1
                reason = "no blocks exist for this probe"
                if len(stats["warnings"]) < 100:
                    stats["warnings"].append(f"{filename}: {reason}")
                _report("unlinked", reason)
                continue
            else:
                stats["unlinked"] += 1
                stats["unlinked_no_block"] += 1
                reason = f"block {block_raw!r} unmatched, {len(block_ids)} blocks exist for this probe"
                if len(stats["warnings"]) < 100:
                    stats["warnings"].append(f"{filename}: {reason}")
                _report("unlinked", reason)
                continue

        stain_id, was_created = resolve_stain(stain_raw, stain_map, conn) if stain_raw else (None, False)
        if was_created:
            stats["stains_created"] += 1

        if stain_id is None:
            stain_id = stain_map.get(normalize_stain("HE"))
            if stain_id is None:
                stats["unlinked"] += 1
                stats["unlinked_no_stain"] += 1
                reason = "could not resolve stain"
                if len(stats["warnings"]) < 100:
                    stats["warnings"].append(f"{filename}: {reason}")
                _report("unlinked", reason)
                continue

        file_path = f"{rec['folder']}/{filename}"

        cur.execute(
            "INSERT INTO scans (block_id, stain_id, file_path, file_format) "
            "VALUES (%s, %s, %s, %s) ON CONFLICT (file_path) DO NOTHING",
            (block_id, stain_id, file_path, rec["format"]),
        )
        if cur.rowcount:
            stats["scans_inserted"] += 1
            _report("inserted", "")
        else:
            stats["duplicate_skipped"] += 1
            _report("duplicate_skipped", "a scan with this exact file path already exists")

        if i % BATCH_SIZE == 0:
            conn.commit()

    conn.commit()
    cur.close()

    if len(stats["warnings"]) > 100:
        stats["warnings"] = stats["warnings"][:100] + [f"... and {len(stats['warnings']) - 100} more"]

    if result_dir:
        try:
            report_path = Path(result_dir) / "scan_sync_report.csv"
            with open(report_path, "w", newline="", encoding="utf-8") as f:
                writer = csv.DictWriter(f, fieldnames=[
                    "filename", "folder", "status", "reason",
                    "b_case", "probe", "block", "stain", "format",
                ])
                writer.writeheader()
                writer.writerows(report_rows)
            stats["report_csv"] = "scan_sync_report.csv"
        except Exception as e:
            log.warning(f"Could not write scan_sync_report.csv: {e}")

    stats["inserted_sample"] = [r["filename"] for r in report_rows if r["status"] == "inserted"][:25]
    stats["parse_failed_sample"] = [r["filename"] for r in report_rows if r["status"] == "parse_failed"][:25]
    stats["unlinked_sample"] = [
        {"filename": r["filename"], "reason": r["reason"]}
        for r in report_rows if r["status"] == "unlinked"
    ][:25]

    log.info(
        f"Scans done: {stats['scans_inserted']} inserted, "
        f"{stats['unlinked']} unlinked, "
        f"{stats['duplicate_skipped']} already existed, "
        f"{stats['parse_failed']} failed to parse, "
        f"{stats['stains_created']} stains auto-created"
    )
    return stats


def _resolve_probe_for_scan(
    b_case: str,
    probe_raw: Optional[str],
    submission_map: dict,
    probe_map: dict,
    sub_to_probes: dict,
    probe_map_ci: dict,
    probe_by_lis_probe_id: dict,
) -> tuple:
    """
    Era-aware probe resolution. Mirrors etl.py's resolve_probe_for_scan.
    Returns (sub_id, probe_id) or (None, None).

    All lookups are O(1) against pre-built indices. The previous version
    fell back to scanning every entry in probe_map per scan file — fine at
    small scale, but this database has well over a million probes, and
    this function runs once per file being matched.
    """
    year = extract_year(b_case)

    def try_submission_match():
        sub_id = submission_map.get(b_case)
        if sub_id is None:
            return None, None
        if probe_raw:
            pid = probe_map.get((b_case, probe_raw))
            if pid:
                return sub_id, pid
            pid = probe_map_ci.get((b_case, probe_raw.upper()))
            if pid:
                return sub_id, pid
        probe_ids = sub_to_probes.get(sub_id, [])
        if len(probe_ids) == 1:
            return sub_id, probe_ids[0]
        return sub_id, None

    def try_probe_direct_match():
        matches = probe_by_lis_probe_id.get(b_case)
        if matches:
            sk, pid = matches[0]
            return submission_map.get(sk), pid
        return None, None

    def try_composite_match():
        if not probe_raw:
            return None, None
        try:
            padded = f"{int(probe_raw):03d}"
        except (ValueError, TypeError):
            return None, None
        composite = f"{b_case}/{padded}"
        matches = probe_by_lis_probe_id.get(composite)
        if matches:
            sk, pid = matches[0]
            return submission_map.get(sk), pid
        return None, None

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

    sub_id = submission_map.get(b_case)
    return sub_id, None


# ─── Main Dispatch ────────────────────────────────────────────────────────────

def main():
    try:
        conn = get_connection()
        log.info("Database connection established")
    except Exception as e:
        log.error(f"Database connection failed: {e}")
        sys.exit(1)

    run_scans(conn, "/storage/research/igmp_dp_workspace/garciabaroja_javier/PW_reports/database/pathodb/etl")

    try:
        conn.close()
    except Exception:
        pass

if __name__ == "__main__":
    main()