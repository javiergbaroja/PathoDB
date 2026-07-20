#!/usr/bin/env python3
"""
PathoDB ETL — Mount Sinai Hospital (Toronto) colorectal cohort
==============================================================
Ingests the MSH Toronto CRC cohort (585 patients) into the existing PathoDB
backbone and synthesises synoptic-style reports from the integer-coded sheet.

Data provided
-------------
  clinical : MSH_CRC dataset.xlsx, sheet 'Data (n=585)' (codes in sheet 'Code').
  images   : Images/*.svs. Most are long-form 'TB_S02_<n>_SP-<yy>-<acc>_C0001_L16_A14.svs'
             with the SP embedded; 38 are short-form '<yy>-<acc>_<n>.svs'.

Identifiers
-----------
  patient_code      = 'MSH-' + ID           (ID column; MSH = Mount Sinai Hospital)
  lis_submission_id = SP                     (e.g. 'SP-11-160')
  slide link        : the SP extracted from the filename (embedded 'SP-..' or, for
                      short-form, the leading '<yy>-<acc>' -> 'SP-<yy>-<acc>').
  576/585 patients have >=1 slide; 9 have none; 36 slide-SPs are not in the sheet
  (skipped — no clinical data to attach them to).

Coded fields (decoded from the 'Code' sheet)
--------------------------------------------
  YEAR   : 1..6 -> 2011..2016 (year of diagnosis; year = 2010 + code).
  SEX    : 0=M, 1=F.  date_of_birth = year_of_diagnosis - AGE (Jan 1).
  Derived SNOMED (matched to the master vocabulary):
    topography (LOCATION_ALL): cecum T67100, ascending T67200, hepatic flexure
      T67300, transverse T67400, splenic T67500, descending T67600, sigmoid
      T67700, rectosigmoid T68200, rectum T68000.
    morphology (HISTO_TYPE): Conventional/SRC/Micropapillary -> M81403 (the master
      has no SRC/micropapillary code — per data owner, collapse to adeno NOS),
      Mucinous -> M84803, Other -> M80103 (carcinoma NOS), Mixed -> M82553
      (adenocarcinoma w/ mixed subtypes).

Reports render grade, LVI/VI/EMVI/PNI, deposits, budding grade, serosal, pT/pN/pM,
AJCC stage group, MMR/RAS/BRAF, margin + LN counts. Survival/recurrence/treatment
columns are left for a future structured clinical model.

Idempotent (ON CONFLICT). --dry-run reads + renders, writes nothing.
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

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s  %(levelname)-8s  %(message)s",
                    datefmt="%Y-%m-%d %H:%M:%S")
log = logging.getLogger("pathodb_etl_toronto")

DEFAULT_CLINICAL = "/storage/research/igmp_dp_workspace/baumann_elias/other_ds/toronto/MSH_CRC dataset.xlsx"
DEFAULT_IMAGE_ROOT = "/storage/research/igmp_dp_workspace/baumann_elias/other_ds/toronto/Images"
CLINICAL_SHEET = "Data (n=585)"

SOURCE_CODE = "MSH"
SOURCE_NAME = "Mount Sinai Hospital — Toronto CRC"
SOURCE_INSTITUTION = "Mount Sinai Hospital, Toronto (CA)"
SOURCE_GOVERNANCE = "collaboration (data transfer agreement)"
SENTINEL_PROBE = "1"
NA = "Not reported in source dataset"

# ── Decode maps (from the 'Code' sheet) ───────────────────────────────────────
SEX_MAP   = {"0": "M", "1": "F"}
GRADE     = {"0": "Low grade", "1": "High grade"}
MARGIN    = {"0": "R0", "1": "R1", "2": "R2"}
MMR       = {"0": "pMMR (proficient / normal)", "1": "dMMR (deficient / abnormal)"}
MUT       = {"0": "wild type", "1": "mutant"}
PRESENT   = {"0": "Not identified", "1": "Present"}
NEOADJ    = {"0": "None", "1": "Chemoradiation (CRT)", "2": "Radiotherapy only", "3": "Chemotherapy only"}
SEMI      = {"0": "right colon", "1": "left colon", "2": "rectosigmoid", "3": "rectum"}
N_SUB     = {"0": "pN0", "1": "pN1a", "2": "pN1b", "3": "pN1c", "4": "pN2a", "5": "pN2b"}
N_MAIN    = {"0": "pN0", "1": "pN1", "2": "pN2"}
AJCC_ALL  = {"1": "I", "2": "IIA", "3": "IIB", "4": "IIC", "5": "IIIA",
             "6": "IIIB", "7": "IIIC", "8": "IVA", "9": "IVB", "10": "IVC"}
BUD_GRADE = {"1": "Bd1 (low)", "2": "Bd2 (intermediate)", "3": "Bd3 (high)"}

# LOCATION_ALL code -> SNOMED topography code (master vocabulary)
LOC_TOPO = {
    "0": "T67100", "1": "T67200", "2": "T67300", "3": "T67400", "4": "T67500",
    "5": "T67600", "6": "T67700", "7": "T68200", "8": "T68000",
}
# HISTO_TYPE code -> (SNOMED morphology code, display name)
HISTO_MORPH = {
    "0": ("M81403", "Conventional adenocarcinoma"),
    "1": ("M84803", "Mucinous adenocarcinoma"),
    "2": ("M81403", "Signet-ring cell carcinoma"),      # no master code -> adeno NOS
    "3": ("M81403", "Micropapillary carcinoma"),        # no master code -> adeno NOS
    "4": ("M80103", "Other carcinoma"),
    "5": ("M82553", "Mixed-subtype carcinoma"),
}


# ── Value helpers ─────────────────────────────────────────────────────────────

def clean(val) -> Optional[str]:
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
    s = clean(val)
    return mapping.get(s, na) if s is not None else na


def field(val) -> str:
    s = clean(val)
    return s if s is not None else NA


def diag_year(row) -> Optional[int]:
    y = clean_int(row.get("YEAR"))
    return 2010 + y if y and 1 <= y <= 6 else None


# ── Slide linkage ─────────────────────────────────────────────────────────────

def extract_sp(filename: str) -> Optional[str]:
    stem = filename.rsplit(".", 1)[0]
    m = re.search(r"SP-\d+-\d+", stem)                 # long form: embedded SP
    if m:
        return m.group(0)
    m = re.match(r"(\d+-\d+)_", stem)                  # short form: leading yy-acc
    if m:
        return "SP-" + m.group(1)
    return None


def build_image_map(image_root: str) -> dict:
    root = Path(image_root)
    out: dict = {}
    for fn in os.listdir(root):
        if not fn.lower().endswith(".svs"):
            continue
        sp = extract_sp(fn)
        if sp:
            out.setdefault(sp, []).append(str(root / fn))
        else:
            log.warning(f"  Unparseable slide name skipped: {fn}")
    return out


# ── Report builders ───────────────────────────────────────────────────────────

def _header(kind, sp, mshid):
    return (f"COLORECTAL CARCINOMA — SYNOPTIC {kind}\n"
            f"Derived from {SOURCE_NAME} structured clinical data — not an original "
            f"pathologist narrative.\n"
            f"Source: {SOURCE_CODE} · Case {sp} · Patient MSH-{mshid}\n")


def _pn(row) -> str:
    sub = coded(row.get("N_STAGE_SUB"), N_SUB, na=None)
    if sub:
        return sub
    return coded(row.get("N_STAGE_MAIN"), N_MAIN)


def build_microscopy_report(row, mcode, mdesc, mname, topo_code, topo_desc) -> str:
    sp = clean(row.get("SP")); mshid = clean(row.get("ID"))
    pt = clean_int(row.get("T_STAGE"))
    pm = clean_int(row.get("M_STAGE"))
    nl, pl = clean_int(row.get("LN_yield")), clean_int(row.get("NUM_POS_LN"))
    node_ct = f" ({pl}/{nl} positive)" if (nl is not None and pl is not None) else ""
    tb_ct = clean_int(row.get("TB_NORMALIZED"))
    tb = coded(row.get("TB_GRADE"), BUD_GRADE)
    if tb_ct is not None and tb != NA:
        tb += f" — {tb_ct} buds (ITBCC-normalised)"
    # Keep the ORIGINAL morphology in the narrative — SRC / micropapillary are
    # mapped to M81403 only for the structured snomed code (shown in CODED DATA),
    # not renamed to "adenocarcinoma, NOS" here.
    morph_line = mname

    return "\n".join([
        _header("DIAGNOSIS", sp, mshid),
        "DIAGNOSIS",
        f"  {mname} of the {topo_desc.lower()}.",
        "",
        "CLINICAL HISTORY",
        f"  Age at diagnosis      : {field(clean_int(row.get('AGE')))} years",
        f"  Sex                   : {SEX_MAP.get(clean(row.get('SEX')) or '', 'Not reported')}",
        f"  Neoadjuvant therapy   : {coded(row.get('NEOADJ'), NEOADJ)}",
        "",
        "HISTOPATHOLOGY",
        f"  Histologic type       : {morph_line}",
        f"  Histologic grade      : {coded(row.get('GRADE'), GRADE)}",
        f"  Tumour site           : {topo_desc} ({coded(row.get('LOCATION_SEMI'), SEMI)})",
        f"  Lymphovascular invasion: {coded(row.get('LVI'), PRESENT)}",
        f"  Venous invasion       : {coded(row.get('VI_ANY'), PRESENT)}",
        f"  Extramural venous inv.: {coded(row.get('EMVI'), PRESENT)}",
        f"  Perineural invasion   : {coded(row.get('PNI'), PRESENT)}",
        f"  Tumour deposits       : {coded(row.get('DEPOSIT'), PRESENT)}",
        f"  Tumour budding        : {tb}",
        f"  Serosal involvement   : {coded(row.get('SEROSAL'), PRESENT)}",
        f"  Perforation           : {coded(row.get('PERF'), PRESENT)}",
        "",
        "PATHOLOGIC STAGE (AJCC)",
        f"  Primary tumour (pT)   : {'pT'+str(pt) if pt else NA}",
        f"  Regional nodes (pN)   : {_pn(row)}{node_ct}",
        f"  Distant metastasis(pM): {'pM'+str(pm) if pm is not None else NA}",
        f"  Stage group           : {coded(row.get('AJCC_ALL'), AJCC_ALL)}",
        "",
        "ANCILLARY / MOLECULAR STUDIES",
        f"  Mismatch repair (IHC) : {coded(row.get('MMR'), MMR)}",
        f"  KRAS / RAS            : {coded(row.get('RAS'), MUT)}",
        f"  BRAF                  : {coded(row.get('BRAF'), MUT)}",
        "",
        "RESECTION",
        f"  Margin status         : {coded(row.get('MARGIN_ALL'), MARGIN)}",
        f"  Lymph nodes examined  : {field(clean_int(row.get('LN_yield')))}",
        f"  Lymph nodes positive  : {field(clean_int(row.get('NUM_POS_LN')))}",
        "",
        "CODED DATA",
        f"  SNOMED topography     : {topo_code} ({topo_desc})",
        f"  SNOMED morphology     : {field(mcode)}" + (f" ({mdesc})" if mdesc else ""),
        f"  Year of diagnosis     : {field(diag_year(row))}",
    ])


def build_macroscopy_report(row, topo_desc, slide_paths) -> str:
    sp = clean(row.get("SP")); mshid = clean(row.get("ID"))
    if slide_paths:
        inv = [f"  {len(slide_paths)} whole-slide H&E image(s):"] + \
              [f"    {Path(p).name}" for p in slide_paths]
    else:
        inv = ["  No whole-slide image registered for this patient."]
    return "\n".join([
        _header("GROSS SUMMARY", sp, mshid),
        "SPECIMEN",
        f"  Anatomic site         : {topo_desc}",
        f"  Region                : {coded(row.get('LOCATION_SEMI'), SEMI)}",
        f"  Neoadjuvant therapy   : {coded(row.get('NEOADJ'), NEOADJ)}",
        "",
        "WHOLE-SLIDE INVENTORY (from image repository)",
        *inv,
        "",
        "MACROSCOPIC FEATURES",
        f"  Lymph nodes retrieved : {field(clean_int(row.get('LN_yield')))}",
        f"  Perforation           : {coded(row.get('PERF'), PRESENT)}",
        f"  Tumour size           : {NA}",
    ])


# ── DB helpers ────────────────────────────────────────────────────────────────

def get_or_create_source(cur, dry) -> Optional[int]:
    cur.execute("SELECT id FROM data_sources WHERE code = %s", (SOURCE_CODE,))
    row = cur.fetchone()
    if row:
        return row[0]
    if dry:
        return -1
    cur.execute("""INSERT INTO data_sources (code, name, institution, governance)
                   VALUES (%s,%s,%s,%s) ON CONFLICT (code) DO NOTHING RETURNING id""",
                (SOURCE_CODE, SOURCE_NAME, SOURCE_INSTITUTION, SOURCE_GOVERNANCE))
    r = cur.fetchone()
    if r:
        return r[0]
    cur.execute("SELECT id FROM data_sources WHERE code = %s", (SOURCE_CODE,))
    return cur.fetchone()[0]


def fetch_he_stain_id(cur) -> int:
    cur.execute("SELECT id FROM stains WHERE stain_category='HE' ORDER BY id LIMIT 1")
    row = cur.fetchone()
    if not row:
        raise RuntimeError("No H&E stain in `stains`.")
    return row[0]


def fetch_desc(cur, category) -> dict:
    cur.execute("SELECT code, description FROM snomed_codes WHERE category=%s", (category,))
    return {c: d for c, d in cur.fetchall()}


def upsert_patient(cur, code, sex, source_id, dob, dry, stats) -> Optional[int]:
    if dry:
        stats["patients"] += 1
        return -1
    cur.execute("""INSERT INTO patients (patient_code, sex, source_id, date_of_birth)
        VALUES (%s,%s,%s,%s)
        ON CONFLICT (patient_code) DO UPDATE
          SET source_id=EXCLUDED.source_id, sex=EXCLUDED.sex, date_of_birth=EXCLUDED.date_of_birth
        RETURNING id, (xmax=0) AS inserted""", (code, sex, source_id, dob))
    pid, inserted = cur.fetchone()
    if inserted:
        stats["patients"] += 1
    return pid


def upsert_submission(cur, patient_id, sp, report_date, dry, stats) -> Optional[int]:
    if dry:
        stats["submissions"] += 1
        return -1
    cur.execute("""INSERT INTO submissions (patient_id, lis_submission_id, report_date, malignancy_flag, consent)
        VALUES (%s,%s,%s,TRUE,NULL)
        ON CONFLICT (lis_submission_id) DO UPDATE SET report_date=EXCLUDED.report_date
        RETURNING id""", (patient_id, sp, report_date))
    stats["submissions"] += 1
    return cur.fetchone()[0]


def upsert_probe(cur, sub_id, topo_desc, topo_code, morph_codes, dry, stats) -> Optional[int]:
    if dry:
        stats["probes"] += 1
        return -1
    cur.execute("""INSERT INTO probes
          (submission_id, lis_probe_id, submission_type, topo_description, snomed_topo_code, snomed_morph_codes)
        VALUES (%s,%s,%s,%s,%s,%s)
        ON CONFLICT (submission_id, lis_probe_id) DO UPDATE
          SET topo_description=EXCLUDED.topo_description, snomed_topo_code=EXCLUDED.snomed_topo_code,
              snomed_morph_codes=EXCLUDED.snomed_morph_codes
        RETURNING id""",
                (sub_id, SENTINEL_PROBE, f"{SOURCE_CODE} case", topo_desc, topo_code, morph_codes))
    stats["probes"] += 1
    return cur.fetchone()[0]


def upsert_block(cur, probe_id, label, dry, stats) -> Optional[int]:
    if dry:
        stats["blocks"] += 1
        return -abs(hash((probe_id, label)))
    cur.execute("""INSERT INTO blocks (probe_id, block_label, block_info) VALUES (%s,%s,%s)
        ON CONFLICT (probe_id, block_label) DO NOTHING""",
                (probe_id, label, f"H&E whole-slide image ({SOURCE_CODE})"))
    if cur.rowcount:
        stats["blocks"] += 1
    cur.execute("SELECT id FROM blocks WHERE probe_id=%s AND block_label=%s", (probe_id, label))
    return cur.fetchone()[0]


def upsert_scan(cur, block_id, stain_id, file_path, dry, stats):
    if dry:
        stats["scans"] += 1
        return
    cur.execute("""INSERT INTO scans (block_id, stain_id, file_path, file_format)
        VALUES (%s,%s,%s,'SVS')
        ON CONFLICT (file_path) DO UPDATE SET block_id=EXCLUDED.block_id
        RETURNING (xmax=0) AS inserted""", (block_id, stain_id, file_path))
    if cur.fetchone()[0]:
        stats["scans"] += 1


def upsert_report(cur, sub_id, rtype, text, report_date, dry, stats):
    if dry:
        stats[f"reports_{rtype}"] += 1
        return
    cur.execute("""INSERT INTO reports (submission_id, report_type, report_text, report_date)
        VALUES (%s,%s,%s,%s)
        ON CONFLICT (submission_id, report_type) DO UPDATE
          SET report_text=EXCLUDED.report_text, report_date=EXCLUDED.report_date""",
                (sub_id, rtype, text, report_date))
    stats[f"reports_{rtype}"] += 1


# ── Main load ─────────────────────────────────────────────────────────────────

def load(clinical, image_root, conn, dry, limit, print_reports):
    df = pd.read_excel(clinical, sheet_name=CLINICAL_SHEET, dtype=str)
    df.columns = [str(c).strip() for c in df.columns]
    if limit:
        df = df.head(limit)

    cur = conn.cursor()
    stain_id = fetch_he_stain_id(cur)
    source_id = get_or_create_source(cur, dry)
    morph_desc = fetch_desc(cur, "morphology")
    topo_desc = fetch_desc(cur, "topography")
    image_map = build_image_map(image_root)
    total_slides = sum(len(v) for v in image_map.values())
    log.info(f"H&E stain_id={stain_id} | source '{SOURCE_CODE}' id={source_id} | "
             f"{len(df)} patients | {total_slides} slides indexed ({len(image_map)} SPs)")

    stats = {k: 0 for k in ("patients", "submissions", "probes", "blocks", "scans",
                            "reports_microscopy", "reports_macro", "with_slide",
                            "without_slide", "topo_unmapped", "morph_unmapped")}
    linked_slides = 0
    printed = 0

    for i, row in tqdm(df.iterrows(), total=len(df), desc="  Toronto"):
        mshid = clean(row.get("ID")); sp = clean(row.get("SP"))
        if not mshid or not sp:
            continue
        code = f"MSH-{mshid}"
        sex = SEX_MAP.get(clean(row.get("SEX")) or "")
        yr = diag_year(row)
        rdate = date(yr, 1, 1) if yr else None
        age = clean_int(row.get("AGE"))
        dob = date(yr - age, 1, 1) if (yr and age is not None) else None

        loc = clean(row.get("LOCATION_ALL"))
        tcode = LOC_TOPO.get(loc)
        if loc is not None and tcode is None:
            stats["topo_unmapped"] += 1
        tdesc = topo_desc.get(tcode) or "colon"
        histo = clean(row.get("HISTO_TYPE"))
        mcode, mname = HISTO_MORPH.get(histo, (None, "Carcinoma"))
        if mcode and mcode not in morph_desc:
            stats["morph_unmapped"] += 1; mcode = None

        patient_id = upsert_patient(cur, code, sex, source_id, dob, dry, stats)
        sub_id = upsert_submission(cur, patient_id, sp, rdate, dry, stats)
        probe_id = upsert_probe(cur, sub_id, tdesc, tcode, [mcode] if mcode else [], dry, stats)

        slides = image_map.get(sp, [])
        if slides:
            stats["with_slide"] += 1
        else:
            stats["without_slide"] += 1
        for path in slides:
            label = Path(path).name.rsplit(".", 1)[0]
            block_id = upsert_block(cur, probe_id, label, dry, stats)
            upsert_scan(cur, block_id, stain_id, path, dry, stats)
            linked_slides += 1

        micro = build_microscopy_report(row, mcode, morph_desc.get(mcode) if mcode else None,
                                        mname, tcode, tdesc)
        macro = build_macroscopy_report(row, tdesc, slides)
        upsert_report(cur, sub_id, "microscopy", micro, rdate, dry, stats)
        upsert_report(cur, sub_id, "macro", macro, rdate, dry, stats)

        if printed < print_reports:
            print("\n" + "#" * 78 + f"\n# {code}  /  {sp}\n" + "#" * 78)
            print(micro); print("\n" + "-" * 40 + "\n"); print(macro)
            printed += 1
        if not dry and i % 100 == 0:
            conn.commit()

    if not dry:
        conn.commit()
    cur.close()

    log.info("=" * 60)
    log.info("TORONTO IMPORT SUMMARY" + ("  (DRY RUN — nothing written)" if dry else ""))
    log.info("=" * 60)
    for k in ("patients", "submissions", "probes", "blocks", "scans",
              "reports_microscopy", "reports_macro", "with_slide", "without_slide",
              "topo_unmapped", "morph_unmapped"):
        log.info(f"  {k:<20}: {stats[k]}")
    log.info(f"  slides linked         : {linked_slides}")
    log.info(f"  slides skipped (SP not in sheet): {total_slides - linked_slides}")
    log.info("=" * 60)
    return stats


def main():
    ap = argparse.ArgumentParser(description="Import the MSH Toronto CRC cohort into PathoDB")
    ap.add_argument("--clinical", default=DEFAULT_CLINICAL)
    ap.add_argument("--image-root", default=DEFAULT_IMAGE_ROOT)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--print-reports", type=int, default=0)
    args = ap.parse_args()

    if not Path(args.clinical).exists():
        log.error(f"Clinical file not found: {args.clinical}"); sys.exit(1)
    if args.dry_run:
        log.info("DRY RUN — no data will be written")
    load_dotenv()
    db_url = os.getenv("DATABASE_URL")
    if not db_url:
        log.error("DATABASE_URL not set"); sys.exit(1)
    conn = psycopg2.connect(db_url)
    try:
        load(args.clinical, args.image_root, conn, args.dry_run, args.limit, args.print_reports)
    except Exception as exc:
        conn.rollback()
        log.error(f"Toronto import failed: {exc}", exc_info=True)
        sys.exit(1)
    finally:
        conn.close()


if __name__ == "__main__":
    main()
