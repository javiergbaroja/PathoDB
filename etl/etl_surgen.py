#!/usr/bin/env python3
"""
PathoDB ETL — SurGen (Scotland, public) colorectal cohort
=========================================================
Public dataset EBI BioStudies S-BIAD1285. Two parts with DIFFERENT label schemas:
  SR386  (427 cases, clean/rich labels, 1 CZI slide/case)
  SR1482 (416 cases, leaner/messy labels, multi CZI slides/case)

Slides are Zeiss CZI. NOTE: the viewer uses OpenSlide, which cannot read CZI, so
these scans are registered (file_format='CZI') as inventory but WILL NOT open in
the viewer until they are converted to a pyramidal format (OME-TIFF) or a CZI
reader is added — a deliberate, accepted follow-up.

Backbone / IDs
--------------
  one 'SURGEN' data source. case_id restarts at 001 in each part, so namespace:
    patient_code      = 'SURGEN-<part>-<case_id>'   (e.g. SURGEN-SR386-001)
    lis_submission_id = '<part>-<case_id>'          (e.g. SR386-001)
  slide link: '<part>_40X_HE_T<case_id>_<n>.czi' -> case_id.
  report_date / date_of_birth: NULL (no date-of-diagnosis or birth data in source).

Derived SNOMED (matched to master vocabulary)
--------------------------------------------
  topography SR386 : site_of_tumour_grouping -> exact master code.
  topography SR1482: free-text tumour_site keyword-matched; metastatic/biopsy
                     sites (liver, bladder, bronchial, …) get NO topo code.
  morphology       : 'mucinous' in the type text -> M84803, else M81403 (adeno NOS).

Idempotent (ON CONFLICT). --dry-run reads + renders, writes nothing.
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
log = logging.getLogger("pathodb_etl_surgen")

DEFAULT_ROOT = "/storage/research/igmp_slide_workspace/GRP Zlobec/SurGen"
SOURCE_CODE = "SURGEN"
SOURCE_NAME = "SurGen — Scotland CRC (public)"
SOURCE_INSTITUTION = "SurGen / NHS Scotland (EBI BioStudies S-BIAD1285)"
SOURCE_GOVERNANCE = "public / open-access"
SENTINEL_PROBE = "1"
NA = "Not reported in source dataset"

PARTS = ["SR386", "SR1482"]

# SR386 site_of_tumour_grouping -> master SNOMED topography code
SR386_TOPO = {
    "rectum": "T68000", "sigmoid colon": "T67700", "caecum": "T67100",
    "ascending colon": "T67200", "transverse colon": "T67400",
    "descending colon": "T67600", "splenic flexure": "T67500",
    "hepatic flexure": "T67300",
}
# SR1482 free-text tumour_site keyword -> topography code (order matters: specific first)
SR1482_SITE_KW = [
    ("rectosigmoid", "T68200"), ("recto-sigmoid", "T68200"), ("sigmoid", "T67700"),
    ("rectal", "T68000"), ("rectum", "T68000"), ("caecum", "T67100"),
    ("cecum", "T67100"), ("caecal", "T67100"), ("ascending", "T67200"),
    ("hepatic flexure", "T67300"), ("transverse", "T67400"),
    ("splenic flexure", "T67500"), ("descending", "T67600"),
    ("right colon", "T67200"), ("left colon", "T67600"), ("colon", "T67000"),
]
GRADE_WORD = {"well": "Well differentiated", "mod": "Moderately differentiated",
              "poor": "Poorly differentiated"}


# ── Value helpers ─────────────────────────────────────────────────────────────

def clean(val) -> Optional[str]:
    if val is None:
        return None
    s = str(val).strip()
    return None if s.lower() in ("", "nan", "none", "null", "-", "not specifed",
                                 "not specified", "n/a") else s


def clean_int(val) -> Optional[int]:
    s = clean(val)
    if s is None:
        return None
    try:
        return int(float(s))
    except ValueError:
        return None


def field(val) -> str:
    s = clean(val)
    return s if s is not None else NA


def summ_mut(*vals) -> str:
    """Summarise mutation columns whose values look like 'M (G12D)' / 'WT' / 'FAIL'."""
    muts, wt, fail = [], 0, 0
    for v in vals:
        s = clean(v)
        if not s:
            continue
        su = s.upper()
        if su == "WT":
            wt += 1
        elif su == "FAIL":
            fail += 1
        else:
            muts.append(s)
    if muts:
        return "Mutant — " + "; ".join(muts)
    if wt:
        return "Wild type"
    if fail:
        return "Not assessable (assay failed)"
    return NA


def norm_hgvs(v) -> str:
    """SR1482 KRAS/NRAS/BRAF single-string values."""
    s = clean(v)
    if not s:
        return NA
    sl = s.lower()
    if sl in ("no mutation", "wt", "wild type"):
        return "Wild type"
    if sl == "not performed":
        return "Not performed"
    if sl in ("failed", "insufficient", "fail"):
        return "Not assessable"
    return f"Mutant — {s}"


def norm_msi(v) -> str:
    s = clean(v)
    if not s:
        return NA
    sl = s.lower().replace(" ", "")
    if sl == "nomsi":
        return "MSS (no MSI)"
    if sl == "msihigh":
        return "MSI-High"
    if sl == "msilow":
        return "MSI-Low"
    return s


# ── Per-part record extraction (normalised dict) ──────────────────────────────

def extract_sr386(row) -> dict:
    tt = clean(row.get("tumour_type"))
    morph_name = re.sub(r"^A/C", "Adenocarcinoma", tt) if tt else "Adenocarcinoma, NOS"
    mcode = "M84803" if (tt and "mucin" in tt.lower()) else "M81403"
    grouping = (clean(row.get("site_of_tumour_grouping")) or "").lower()
    tcode = SR386_TOPO.get(grouping)
    diff = (clean(row.get("differentiation")) or "").lower()
    grade = next((v for k, v in GRADE_WORD.items() if diff.startswith(k)), NA)
    mmr_ihc = clean(row.get("mmr_ihc"))
    mmr = ("pMMR (no loss)" if mmr_ihc and mmr_ihc.upper() == "NO LOSS"
           else f"dMMR ({mmr_ihc})" if mmr_ihc else NA)
    return {
        "sex": clean(row.get("sex")), "age": clean_int(row.get("age_at_diagnosis")),
        "site_text": clean(row.get("site_of_tumour")), "topo_code": tcode,
        "morph_code": mcode, "morph_name": morph_name, "grade": grade,
        "pT": clean(row.get("pT")), "pN": clean(row.get("pN")), "pM": clean(row.get("pM")),
        "stage": clean(row.get("stage_subgroup")) or clean(row.get("stage")),
        "mmr": mmr, "msi": NA,
        "kras": summ_mut(row.get("kras_ex_2"), row.get("kras_ex_3"), row.get("kras_codon_117")),
        "nras": summ_mut(row.get("nras_ex_2"), row.get("nras_ex_3")),
        "braf": summ_mut(row.get("braf_mutant_status")),
        "lvi": field(row.get("em_lvi")),
        "peri": field(row.get("peri_surface_involved")),
    }


def _sr1482_topo(site_text) -> Optional[str]:
    t = (site_text or "").lower()
    for kw, code in SR1482_SITE_KW:
        if kw in t:
            return code
    return None


def extract_sr1482(row) -> dict:
    site = clean(row.get("tumour_site"))
    notes = " ".join(str(row.get(c) or "") for c in ("tumour_site", "stage_notes")).lower()
    mcode = "M84803" if "mucin" in notes else "M81403"
    dukes = clean(row.get("dukes"))
    return {
        "sex": clean(row.get("sex")), "age": clean_int(row.get("age")),
        "site_text": site, "topo_code": _sr1482_topo(site),
        "morph_code": mcode, "morph_name": "Adenocarcinoma, NOS", "grade": NA,
        "pT": clean(row.get("pT")), "pN": clean(row.get("pN")), "pM": clean(row.get("pM")),
        "stage": (f"Dukes {dukes}" if dukes else None) or clean(row.get("stage_notes")),
        "mmr": _mmr_1482(row.get("MMR")), "msi": norm_msi(row.get("MSI")),
        "kras": norm_hgvs(row.get("KRAS")), "nras": norm_hgvs(row.get("NRAS")),
        "braf": norm_hgvs(row.get("BRAF")),
        "lvi": NA, "peri": NA,
    }


def _mmr_1482(v) -> str:
    s = clean(v)
    if not s:
        return NA
    sl = s.lower()
    if sl == "not performed":
        return "Not performed"
    if sl == "no loss":
        return "pMMR (no loss)"
    if "loss" in sl:
        return "dMMR (loss present — see source notes)"
    return s[:80]


EXTRACT = {"SR386": extract_sr386, "SR1482": extract_sr1482}


# ── Report builders ───────────────────────────────────────────────────────────

def _header(kind, sp, pcode):
    return (f"COLORECTAL CARCINOMA — SYNOPTIC {kind}\n"
            f"Derived from {SOURCE_NAME} structured data — not an original "
            f"pathologist narrative.\n"
            f"Source: {SOURCE_CODE} · Case {sp} · Patient {pcode}\n")


def build_microscopy_report(rec, sp, pcode, topo_desc, mdesc) -> str:
    site = topo_desc or rec.get("site_text") or "colon"
    coded_topo = (f"{rec['topo_code']} ({topo_desc})" if rec.get("topo_code")
                  else f"Not assigned (specimen site: {rec.get('site_text') or 'unknown'})")
    return "\n".join([
        _header("DIAGNOSIS", sp, pcode),
        "DIAGNOSIS",
        f"  {rec['morph_name']} of the {site.lower()}.",
        "",
        "CLINICAL HISTORY",
        f"  Age at diagnosis      : {rec['age'] if rec['age'] is not None else NA} years",
        f"  Sex                   : {rec['sex'] or 'Not reported'}",
        "",
        "HISTOPATHOLOGY",
        f"  Histologic type       : {rec['morph_name']}",
        f"  Histologic grade      : {rec['grade']}",
        f"  Tumour site (reported): {rec.get('site_text') or NA}",
        f"  Lymphovascular/venous : {rec['lvi']}",
        f"  Peritoneal surface    : {rec['peri']}",
        "",
        "PATHOLOGIC STAGE",
        f"  Primary tumour (pT)   : {rec['pT'] or NA}",
        f"  Regional nodes (pN)   : {rec['pN'] or NA}",
        f"  Distant metastasis(pM): {rec['pM'] or NA}",
        f"  Stage group           : {rec['stage'] or NA}",
        "",
        "ANCILLARY / MOLECULAR STUDIES",
        f"  Mismatch repair (IHC) : {rec['mmr']}",
        f"  Microsatellite (MSI)  : {rec['msi']}",
        f"  KRAS                  : {rec['kras']}",
        f"  NRAS                  : {rec['nras']}",
        f"  BRAF                  : {rec['braf']}",
        "",
        "CODED DATA",
        f"  SNOMED topography     : {coded_topo}",
        f"  SNOMED morphology     : {rec.get('morph_code') or NA}"
        + (f" ({mdesc})" if mdesc else ""),
    ])


def build_macroscopy_report(rec, sp, pcode, topo_desc, slide_paths) -> str:
    if slide_paths:
        inv = [f"  {len(slide_paths)} whole-slide H&E image(s) [CZI — not viewable until converted]:"] + \
              [f"    {Path(p).name}" for p in slide_paths]
    else:
        inv = ["  No whole-slide image registered for this case."]
    return "\n".join([
        _header("GROSS SUMMARY", sp, pcode),
        "SPECIMEN",
        f"  Anatomic site         : {topo_desc or rec.get('site_text') or NA}",
        f"  Specimen (as reported): {rec.get('site_text') or NA}",
        "",
        "WHOLE-SLIDE INVENTORY (from image repository)",
        *inv,
        "",
        "MACROSCOPIC FEATURES",
        f"  Peritoneal surface    : {rec['peri']}",
        f"  Tumour size           : {NA}",
    ])


# ── DB helpers ────────────────────────────────────────────────────────────────

def get_or_create_source(cur, dry) -> Optional[int]:
    cur.execute("SELECT id FROM data_sources WHERE code=%s", (SOURCE_CODE,))
    row = cur.fetchone()
    if row:
        return row[0]
    if dry:
        return -1
    cur.execute("""INSERT INTO data_sources (code,name,institution,governance)
                   VALUES (%s,%s,%s,%s) ON CONFLICT (code) DO NOTHING RETURNING id""",
                (SOURCE_CODE, SOURCE_NAME, SOURCE_INSTITUTION, SOURCE_GOVERNANCE))
    r = cur.fetchone()
    if r:
        return r[0]
    cur.execute("SELECT id FROM data_sources WHERE code=%s", (SOURCE_CODE,))
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


def upsert_patient(cur, code, sex, source_id, dry, stats) -> Optional[int]:
    if dry:
        stats["patients"] += 1
        return -1
    cur.execute("""INSERT INTO patients (patient_code, sex, source_id) VALUES (%s,%s,%s)
        ON CONFLICT (patient_code) DO UPDATE SET source_id=EXCLUDED.source_id, sex=EXCLUDED.sex
        RETURNING id, (xmax=0) AS inserted""", (code, sex, source_id))
    pid, inserted = cur.fetchone()
    if inserted:
        stats["patients"] += 1
    return pid


def upsert_submission(cur, patient_id, sp, dry, stats) -> Optional[int]:
    if dry:
        stats["submissions"] += 1
        return -1
    cur.execute("""INSERT INTO submissions (patient_id, lis_submission_id, report_date, malignancy_flag, consent)
        VALUES (%s,%s,NULL,TRUE,NULL)
        ON CONFLICT (lis_submission_id) DO UPDATE SET malignancy_flag=EXCLUDED.malignancy_flag
        RETURNING id""", (patient_id, sp))
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
                (probe_id, label, f"H&E whole-slide image ({SOURCE_CODE}, CZI)"))
    if cur.rowcount:
        stats["blocks"] += 1
    cur.execute("SELECT id FROM blocks WHERE probe_id=%s AND block_label=%s", (probe_id, label))
    return cur.fetchone()[0]


def upsert_scan(cur, block_id, stain_id, file_path, dry, stats):
    if dry:
        stats["scans"] += 1
        return
    cur.execute("""INSERT INTO scans (block_id, stain_id, file_path, file_format)
        VALUES (%s,%s,%s,'CZI')
        ON CONFLICT (file_path) DO UPDATE SET block_id=EXCLUDED.block_id
        RETURNING (xmax=0) AS inserted""", (block_id, stain_id, file_path))
    if cur.fetchone()[0]:
        stats["scans"] += 1


def upsert_report(cur, sub_id, rtype, text, dry, stats):
    if dry:
        stats[f"reports_{rtype}"] += 1
        return
    cur.execute("""INSERT INTO reports (submission_id, report_type, report_text, report_date)
        VALUES (%s,%s,%s,NULL)
        ON CONFLICT (submission_id, report_type) DO UPDATE SET report_text=EXCLUDED.report_text""",
                (sub_id, rtype, text))
    stats[f"reports_{rtype}"] += 1


# ── Slide map ─────────────────────────────────────────────────────────────────

def build_slide_map(folder) -> dict:
    m: dict = {}
    if not Path(folder).is_dir():
        return m
    for fn in os.listdir(folder):
        if fn.lower().endswith(".czi"):
            mm = re.search(r"_T(\w+?)_\d+\.czi$", fn, re.I)
            if mm:
                m.setdefault(mm.group(1), []).append(str(Path(folder) / fn))
    return m


# ── Main load ─────────────────────────────────────────────────────────────────

def load(root, conn, dry, limit, print_reports):
    cur = conn.cursor()
    stain_id = fetch_he_stain_id(cur)
    source_id = get_or_create_source(cur, dry)
    morph_desc = fetch_desc(cur, "morphology")
    topo_desc = fetch_desc(cur, "topography")

    stats = {k: 0 for k in ("patients", "submissions", "probes", "blocks", "scans",
                            "reports_microscopy", "reports_macro", "with_slide",
                            "without_slide", "topo_unmapped")}
    printed = 0

    for part in PARTS:
        df = pd.read_csv(Path(root) / f"{part}_labels.csv", dtype=str)
        df.columns = [c.strip() for c in df.columns]
        if limit:
            df = df.head(limit)
        slide_map = build_slide_map(Path(root) / f"{part}_WSIs")
        log.info(f"[{part}] {len(df)} cases | {sum(len(v) for v in slide_map.values())} slides "
                 f"({len(slide_map)} case-ids)")

        for i, row in tqdm(df.iterrows(), total=len(df), desc=f"  {part}"):
            cid = clean(row.get("case_id"))
            if not cid:
                continue
            pcode = f"{SOURCE_CODE}-{part}-{cid}"
            sp = f"{part}-{cid}"
            rec = EXTRACT[part](row)

            tcode = rec.get("topo_code")
            if tcode is None:
                stats["topo_unmapped"] += 1
            tdesc = topo_desc.get(tcode) if tcode else None
            mcode = rec.get("morph_code")
            if mcode and mcode not in morph_desc:
                mcode = None
            rec["morph_code"] = mcode

            patient_id = upsert_patient(cur, pcode, rec["sex"], source_id, dry, stats)
            sub_id = upsert_submission(cur, patient_id, sp, dry, stats)
            probe_id = upsert_probe(cur, sub_id, tdesc, tcode, [mcode] if mcode else [], dry, stats)

            slides = slide_map.get(cid, [])
            stats["with_slide" if slides else "without_slide"] += 1
            for path in slides:
                label = Path(path).name.rsplit(".", 1)[0]
                block_id = upsert_block(cur, probe_id, label, dry, stats)
                upsert_scan(cur, block_id, stain_id, path, dry, stats)

            micro = build_microscopy_report(rec, sp, pcode, tdesc, morph_desc.get(mcode) if mcode else None)
            macro = build_macroscopy_report(rec, sp, pcode, tdesc, slides)
            upsert_report(cur, sub_id, "microscopy", micro, dry, stats)
            upsert_report(cur, sub_id, "macro", macro, dry, stats)

            if printed < print_reports:
                print("\n" + "#" * 78 + f"\n# {pcode}  /  {sp}\n" + "#" * 78)
                print(micro); print("\n" + "-" * 40 + "\n"); print(macro)
                printed += 1
            if not dry and i % 100 == 0:
                conn.commit()
        if not dry:
            conn.commit()

    cur.close()
    log.info("=" * 60)
    log.info("SURGEN IMPORT SUMMARY" + ("  (DRY RUN — nothing written)" if dry else ""))
    log.info("=" * 60)
    for k in ("patients", "submissions", "probes", "blocks", "scans",
              "reports_microscopy", "reports_macro", "with_slide", "without_slide",
              "topo_unmapped"):
        log.info(f"  {k:<20}: {stats[k]}")
    log.info("=" * 60)
    return stats


def main():
    ap = argparse.ArgumentParser(description="Import the SurGen (Scotland) CRC cohort into PathoDB")
    ap.add_argument("--root", default=DEFAULT_ROOT)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--print-reports", type=int, default=0)
    args = ap.parse_args()

    if not Path(args.root).is_dir():
        log.error(f"Root not found: {args.root}"); sys.exit(1)
    if args.dry_run:
        log.info("DRY RUN — no data will be written")
    load_dotenv()
    db_url = os.getenv("DATABASE_URL")
    if not db_url:
        log.error("DATABASE_URL not set"); sys.exit(1)
    conn = psycopg2.connect(db_url)
    try:
        load(args.root, conn, args.dry_run, args.limit, args.print_reports)
    except Exception as exc:
        conn.rollback()
        log.error(f"SurGen import failed: {exc}", exc_info=True)
        sys.exit(1)
    finally:
        conn.close()


if __name__ == "__main__":
    main()
