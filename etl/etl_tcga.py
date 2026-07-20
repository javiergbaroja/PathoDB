#!/usr/bin/env python3
"""
PathoDB ETL — TCGA colorectal cohort import
============================================
Ingests the TCGA-COAD/READ cohort (public) into the existing PathoDB backbone
WITHOUT any schema change, and synthesises synoptic-style pathology reports from
the structured clinical columns.

Data provided
-------------
  clinical : TCGA_sinergia_np.xlsx, sheet 'TCGA412' (412 cases, keyed on
             case_submitter_id, e.g. 'TCGA-A6-2671').
  images   : <image-root>/<case_submitter_id>/*.svs  — one folder per case.
             Slide type is encoded in the TCGA barcode:
               ...-01Z-00-DX1  → diagnostic slide (FFPE)   [primary tumour]
               ...-01A-01-TS1  → frozen section, top       [primary tumour]
               ...-01A-01-BS1  → frozen section, bottom    [primary tumour]
               ...-11A-01-TS1  → matched normal tissue
             sample code (first 2 digits of the 4th barcode field): 01-09 =
             tumour, 10-19 = normal.

Mapping onto the existing backbone (patients → submissions → probes → blocks → scans)
------------------------------------------------------------------------------------
  patients      : one per case.  patient_code = case_submitter_id,
                  sex from `gender`.
  submissions   : one per case (the TCGA "accession").
                  lis_submission_id = case_submitter_id,
                  report_date       = <year_of_diagnosis>-01-01 (year-only in TCGA),
                  malignancy_flag   = TRUE (all cases are carcinomas),
                  consent           = 'TCGA open-access (public)'.
  probes        : one sentinel probe per case (lis_probe_id = '1'), carrying
                  topo_description = organ/site text and
                  snomed_morph_codes = [<ICD-O morphology → M-code>], so the
                  cohort SNOMED-morphology filters light up for TCGA too.
  blocks        : one per barcode sample+vial (e.g. '01A', '01B', '11A');
                  block_info records tumour vs normal.
  scans         : one per .svs, linked to its sample's block, stain H&E.
  reports       : two synthetic synoptic reports per case (see below).

Column → synthetic report allocation
------------------------------------
  MICROSCOPY (report_type='microscopy') — the diagnostic synopsis:
     primary_diagnosis, morphology (ICD-O), icd_10_code, tumor_location,
     ajcc_pathologic_t/n/m, ajcc_pathologic_stage, ajcc_staging_system_edition,
     MSI, CMS, age_at_index, gender, prior_malignancy, prior_treatment,
     synchronous_malignancy, year_of_diagnosis.
     (grade / LVI / PNI / margins are absent from TCGA412 → rendered
      "Not reported in source dataset".)

  MACROSCOPY (report_type='macro') — gross/specimen synopsis, deliberately lean:
     tissue_or_organ_of_origin, tumor_location, icd_10_code, plus a whole-slide
     inventory derived from the .svs files on disk.

  NOT rendered into reports (belong in a future structured clinical model):
     survival/follow-up (days_to_death, vital_status, year_of_death, Censor,
     Months, days_to_last_follow_up, age_at_diagnosis[days]), demographics beyond
     header (ethnicity, race, year_of_birth), treatment detail (Radiotherapy,
     pharmacological), progression_or_recurrence, image-derived research features
     (average_mucin, max_mucin, mucin, difference, slides) and redundant recodes
     (STAG, Location, tumor_stage).

Provenance / integrity
----------------------
  The reports are DERIVED, not authored by a pathologist. Every report opens with
  a header that says so and cites the TCGA source, so the text is self-identifying
  wherever it surfaces (search, embeddings, the agent). They are typed 'microscopy'
  / 'macro' on purpose so they flow through the existing report pipeline; if you
  later want machine-readable provenance, add a nullable reports.is_synthetic /
  reports.source column (additive, non-breaking) and set it here.

Safety
------
  Idempotent (ON CONFLICT). Re-running is safe. --dry-run performs all reads and
  renders reports but writes nothing. Start with --dry-run --print-reports.

Usage
-----
  python etl_tcga.py --dry-run --print-reports 3 --limit 5
  python etl_tcga.py                                   # full load
  python etl_tcga.py --exclude-frozen --exclude-normal # diagnostic FFPE only
"""

