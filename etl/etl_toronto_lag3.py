#!/usr/bin/env python3
"""
PathoDB ETL — Mount Sinai Hospital (Toronto) LAG3-publication CRC sub-cohort
=============================================================================
Ingests a second, older MSH Toronto batch (142 cases, accession years 1992-2010)
donated for tissue-microarray (TMA) construction, distinct from the 2011-2016
batch loaded by etl_toronto.py (0 overlap in submission IDs, confirmed at
build time). Same PathoDB backbone, same data_sources row (source_id=3, code
'MSH') — this is an additional MSH sub-cohort, not a new source.

Data provided
-------------
  clinical : Copy of LAG3_publication_analysis.xlsx, sheet 'Tabelle1' (142 rows).
             No accompanying codebook sheet (unlike the 2011-2016 batch's
             'Code' sheet) — coded fields below are inferred from column
             semantics + the sibling dataset's conventions, not a codebook.
  images   : TMA_17_17_Toronto/*.mrxs (whole-slide scans of the donor blocks
             selected for TMA construction). HE and AE1/AE3 (pan-cytokeratin,
             used to assist tumour-budding counts) stains; filename suffix
             ' HE' / ' AE1_AE3' / ' new HE' identifies the stain, absence of
             a suffix -> assume HE (per data owner instruction). The 'Error/'
             and 'komisch/' subfolders (12 files) are QC-excluded — the data
             owner flagged them as problematic, so they are skipped entirely.

Identifiers
-----------
  accession          = patient_id with any leading legacy 'S' prefix stripped
                        (patient_id already equals ProbeNummer minus 'SP-',
                        except ~10 pre-2000 rows that keep 'S99-xxxx' style —
                        normalised here so lis_submission_id is uniform).
  lis_submission_id  = 'SP-' + accession   (e.g. 'SP-00-11188', 'SP-95-9158')
  patient_code       = 'MSH-<N>', continuing the SAME numeric sequence used by
                        the 2011-2016 batch (max existing MSH-N + 1, assigned
                        in accession order) — NOT a new naming scheme. Reruns
                        are idempotent: a case whose submission already exists
                        keeps its already-assigned patient_code instead of
                        being handed a new number.
  slide link         : clinical row's 'Donor Block ID' matched against the
                        mrxs filename (minus stain suffix), whitespace/case
                        normalised. 133/142 match exactly; 5 more (all
                        pre-2000, e.g. 'S95-9158-5' vs file 'S95-9158') match
                        via a same-case-root fallback (unique candidate
                        sharing the accession's first two dash tokens). 4 rows
                        have no image at all (3 fell in the excluded
                        Error/komisch folders, 1 — '10-22718' — has no file on
                        disk under any spelling, likely a transcription typo
                        against the on-disk '10-22716'; NOT guessed at,
                        registered with 0 scans for manual follow-up).
  212 image files (144 block-id keys) have no matching clinical row and are
  skipped — same policy as etl_toronto.py's unmatched-SP slides.

Coded fields (inferred — see docstring notes above; no source codebook)
------------------------------------------------------------------------
  Gender : 0=M, 1=F (matches the sibling MSH batch's SEX_MAP).
  G (grade): 1=Low grade, 2=High grade — inferred two-tier CRC grading
             (only values 1/2 occur; the sibling dataset's own GRADE field
             used an explicit 0/1 Low/High code, consistent with this read).
  V      : venous invasion, 0/1 -> Not identified / Present.
  Budding ITBCC : raw hotspot bud count -> ITBCC 2016 consensus tier
             (0-4 Bd1 low, 5-9 Bd2 intermediate, >=10 Bd3 high).
  MMR-status : 'MMR p' / 'MMR d' -> proficient / deficient (as in sibling batch).
  Tumor location -> SNOMED topography, matched to the master vocabulary
             (whitespace/case-normalised: 'Splenic flexure     ' == 'splenic
             flexure'); 'Right colon' / 'Left colon' (2 rows, no ICD10) have
             no side-specific master code -> mapped to generic T67000 'colon'.
  Morphology : no histologic-subtype column in this export (unlike the sibling
             batch's HISTO_TYPE) -> all rows get M81403 (adenocarcinoma, NOS),
             consistent with the ICD10 C18.x colon-adenocarcinoma pattern.
  Malignancy : ALL inserted submissions flagged malignant (explicit instruction).

Reports render pT/pN/pM/stage group, grade, venous invasion, tumour budding
(ITBCC tier + raw counts), LN yield/positive, MMR, plus a clearly-labelled
"RESEARCH IMMUNOHISTOCHEMISTRY (LAG3 — study data)" section for the
front/center/stroma LAG3 scores this sub-cohort was collected for — NOT a
routine clinical assay. Survival/relapse/metastasis-site columns are excluded
from report text, per the existing external-cohort design (structured-only,
future clinical-variables model), same as every other cohort ETL here.

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
log = logging.getLogger("pathodb_etl_toronto_lag3")

DEFAULT_CLINICAL = ("/storage/research/igmp_dp_workspace/baumann_elias/other_ds/"
                     "Mount_Sinai_Meta/Copy of LAG3_publication_analysis.xlsx")
DEFAULT_IMAGE_ROOT = ("/storage/research/igmp_slide_workspace/GRP Lugli-Zlobec/"
                       "01_Slides for TMA Construction/TMA_17_17_Toronto")
CLINICAL_SHEET = "Tabelle1"
EXCLUDE_DIRS = {"Error", "komisch"}

SOURCE_CODE = "MSH"
SENTINEL_PROBE = "1"
NA = "Not reported in source dataset"

SEX_MAP = {"0": "M", "1": "F"}
GRADE_MAP = {"1": "Low grade (G1)", "2": "High grade (G2)"}
PRESENT = {"0": "Not identified", "1": "Present"}
MMR_MAP = {"MMR p": "pMMR (proficient / normal)", "MMR d": "dMMR (deficient / abnormal)"}

# Tumor location (normalised: lower, whitespace-collapsed) -> SNOMED topography code
LOC_TOPO = {
    "cecum": "T67100",
    "ascending": "T67200",
    "hepatic flexure": "T67300",
    "transverse": "T67400",
    "splenic flexure": "T67500",
    "descending": "T67600",
    "sigmoid": "T67700",
    "rectosigmoid": "T68200",
    "rectum": "T68000",
    "right colon": "T67000",   # generic — no side-specific master code
    "left colon": "T67000",
}
MORPH_CODE = "M81403"  # adenocarcinoma, NOS — no histologic-subtype column in this export


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


def clean_float(val) -> Optional[float]:
    s = clean(val)
    if s is None:
        return None
    try:
        return float(s)
    except ValueError:
        return None


def coded(val, mapping, na=NA) -> str:
    s = clean(val)
    return mapping.get(s, na) if s is not None else na


def field(val) -> str:
    if val is None:
        return NA
    s = clean(val) if not isinstance(val, (int, float)) else str(val)
    return s if s else NA


def norm_loc(s: str) -> str:
    return re.sub(r"\s+", " ", s.strip().lower())


def accession_from_patient_id(pid: str) -> str:
    """Strip a legacy leading 'S' (S95-9158 -> 95-9158); leaves 'SP'-safe."""
    return re.sub(r"^[Ss](?=\d)", "", pid)


def build_lis_submission_id(patient_id: str, probenummer: str) -> str:
    """Prefer the literal ProbeNummer (it keeps zero-padding patient_id drops,
    e.g. patient_id='06-971' but ProbeNummer='SP-06-0971') UNLESS its numeric
    accession disagrees with patient_id entirely (not just padding) — a known
    single-row data-entry error in the source sheet (patient_id='06-1673' /
    Donor Block ID='06-1673-1-1J' / actual slide file all agree with '1673',
    but ProbeNummer says 'SP-06-4044'). In that case trust patient_id, since
    it's corroborated by the block ID and the real image on disk."""
    from_pid = "SP-" + accession_from_patient_id(patient_id)
    pn = probenummer.strip()
    from_pn = "SP-" + pn[1:] if re.match(r"^[Ss]\d", pn) else pn
    digits_pid = re.sub(r"\D", "", from_pid)
    digits_pn = re.sub(r"\D", "", from_pn)
    # Compare numeric value of the accession segment only (drop leading zeros).
    def acc_num(s):
        parts = re.sub(r"^SP-", "", s).split("-")
        return int(parts[1]) if len(parts) > 1 else None
    if acc_num(from_pid) == acc_num(from_pn):
        return from_pn  # same case, ProbeNummer's padding is authoritative
    log.warning(f"ProbeNummer '{probenummer}' disagrees with patient_id '{patient_id}' "
                f"beyond padding — trusting patient_id-derived '{from_pid}'")
    return from_pid


