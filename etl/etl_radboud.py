#!/usr/bin/env python3
"""
PathoDB ETL — Radboud UMC (Immunoscore Nijmegen) colorectal cohort
==================================================================
Ingests the Radboud UMC Nijmegen CRC cohort into the existing PathoDB backbone
(no schema change) and synthesises synoptic-style pathology reports from the
integer-coded clinical spreadsheet.

Data provided
-------------
  clinical : compleet follow up - transcan cohort.xlsx, sheet
             'Data Nijmegen-part 1&2' (646 patients). Values are integer-coded
             against the 'Instructions for Formatting' codebook sheet; '99' means
             "not available", blanks are missing. Dates are real (mm/dd/yyyy).
  images   : <image-root>/AQ_S05_P<num>_C####_L##_A##.mrxs  (MIRAX; 571 files,
             one H&E slide per patient).

Identifiers & the image crosswalk
---------------------------------
  patient_code      = patient_id      (e.g. 'NIJ0002')
  lis_submission_id = T-nummer        (e.g. 'T86-04777')  ← the accession
  image link: the P-number in the .mrxs filename equals the NIJ number after
              dropping leading zeros — NIJ0002 <-> P000002. 571/646 patients
              have a slide; the other 75 get clinical + reports only.

Derived fields (no such column in the source)
---------------------------------------------
  morphology  : mucinous_colloide=1 -> 8480/3 (M84803), else 8140/3 (M81403).
  topography  : the set location flag (cecum/ascending/hepflex/transverse/
                splenflex/descending/sigmoid) -> its SNOMED code; else colon-level
                (colon=3 -> T67920 colon+rectum, colon=2 -> T68000 rectum,
                 else T67000 colon).
  pN          : from plnode — 0 -> N0, 1-3 -> N1, >=4 -> N2.
  date_of_birth: dx_date year minus age (year precision, Jan 1). Radboud has no
                 birth date; this exists to enable age queries, not as a real DOB.

Reports (report_type 'microscopy' + 'macro', self-identifying as derived)
------------------------------------------------------------------------
  microscopy : diagnosis, clinical history, histopathology (grade, mucinous,
               lymphatic/venous/perineural invasion, budding, perforation),
               pathologic stage (pT/pN/pM + stage group), MMR/MSI + molecular,
               resection/LN, coded data. Fields that are all-'99' in this export
               (KRAS/BRAF/APC/p53/PI3K/CIMP/budding, R-status) render "not
               reported".
  macro      : specimen site + procedure + whole-slide inventory + LN retrieved.

Not rendered into reports (-> future structured clinical model): survival /
follow-up (fu_stat, dth_date, rc_stat, rc_date, np_date, evl_date, ltf_date) and
treatment (postop_chemo, postop_biotherapy).

Safety: idempotent (ON CONFLICT). --dry-run reads + renders but writes nothing.

Usage
-----
  python etl_radboud.py --dry-run --print-reports 3 --limit 5
  python etl_radboud.py                              # full load
"""

import argparse
import logging
import os
import re
import sys
from datetime import date, datetime
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
log = logging.getLogger("pathodb_etl_radboud")

# ── Constants ─────────────────────────────────────────────────────────────────
DEFAULT_CLINICAL = "/storage/research/igmp_slide_workspace/GRP Zlobec/Immunoscore Nijmegen/compleet follow up - transcan cohort.xlsx"
DEFAULT_IMAGE_ROOT = "/storage/research/igmp_slide_workspace/GRP Zlobec/Immunoscore Nijmegen/HE/HE"
CLINICAL_SHEET = "Data Nijmegen-part 1&2"

SOURCE_LABEL = "Radboud UMC"
SOURCE_CODE = "RADBOUD"
SOURCE_NAME = "Radboud UMC — Immunoscore Nijmegen"
SOURCE_INSTITUTION = "Radboud University Medical Center, Nijmegen (NL)"
SOURCE_GOVERNANCE = "collaboration (data transfer agreement)"
SENTINEL_PROBE = "1"

NA = "Not reported in source dataset"

# ── Decode maps (from the codebook sheet) ─────────────────────────────────────
SEX_MAP        = {"0": "M", "1": "F"}
T_STAGE        = {"1": "T1", "2": "T2", "3": "T3", "4": "T4a", "5": "T4b",
                  "6": "Perforation", "7": "Tis", "8": "TX"}