import argparse
import logging
import os
import re
import sys
from datetime import date
from pathlib import Path
from typing import Optional

import pandas as pd
import psycopg2
from dotenv import load_dotenv
from tqdm import tqdm

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("pathodb_etl_tcga")

# ── Constants ─────────────────────────────────────────────────────────────────
DEFAULT_CLINICAL = "/storage/research/igmp_slide_workspace/GRP Zlobec/TCGA/TCGA_sinergia_np.xlsx"
DEFAULT_IMAGE_ROOT = "/storage/research/igmp_slide_workspace/GRP Zlobec/TCGA/Image"
CLINICAL_SHEET = "TCGA412"
SOURCE_LABEL = "TCGA"
SOURCE_CODE = "TCGA"                                 # data_sources.code
SOURCE_NAME = "TCGA COAD/READ"                       # data_sources.name
SOURCE_INSTITUTION = "NIH/NCI Genomic Data Commons"  # data_sources.institution
SOURCE_GOVERNANCE = "public / open-access"           # data_sources.governance
SENTINEL_PROBE = "1"

# TCGA encodes missing values as the string "'--"; pandas also yields NaN/None.
_MISSING = {"", "nan", "none", "'--", "--", "na", "n/a", "not reported"}

# ICD-O behaviour codes that are structurally valid.
_VALID_BEHAVIOUR = {"0", "1", "2", "3", "6", "9"}

# Human labels for the barcode slide-type prefix.
_SLIDE_TYPE = {
    "DX": "Diagnostic slide (FFPE)",
    "TS": "Frozen section (top)",
    "BS": "Frozen section (bottom)",
    "MS": "Frozen section (middle)",
}

SEX_MAP = {"male": "M", "female": "F", "m": "M", "f": "F"}

# tumor_location (TCGA412) → SNOMED topography code in the master snomed_codes
# vocabulary (category='topography'). Every unique value in the cohort is mapped.
TOPO_MAP = {
    "Sigmoid colon":            "T67700",  # sigmoid colon
    "Colon, NOS":               "T67000",  # colon
    "Cecum":                    "T67100",  # cecum
    "Ascending colon":          "T67200",  # ascending colon
    "Rectum, NOS":              "T68000",  # rectum
    "Transverse colon":         "T67400",  # transverse colon
    "Descending colon":         "T67600",  # descending colon
    "Hepatic flexure of colon": "T67300",  # hepatic flexure (right colic flexure)
    "Splenic flexure of colon": "T67500",  # left colon flexure (splenic flexure)
}


# ── Value helpers ─────────────────────────────────────────────────────────────

def clean(val) -> Optional[str]:
    """Strip and normalise a raw cell; TCGA sentinels and blanks → None."""
    if val is None:
        return None
    s = str(val).strip()
    return None if s.lower() in _MISSING else s


def clean_num(val) -> Optional[str]:
    """Return an integer-looking value without a trailing '.0' (e.g. '1.0'→'1')."""
    s = clean(val)
    if s is None:
        return None
    try:
        f = float(s)
        if f.is_integer():
            return str(int(f))
    except ValueError:
        pass
    return s


def field(val, default="Not reported in source dataset") -> str:
    """Render a value for a report, substituting a default when missing."""
    s = clean(val)
    return s if s is not None else default


# ── Barcode parsing ───────────────────────────────────────────────────────────

def parse_barcode(filename: str) -> Optional[dict]:
    """
    Parse a TCGA slide filename into its components.

    'TCGA-A6-2674-01B-03-BS3.<uuid>.svs' →
        {case: 'TCGA-A6-2674', sample_vial: '01B', sample: '01',
         is_normal: False, slide: 'BS3', slide_type: 'BS'}
    Returns None if the name is not a parseable TCGA slide barcode.
    """
    stem = filename.split(".")[0]
    parts = stem.split("-")
    if len(parts) < 6:
        return None
    sample_vial = parts[3]
    slide = parts[5]
    m = re.match(r"[A-Za-z]+", slide)
    slide_type = m.group(0).upper() if m else slide.upper()
    sample = sample_vial[:2]
    is_normal = sample.isdigit() and 10 <= int(sample) <= 19
    return {
        "case": "-".join(parts[:3]),
        "barcode": stem,               # full slide barcode, unique per scan
        "sample_vial": sample_vial,
        "sample": sample,
        "is_normal": is_normal,
        "slide": slide,
        "slide_type": slide_type,
    }