def accession_year(accession: str) -> Optional[int]:
    m = re.match(r"^(\d{2})-", accession)
    if not m:
        return None
    yy = int(m.group(1))
    return 1900 + yy if yy >= 90 else 2000 + yy


def budding_tier(count: Optional[float]) -> str:
    if count is None:
        return NA
    c = count
    if c < 5:
        return "Bd1 (low)"
    if c < 10:
        return "Bd2 (intermediate)"
    return "Bd3 (high)"


# ── Slide linkage ─────────────────────────────────────────────────────────────

def norm_key(s: str) -> str:
    return re.sub(r"\s+", "", s.strip().lower())


def parse_slide_filename(fn: str):
    """-> (block_id_raw, stain_name, is_dup)"""
    stem = fn.rsplit(".", 1)[0]
    is_dup = bool(re.search(r"\s*\(\d+\)$", stem))
    stem = re.sub(r"\s*\(\d+\)$", "", stem).strip()
    m = re.search(r"(?i)^(.*?)\s+(AE1_AE3|HE|IHC|new HE)$", stem)
    if m:
        block_id, stain = m.group(1).strip(), m.group(2).strip().upper()
        stain = "HE" if stain == "NEW HE" else stain
    else:
        block_id, stain = stem, "HE"  # no suffix -> assume HE
    return block_id, stain, is_dup