M_STAGE        = {"0": "M0", "1": "M1a", "2": "M1b"}
GRADE          = {"1": "Well differentiated", "2": "Moderately differentiated",
                  "3": "Poorly differentiated", "4": "Undifferentiated"}
MSI            = {"0": "pMMR (proficient)", "1": "dMMR (deficient)"}
COLON          = {"1": "Colon", "2": "Rectum", "3": "Colon and rectum"}
SIDEDNESS      = {"1": "proximal", "2": "distal"}
RESECT         = {"1": "R0", "2": "R1", "3": "R2"}
SURG_TYPE      = {"1": "Open", "2": "Laparoscopic"}
PRESENT_ABSENT = {"0": "Not identified", "1": "Present"}
YES_NO         = {"0": "No", "1": "Yes"}

# location flag column -> SNOMED topography code (master vocabulary)
LOC_FLAGS = [
    ("cecum",      "T67100"), ("ascending",  "T67200"), ("hepflex",    "T67300"),
    ("transverse", "T67400"), ("splenflex",  "T67500"), ("descending", "T67600"),
    ("sigmoid",    "T67700"),
]
TOPO_NAME = {
    "T67100": "Cecum", "T67200": "Ascending colon", "T67300": "Hepatic flexure",
    "T67400": "Transverse colon", "T67500": "Splenic flexure (left colon flexure)",
    "T67600": "Descending colon", "T67700": "Sigmoid colon",
    "T67000": "Colon, NOS", "T67920": "Colon and rectum", "T68000": "Rectum",
}


# ── Value helpers ─────────────────────────────────────────────────────────────

def clean(val) -> Optional[str]:
    """Strip; blanks / nan -> None. NOTE: '99' is kept here (handled per-field)."""
    if val is None:
        return None
    s = str(val).strip()
    return None if s.lower() in ("", "nan", "none") else s


def clean_int(val) -> Optional[int]:
    s = clean(val)
    if s is None:
        return None
    try:
        return int(float(s))
    except ValueError:
        return None


def coded(val, mapping, na=NA) -> str:
    """Decode a coded categorical; '99' (not available) and unknowns -> `na`."""
    s = clean(val)
    if s is None or s == "99":
        return na
    return mapping.get(s, na)


def parse_date(val) -> Optional[date]:
    """Parse a spreadsheet date ('1986-06-12 00:00:00' / 'mm/dd/yyyy') -> date."""
    s = clean(val)
    if s is None:
        return None
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d", "%m/%d/%Y", "%d/%m/%Y"):
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            continue
    try:
        return datetime.fromisoformat(s).date()
    except ValueError:
        log.warning(f"  Unparseable date: {s!r}")
        return None


def field(val) -> str:
    s = clean(val)
    return s if s is not None else NA


# ── Derivations ───────────────────────────────────────────────────────────────

def derive_dob(dx_date_val, age_val) -> Optional[date]:
    """DOB ~= year of diagnosis minus age (year precision, Jan 1). Approximate."""
    d = parse_date(dx_date_val)
    a = clean_int(age_val)
    if d and a is not None:
        try:
            return date(d.year - a, 1, 1)
        except ValueError:
            return None
    return None


def derive_morph(row) -> Optional[str]:
    """mucinous_colloide=1 -> mucinous adenocarcinoma (M84803), else adeno NOS."""
    if clean(row.get("mucinous_colloide")) == "1":
        return "M84803"
    return "M81403"


def derive_topo(row) -> tuple:
    """Return (snomed_topo_code, topo_description) from the location flags/colon."""
    hits = [code for col, code in LOC_FLAGS if clean(row.get(col)) == "1"]
    if len(hits) == 1:
        return hits[0], TOPO_NAME[hits[0]]
    c = clean(row.get("colon"))
    if c == "3":
        return "T67920", TOPO_NAME["T67920"]
    if c == "2":
        return "T68000", TOPO_NAME["T68000"]
    return "T67000", TOPO_NAME["T67000"]


def derive_pn(plnode_val) -> str:
    p = clean_int(plnode_val)
    if p is None:
        return NA
    if p == 0:
        return "pN0"
    if p <= 3:
        return "pN1"
    return "pN2"


# ── Image crosswalk ───────────────────────────────────────────────────────────