def scan_case_folder(folder: Path, include_frozen: bool, include_normal: bool) -> list:
    """Return parsed .svs entries for a case folder, honouring the include flags."""
    entries = []
    if not folder.is_dir():
        return entries
    for fn in sorted(os.listdir(folder)):
        if not fn.lower().endswith(".svs"):
            continue
        bc = parse_barcode(fn)
        if bc is None:
            log.warning(f"  Unparseable slide name skipped: {fn}")
            continue
        is_frozen = bc["slide_type"] in ("TS", "BS", "MS")
        if bc["is_normal"] and not include_normal:
            continue
        if is_frozen and not include_frozen:
            continue
        bc["file_path"] = str(folder / fn)
        entries.append(bc)
    return entries


# ── Morphology mapping ────────────────────────────────────────────────────────

def icdo_to_mcode(icdo: Optional[str]) -> Optional[str]:
    """
    Convert an ICD-O morphology code ('8140/3') to the SNOMED M-code ('M81403').
    Returns None for missing or structurally invalid codes (e.g. '8140/11', whose
    behaviour suffix is not a single valid digit — a known dirty value in the
    secondary TCGA sheets).
    """
    s = clean(icdo)
    if s is None:
        return None
    m = re.match(r"^(\d{4})\s*/\s*(\d{1,2})$", s)
    if not m:
        log.warning(f"  Morphology not in NNNN/B form, ignored: {icdo!r}")
        return None
    hist, beh = m.group(1), m.group(2)
    if beh not in _VALID_BEHAVIOUR:
        log.warning(f"  Invalid ICD-O behaviour code, ignored: {icdo!r}")
        return None
    return f"M{hist}{beh}"


# ── Synoptic report builders ──────────────────────────────────────────────────

def _header(kind: str, project: str, case: str) -> str:
    return (
        f"COLORECTAL CARCINOMA — SYNOPTIC {kind}\n"
        f"Derived from TCGA structured clinical data — not an original "
        f"pathologist narrative.\n"
        f"Source: {SOURCE_LABEL} · Project {field(project, 'TCGA')} · Case {case}\n"
    )


def build_microscopy_report(row: pd.Series, morph_desc: Optional[str]) -> str:
    """Synoptic diagnostic (microscopy) report from the clinical columns."""
    case = clean(row.get("case_submitter_id"))
    site = clean(row.get("tumor_location")) or clean(row.get("tissue_or_organ_of_origin"))
    diagnosis = field(row.get("primary_diagnosis"), "Colorectal carcinoma")
    morphology = clean(row.get("morphology"))
    mcode = icdo_to_mcode(morphology)

    t = clean_num(row.get("ajcc_pathologic_t"))
    n = clean_num(row.get("ajcc_pathologic_n"))
    m = clean_num(row.get("ajcc_pathologic_m"))
    stage = clean(row.get("ajcc_pathologic_stage"))
    edition = clean(row.get("ajcc_staging_system_edition"))

    pt = f"pT{t}" if t else "Not reported in source dataset"
    pn = f"pN{n}" if n else "Not reported in source dataset"
    pm = f"pM{m}" if m else "Not assessed (pMX)"
    stage_line = f"AJCC stage {stage}" if stage else "Not reported in source dataset"
    edition_note = f" (AJCC {edition} edition)" if edition else ""

    morph_line = field(row.get("primary_diagnosis"))
    if mcode:
        morph_line += f" [ICD-O {morphology}"
        morph_line += f" · SNOMED {mcode}" + (f" — {morph_desc}" if morph_desc else "")
        morph_line += "]"

    dx_site = f" of the {site.lower()}" if site else ""

    return "\n".join([
        _header("DIAGNOSIS", row.get("project_id"), case),
        "DIAGNOSIS",
        f"  {diagnosis}{dx_site}.",
        "",
        "CLINICAL HISTORY",
        f"  Age at diagnosis      : {field(clean_num(row.get('age_at_index')))} years",
        f"  Sex                   : {SEX_MAP.get((clean(row.get('gender')) or '').lower(), 'Not reported')}",
        f"  Prior malignancy      : {field(row.get('prior_malignancy'))}",
        f"  Neoadjuvant/prior tx  : {field(row.get('prior_treatment'))}",
        f"  Synchronous malignancy: {field(row.get('synchronous_malignancy'))}",
        "",
        "HISTOPATHOLOGY",
        f"  Histologic type       : {morph_line}",
        f"  Histologic grade      : Not reported in source dataset",
        f"  Tumour site           : {field(row.get('tumor_location'))}",
        f"  Lymphovascular invasion: Not reported in source dataset",
        f"  Perineural invasion   : Not reported in source dataset",
        "",
        f"PATHOLOGIC STAGE{edition_note}",
        f"  Primary tumour (pT)   : {pt}",
        f"  Regional nodes (pN)   : {pn}",
        f"  Distant metastasis(pM): {pm}",
        f"  Stage group           : {stage_line}",
        "",
        "ANCILLARY / MOLECULAR STUDIES",
        f"  Microsatellite status : {field(row.get('MSI'))}",
        f"  Consensus mol. subtype: {field(row.get('CMS'))}",
        "",
        "CODED DATA",
        f"  ICD-O-3 morphology    : {field(morphology)}"
        + (f" ({mcode})" if mcode else ""),
        f"  Topography (ICD-10)   : {field(row.get('icd_10_code'))}",
        f"  Year of diagnosis     : {field(clean_num(row.get('year_of_diagnosis')))}",
    ])