def build_image_index(image_root: str) -> dict:
    """norm_key(block_id) -> list of (block_id_raw, stain, is_dup, path)"""
    idx: dict = {}
    root = Path(image_root)
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in EXCLUDE_DIRS]
        for fn in filenames:
            if not fn.lower().endswith(".mrxs"):
                continue
            block_id, stain, is_dup = parse_slide_filename(fn)
            idx.setdefault(norm_key(block_id), []).append(
                (block_id, stain, is_dup, str(Path(dirpath) / fn)))
    return idx


def case_root(s: str) -> str:
    parts = norm_key(s).split("-")
    return "-".join(parts[:2]) if len(parts) >= 2 else norm_key(s)


def resolve_slides(donor_block_id: str, image_index: dict, root_index: dict) -> list:
    hits = image_index.get(norm_key(donor_block_id))
    if hits:
        return hits
    # Fallback: same accession (year-acc) root, only if it resolves to exactly
    # one distinct block-id (avoids guessing across genuinely different blocks).
    cr = case_root(donor_block_id)
    cand_keys = root_index.get(cr, set())
    if len(cand_keys) == 1:
        return image_index[next(iter(cand_keys))]
    return []


# ── Report builders ───────────────────────────────────────────────────────────

def _header(kind, sp, code):
    return (f"COLORECTAL CARCINOMA — SYNOPTIC {kind}\n"
            f"Derived from Mount Sinai Hospital — Toronto CRC structured clinical "
            f"data — not an original pathologist narrative.\n"
            f"Sub-cohort: LAG3 publication dataset (donor blocks selected for "
            f"tissue microarray construction).\n"
            f"Source: {SOURCE_CODE} · Case {sp} · Patient {code}\n")