def build_image_map(image_root: str) -> dict:
    """Map NIJ/P number -> .mrxs file path. P-number == NIJ number (no leading 0)."""
    root = Path(image_root)
    mapping: dict = {}
    if not root.is_dir():
        log.warning(f"Image root not found: {image_root}")
        return mapping
    for fn in os.listdir(root):
        if not fn.lower().endswith(".mrxs"):
            continue
        m = re.search(r"_P0*(\d+)_", fn)
        if not m:
            log.warning(f"  Unparseable slide name skipped: {fn}")
            continue
        mapping[int(m.group(1))] = str(root / fn)
    return mapping


def nij_number(patient_code: str) -> Optional[int]:
    m = re.search(r"(\d+)", patient_code or "")
    return int(m.group(1)) if m else None


# ── Synoptic report builders ──────────────────────────────────────────────────

def _header(kind: str, tnum: str, nij: str) -> str:
    return (
        f"COLORECTAL CARCINOMA — SYNOPTIC {kind}\n"
        f"Derived from {SOURCE_NAME} structured clinical data — not an original "
        f"pathologist narrative.\n"
        f"Source: {SOURCE_CODE} · Case {tnum} · Patient {nij}\n"
    )


def build_microscopy_report(row, morph_code, morph_desc, topo_code, topo_desc) -> str:
    tnum = clean(row.get("T-nummer"))
    nij = clean(row.get("patient_id"))
    mucinous = clean(row.get("mucinous_colloide")) == "1"
    dx = "Mucinous adenocarcinoma" if mucinous else "Adenocarcinoma, NOS"
    site = topo_desc

    morph_line = dx
    if morph_code:
        morph_line += f" [ICD-O {'8480/3' if mucinous else '8140/3'} · SNOMED {morph_code}"
        morph_line += (f" — {morph_desc}]" if morph_desc else "]")

    pt = coded(row.get("t_stage"), {k: f"p{v}" for k, v in T_STAGE.items()})
    pm = coded(row.get("m_stage"), {k: f"p{v}" for k, v in M_STAGE.items()})
    pn = derive_pn(row.get("plnode"))
    nl, pl = clean_int(row.get("nlnode")), clean_int(row.get("plnode"))
    node_ct = f" ({pl}/{nl} positive)" if (nl is not None and pl is not None) else ""

    return "\n".join([
        _header("DIAGNOSIS", tnum, nij),
        "DIAGNOSIS",
        f"  {dx} of the {site.lower()}.",
        "",
        "CLINICAL HISTORY",
        f"  Age at diagnosis      : {field(clean_int(row.get('age')))} years",
        f"  Sex                   : {SEX_MAP.get(clean(row.get('gender')) or '', 'Not reported')}",
        f"  Inflammatory bowel dis: {coded(row.get('ibs'), YES_NO)}",
        "",
        "HISTOPATHOLOGY",
        f"  Histologic type       : {morph_line}",
        f"  Histologic grade      : {coded(row.get('differentiation'), GRADE)}",
        f"  Tumour site           : {site} ({coded(row.get('colon'), COLON)}"
        f"; {coded(row.get('sidedness'), SIDEDNESS)})",
        f"  Mucinous component    : {coded(row.get('mucinous_colloide'), YES_NO)}",
        f"  Lymphatic invasion    : {coded(row.get('lymphatic_invasion'), PRESENT_ABSENT)}",
        f"  Venous invasion       : {coded(row.get('venous_emboli'), PRESENT_ABSENT)}",
        f"  Perineural invasion   : {coded(row.get('perineural_invasion'), PRESENT_ABSENT)}",
        f"  Tumour budding        : {coded(row.get('tumor_budding'), YES_NO)}",
        f"  Perforation           : {coded(row.get('perforation'), YES_NO)}",
        "",
        "PATHOLOGIC STAGE (AJCC / UICC)",
        f"  Primary tumour (pT)   : {pt}",
        f"  Regional nodes (pN)   : {pn}{node_ct}",
        f"  Distant metastasis(pM): {pm}",
        f"  Stage group           : {field(clean(row.get('Stadium')))}",
        "",
        "ANCILLARY / MOLECULAR STUDIES",
        f"  Mismatch repair (IHC) : {coded(row.get('msi_ihc'), MSI)}",
        f"  Microsatellite (gen.) : {coded(row.get('msi_gen'), MSI)}",
        f"  KRAS / BRAF / APC / p53 / PI3K / CIMP : {NA}",
        "",
        "RESECTION",
        f"  Margin status (R)     : {coded(row.get('resect_pt'), RESECT)}",
        f"  Lymph nodes examined  : {field(clean_int(row.get('nlnode')))}",
        f"  Lymph nodes positive  : {field(clean_int(row.get('plnode')))}",
        "",
        "CODED DATA",
        f"  SNOMED topography     : {topo_code}"
        + (f" ({topo_desc})" if topo_desc else ""),
        f"  SNOMED morphology     : {field(morph_code)}"
        + (f" ({morph_desc})" if morph_desc else ""),
        f"  Date of diagnosis     : {parse_date(row.get('dx_date')) or NA}",
    ])


