"""Filename → metadata parsing + docx-table rendering for the guideline corpus.

Deliberately dependency-free (stdlib only) so the parser and the table renderer
are unit-testable without python-docx / the DB (see tests/test_agent_pure.py),
and importable by both the ingestion worker (api/workers/embed_guidelines.py) and
retrieval without pulling heavy deps.

Two source conventions, both verified against the real corpora:
  CAP  : ``<Organ[.Modifiers][.Specimen]>_<W.X.Y.Z>.REL[_.]CAPCP[...].docx``
         (a 4-part numeric version), plus a few legacy ``cp-<topic>-<n>.docx``.
  ICCR : ``[ICCR-]<Organ-Words>-<N(st|nd|rd|th)>-ed-v<Ver>-word[-n].docx``
         (the '-ed' is occasionally absent, e.g. '-neoadjuvant-2nd-v2.0').

`doc_slug` deliberately EXCLUDES the version so a new protocol version replaces
the prior rows (see the "latest only" note in db/schema.sql), while `version` is
kept as a column for citation + staleness stamping.
"""
import re
from typing import List, Optional, Sequence

# Tokens that denote the specimen/procedure rather than the organ. Ordered so the
# first match wins (biopsy before resection for mixed 'Bx.Res' docs is arbitrary;
# such docs cover both, and the fenceless label is only advisory).
_SPECIMEN_TOKENS = [
    ("biopsy", ("bx", "biopsy", "corebx", "needle", "cnb")),
    ("resection", ("res", "resection", "turbt", "turp", "tur", "rp", "rplnd",
                   "orchidectomy", "excision")),
    ("cytology", ("cytopathology", "cytology", "cyt")),
    ("biomarker", ("bmk", "biomarker")),
]
# Non-organ descriptor tokens dropped when forming the human organ label.
_DROP_TOKENS = {
    "bx", "biopsy", "corebx", "cnb", "needle", "res", "resection", "turbt",
    "turp", "tur", "rp", "rplnd", "orchidectomy", "excision", "cytopathology",
    "cytology", "cyt", "bmk", "biomarker", "case", "specimen", "part", "part1",
    "part2", "clininfo", "caselevel", "speclevel", "tde", "word", "rel", "capcp",
    "iccr", "cp",
}

_CAP_VERSION_RE = re.compile(r"(\d+\.\d+\.\d+\.\d+)")
_ICCR_EDITION_RE = re.compile(r"(\d+)(?:st|nd|rd|th)", re.I)
_ICCR_VERSION_RE = re.compile(r"v(\d+(?:\.\d+)*)", re.I)
_SEP_RE = re.compile(r"[._\-\s]+")
_TRAIL_JUNK_RE = re.compile(r"[._\-\s]+$")


def slugify(s: str) -> str:
    """Lowercase, collapse separators to single hyphens, strip ends."""
    return _SEP_RE.sub("-", (s or "").strip().lower()).strip("-")


def classify_specimen(name: str) -> Optional[str]:
    """Map a descriptor string to a specimen type, or None if it names none."""
    toks = set(_SEP_RE.split((name or "").lower()))
    for label, markers in _SPECIMEN_TOKENS:
        if toks & set(markers):
            return label
    return None


def _organ_label(descriptor: str) -> str:
    """Human organ label: the descriptor tokens minus specimen/boilerplate ones,
    re-joined with spaces. Falls back to the raw descriptor if everything was
    dropped (e.g. a doc whose whole name is a specimen word)."""
    toks = [t for t in _SEP_RE.split(descriptor) if t]
    kept = [t for t in toks if t.lower() not in _DROP_TOKENS]
    label = " ".join(kept) if kept else " ".join(toks)
    return label.strip()


def _parse_cap(stem: str) -> dict:
    m = _CAP_VERSION_RE.search(stem)
    if m:
        descriptor = _TRAIL_JUNK_RE.sub("", stem[:m.start()])
        version = m.group(1)
    else:
        # Legacy 'cp-<topic>-<year>-<build>' templates: version is the trailing run.
        parts = stem.split("-")
        version = parts[-1] if parts else ""
        descriptor = " ".join(p for p in parts if p.lower() not in _DROP_TOKENS
                              and not p[:1].isdigit())
    return {"descriptor": descriptor, "version": version}


def _parse_iccr(stem: str) -> dict:
    s = re.sub(r"^iccr[-_]", "", stem, flags=re.I)
    s = re.sub(r"[-_]word(?:[-_]\d+)?$", "", s, flags=re.I)   # trailing '-word', '-word-1'
    edition = _ICCR_EDITION_RE.search(s)
    ver = _ICCR_VERSION_RE.search(s)
    # Organ descriptor = everything before the edition/version marker.
    cut = len(s)
    for mm in (edition, ver):
        if mm:
            cut = min(cut, mm.start())
    descriptor = _TRAIL_JUNK_RE.sub("", s[:cut])
    version = ""
    if edition:
        version = f"{edition.group(0)} ed"
    if ver:
        version = (version + " " if version else "") + f"v{ver.group(1)}"
    return {"descriptor": descriptor, "version": version.strip()}