def build_microscopy_report(row, code, sp, topo_code, topo_desc, morph_desc) -> str:
    pt = clean(row.get("pT"))
    pn = clean_int(row.get("pN"))
    pm = clean_int(row.get("pM"))
    stage = clean(row.get("c_pTNM"))
    bud_count = clean_float(row.get("Budding ITBCC"))
    bud_ck = clean_float(row.get("Buds 10in10 CK"))
    bud_line = budding_tier(bud_count)
    if bud_count is not None and bud_line != NA:
        bud_line += f" — {bud_count:g} buds/hotspot (ITBCC)"
        if bud_ck is not None:
            bud_line += f"; {bud_ck:g} buds/10 fields (AE1/AE3-assisted count)"
    nl, pl = clean_int(row.get("Total LN")), clean_int(row.get("Positive LN"))
    node_ct = f" ({pl}/{nl} positive)" if (nl is not None and pl is not None) else ""

    front_max, front_mean = clean_float(row.get("front_score_max")), clean_float(row.get("front_score_mean"))
    center_max, center_mean = clean_float(row.get("center_score_max")), clean_float(row.get("center_score_mean"))
    stroma_max, stroma_mean = clean_float(row.get("stroma_score_max")), clean_float(row.get("stroma_score_mean"))
    front_pos = coded(row.get("FRONT_LAG3"), {"1": "Positive", "0": "Negative"})
    center_pos = coded(row.get("CENTER_LAG3"), {"1": "Positive", "0": "Negative"})
    stroma_pos = coded(row.get("STROMA_LAG3"), {"1": "Positive", "0": "Negative"})
    combo = coded(row.get("CenterANDFront"), {"1": "Positive (center AND front)", "0": "Negative"})
    combo_or = coded(row.get("CenterORFront"), {"1": "Positive (center OR front)", "0": "Negative"})

    return "\n".join([
        _header("DIAGNOSIS", sp, code),
        "DIAGNOSIS",
        f"  Adenocarcinoma, NOS, of the {topo_desc.lower()}.",
        "",
        "CLINICAL HISTORY",
        f"  Age at diagnosis      : {field(clean_int(row.get('Age (yrs)')))} years",
        f"  Sex                   : {coded(row.get('Gender'), SEX_MAP)}",
        "",
        "HISTOPATHOLOGY",
        f"  Histologic type       : Adenocarcinoma, NOS",
        f"  Histologic grade      : {coded(row.get('G'), GRADE_MAP)}",
        f"  Tumour site           : {topo_desc} ({field(row.get('Tumor location simplified'))} colon)",
        f"  Venous invasion       : {coded(row.get('V'), PRESENT)}",
        f"  Tumour budding        : {bud_line}",
        "",
        "PATHOLOGIC STAGE (AJCC/UICC)",
        f"  Primary tumour (pT)   : {'pT' + pt if pt else NA}",
        f"  Regional nodes (pN)   : {'pN' + str(pn) if pn is not None else NA}{node_ct}",
        f"  Distant metastasis(pM): {'pM' + str(pm) if pm is not None else NA}",
        f"  Stage group           : {field(stage)}",
        "",
        "ANCILLARY / MOLECULAR STUDIES",
        f"  Mismatch repair (IHC) : {coded(row.get('MMR-status'), MMR_MAP)}",
        "",
        "RESEARCH IMMUNOHISTOCHEMISTRY (LAG3 — study data, not a clinical assay)",
        f"  Invasive front LAG3   : {front_pos}"
        + (f" (score max {front_max:g}, mean {front_mean:g})" if front_max is not None else ""),
        f"  Tumour center LAG3    : {center_pos}"
        + (f" (score max {center_max:g}, mean {center_mean:g})" if center_max is not None else ""),
        f"  Stroma LAG3           : {stroma_pos}"
        + (f" (score max {stroma_max:g}, mean {stroma_mean:g})" if stroma_max is not None else ""),
        f"  Combined (center+front): {combo} / {combo_or}",
        "",
        "RESECTION",
        f"  Lymph nodes examined  : {field(nl)}",
        f"  Lymph nodes positive  : {field(pl)}",
        "",
        "CODED DATA",
        f"  SNOMED topography     : {topo_code} ({topo_desc})",
        f"  SNOMED morphology     : {MORPH_CODE} ({morph_desc})",
        f"  ICD-10                : {field(row.get('ICD10'))}",
        f"  Accession year        : {field(accession_year(accession_from_patient_id(clean(row.get('patient_id')) or '')))}",
    ])


def build_macroscopy_report(row, code, sp, topo_desc, slides) -> str:
    if slides:
        inv = [f"  {len(slides)} whole-slide image(s):"] + \
              [f"    {Path(p).name}  [{stain}]" for (_bid, stain, _dup, p) in slides]
    else:
        inv = ["  No whole-slide image registered for this donor block."]
    return "\n".join([
        _header("GROSS SUMMARY", sp, code),
        "SPECIMEN",
        f"  Anatomic site         : {topo_desc}",
        f"  Region                : {field(row.get('Tumor location simplified'))} colon",
        f"  Donor block ID        : {field(row.get('Donor Block ID'))}",
        "",
        "WHOLE-SLIDE INVENTORY (from image repository)",
        *inv,
        "",
        "MACROSCOPIC FEATURES",
        f"  Lymph nodes retrieved : {field(clean_int(row.get('Total LN')))}",
    ])


# ── DB helpers ────────────────────────────────────────────────────────────────