def build_macroscopy_report(row, topo_desc, slide_path) -> str:
    tnum = clean(row.get("T-nummer"))
    nij = clean(row.get("patient_id"))
    if slide_path:
        inv = ["  1 whole-slide H&E image:", f"    {Path(slide_path).name}"]
    else:
        inv = ["  No whole-slide image registered for this patient."]
    return "\n".join([
        _header("GROSS SUMMARY", tnum, nij),
        "SPECIMEN",
        f"  Anatomic site         : {topo_desc}",
        f"  Primary tumour location: {coded(row.get('colon'), COLON)}",
        f"  Sidedness             : {coded(row.get('sidedness'), SIDEDNESS)}",
        f"  Procedure             : {coded(row.get('surg_pt_type'), SURG_TYPE)}",
        f"  Date of surgery       : {parse_date(row.get('surg_pt_date')) or NA}",
        "",
        "WHOLE-SLIDE INVENTORY (from image repository)",
        *inv,
        "",
        "MACROSCOPIC FEATURES",
        f"  Lymph nodes retrieved : {field(clean_int(row.get('nlnode')))}",
        f"  Perforation           : {coded(row.get('perforation'), YES_NO)}",
        f"  Tumour size           : {NA}",
    ])


# ── DB helpers (same pattern as etl_tcga.py) ──────────────────────────────────

def get_or_create_source(cur, dry: bool) -> Optional[int]:
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


def fetch_code_descriptions(cur, category: str) -> dict:
    cur.execute("SELECT code, description FROM snomed_codes WHERE category = %s", (category,))
    return {code: desc for code, desc in cur.fetchall()}


def upsert_patient(cur, code, sex, source_id, dob, dry, stats) -> Optional[int]:
    if dry:
        stats["patients"] += 1
        return -1
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
        (code, sex, source_id, dob),
    )
    pid, inserted = cur.fetchone()
    if inserted:
        stats["patients"] += 1
    return pid


def upsert_submission(cur, patient_id, tnum, report_date, dry, stats) -> Optional[int]:
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
        (patient_id, tnum, report_date, None),
    )
    stats["submissions"] += 1
    return cur.fetchone()[0]


def upsert_probe(cur, sub_id, topo, topo_code, morph_codes, dry, stats) -> Optional[int]:
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
        (sub_id, SENTINEL_PROBE, f"{SOURCE_CODE} case", topo, topo_code, morph_codes),
    )
    stats["probes"] += 1
    return cur.fetchone()[0]


def upsert_block(cur, probe_id, label, info, dry, stats) -> Optional[int]:
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


def upsert_scan(cur, block_id, stain_id, file_path, dry, stats):
    if dry:
        stats["scans"] += 1
        return
    cur.execute(
        """
        INSERT INTO scans (block_id, stain_id, file_path, file_format)
        VALUES (%s, %s, %s, 'MRXS')
        ON CONFLICT (file_path) DO UPDATE SET block_id = EXCLUDED.block_id
        RETURNING (xmax = 0) AS inserted
        """,
        (block_id, stain_id, file_path),
    )
    if cur.fetchone()[0]:
        stats["scans"] += 1


def upsert_report(cur, sub_id, rtype, text, report_date, dry, stats):
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