def build_macroscopy_report(row: pd.Series, inventory: list) -> str:
    """Synoptic gross/specimen report: site + whole-slide inventory from disk."""
    case = clean(row.get("case_submitter_id"))

    # Inventory grouped by (tumour|normal, slide-type label).
    counts: dict = {}
    for e in inventory:
        tissue = "Matched normal tissue" if e["is_normal"] else "Primary tumour"
        label = _SLIDE_TYPE.get(e["slide_type"], f"Slide type {e['slide_type']}")
        counts[(tissue, label)] = counts.get((tissue, label), 0) + 1

    if counts:
        inv_lines = [f"  {len(inventory)} whole-slide image(s):"]
        for (tissue, label) in sorted(counts):
            inv_lines.append(f"    {tissue} — {label}: {counts[(tissue, label)]}")
    else:
        inv_lines = ["  No whole-slide images registered for this case."]

    return "\n".join([
        _header("GROSS SUMMARY", row.get("project_id"), case),
        "SPECIMEN",
        f"  Anatomic site         : {field(row.get('tissue_or_organ_of_origin'))}",
        f"  Tumour location       : {field(row.get('tumor_location'))}",
        f"  Topography (ICD-10)   : {field(row.get('icd_10_code'))}",
        f"  Procedure             : Not specified in source dataset",
        "",
        "WHOLE-SLIDE INVENTORY (from image repository)",
        *inv_lines,
        "",
        "MACROSCOPIC FEATURES",
        f"  Tumour size           : Not reported in source dataset",
        f"  Gross perforation     : Not reported in source dataset",
        f"  Margins               : Not reported in source dataset",
    ])


# ── DB helpers ────────────────────────────────────────────────────────────────

def get_or_create_source(cur, dry: bool) -> Optional[int]:
    """Return the data_sources.id for this cohort, creating the row if needed."""
    cur.execute("SELECT id FROM data_sources WHERE code = %s", (SOURCE_CODE,))
    row = cur.fetchone()
    if row:
        return row[0]
    if dry:
        return -1
    cur.execute(
        """
        INSERT INTO data_sources (code, name, institution, governance)
        VALUES (%s, %s, %s, %s)
        ON CONFLICT (code) DO NOTHING
        RETURNING id
        """,
        (SOURCE_CODE, SOURCE_NAME, SOURCE_INSTITUTION, SOURCE_GOVERNANCE),
    )
    r = cur.fetchone()
    if r:
        return r[0]
    cur.execute("SELECT id FROM data_sources WHERE code = %s", (SOURCE_CODE,))
    return cur.fetchone()[0]