def fetch_source_id(cur) -> int:
    cur.execute("SELECT id FROM data_sources WHERE code = %s", (SOURCE_CODE,))
    row = cur.fetchone()
    if not row:
        raise RuntimeError(f"data_sources row '{SOURCE_CODE}' not found — run etl_toronto.py first.")
    return row[0]


def fetch_stain_ids(cur) -> dict:
    cur.execute("SELECT id, stain_name FROM stains WHERE stain_name IN ('HE', 'AE1/AE3')")
    m = {name: sid for sid, name in cur.fetchall()}
    if "HE" not in m or "AE1/AE3" not in m:
        raise RuntimeError(f"Missing stain rows: found {m}")
    return {"HE": m["HE"], "AE1_AE3": m["AE1/AE3"]}


def fetch_desc(cur, category) -> dict:
    cur.execute("SELECT code, description FROM snomed_codes WHERE category=%s", (category,))
    return {c: d for c, d in cur.fetchall()}


def fetch_max_msh_number(cur) -> int:
    cur.execute(r"""
        SELECT COALESCE(MAX((regexp_match(patient_code, '^MSH-(\d+)$'))[1]::int), 0)
        FROM patients p JOIN data_sources ds ON ds.id = p.source_id
        WHERE ds.code = %s
    """, (SOURCE_CODE,))
    return cur.fetchone()[0]