def load_radboud(clinical, image_root, conn, dry, limit, print_reports):
    df = pd.read_excel(clinical, sheet_name=CLINICAL_SHEET, dtype=str)
    df.columns = [str(c).strip() for c in df.columns]
    if limit:
        df = df.head(limit)
    log.info(f"Loaded {len(df)} Radboud patients from {Path(clinical).name}")

    cur = conn.cursor()
    stain_id = fetch_he_stain_id(cur)
    source_id = get_or_create_source(cur, dry)
    morph_desc = fetch_code_descriptions(cur, "morphology")
    topo_desc_master = fetch_code_descriptions(cur, "topography")
    image_map = build_image_map(image_root)
    log.info(f"H&E stain_id={stain_id} | source '{SOURCE_CODE}' id={source_id} | "
             f"{len(image_map)} slides indexed")

    stats = {k: 0 for k in (
        "patients", "submissions", "probes", "blocks", "scans",
        "reports_microscopy", "reports_macro",
        "with_slide", "without_slide", "topo_unmapped", "morph_unmapped",
    )}
    printed = 0

    for _, row in tqdm(df.iterrows(), total=len(df), desc="  Radboud"):
        nij = clean(row.get("patient_id"))
        tnum = clean(row.get("T-nummer"))
        if not nij or not tnum:
            continue

        sex = SEX_MAP.get(clean(row.get("gender")) or "")
        dob = derive_dob(row.get("dx_date"), row.get("age"))
        rdate = parse_date(row.get("dx_date"))

        mcode = derive_morph(row)
        if mcode and mcode not in morph_desc:
            stats["morph_unmapped"] += 1
            mcode = None
        topo_code, topo_text = derive_topo(row)
        if topo_code not in topo_desc_master:
            stats["topo_unmapped"] += 1

        # ── Backbone ───────────────────────────────────────────────────────────
        patient_id = upsert_patient(cur, nij, sex, source_id, dob, dry, stats)
        sub_id = upsert_submission(cur, patient_id, tnum, rdate, dry, stats)
        # topo_description = the master vocabulary's description (canonical casing).
        probe_id = upsert_probe(cur, sub_id, topo_desc_master.get(topo_code) or topo_text,
                                topo_code, [mcode] if mcode else [], dry, stats)

        # ── Slide (one per patient, if present) ──────────────────────────────────
        slide_path = image_map.get(nij_number(nij))
        if slide_path:
            stats["with_slide"] += 1
            label = Path(slide_path).name.rsplit(".", 1)[0]   # AQ_S05_P..._A15
            info = f"H&E whole-slide image ({SOURCE_CODE})"
            block_id = upsert_block(cur, probe_id, label, info, dry, stats)
            upsert_scan(cur, block_id, stain_id, slide_path, dry, stats)
        else:
            stats["without_slide"] += 1

        # ── Synthetic synoptic reports ──────────────────────────────────────────
        micro = build_microscopy_report(
            row, mcode, morph_desc.get(mcode) if mcode else None,
            topo_code, topo_desc_master.get(topo_code) or topo_text,
        )
        macro = build_macroscopy_report(row, topo_text, slide_path)
        upsert_report(cur, sub_id, "microscopy", micro, rdate, dry, stats)
        upsert_report(cur, sub_id, "macro", macro, rdate, dry, stats)

        if printed < print_reports:
            print("\n" + "#" * 78 + f"\n# {nij}  /  {tnum}\n" + "#" * 78)
            print(micro)
            print("\n" + "-" * 40 + "\n")
            print(macro)
            printed += 1

        if not dry and _ % 100 == 0:
            conn.commit()

    if not dry:
        conn.commit()
    cur.close()

    log.info("=" * 60)
    log.info("RADBOUD IMPORT SUMMARY" + ("  (DRY RUN — nothing written)" if dry else ""))
    log.info("=" * 60)
    for k in ("patients", "submissions", "probes", "blocks", "scans",
              "reports_microscopy", "reports_macro", "with_slide", "without_slide",
              "topo_unmapped", "morph_unmapped"):
        log.info(f"  {k:<20}: {stats[k]}")
    log.info("=" * 60)
    return stats


def main():
    ap = argparse.ArgumentParser(description="Import the Radboud UMC CRC cohort into PathoDB")
    ap.add_argument("--clinical", default=DEFAULT_CLINICAL, help="Radboud clinical .xlsx")
    ap.add_argument("--image-root", default=DEFAULT_IMAGE_ROOT, help="Folder of .mrxs slides")
    ap.add_argument("--dry-run", action="store_true", help="Read + render, write nothing")
    ap.add_argument("--limit", type=int, default=None, help="Only process the first N patients")
    ap.add_argument("--print-reports", type=int, default=0, help="Print the first N report pairs")
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
        load_radboud(args.clinical, args.image_root, conn, args.dry_run,
                     args.limit, args.print_reports)
    except Exception as exc:
        conn.rollback()
        log.error(f"Radboud import failed: {exc}", exc_info=True)
        sys.exit(1)
    finally:
        conn.close()


if __name__ == "__main__":
    main()