def parse_guideline_filename(filename: str, source_org: str) -> dict:
    """Best-effort metadata from a guideline filename.

    Returns {organ, specimen_type, version, doc_slug, title_hint}. `source_org`
    ('CAP'|'ICCR') is known from the ingest directory, so it isn't inferred.
    Always returns a usable doc_slug + title_hint even for odd names.
    """
    stem = re.sub(r"\.docx$", "", filename or "", flags=re.I)
    org = (source_org or "").upper()
    parsed = _parse_iccr(stem) if org == "ICCR" else _parse_cap(stem)
    descriptor = parsed["descriptor"] or stem
    organ = _organ_label(descriptor)
    specimen = classify_specimen(descriptor)
    # Slug excludes version → a new version overwrites the same document identity.
    doc_slug = f"{org.lower()}:{slugify(descriptor)}" if descriptor else f"{org.lower()}:{slugify(stem)}"
    title_hint = _SEP_RE.sub(" ", descriptor).strip() or stem
    return {
        "organ": organ,
        "specimen_type": specimen,
        "version": parsed["version"],
        "doc_slug": doc_slug,
        "title_hint": title_hint,
    }


# ── Title → organ (authoritative: the inline document title names the real organ,
#    unlike cryptic filenames — 'CXC' → 'ICCR Colorectal Cancer …') ─────────────
_ICCR_LEAD_RE = re.compile(r"^\s*ICCR\s+", re.I)
_ICCR_TAIL_RE = re.compile(r"\s+Histopathology Reporting Guide.*$", re.I)
_CAP_LEAD_RE = re.compile(r"^\s*Protocol for the Examination of\s+", re.I)
_CAP_TEMPLATE_RE = re.compile(r"^\s*Template for Reporting(?:\s+Results)?\s*(?:of\s+)?", re.I)
_CAP_PATIENTS_RE = re.compile(r"Patients?\s+[Ww]ith\s+(.+)$")
_EDITION_TAIL_RE = re.compile(r",?\s*\d+(?:st|nd|rd|th)\s+edition.*$", re.I)
# Leading tumour/cancer qualifiers to strip down to the organ noun.
_OF_THE_RE = re.compile(
    r"^(?:Carcinomas?|Tumou?rs?|Cancers?|Primary\s+Tumou?rs?|Malignant\s+\w+|"
    r"Neoplasms?|Well-Differentiated\s+Neuroendocrine\s+Tumou?rs?[^)]*\))\s+of\s+the\s+",
    re.I)
_FOR_WHICH_RE = re.compile(r"\s+for Which\b.*$", re.I)


def is_title_boilerplate(text: str) -> bool:
    """True for the CORE/NON-CORE legend and definition lines some ICCR docs open
    with, so title extraction skips them and reaches the real heading."""
    t = (text or "").strip().lower()
    if not t:
        return True
    if t.startswith("elements in black text") or ("core" in t and "non-core" in t):
        return True
    if t.startswith(("figure", "table ", "definition of")):
        return True
    return False


def organ_from_title(title: str, source_org: str) -> str:
    """Best-effort short organ/tumour phrase from an authoritative inline title.

    ICCR: '<Organ> Histopathology Reporting Guide, Nth edition' → '<Organ>'.
    CAP:  'Protocol for the Examination of … Patients with <Organ>' → '<Organ>',
          then leading 'Carcinoma/Tumors/Cancers of the' qualifiers are stripped.
    Returns "" when nothing usable is found (caller falls back to the filename organ).
    """
    t = re.sub(r"\s+", " ", (title or "").strip()).strip(" ,.")
    if not t:
        return ""
    if (source_org or "").upper() == "ICCR":
        t = _ICCR_LEAD_RE.sub("", t)
        t = _ICCR_TAIL_RE.sub("", t)
        t = _EDITION_TAIL_RE.sub("", t)
    else:
        m = _CAP_PATIENTS_RE.search(t)
        t = m.group(1) if m else _CAP_TEMPLATE_RE.sub("", _CAP_LEAD_RE.sub("", t))
    t = _FOR_WHICH_RE.sub("", t)
    t = _OF_THE_RE.sub("", t).strip(" ,.-")
    return t[:80].strip(" ,.-")


# ── Section headings (CAP): these docs use NO Word heading styles — sections are
#    marked by bold / ALL-CAPS formatting (e.g. 'SPECIMEN', 'Procedure') ────────
# NB: '+' is NOT skipped — in CAP it prefixes OPTIONAL element headings
# (e.g. '+Tumor Comment'), which we want to capture as elements.
_HEADING_SKIP_FIRST = set("_□☐○●•▪#->–—✔✓~")