def fetch_he_stain_id(cur) -> int:
    cur.execute("SELECT id FROM stains WHERE stain_category = 'HE' ORDER BY id LIMIT 1")
    row = cur.fetchone()
    if not row:
        cur.execute("SELECT id FROM stains WHERE stain_name = 'H&E'")
        row = cur.fetchone()
    if not row:
        raise RuntimeError("No H&E stain found in `stains` — run the main ETL first.")
    return row[0]


def fetch_morph_descriptions(cur) -> dict:
    cur.execute("SELECT code, description FROM snomed_codes WHERE category = 'morphology'")
    return {code: desc for code, desc in cur.fetchall()}


def upsert_patient(cur, case: str, sex: Optional[str], source_id: Optional[int],
                   dob, dry: bool, stats: dict) -> Optional[int]:
    if dry:
        stats["patients"] += 1
        return -1
    # DO UPDATE (not DO NOTHING) so a re-run backfills provenance + DOB.
    # xmax = 0 distinguishes a fresh INSERT from a conflict UPDATE.
    cur.execute(
        """
        INSERT INTO patients (patient_code, sex, source_id, date_of_birth)
        VALUES (%s, %s, %s, %s)
        ON CONFLICT (patient_code) DO UPDATE
            SET source_id     = EXCLUDED.source_id,
                sex           = EXCLUDED.sex,
                date_of_birth = EXCLUDED.date_of_birth
        RETURNING id, (xmax = 0) AS inserted
        """,
        (case, sex, source_id, dob),
    )
    pid, inserted = cur.fetchone()
    if inserted:
        stats["patients"] += 1
    return pid


def upsert_submission(cur, patient_id: int, case: str, report_date, dry: bool, stats: dict) -> Optional[int]:
    if dry:
        stats["submissions"] += 1
        return -1
    cur.execute(
        """
        INSERT INTO submissions
            (patient_id, lis_submission_id, report_date, malignancy_flag, consent)
        VALUES (%s, %s, %s, TRUE, %s)
        ON CONFLICT (lis_submission_id) DO UPDATE
            SET report_date = EXCLUDED.report_date
        RETURNING id
        """,
        # consent = NULL: provenance now lives on patients.source_id, not here.
        (patient_id, case, report_date, None),
    )
    stats["submissions"] += 1
    return cur.fetchone()[0]


def upsert_probe(cur, sub_id: int, topo: Optional[str], topo_code: Optional[str],
                 morph_codes: list, dry: bool, stats: dict) -> Optional[int]:
    if dry:
        stats["probes"] += 1
        return -1
    cur.execute(
        """
        INSERT INTO probes
            (submission_id, lis_probe_id, submission_type,
             topo_description, snomed_topo_code, snomed_morph_codes)
        VALUES (%s, %s, %s, %s, %s, %s)
        ON CONFLICT (submission_id, lis_probe_id) DO UPDATE
            SET topo_description   = EXCLUDED.topo_description,
                snomed_topo_code   = EXCLUDED.snomed_topo_code,
                snomed_morph_codes = EXCLUDED.snomed_morph_codes
        RETURNING id
        """,
        (sub_id, SENTINEL_PROBE, f"{SOURCE_LABEL} case", topo, topo_code, morph_codes),
    )
    stats["probes"] += 1
    return cur.fetchone()[0]


def upsert_block(cur, probe_id: int, label: str, info: str, dry: bool, stats: dict) -> Optional[int]:
    if dry:
        stats["blocks"] += 1
        return -abs(hash((probe_id, label)))
    cur.execute(
        """
        INSERT INTO blocks (probe_id, block_label, block_info) VALUES (%s, %s, %s)
        ON CONFLICT (probe_id, block_label) DO NOTHING
        """,
        (probe_id, label, info),
    )
    if cur.rowcount:
        stats["blocks"] += 1
    cur.execute(
        "SELECT id FROM blocks WHERE probe_id = %s AND block_label = %s",
        (probe_id, label),
    )
    return cur.fetchone()[0]