def fetch_existing_patient_codes(cur, sps: list) -> dict:
    """lis_submission_id -> patient_code, for reruns (idempotent numbering)."""
    if not sps:
        return {}
    cur.execute("""
        SELECT s.lis_submission_id, p.patient_code
        FROM submissions s JOIN patients p ON p.id = s.patient_id
        WHERE s.lis_submission_id = ANY(%s)
    """, (sps,))
    return dict(cur.fetchall())


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
        ON CONFLICT (lis_submission_id) DO UPDATE SET report_date=EXCLUDED.report_date, malignancy_flag=TRUE
        RETURNING id""", (patient_id, sp, report_date))
    stats["submissions"] += 1
    return cur.fetchone()[0]


def upsert_probe(cur, sub_id, topo_desc, topo_code, dry, stats) -> Optional[int]:
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
                (sub_id, SENTINEL_PROBE, f"{SOURCE_CODE} case (LAG3 sub-cohort)", topo_desc, topo_code, [MORPH_CODE]))
    stats["probes"] += 1
    return cur.fetchone()[0]


def upsert_block(cur, probe_id, label, dry, stats) -> Optional[int]:
    if dry:
        stats["blocks"] += 1
        return -abs(hash((probe_id, label)))
    cur.execute("""INSERT INTO blocks (probe_id, block_label, block_info) VALUES (%s,%s,%s)
        ON CONFLICT (probe_id, block_label) DO NOTHING""",
                (probe_id, label, f"H&E/AE1-AE3 TMA donor-block whole-slide image ({SOURCE_CODE})"))
    if cur.rowcount:
        stats["blocks"] += 1
    cur.execute("SELECT id FROM blocks WHERE probe_id=%s AND block_label=%s", (probe_id, label))
    return cur.fetchone()[0]


def upsert_scan(cur, block_id, stain_id, file_path, dry, stats):
    if dry:
        stats["scans"] += 1
        return
    cur.execute("""INSERT INTO scans (block_id, stain_id, file_path, file_format)
        VALUES (%s,%s,%s,'MRXS')
        ON CONFLICT (file_path) DO UPDATE SET block_id=EXCLUDED.block_id, stain_id=EXCLUDED.stain_id
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
    df = df[df["patient_id"].notna()].copy()
    df["_accession"] = df["patient_id"].map(lambda v: accession_from_patient_id(clean(v)))
    df["_sp"] = df.apply(lambda r: build_lis_submission_id(clean(r["patient_id"]), clean(r["ProbeNummer"]) or ""), axis=1)
    df = df.sort_values("_accession").reset_index(drop=True)
    if limit:
        df = df.head(limit)

    cur = conn.cursor()
    source_id = fetch_source_id(cur)
    stain_ids = fetch_stain_ids(cur)
    topo_desc_master = fetch_desc(cur, "topography")
    morph_desc_master = fetch_desc(cur, "morphology")
    morph_desc = morph_desc_master.get(MORPH_CODE, "adenocarcinoma, NOS")

    sps = list(df["_sp"])
    existing_codes = fetch_existing_patient_codes(cur, sps)
    next_num = fetch_max_msh_number(cur) + 1

    image_index = build_image_index(image_root)
    root_index: dict = {}
    for key, hits in image_index.items():
        root_index.setdefault(case_root(hits[0][0]), set()).add(key)
    total_slides = sum(len(v) for v in image_index.values())
    log.info(f"stains HE={stain_ids['HE']} AE1/AE3={stain_ids['AE1_AE3']} | source '{SOURCE_CODE}' id={source_id} | "
             f"{len(df)} clinical rows | {total_slides} slides indexed ({len(image_index)} block-id keys, "
             f"Error/komisch excluded) | next MSH number = {next_num}")

    stats = {k: 0 for k in ("patients", "submissions", "probes", "blocks", "scans",
                            "reports_microscopy", "reports_macro", "with_slide",
                            "without_slide", "topo_unmapped", "fallback_matched")}
    printed = 0

    for i, row in tqdm(df.iterrows(), total=len(df), desc="  MSH-LAG3"):
        acc = row["_accession"]
        sp = row["_sp"]
        code = existing_codes.get(sp)
        if code is None:
            code = f"MSH-{next_num}"
            next_num += 1

        sex = SEX_MAP.get(clean(row.get("Gender")) or "")
        yr = accession_year(acc)
        rdate = date(yr, 1, 1) if yr else None
        age = clean_int(row.get("Age (yrs)"))
        dob = date(yr - age, 1, 1) if (yr and age is not None) else None

        raw_loc = clean(row.get("Tumor location"))
        loc_key = norm_loc(raw_loc) if raw_loc else None
        tcode = LOC_TOPO.get(loc_key) if loc_key else None
        if loc_key is not None and tcode is None:
            stats["topo_unmapped"] += 1
        tdesc = topo_desc_master.get(tcode) if tcode else "colon"

        patient_id = upsert_patient(cur, code, sex, source_id, dob, dry, stats)
        sub_id = upsert_submission(cur, patient_id, sp, rdate, dry, stats)
        probe_id = upsert_probe(cur, sub_id, tdesc, tcode, dry, stats)

        donor_block_id = clean(row.get("Donor Block ID")) or ""
        slides = resolve_slides(donor_block_id, image_index, root_index) if donor_block_id else []
        used_fallback = bool(slides) and norm_key(donor_block_id) not in image_index
        if used_fallback:
            stats["fallback_matched"] += 1
        if slides:
            stats["with_slide"] += 1
        else:
            stats["without_slide"] += 1

        for (block_id_raw, stain, is_dup, path) in slides:
            label = block_id_raw + (" (2)" if is_dup else "")
            block_row_id = upsert_block(cur, probe_id, label, dry, stats)
            upsert_scan(cur, block_row_id, stain_ids[stain if stain in stain_ids else "HE"], path, dry, stats)

        micro = build_microscopy_report(row, code, sp, tcode, tdesc, morph_desc)
        macro = build_macroscopy_report(row, code, sp, tdesc, slides)
        upsert_report(cur, sub_id, "microscopy", micro, rdate, dry, stats)
        upsert_report(cur, sub_id, "macro", macro, rdate, dry, stats)

        if printed < print_reports:
            print("\n" + "#" * 78 + f"\n# {code}  /  {sp}\n" + "#" * 78)
            print(micro); print("\n" + "-" * 40 + "\n"); print(macro)
            printed += 1
        if not dry and i % 50 == 0:
            conn.commit()

    if not dry:
        conn.commit()
    cur.close()

    log.info("=" * 60)
    log.info("MSH LAG3 SUB-COHORT IMPORT SUMMARY" + ("  (DRY RUN — nothing written)" if dry else ""))
    log.info("=" * 60)
    for k in ("patients", "submissions", "probes", "blocks", "scans",
              "reports_microscopy", "reports_macro", "with_slide", "without_slide",
              "topo_unmapped", "fallback_matched"):
        log.info(f"  {k:<20}: {stats[k]}")
    log.info("=" * 60)
    return stats


def main():
    ap = argparse.ArgumentParser(description="Import the MSH Toronto LAG3-publication CRC sub-cohort into PathoDB")
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
        log.error(f"MSH LAG3 import failed: {exc}", exc_info=True)
        sys.exit(1)
    finally:
        conn.close()


if __name__ == "__main__":
    main()