def heading_level(text: str, all_bold: bool):
    """Classify a paragraph as a 'major' section, a 'minor' sub-heading, or None
    (body/data). CAP protocols nest as ALL-CAPS majors ('SPECIMEN', 'TUMOR') →
    bold sub-elements ('Tumor Site') → '___ ' option lines; this two-level split
    lets the worker build a 'SPECIMEN — Tumor Site' section. `all_bold` = every
    run bold (these docs carry no Word heading styles)."""
    t = (text or "").strip()
    if not t or len(t) > 90 or t[0] in _HEADING_SKIP_FIRST:
        return None
    letters = [c for c in t if c.isalpha()]
    if letters and t == t.upper() and len(t) <= 60:
        return "major"          # ALL-CAPS section header
    if all_bold:
        return "minor"          # bold sub-element / sub-subsection
    return None


def looks_like_heading(text: str, all_bold: bool) -> bool:
    """True if a paragraph reads as any section heading (major or minor)."""
    return heading_level(text, all_bold) is not None


# ── Reporting-element tables (ICCR): each data row is one reporting element, with
#    a 'Core/Non-core' status column ──────────────────────────────────────────
_VALID_CORE = {"core", "non-core", "non core", "core and non-core", "core/non-core"}
_FOOTNOTE_RE = re.compile(r"(?<=[A-Z])[a-z]{1,2}$")   # 'TUMOUR SITEa' → 'TUMOUR SITE'


def _find_col(header, *keys):
    for i, h in enumerate(header):
        hl = (h or "").strip().lower()
        if any(k in hl for k in keys):
            return i
    return None


def _norm_core(value: str) -> str:
    """Return the status text if it is a valid core status ('Core'/'Non-core'/
    'Core and Non-core'), else "". Tolerates a trailing footnote letter/asterisk
    (e.g. 'Corea' → 'Core'). Guards against merged 'spanner' rows whose status
    cell just repeats the element name (→ "")."""
    v = (value or "").strip()
    low = v.lower().rstrip("* ")
    if low in _VALID_CORE:
        return v
    if len(low) > 1 and low[:-1] in _VALID_CORE:   # strip one footnote letter
        return v[:-1].strip()
    return ""


def element_rows_from_grid(grid: Sequence[Sequence[str]]):
    """Parse an ICCR reporting-element table.

    `grid` is the table's cell text as list-of-rows (row 0 = header). If the header
    names an 'Element name' column, return [(element_name, structured_text), …] —
    one entry per reporting element, the text carrying its core status, values,
    commentary and implementation notes. Returns None for any other table (callers
    fall back to plain row rendering). Element name doubles as the chunk `section`.
    """
    if not grid or len(grid) < 2:
        return None
    header = [c or "" for c in grid[0]]
    # Match the actual 'Element name' column — NOT a loose 'element', which also
    # matches the definition table's 'Definition of Core elements' header.
    i_name = _find_col(header, "element name")
    if i_name is None:
        return None
    i_core = _find_col(header, "core")
    i_val = _find_col(header, "value")
    i_comm = _find_col(header, "commentary", "comment")
    i_impl = _find_col(header, "implementation")

    def cell(cells, i):
        return (cells[i].strip() if (i is not None and i < len(cells) and cells[i]) else "")

    out = []
    for cells in grid[1:]:
        name = cell(cells, i_name)
        if not name:
            continue
        # Strip a trailing footnote letter ('TUMOUR SITEa' → 'TUMOUR SITE'); the
        # lookbehind only fires after an uppercase char, so mixed-case names are safe.
        label = _FOOTNOTE_RE.sub("", name)
        core = _norm_core(cell(cells, i_core))
        text = (f"[{core}] " if core else "") + label
        for lab, i in (("Values", i_val), ("Commentary", i_comm),
                       ("Implementation notes", i_impl)):
            v = cell(cells, i)
            if v:
                text += f"\n{lab}: {v}"
        out.append((label, text))
    return out or None


# ── Element core status (for enumeration): ICCR from the '[Core]/[Non-core]'
#    marker in the chunk text; CAP from the element heading conventions ─────────
_ICCR_CORE_RE = re.compile(r"\]\s*\n\s*\[([^\]]{1,24})\]")


def element_core_status(source_org: str, section: str, chunk_text: str):
    """Return a short core-status label for a reporting element, or None.

    ICCR encodes it explicitly ('[Core]' / '[Non-core]' / '[Core and Non-core]')
    at the head of the element chunk. CAP encodes it by convention in the element
    heading: a leading '+' = optional, '(required only …)' = conditional, else the
    element is core.
    """
    if (source_org or "").upper() == "ICCR":
        m = _ICCR_CORE_RE.search(chunk_text or "")
        return m.group(1).strip() if m else None
    elem = (section or "").split(" — ")[-1].strip().lower()
    if elem.startswith("+"):
        return "optional"
    if "required only" in elem:
        return "conditional"
    return "core"


def render_table_rows(rows: Sequence[Sequence[str]]) -> str:
    """Render docx table rows as pipe-joined lines so their content (CAP staging
    thresholds / checklists live in tables) survives chunking. Empty rows and
    fully-empty tables collapse to nothing."""
    lines: List[str] = []
    for row in rows or []:
        cells = [re.sub(r"\s+", " ", (c or "").strip()) for c in row]
        if any(cells):
            lines.append(" | ".join(cells))
    return "\n".join(lines)