def upsert_scan(cur, block_id: int, stain_id: int, file_path: str, dry: bool, stats: dict):
    if dry:
        stats["scans"] += 1
        return
    # DO UPDATE the block_id so a re-run re-homes an existing scan onto its
    # corrected block (needed to migrate the earlier sample-vial grouping).
    cur.execute(
        """
        INSERT INTO scans (block_id, stain_id, file_path, file_format)
        VALUES (%s, %s, %s, 'SVS')
        ON CONFLICT (file_path) DO UPDATE SET block_id = EXCLUDED.block_id
        RETURNING (xmax = 0) AS inserted
        """,
        (block_id, stain_id, file_path),
    )
    if cur.fetchone()[0]:
        stats["scans"] += 1


def upsert_report(cur, sub_id: int, rtype: str, text: str, report_date, dry: bool, stats: dict):
    if dry:
        stats[f"reports_{rtype}"] += 1
        return
    cur.execute(
        """
        INSERT INTO reports (submission_id, report_type, report_text, report_date)
        VALUES (%s, %s, %s, %s)
        ON CONFLICT (submission_id, report_type) DO UPDATE
            SET report_text = EXCLUDED.report_text,
                report_date = EXCLUDED.report_date
        """,
        (sub_id, rtype, text, report_date),
    )
    stats[f"reports_{rtype}"] += 1


# ── Main load ─────────────────────────────────────────────────────────────────

def load_tcga(clinical: str, image_root: str, conn, dry: bool,
              include_frozen: bool, include_normal: bool,
              limit: Optional[int], print_reports: int):
    df = pd.read_excel(clinical, sheet_name=CLINICAL_SHEET, dtype=str)
    df.columns = df.columns.str.strip()
    if limit:
        df = df.head(limit)
    log.info(f"Loaded {len(df)} TCGA cases from {Path(clinical).name} [{CLINICAL_SHEET}]")

    cur = conn.cursor()
    stain_id = fetch_he_stain_id(cur)
    morph_desc = fetch_morph_descriptions(cur)
    cur.execute("SELECT code, description FROM snomed_codes WHERE category = 'topography'")
    topo_desc = {c: d for c, d in cur.fetchall()}
    source_id = get_or_create_source(cur, dry)
    log.info(f"H&E stain_id={stain_id} | {len(morph_desc)} master morphology codes | "
             f"source '{SOURCE_CODE}' id={source_id}")

    stats = {k: 0 for k in (
        "patients", "submissions", "probes", "blocks", "scans",
        "reports_microscopy", "reports_macro", "cases_no_slides",
        "cases_missing_folder", "morph_unmapped", "topo_unmapped",
    )}
    printed = 0
    image_root_p = Path(image_root)

    for idx, row in tqdm(df.iterrows(), total=len(df), desc="  TCGA cases"):
        case = clean(row.get("case_submitter_id"))
        if not case:
            continue

        folder = image_root_p / case
        if not folder.is_dir():
            stats["cases_missing_folder"] += 1
        inventory = scan_case_folder(folder, include_frozen, include_normal)
        if not inventory:
            stats["cases_no_slides"] += 1

        # report_date: TCGA only records the year of diagnosis.
        year = clean_num(row.get("year_of_diagnosis"))
        rdate = date(int(year), 1, 1) if year and year.isdigit() else None

        sex = SEX_MAP.get((clean(row.get("gender")) or "").lower())
        # DOB from year_of_birth (year only in TCGA) — day defaults to Jan 1.
        yob = clean_num(row.get("year_of_birth"))
        dob = date(int(yob), 1, 1) if (yob and yob.isdigit()) else None
        mcode = icdo_to_mcode(row.get("morphology"))
        if clean(row.get("morphology")) and not mcode:
            stats["morph_unmapped"] += 1
        morph_codes = [mcode] if mcode else []
        # Topography from tumor_location → master SNOMED topography code.
        location = clean(row.get("tumor_location")) or clean(row.get("tissue_or_organ_of_origin"))
        topo_code = TOPO_MAP.get(location)
        if location and not topo_code:
            stats["topo_unmapped"] += 1

        # ── Backbone ───────────────────────────────────────────────────────────
        patient_id = upsert_patient(cur, case, sex, source_id, dob, dry, stats)
        sub_id = upsert_submission(cur, patient_id, case, rdate, dry, stats)
        # topo_description = the master vocabulary's description (canonical casing).
        probe_id = upsert_probe(cur, sub_id, topo_desc.get(topo_code) or location,
                                topo_code, morph_codes, dry, stats)

        # One block per scan. TCGA slides are each a distinct block/section, not
        # multiple scans of one block: the DX slide is FFPE (diagnostic) while
        # TS#/BS#/MS# are separate frozen sections (see andrewjanowczyk.com FFPE
        # guide). block_label = the full slide barcode, which is unique per scan.
        for e in inventory:
            tissue = "Matched normal tissue" if e["is_normal"] else "Primary tumour"
            kind = _SLIDE_TYPE.get(e["slide_type"], f"slide type {e['slide_type']}")
            info = f"{tissue} — {kind} ({SOURCE_LABEL} sample {e['sample_vial']})"
            block_id = upsert_block(cur, probe_id, e["barcode"], info, dry, stats)
            upsert_scan(cur, block_id, stain_id, e["file_path"], dry, stats)

        # ── Synthetic synoptic reports ──────────────────────────────────────────
        micro = build_microscopy_report(row, morph_desc.get(mcode) if mcode else None)
        macro = build_macroscopy_report(row, inventory)
        upsert_report(cur, sub_id, "microscopy", micro, rdate, dry, stats)
        upsert_report(cur, sub_id, "macro", macro, rdate, dry, stats)

        if printed < print_reports:
            print("\n" + "#" * 78 + f"\n# {case}\n" + "#" * 78)
            print(micro)
            print("\n" + "-" * 40 + "\n")
            print(macro)
            printed += 1

        if not dry and idx % 100 == 0:
            conn.commit()

    if not dry:
        conn.commit()
    cur.close()

    log.info("=" * 60)
    log.info("TCGA IMPORT SUMMARY" + ("  (DRY RUN — nothing written)" if dry else ""))
    log.info("=" * 60)
    for k in ("patients", "submissions", "probes", "blocks", "scans",
              "reports_microscopy", "reports_macro"):
        log.info(f"  {k:<20}: {stats[k]}")
    log.info(f"  cases w/o slides    : {stats['cases_no_slides']}")
    log.info(f"  cases missing folder: {stats['cases_missing_folder']}")
    log.info(f"  morphology unmapped : {stats['morph_unmapped']}")
    log.info(f"  topography unmapped : {stats['topo_unmapped']}")
    log.info("=" * 60)
    return stats


def main():
    ap = argparse.ArgumentParser(description="Import the TCGA CRC cohort into PathoDB")
    ap.add_argument("--clinical", default=DEFAULT_CLINICAL, help="TCGA clinical .xlsx")
    ap.add_argument("--image-root", default=DEFAULT_IMAGE_ROOT, help="Root of per-case image folders")
    ap.add_argument("--dry-run", action="store_true", help="Read + render, write nothing")
    ap.add_argument("--exclude-frozen", action="store_true", help="Skip TS/BS/MS frozen slides")
    ap.add_argument("--exclude-normal", action="store_true", help="Skip matched normal (11x) slides")
    ap.add_argument("--limit", type=int, default=None, help="Only process the first N cases")
    ap.add_argument("--print-reports", type=int, default=0, help="Print the first N rendered report pairs")
    args = ap.parse_args()

    if not Path(args.clinical).exists():
        log.error(f"Clinical file not found: {args.clinical}")
        sys.exit(1)

    if args.dry_run:
        log.info("DRY RUN — no data will be written")

    load_dotenv()
    db_url = os.getenv("DATABASE_URL")
    if not db_url:
        log.error("DATABASE_URL not set (.env)")
        sys.exit(1)
    conn = psycopg2.connect(db_url)

    try:
        load_tcga(
            args.clinical, args.image_root, conn, args.dry_run,
            include_frozen=not args.exclude_frozen,
            include_normal=not args.exclude_normal,
            limit=args.limit, print_reports=args.print_reports,
        )
    except Exception as exc:
        conn.rollback()
        log.error(f"TCGA import failed: {exc}", exc_info=True)
        sys.exit(1)
    finally:
        conn.close()


if __name__ == "__main__":
    main()
