"""Agent tools — thin wrappers over EXISTING PathoDB functions.

`get_tools(db, user)` builds LangChain tools bound (via closure) to the current
request's DB session and authenticated user, so every tool runs with the caller's
auth and transaction. Each tool returns a JSON string ``{summary, citations, ...}``
so the LLM sees grounded IDs and the stream layer can surface clickable citations.

Tools in ACTION_TOOL_NAMES mutate state and are gated behind a human-confirmation
interrupt in the graph; they execute only after the user approves.
"""
import json
import logging
from typing import List, Optional

from sqlalchemy import Text, cast
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.orm import Session

from ..config import get_settings
from ..models import User, Patient
from .guardrails import fence_untrusted
# NOTE: enrich_snomed_codes is imported lazily inside get_tools() rather than at
# module load. It lives in api.routers.patients, and api.routers.__init__ eagerly
# imports the assistant router -> agent.graph -> this module; a top-level import
# here would form a circular import whenever the agent is imported before the
# routers package is fully initialized (e.g. the eval harness, scripts, tests).

log = logging.getLogger("pathodb_agent")

ACTION_TOOL_NAMES = {"submit_analysis_job", "save_cohort", "generate_patient_summary"}


def _dumps(obj: dict) -> str:
    return json.dumps(obj, default=str)


# ─────────────────────────────────────────────────────────────────────────────
# Presentation blocks — the reusable "usable output" contract.
#
# A tool may attach a `blocks` list to its JSON result. Each block is a typed,
# render-ready payload the chat UI draws inline (a table, a list of cards); the
# stream layer forwards them and the frontend switches on `kind`. This is what
# turns a "retrieve all X" / "find cases mentioning Y" request into something
# enumerable and clickable instead of a prose paragraph. `blocks` is model-visible
# too (it is in the tool JSON), so it doubles as the model's grounding — one copy,
# no duplicate `results` array. Fenced report text inside a card is stripped for
# display by the stream layer, so the model keeps the fenced bytes.
# ─────────────────────────────────────────────────────────────────────────────

def _submission_citation(lis_id, patient_id=None) -> dict:
    """A submission citation, made clickable when we know the patient it belongs
    to (submissions have no page of their own; the patient page is the target).
    Centralized so every tool links submissions the same way — previously some
    emitted a bare, non-clickable chip and others a patient link."""
    c = {"type": "submission", "id": lis_id, "label": lis_id}
    if patient_id is not None:
        c["url"] = f"/patients/{patient_id}"
    return c


# Column sets the cohort table surfaces, per return_level, in display order.
# Only keys actually present on a row are kept (a scan-level row has no
# report_date; a submission-level row has no scan_id), so a level that lacks a
# column simply drops it rather than showing blanks. (key, header) pairs.
_COHORT_COLUMNS = [
    ("patient_code", "Patient"),
    ("lis_submission_id", "Submission"),
    ("report_date", "Date"),
    ("topo_description", "Topography"),
    ("submission_type", "Type"),
    ("malignancy", "Malignant"),
    ("block_label", "Block"),
    ("stain_name", "Stain"),
    ("scan_id", "Scan"),
    ("has_report", "Report"),
]


def _cohort_row_citation(row: dict) -> Optional[dict]:
    """A clickable link for one cohort row: the slide viewer when the row is a
    scan, else the submission (clickable when the row carries patient_id)."""
    scan_id = row.get("scan_id")
    if scan_id is not None:
        sub = row.get("lis_submission_id")
        label = f"{sub} · scan {scan_id}" if sub else f"scan {scan_id}"
        return {"type": "scan", "id": scan_id, "label": label,
                "url": f"/viewer/{scan_id}"}
    sub = row.get("lis_submission_id")
    if sub:
        return _submission_citation(sub, row.get("patient_id"))
    return None


def _table_block(rows: list, level: str, total: int, preview: int) -> tuple:
    """Build a `table` block for the chat UI plus the per-row citations that make
    the preview clickable.

    Returns (block, citations). `block` = {kind, level, columns, rows, total,
    shown, truncated}; columns are only those present in the data. Citations are
    capped to the preview so a 50k-row cohort can't flood the citation channel; the
    full set stays reachable by saving the cohort and exporting it.
    """
    shown = rows[:preview]
    present = {k for r in shown for k in r.keys()}
    columns = [{"key": k, "label": h} for k, h in _COHORT_COLUMNS if k in present]
    # Keep only the displayed columns on each preview row (drops file_path etc.).
    keys = [c["key"] for c in columns]
    table_rows = [{k: r.get(k) for k in keys} for r in shown]
    citations = [c for c in (_cohort_row_citation(r) for r in shown) if c]
    block = {
        "kind": "table",
        "level": level,
        "columns": columns,
        "rows": table_rows,
        "total": total,
        "shown": len(table_rows),
        "truncated": total > len(table_rows),
    }
    return block, citations


def _excerpt_cards_block(items: list, total: Optional[int] = None) -> dict:
    """Build a `cards` block of report-search hits: each item is a matched excerpt
    with its submission/type, score and (when known) a patient link. Snippets carry
    the FENCED excerpt as the tool returns it; the stream layer strips the fence
    markers for display so the model still sees fenced bytes."""
    block = {"kind": "cards", "variant": "excerpt", "items": items}
    if total is not None:
        block["total"] = total
    return block


def _err(msg: str) -> str:
    return _dumps({"summary": str(msg), "citations": []})


# The cohort filter arguments shared by query_cohort and save_cohort. Both tools
# must expose the SAME filter surface: save_cohort used to declare a hand-copied
# subset that silently omitted morphology/etiology, so "find all colorectal
# adenocarcinomas, now save that" persisted a cohort filtered only on topography
# and date — a far larger set, under a name asserting otherwise. Keep this tuple
# and _cohort_filter() as the single definition; test_cohort_filter_arg_parity
# fails if the two tool signatures drift from it again.
COHORT_FILTER_ARGS = (
    "topo_description_search", "snomed_topo_codes",
    "snomed_morph_codes", "morph_description_search",
    "snomed_etiology_codes", "etiology_description_search",
    "submission_types", "malignancy_flag",
    "submission_date_from", "submission_date_to",
    "has_scan", "stain_names", "stain_categories", "file_formats",
    "magnification_min", "magnification_max",
)


def _cohort_filter(return_level: str, **kwargs):
    """Build a CohortFilter from tool arguments.

    Maps the tool's 'etiology' spelling (which matches lookup_filter_values'
    field names) onto CohortFilter's 'etio' spelling — pydantic is extra='ignore',
    so an unmapped key would be dropped silently rather than error.
    """
    from ..schemas import CohortFilter
    raw = {k: kwargs.get(k) for k in COHORT_FILTER_ARGS}
    raw["snomed_etio_codes"] = raw.pop("snomed_etiology_codes")
    raw["etio_description_search"] = raw.pop("etiology_description_search")
    raw["return_level"] = return_level
    return CohortFilter(**{k: v for k, v in raw.items() if v is not None})


def _validate_filter_values(db: Session, f) -> list:
    """Find filter values that resolve to nothing, with near-miss suggestions.

    Every one of these predicates fails CLOSED: an unknown code matches no row,
    and an unmatched description list compiles to `codes && NULL` → NULL → no
    rows (see _apply_filters). Both look identical to "there are no such cases",
    which is how "find all colorectal adenocarcinomas" came back empty rather
    than wrong. Resolving the vocabulary up front lets the caller distinguish a
    bad filter from a real absence.

    Returns [{field, unresolved: [...], suggestions: [...], problem: str}].
    """
    from ..models import SnomedCode, Stain
    problems = []

    def _check(field, values, known_fn, suggest_fn, what):
        """known_fn(values) -> the subset that exists; ONE query, not one per value.

        A resolved diagnosis passes 130+ topography codes, so a per-value
        existence check would fire 130+ round-trips on every cohort query.
        """
        if not values:
            return
        values = values if isinstance(values, list) else [values]
        missing = [v for v in values if v not in known_fn(values)]
        if not missing:
            return
        suggestions = []
        for v in missing[:3]:
            suggestions.extend(suggest_fn(v))
        entry = {"field": field, "unresolved": missing,
                 "suggestions": sorted(set(suggestions))[:10]}
        entry["problem"] = (
            f"{field}={missing!r} matched no {what}"
            + (f" — did you mean {entry['suggestions'][:5]}?" if entry["suggestions"] else "")
        )
        problems.append(entry)

    def _known_codes(category):
        def _k(values):
            return {r[0] for r in db.query(SnomedCode.code).filter(
                SnomedCode.category == category, SnomedCode.code.in_(values)).all()}
        return _k

    def _code_suggest(category):
        def _s(v):
            # Same axis + same leading digits: the SNOMED family the model meant.
            stem = "".join(c for c in v if c.isalnum())[:4]
            rows = db.query(SnomedCode.code, SnomedCode.description).filter(
                SnomedCode.category == category,
                SnomedCode.code.ilike(f"{stem}%")).limit(5).all()
            return [f"{r[0]} ({r[1]})" for r in rows]
        return _s

    def _known_descs(category):
        def _k(values):
            return {r[0] for r in db.query(SnomedCode.description).filter(
                SnomedCode.category == category,
                SnomedCode.description.in_(values)).all()}
        return _k

    def _desc_suggest(category):
        def _s(v):
            rows = db.query(SnomedCode.description).filter(
                SnomedCode.category == category,
                SnomedCode.description.ilike(f"%{v}%")).limit(5).all()
            return [r[0] for r in rows if r[0]]
        return _s

    _check("snomed_topo_codes", getattr(f, "snomed_topo_codes", None),
           _known_codes("topography"), _code_suggest("topography"), "topography code")
    _check("snomed_morph_codes", getattr(f, "snomed_morph_codes", None),
           _known_codes("morphology"), _code_suggest("morphology"), "morphology code")
    _check("snomed_etio_codes", getattr(f, "snomed_etio_codes", None),
           _known_codes("etiology"), _code_suggest("etiology"), "etiology code")
    # These two are matched EXACTLY against the master vocabulary, so a partial
    # term ('adenocarcinoma' vs 'adenocarcinoma, NOS') silently matches nothing.
    _check("morph_description_search", getattr(f, "morph_description_search", None),
           _known_descs("morphology"), _desc_suggest("morphology"),
           "morphology description (exact match required)")
    _check("etio_description_search", getattr(f, "etio_description_search", None),
           _known_descs("etiology"), _desc_suggest("etiology"),
           "etiology description (exact match required)")
    _check("stain_names", getattr(f, "stain_names", None),
           lambda vals: {r[0] for r in db.query(Stain.stain_name).filter(
               Stain.stain_name.in_(vals)).all()},
           lambda v: [r[0] for r in db.query(Stain.stain_name).filter(
               Stain.stain_name.ilike(f"%{v}%")).limit(5).all()],
           "stain")

    # topo_description_search is matched against probe text, not the master
    # vocabulary — check it against the column it actually queries. A list is
    # matched exactly (IN), a bare string as a substring (see _apply_filters).
    topo_desc = getattr(f, "topo_description_search", None)
    if topo_desc:
        from ..models import Probe
        if isinstance(topo_desc, list):
            _check("topo_description_search", topo_desc,
                   lambda vals: {r[0] for r in db.query(Probe.topo_description).filter(
                       Probe.topo_description.in_(vals)).distinct().all()},
                   lambda v: [r[0] for r in db.query(SnomedCode.description).filter(
                       SnomedCode.category == "topography",
                       SnomedCode.description.ilike(f"%{v}%")).limit(5).all() if r[0]],
                   "probe topography")
        else:
            hit = db.query(Probe.id).filter(
                Probe.topo_description.ilike(f"%{topo_desc}%")).first()
            if hit is None:
                sugg = [r[0] for r in db.query(SnomedCode.description).filter(
                    SnomedCode.category == "topography",
                    SnomedCode.description.ilike(f"%{topo_desc}%")).limit(8).all() if r[0]]
                problems.append({
                    "field": "topo_description_search", "unresolved": [topo_desc],
                    "suggestions": sugg,
                    "problem": f"topo_description_search={topo_desc!r} matched no probe "
                               "topography — it is matched against probe TEXT, not SNOMED "
                               "codes, so a code or a diagnosis phrase never matches here. "
                               "For a diagnosis use resolve_diagnosis."
                               + (f" Did you mean {sugg[:5]}?" if sugg else ""),
                })

    return problems


def _resolve_axes(db: Session, topography: Optional[str],
                  morphology: Optional[str]) -> dict:
    """Split a diagnosis across the topography/morphology axes and expand each to
    its complete code family. The engine behind resolve_diagnosis, and reused by
    find_cases so the two tools cannot disagree about what a diagnosis means.

    Returns {topography?, morphology?, coverage?, notes: [...]} — see
    snomed_concepts for the expansion rules.
    """
    from ..models import SnomedCode, Probe
    from sqlalchemy import func as sqlfunc
    from .snomed_concepts import (expand_morphology, prefix_families,
                                  select_families, expand_topography,
                                  related_topography, lexical_score,
                                  REGION_ALIASES)

    rows = [{"code": r.code, "category": r.category, "description": r.description or ""}
            for r in db.query(SnomedCode).all()]
    out: dict = {}
    notes: list = []

    def _topo_counts(codes):
        if not codes:
            return {}
        res = (db.query(Probe.snomed_topo_code, sqlfunc.count(Probe.id))
               .filter(Probe.snomed_topo_code.in_(codes))
               .group_by(Probe.snomed_topo_code).all())
        return {r[0]: r[1] for r in res}

    def _morph_counts(codes):
        if not codes:
            return {}
        res = (db.query(sqlfunc.unnest(Probe.snomed_morph_codes).label("c"),
                        sqlfunc.count(Probe.id))
               .filter(Probe.snomed_morph_codes.op("&&")(list(codes)))
               .group_by("c").all())
        return {r[0]: r[1] for r in res if r[0] in set(codes)}

    # A near-exact description match ('colon' == 'colon') already pins the organ
    # family; the semantic neighbours would only re-rank codes the lexical pass
    # has. Below this, the term is phrased unlike the vocabulary and the embedder
    # earns its cost.
    _LEXICAL_CONFIDENT = 0.9

    def _seeds(term, category):
        """Lexical hits scored by specificity, then semantic neighbours IF NEEDED.

        Lexical hits are NOT all equal — see lexical_score. The semantic arm is a
        FALLBACK, not a supplement: it costs a full bge-m3 index build (~1368
        codes, ~9 min on CPU, once per process) plus ~5s per query, and for the
        common terms it is asked about ('colon', 'rectum', 'adenocarcinoma') an
        exact lexical match already resolves the family and the semantic result
        is discarded. Calling it unconditionally made resolve_diagnosis take 12
        minutes to do 13 seconds of work.
        """
        seen, seeds = set(), []
        for r in rows:
            if r["category"] != category:
                continue
            s = lexical_score(term, r["description"])
            if s > 0:
                seeds.append({**r, "score": s})
                seen.add(r["code"])
        if any(s["score"] >= _LEXICAL_CONFIDENT for s in seeds):
            return seeds
        try:
            from .snomed_index import semantic_search, EmbeddingsUnavailable
            for r in semantic_search(db, term, category=category, top_k=10):
                if r["code"] not in seen:
                    seeds.append(r)
        except EmbeddingsUnavailable:
            notes.append(f"{category}: embedder unavailable — lexical matching only.")
        except Exception as e:
            log.warning("resolve axes: semantic seeds failed (%s): %s", category, e)
        return seeds

    def _topo_prefixes(term):
        """Organ prefixes for a topography term, expanding composite regions.

        'colorectal' names two organs and no description contains it, so it is
        resolved per constituent and unioned — rather than hoping colon and
        rectum land within a margin of each other in embedding space.
        """
        constituents = REGION_ALIASES.get(term.strip().lower(), [term])
        chosen, used = [], []
        for c in constituents:
            s = _seeds(c, "topography")
            if not s:
                continue
            for p in select_families(prefix_families(s)):
                if p not in chosen:
                    chosen.append(p)
            used.append(c)
        return chosen, constituents, used

    if topography:
        chosen, constituents, used = _topo_prefixes(topography)
        if not chosen:
            out["topography"] = {"term": topography, "codes": [], "resolved": False,
                                 "note": f"No topography code matches '{topography}'. "
                                         "Check the term, or use lookup_snomed to explore."}
        else:
            if len(constituents) > 1:
                notes.append(f"topography: '{topography}' expanded to {', '.join(used)}.")
            family = expand_topography(rows, chosen)
            codes = [r["code"] for r in family]
            counts = _topo_counts(codes)
            # Search related codes by CONSTITUENT: no description contains
            # 'colorectal', so the raw term would surface nothing and the
            # ambiguous multi-organ codes ('ileum and colon') would be lost
            # rather than offered as a judgement call.
            rel, rel_seen = [], set()
            for c in (used or [topography]):
                for r in related_topography(rows, c, chosen):
                    if r["code"] not in rel_seen:
                        rel_seen.add(r["code"])
                        rel.append(r)
            rel.sort(key=lambda r: r["code"])
            rel_counts = _topo_counts([r["code"] for r in rel])
            out["topography"] = {
                "term": topography, "resolved": True,
                "organ_families": chosen,
                "codes": codes,
                "descriptions": [r["description"] for r in family],
                "detail": [{"code": r["code"], "description": r["description"],
                            "probes": counts.get(r["code"], 0)} for r in family],
                "total_probes": sum(counts.values()),
                "related_not_included": [
                    {"code": r["code"], "description": r["description"],
                     "probes": rel_counts.get(r["code"], 0)} for r in rel],
            }

    if morphology:
        # Resolve the family FIRST and only seed if it comes back empty — the
        # seeds are a fallback and computing them eagerly pays for the embedder
        # on every call just to throw the result away.
        fam = expand_morphology(rows, morphology)
        core = fam["core"]
        if not core:
            # No exact head-term family: fall back to seeds so a term phrased
            # differently from the vocabulary still resolves, but say so — these
            # are matches, not a family.
            seeds = _seeds(morphology, "morphology")
            core = [s for s in seeds if s.get("score", 0) >= 0.6][:10]
            if core:
                notes.append(f"morphology: no exact '{morphology}' family; showing closest "
                             "matching codes instead — check them before use.")
        if not core:
            out["morphology"] = {"term": morphology, "codes": [], "resolved": False,
                                 "note": f"No morphology code matches '{morphology}'. "
                                         "Check the term, or use lookup_snomed to explore."}
        else:
            codes = [r["code"] for r in core]
            counts = _morph_counts(codes)
            rel_counts = _morph_counts([r["code"] for r in fam["related"]])
            out["morphology"] = {
                "term": morphology, "resolved": True,
                "codes": codes,
                "detail": [{"code": r["code"], "description": r["description"],
                            "behavior": r.get("behavior"),
                            "probes": counts.get(r["code"], 0)} for r in core],
                "total_probes": sum(counts.values()),
                "related_not_included": [
                    {"code": r["code"], "description": r["description"],
                     "behavior": r.get("behavior"),
                     "probes": rel_counts.get(r["code"], 0)} for r in fam["related"]],
            }

    # The recall ceiling. A morphology filter only ever sees coded probes, and
    # most are not coded — without this the count reads as a total.
    if morphology and out.get("morphology", {}).get("resolved"):
        total_probes = db.query(sqlfunc.count(Probe.id)).scalar() or 0
        coded = db.query(sqlfunc.count(Probe.id)).filter(
            Probe.snomed_morph_codes != cast([], ARRAY(Text))).scalar() or 0
        if total_probes:
            out["coverage"] = {
                "probes_with_any_morphology_code": coded,
                "probes_total": total_probes,
                "fraction_coded": round(coded / total_probes, 3),
                "warning": (f"Only {coded / total_probes:.0%} of probes carry any "
                            "morphology code. A code-based cohort is therefore a "
                            "FLOOR, not a total: cases whose diagnosis appears only "
                            "in the report text are invisible to query_cohort. Use "
                            "find_cases to cover both, or state the caveat."),
            }

    out["notes"] = notes
    return out


def _find_cases_core(db: Session, topography: Optional[str], morphology: Optional[str] = None,
                     date_from=None, date_to=None, report_type: str = "microscopy",
                     text_term: Optional[str] = None, max_rows: Optional[int] = None) -> dict:
    """Shared engine for the find_cases tool AND its export endpoint, so the two can
    never disagree about what a query returns.

    Runs the coded arm (only when the morphology axis is a real SNOMED code) and the
    exhaustive text arm, reconciles them, and returns FULL row lists with RAW (un-
    fenced) excerpts. Callers cap / fence / format for their own surface. `max_rows`
    caps EACH arm (the interactive preview); None returns everything (export).

    Returns {"ok": False, "error": ...} on bad args or an unresolvable topography.
    """
    from .rag import text_evidence_submissions
    from ..models import Submission, Probe

    if not topography:
        return {"ok": False, "error": "topography is required."}
    if not morphology and not text_term:
        return {"ok": False, "error": "give morphology and/or text_term."}

    axes = _resolve_axes(db, topography, morphology)
    notes = axes.pop("notes", [])
    topo, morph = axes.get("topography", {}), axes.get("morphology", {})
    if not topo.get("resolved"):
        return {"ok": False, "resolved": axes,
                "error": "Could not resolve the topography: "
                         + (topo.get("note") or f"'{topography}' matched no organ.")}

    search_term = text_term or morphology
    morph_resolved = bool(morph.get("resolved"))

    # ── Coded arm: exact, exhaustive — ONLY when morphology is a real code ──
    coded_rows = {}
    if morph_resolved:
        q = (db.query(Submission.id, Submission.lis_submission_id, Submission.report_date)
             .join(Probe, Probe.submission_id == Submission.id)
             .filter(Probe.snomed_topo_code.in_(topo["codes"]),
                     Probe.snomed_morph_codes.op("&&")(morph["codes"])))
        if date_from:
            q = q.filter(Submission.report_date >= date_from)
        if date_to:
            q = q.filter(Submission.report_date <= date_to)
        coded_rows = {r[0]: {"lis": r[1], "date": r[2]} for r in q.distinct().all()}
    elif morphology:
        notes.append(f"'{morphology}' is not a SNOMED morphology code, so there is no "
                     "coded arm — the text arm is the whole answer, as candidates.")

    # ── Text arm: exhaustive within the SAME scope ──
    text_hits = text_evidence_submissions(
        db, search_term, topo["codes"],
        date_from=date_from, date_to=date_to, report_type=report_type)
    text_only_ids = [i for i in text_hits if i not in coded_rows]
    both_ids = [i for i in text_hits if i in coded_rows]

    meta = {}
    if text_only_ids:
        for r in (db.query(Submission.id, Submission.lis_submission_id, Submission.report_date)
                  .filter(Submission.id.in_(text_only_ids)).all()):
            meta[r[0]] = {"lis": r[1], "date": r[2]}

    # FULL ordered row lists (raw excerpts). max_rows caps each arm when given.
    coded_items = (list(coded_rows.items()) if max_rows is None
                   else list(coded_rows.items())[:max_rows])
    coded_list = [{"submission_id": info["lis"], "date": str(info["date"]),
                   "evidence": "both" if sid in text_hits else "coded", "confirmed": True}
                  for sid, info in coded_items]
    text_ids = text_only_ids if max_rows is None else text_only_ids[:max_rows]
    text_list = []
    for sid in text_ids:
        info = meta.get(sid, {})
        hit = text_hits.get(sid) or {}
        topos = [t for t in (hit.get("topographies") or []) if t]
        row = {"submission_id": info.get("lis"), "date": str(info.get("date")),
               "evidence": "text_only", "confirmed": False, "topographies": topos,
               "likely_negated": bool(hit.get("likely_negated")),
               "excerpt": hit.get("excerpt") or ""}
        if len(topos) > 1:
            row["ambiguous_site"] = ("submission spans several organs ("
                                     + ", ".join(topos[:5]) + ")")
        text_list.append(row)

    text_only_negated = sum(1 for i in text_only_ids
                            if (text_hits.get(i) or {}).get("likely_negated"))
    counts = {"coded": len(coded_rows), "both": len(both_ids),
              "coded_only": len(coded_rows) - len(both_ids),
              "text_only_candidates": len(text_only_ids),
              "text_only_likely_negated": text_only_negated}
    scope = (f"{topography} ({len(topo['codes'])} topography codes)"
             + (f", {date_from or '…'}..{date_to or '…'}" if (date_from or date_to) else "")
             + f", {report_type} reports")
    return {"ok": True, "topography": topography, "morphology": morphology,
            "search_term": search_term, "morph_resolved": morph_resolved,
            "report_type": report_type, "notes": notes,
            "topo_codes": topo["codes"], "morph_codes": morph.get("codes", []),
            "morph_detail": morph.get("detail", []),
            "coded_list": coded_list, "text_list": text_list,
            "coded_total": len(coded_rows), "text_only_total": len(text_only_ids),
            "counts": counts, "scope": scope}


def _coding_coverage(db: Session, f, field: str) -> Optional[str]:
    """How much of the non-morphology scope is coded at all, as a caveat string.

    A morphology filter is a filter over *codes*, and only ~24-30% of recent
    probes carry a morphology code — the diagnosis lives in the report text for
    the rest. So the count query_cohort returns is a floor, not a total, and
    nothing in the result said so. Measures coverage within the same scope minus
    the morphology predicate, so the caveat is about this query, not the corpus.

    Returns None when coverage is high enough not to mislead, or on any error —
    this is advisory, and must never break the query it annotates.
    """
    from ..models import Probe
    from ..routers.cohorts import _apply_filters
    from sqlalchemy import func as sqlfunc
    try:
        scoped = f.model_copy(update={field: None, "morph_description_search": None,
                                      "return_level": "probe"})
        q = _apply_filters(db, scoped)
        row = q.with_entities(
            sqlfunc.count(sqlfunc.distinct(Probe.id)),
            sqlfunc.count(sqlfunc.distinct(Probe.id)).filter(
                Probe.snomed_morph_codes != cast([], ARRAY(Text))),
        ).one()
        total, coded = int(row[0] or 0), int(row[1] or 0)
        if not total or coded / total >= 0.9:
            return None
        return (f"only {coded:,} of {total:,} probes in this scope ({coded / total:.0%}) "
                "carry ANY morphology code, so this count is a FLOOR — cases whose "
                "diagnosis appears only in report text are not included. Use "
                "semantic_report_search over the same scope to find those.")
    except Exception as e:
        log.warning("coding-coverage caveat failed: %s", e)
        return None


def _describe_filter(f) -> str:
    """One-line human description of the predicates a CohortFilter applies."""
    parts = []
    for field, label in (("snomed_topo_codes", "topography code"),
                         ("topo_description_search", "topography"),
                         ("snomed_morph_codes", "morphology code"),
                         ("morph_description_search", "morphology"),
                         ("snomed_etio_codes", "etiology code"),
                         ("etio_description_search", "etiology"),
                         ("submission_types", "submission type"),
                         ("stain_names", "stain"),
                         ("stain_categories", "stain category"),
                         ("file_formats", "format")):
        v = getattr(f, field, None)
        if not v:
            continue
        vals = v if isinstance(v, list) else [v]
        shown = ", ".join(str(x) for x in vals[:4])
        more = f" +{len(vals) - 4} more" if len(vals) > 4 else ""
        parts.append(f"{label} in [{shown}{more}]")
    if getattr(f, "malignancy_flag", None) is not None:
        parts.append(f"malignancy={f.malignancy_flag}")
    if getattr(f, "submission_date_from", None) or getattr(f, "submission_date_to", None):
        parts.append(f"date {f.submission_date_from or '…'}..{f.submission_date_to or '…'}")
    if getattr(f, "has_scan", None) is not None:
        parts.append(f"has_scan={f.has_scan}")
    return "; ".join(parts) or "no filters (whole database)"


# HoVer-NeXt cell taxonomy (see models/catalog.json). Grouped for immune /
# tumor-infiltration metrics. Kept here as the single source of truth for the
# detection adapter and the spatial-feature tool.
_LYMPHOID_CELLS = {"lymphocyte", "plasma-cell"}
_IMMUNE_CELLS = {"lymphocyte", "plasma-cell", "neutrophil", "eosinophil"}
_EPITHELIAL_CELL = "epithelial-cell"


def _detection_metrics(class_counts: dict, total: Optional[int] = None) -> dict:
    """Derive immune / lymphoid / epithelial ratios from HoVer-NeXt counts."""
    counts = {k: v for k, v in (class_counts or {}).items() if isinstance(v, (int, float))}
    total = total or sum(counts.values())
    immune = sum(counts.get(c, 0) for c in _IMMUNE_CELLS)
    lymphoid = sum(counts.get(c, 0) for c in _LYMPHOID_CELLS)
    epithelial = counts.get(_EPITHELIAL_CELL, 0)
    return {
        "total_cells": total,
        "immune_fraction": round(immune / total, 4) if total else None,
        "lymphoid_fraction": round(lymphoid / total, 4) if total else None,
        "lymphoid_to_epithelial_ratio": round(lymphoid / epithelial, 4) if epithelial else None,
    }


def _summarize_outcome(outcome: Optional[dict], model_id: str) -> dict:
    """Reduce a result.json `outcome` block to a compact, model-aware summary.

    Adapts to the two known result shapes and degrades gracefully for anything
    else (returning only scalar outcome fields, never nested geometry). Never
    touches the `files`/`overlays` blocks — those are GeoJSON/raster paths, not
    interpretable output.
    """
    if not isinstance(outcome, dict):
        return {"headline": "No structured outcome in result."}
    status = outcome.get("status")

    # metassist_v2 — lymph-node metastasis detection
    if "positive_ln_count" in outcome or "ln_count" in outcome:
        pm = outcome.get("primary_metric") or {}
        measure = pm.get("value")
        if (not measure or measure == "N/A") and outcome.get("measurement_um"):
            measure = f"{outcome['measurement_um']} um"
        headline = status or "result"
        if measure and measure != "N/A":
            headline += f" ({pm.get('label', 'measurement')}: {measure})"
        return {
            "headline": headline,
            "status": status,
            "lymph_nodes_total": outcome.get("ln_count"),
            "lymph_nodes_positive": outcome.get("positive_ln_count"),
            "measurement_um": outcome.get("measurement_um"),
            "primary_metric": pm or None,
        }

    # crc_tissue_seg — tissue-class composition
    if "composition_pct" in outcome:
        comp = outcome.get("composition_pct") or {}
        ranked = sorted(((k, v) for k, v in comp.items() if isinstance(v, (int, float))),
                        key=lambda kv: kv[1], reverse=True)
        headline = "tissue composition — " + ", ".join(f"{k} {v:.1f}%" for k, v in ranked[:4])
        return {
            "headline": headline,
            "status": status,
            "composition_pct": {k: round(v, 2) for k, v in ranked},
            "total_tissue_pixels": outcome.get("total_tissue_pixels"),
        }

    # hover_next — multiclass nuclei detection/classification
    if "class_counts" in outcome:
        counts = outcome.get("class_counts") or {}
        m = _detection_metrics(counts, outcome.get("total_cells"))
        headline = f"{m['total_cells']} cells"
        if m["immune_fraction"] is not None:
            headline += f", immune {m['immune_fraction']:.1%}"
        return {
            "headline": headline,
            "status": status,
            "class_counts": counts,
            **m,
        }

    # Unknown model — surface scalar fields only, no invented interpretation.
    scalars = {k: v for k, v in outcome.items()
               if v is None or isinstance(v, (str, int, float, bool))}
    return {"headline": status or "result available", **scalars}


def _find_result_json(job, results_dir: str):
    """Locate a job's result.json (result_path first, then results_dir/<id>/)."""
    from pathlib import Path
    candidates = []
    if job.result_path:
        candidates.append(Path(job.result_path) / "result.json")
    candidates.append(Path(results_dir) / str(job.id) / "result.json")
    return next((p for p in candidates if p.exists()), None)


def _slide_base_mpp(scan_path: Optional[str]) -> Optional[float]:
    """Level-0 microns-per-pixel for a WSI (mean of X/Y), or None if unreadable.

    HoVer-NeXt GeoJSON coordinates are in level-0 slide pixel space
    (models/hover_next/infer.py scales inference coords by level_downsampling),
    so this is the scale that converts a neighbour radius in µm to pixels.
    """
    if not scan_path:
        return None
    try:
        import os
        if not os.path.exists(scan_path):
            return None
        import openslide  # handles MIRAX/.mrxs etc.; heavy → import lazily
        sl = openslide.open_slide(scan_path)
        mx = sl.properties.get(openslide.PROPERTY_NAME_MPP_X)
        my = sl.properties.get(openslide.PROPERTY_NAME_MPP_Y)
        sl.close()
        if mx is None or my is None:
            return None
        return 0.5 * (float(mx) + float(my))
    except Exception:
        return None


def _tumor_mask_from_crc_geojson(geojson_path: str, tumor_class: str = "Tumor",
                                 max_dim: int = 6000):
    """Rasterize the Tumor-class polygons of a CRC segmentation GeoJSON into a
    binary mask (faithful to utils.geometry.decode_geojson_to_mask, but cv2-only
    so we don't need shapely).

    The GeoJSON is self-describing: top-level `mask_shape` [H,W],
    `level_downsampling` (coords are level-0 slide pixels → divide to reach mask
    space) and `category_dict`. To bound memory for distance_transform_edt on
    huge slides, the mask is built at a reduced resolution when needed; the
    effective downsample (level-0 px per mask px) is returned alongside.

    Returns (mask uint8 HxW, effective_downsample) or (None, None).
    """
    import json as _json
    import math
    import numpy as np
    import cv2

    with open(geojson_path) as f:
        gj = _json.load(f)
    shape = gj.get("mask_shape")
    ds = gj.get("level_downsampling")
    if not shape or not ds:
        return None, None
    H, W = int(shape[0]), int(shape[1])
    scale = max(1, math.ceil(max(H, W) / max_dim))
    eff_ds = float(ds) * scale
    out_h, out_w = math.ceil(H / scale), math.ceil(W / scale)

    mask = np.zeros((out_h, out_w), dtype=np.uint8)
    outers, holes = [], []
    for feat in gj.get("features", []):
        props = feat.get("properties") or {}
        name = (props.get("classification") or {}).get("name") or props.get("type")
        if name != tumor_class:
            continue
        coords = (feat.get("geometry") or {}).get("coordinates")
        if not coords:
            continue
        if isinstance(coords[0][0], (int, float)):     # bare ring → wrap as polygon
            coords = [coords]
        outer = (np.asarray(coords[0], dtype=np.float64) / eff_ds).astype(np.int32)
        if len(np.unique(outer, axis=0)) > 3:
            outers.append(outer)
        for hole in coords[1:]:
            h = (np.asarray(hole, dtype=np.float64) / eff_ds).astype(np.int32)
            if len(np.unique(h, axis=0)) > 3:
                holes.append(h)
    if outers:
        cv2.fillPoly(mask, outers, 1)
    if holes:
        cv2.fillPoly(mask, holes, 0)
    return mask, eff_ds


def _tumor_infiltration_features(cells_geojson: str, tumor_mask, eff_ds: float,
                                 mpp: float, front_width_um: float,
                                 max_cells: int) -> dict:
    """Cross HoVer-NeXt cells with a CRC tumor mask: intratumoral vs
    extratumoral lymphoid load, and invasion-front vs tumor-center gradient
    (front = tumor pixels within front_width_um of the tumor boundary, via a
    distance transform). Cell coords and the mask are both keyed to level-0
    slide pixels through eff_ds.
    """
    import ijson
    import numpy as np
    from scipy.ndimage import distance_transform_edt

    if tumor_mask is None or not tumor_mask.any():
        return {"error": "No Tumor region found in the segmentation GeoJSON."}

    from scipy.ndimage import label

    H, W = tumor_mask.shape
    um_per_px = eff_ds * mpp
    # Distance (in reduced-mask px) from each tumor pixel to the tumor boundary.
    dist_in = distance_transform_edt(tumor_mask)
    front_px = front_width_um / um_per_px
    # Tumor morphology — lets the caller interpret the front/center split (e.g. a
    # fragmented tumor whose max depth < front_width has no distinct "center").
    max_depth_um = float(dist_in.max()) * um_per_px
    _, n_components = label(tumor_mask)
    tumor_area_mm2 = round(int(tumor_mask.sum()) * (um_per_px / 1000.0) ** 2, 3)

    xs, ys, grp = [], [], []       # grp: 0=lymphoid, 1=epithelial, 2=other
    capped = False
    with open(cells_geojson, "rb") as fh:
        for feat in ijson.items(fh, "features.item"):
            geom = feat.get("geometry") or {}
            if geom.get("type") != "Point":
                continue
            name = ((feat.get("properties") or {}).get("classification") or {}).get("name")
            xy = geom.get("coordinates")
            if not name or not xy or len(xy) < 2:
                continue
            if len(xs) >= max_cells:
                capped = True
                break
            xs.append(float(xy[0])); ys.append(float(xy[1]))
            grp.append(0 if name in _LYMPHOID_CELLS else 1 if name == _EPITHELIAL_CELL else 2)

    if not xs:
        return {"error": "No classified point cells found in the detection GeoJSON."}

    xi = np.clip((np.asarray(xs) / eff_ds).astype(np.int64), 0, W - 1)
    yi = np.clip((np.asarray(ys) / eff_ds).astype(np.int64), 0, H - 1)
    grp = np.asarray(grp)
    in_tumor = tumor_mask[yi, xi] == 1
    lymphoid = grp == 0
    dist = dist_in[yi, xi]
    front = in_tumor & (dist <= front_px)
    center = in_tumor & ~front

    def _stats(sel) -> dict:
        tot = int(sel.sum())
        lym = int((sel & lymphoid).sum())
        return {"cells": tot, "lymphoid": lym,
                "lymphoid_fraction": round(lym / tot, 4) if tot else None}

    intra, extra = _stats(in_tumor), _stats(~in_tumor)
    intra_f = intra["lymphoid_fraction"]
    extra_f = extra["lymphoid_fraction"]
    return {
        "cells_processed": len(xs),
        "approximate": capped,
        "tumor": {
            "components": int(n_components),
            "area_mm2": tumor_area_mm2,
            "max_depth_um": round(max_depth_um),
        },
        "intratumoral": intra,
        "extratumoral": extra,
        "invasion_front": {"width_um": front_width_um, **_stats(front)},
        "tumor_center": _stats(center),
        "tumor_epithelial_cells": int((in_tumor & (grp == 1)).sum()),
        # >1 → lymphoid relatively enriched inside the tumor; <1 → immune exclusion
        "intratumoral_vs_extratumoral_lymphoid_ratio":
            round(intra_f / extra_f, 3) if intra_f and extra_f else None,
    }


def _cell_spatial_features(geojson_path: str, neighbor_radius_px: Optional[float],
                           max_cells: int) -> dict:
    """Compute SPARK-style spatial single-cell features from a HoVer-NeXt cell
    GeoJSON (a FeatureCollection of classified Points).

    Streams the file (ijson) so large slides don't blow memory. Per-class counts
    and fractions are computed over ALL cells (exact, cheap Counter). Only the
    epithelial + lymphoid *coordinates* needed for the spatial metric are stored,
    each capped at max_cells (flagged `spatial_approximate` if hit). Returns
    immune/lymphoid ratios and a tumor-infiltration metric (fraction of
    epithelial cells with a lymphoid cell within neighbor_radius_px — in level-0
    slide pixel space; the caller converts µm→px via the slide mpp). Ratios are
    scale-invariant; absolute densities are out of scope here.
    """
    import ijson
    from collections import Counter

    counts: Counter = Counter()
    epi: list = []             # epithelial (tumor-proxy) coords
    lymph: list = []           # lymphoid coords (lymphocyte + plasma-cell)
    spatial_capped = False
    try:
        with open(geojson_path, "rb") as fh:
            for feat in ijson.items(fh, "features.item"):
                geom = feat.get("geometry") or {}
                if geom.get("type") != "Point":
                    continue
                name = ((feat.get("properties") or {}).get("classification") or {}).get("name")
                if not name:
                    continue
                counts[name] += 1                       # exact over the full slide
                xy = geom.get("coordinates")
                if not xy or len(xy) < 2:
                    continue
                if name == _EPITHELIAL_CELL:
                    if len(epi) < max_cells:
                        epi.append((float(xy[0]), float(xy[1])))
                    else:
                        spatial_capped = True
                elif name in _LYMPHOID_CELLS:
                    if len(lymph) < max_cells:
                        lymph.append((float(xy[0]), float(xy[1])))
                    else:
                        spatial_capped = True
    except Exception as e:
        return {"error": f"Failed to parse cell GeoJSON: {e}"}

    total = sum(counts.values())
    if total == 0:
        return {"error": "No classified point cells found in GeoJSON."}

    feats = {
        "counts": dict(counts),
        "fractions": {c: round(counts[c] / total, 4) for c in counts},
        **_detection_metrics(dict(counts), total),
    }

    # Spatial tumor infiltration: lymphoid cells near epithelial (tumor) cells.
    # Skipped when no radius is given (e.g. slide mpp was unavailable upstream).
    import numpy as np
    from scipy.spatial import cKDTree
    if epi and lymph and neighbor_radius_px:
        tree = cKDTree(np.asarray(lymph))
        near = tree.query_ball_point(np.asarray(epi), r=neighbor_radius_px,
                                     return_length=True)
        feats["spatial"] = {
            "neighbor_radius_px": neighbor_radius_px,
            "epithelial_cells": len(epi),
            "epithelial_infiltrated_fraction": round(float((near > 0).mean()), 4),
            "mean_lymphoid_neighbors_per_epithelial": round(float(near.mean()), 3),
            "approximate": spatial_capped,
        }
    return feats


def get_tools(db: Session, user: User) -> list:
    """Build the per-request tool set. Lazily imports langchain_core."""
    from langchain_core.tools import tool
    # Lazy (see module-top note): safe here because get_tools runs at graph-build
    # time, by which point both the routers package and this module are fully
    # imported — no partial-init cycle.
    from ..routers.patients import enrich_snomed_codes

    settings = get_settings()
    max_rows = settings.agent_max_tool_rows

    # ==========================================================================
    # TIER 0 — ORIGINAL TOOLS (unchanged)
    # ==========================================================================

    @tool
    def query_cohort(
        return_level: str = "scan",
        topo_description_search: Optional[str] = None,
        snomed_topo_codes: Optional[List[str]] = None,
        snomed_morph_codes: Optional[List[str]] = None,
        morph_description_search: Optional[List[str]] = None,
        snomed_etiology_codes: Optional[List[str]] = None,
        etiology_description_search: Optional[List[str]] = None,
        submission_types: Optional[List[str]] = None,
        malignancy_flag: Optional[bool] = None,
        submission_date_from: Optional[str] = None,
        submission_date_to: Optional[str] = None,
        has_scan: Optional[bool] = None,
        stain_names: Optional[List[str]] = None,
        stain_categories: Optional[List[str]] = None,
        file_formats: Optional[List[str]] = None,
        magnification_min: Optional[float] = None,
        magnification_max: Optional[float] = None,
        max_rows: int = 50,
        sort: Optional[str] = None,
        count_only: bool = False,
    ) -> str:
        """Build a structured cohort from CODED metadata (SNOMED topography /
        morphology / etiology, stain, date, malignancy).

        For a DIAGNOSIS phrase ('colorectal adenocarcinoma', 'gastric MALT
        lymphoma'), call resolve_diagnosis FIRST and pass the code lists it
        returns — it splits the phrase across the topography and morphology axes
        and expands each to its full code family. Do not hand a diagnosis phrase
        to a single filter here; topography and morphology are separate axes and
        a phrase spanning both will silently match nothing.

        return_level is one of patient, submission, probe, block, scan.
        Dates are ISO (YYYY-MM-DD). Cannot express negative-stain or count
        constraints.

        Matching semantics differ per parameter — they are not interchangeable:
        - snomed_*_codes: exact code match (topography) / array overlap (morph,
          etiology). This is the reliable path — prefer it.
        - topo_description_search: case-insensitive SUBSTRING over probe
          topography text.
        - morph_description_search / etiology_description_search: EXACT, full
          description match against the SNOMED master vocabulary (a list ORs
          together). 'adenocarcinoma' matches nothing — the description is
          'adenocarcinoma, NOS'. Validate with lookup_filter_values first, or
          use codes.
        Values that resolve to nothing are reported as an error with
        suggestions, never as an empty result.

        `sort`: 'recent' orders results by report_date (newest first), 'oldest'
        (newest last). Combine with max_rows to answer 'the N most recent …'.
        `count_only`: skip building result rows and return just the count. Use
        for 'how many …' — much faster and far cheaper on a broad filter."""
        from ..routers.cohorts import _get_results_for_cohort, count_for_cohort
        try:
            f = _cohort_filter(
                return_level,
                topo_description_search=topo_description_search,
                snomed_topo_codes=snomed_topo_codes,
                snomed_morph_codes=snomed_morph_codes,
                morph_description_search=morph_description_search,
                snomed_etiology_codes=snomed_etiology_codes,
                etiology_description_search=etiology_description_search,
                submission_types=submission_types,
                malignancy_flag=malignancy_flag,
                submission_date_from=submission_date_from,
                submission_date_to=submission_date_to,
                has_scan=has_scan,
                stain_names=stain_names,
                stain_categories=stain_categories,
                file_formats=file_formats,
                magnification_min=magnification_min,
                magnification_max=magnification_max,
            )

            # Resolve every vocabulary term BEFORE querying. An unmatched term
            # makes the SQL predicate match zero rows with no error (an
            # unresolved description list compiles to `codes && NULL` → NULL →
            # no rows), which is indistinguishable from a genuine absence of
            # cases. Fail loudly with suggestions instead.
            problems = _validate_filter_values(db, f)
            if problems:
                return _dumps({
                    "summary": "Filter not applied — these values match nothing in the "
                               "database, so the query would have returned 0 results for "
                               "the wrong reason: " + "; ".join(p["problem"] for p in problems),
                    "unresolved": problems, "results": [], "citations": [],
                })

            if count_only:
                total = count_for_cohort(f, db)
                return _dumps({
                    "summary": f"{total} {f.return_level}(s) match: {_describe_filter(f)}",
                    "total": total, "count_only": True,
                    "filter": _describe_filter(f), "results": [], "citations": [],
                })

            rows, _not_found = _get_results_for_cohort(f, db)
            total = len(rows)
            # Optional recency sort by report_date. Sort the FULL result set
            # before slicing so "the N most recent" returns the right N. Dated
            # rows come first (ordered by direction); rows without a report_date
            # (e.g. some non-submission levels) always sort last.
            if sort in ("recent", "oldest"):
                dated = [r for r in rows if r.get("report_date")]
                undated = [r for r in rows if not r.get("report_date")]
                dated.sort(key=lambda r: r["report_date"], reverse=(sort == "recent"))
                rows = dated + undated
            ordered = (" (newest first)" if sort == "recent"
                       else " (oldest first)" if sort == "oldest" else "")
            # Slim each row: cohort results are for identifying/counting cases,
            # so DROP the full report bodies (report_macro / report_microscopy) —
            # 50 rows of full reports is tens of thousands of tokens and blows the
            # context window when the agent loops. Keep a boolean flag; the agent
            # uses get_report_text for the actual text of a specific submission.
            preview = settings.agent_cohort_preview_rows
            sample = []
            for r in rows[:preview]:
                row = {k: v for k, v in r.items()
                       if k not in ("report_macro", "report_microscopy")}
                row["has_report"] = bool(r.get("report_macro") or r.get("report_microscopy"))
                sample.append(row)
            # Structured result set for the chat UI to render as a table, plus
            # clickable per-row citations. This is what makes a "retrieve all X"
            # request usable: an enumerable, linked list instead of prose.
            table, citations = _table_block(sample, return_level, total, preview)
            # Attach the RAW filter so the UI's "Save as cohort" button can persist
            # it directly (one API call), instead of asking the model to reconstruct
            # the filter from prose — which could silently save a different set.
            try:
                table["save"] = {"kind": "cohort",
                                 "filter_json": f.model_dump(exclude_none=True),
                                 "level": return_level}
            except Exception:
                pass
            out = {
                "summary": f"{total} result(s) at {return_level} level{ordered}"
                           + (f" (showing first {table['shown']}; save as a cohort "
                              f"to get all {total})" if table["truncated"] else "")
                           + f" — filter: {_describe_filter(f)}",
                "total": total, "filter": _describe_filter(f),
                # The `table` block is the model's grounding AND the UI's data —
                # one copy, not a duplicate `results` array (halves the tool output
                # in the context window). For per-case detail the agent calls
                # get_submission_hierarchy on a specific id.
                "blocks": [table],
                "citations": citations,
            }
            # A morphology/etiology filter can only ever see coded probes, and
            # most are not coded (~24% carry a morphology code in recent years).
            # Reporting the count without that ceiling reads as a complete
            # answer when it is a floor — say so, and point at the text path.
            if f.snomed_morph_codes or f.morph_description_search:
                cov = _coding_coverage(db, f, "snomed_morph_codes")
                if cov:
                    out["coverage_caveat"] = cov
                    out["summary"] += f" NOTE: {cov}"
            if total == 0:
                out["summary"] += (" All filter values resolved against the vocabulary, "
                                   "so this is a genuine absence of CODED cases — not a "
                                   "bad filter. The diagnosis may still be present in "
                                   "report text; try semantic_report_search.")
            return _dumps(out)
        except Exception as e:
            return _err(f"Cohort query failed: {e}")

    @tool
    def lookup_filter_values(field: str, q: str) -> str:
        """Auto-complete valid filter values for query_cohort. The field is one
        of snomed_topo_code, topo_description, snomed_morph_code, morph_description,
        snomed_etiology_code, etiology_description, stain_name."""
        from ..routers.stats import lookup_values
        try:
            values = lookup_values(field=field, q=q, db=db, _=user)
        except Exception as e:
            return _err(f"Lookup failed: {e}")
        return _dumps({"summary": f"{len(values)} matches for {field} ~ '{q}'",
                       "values": values, "citations": []})

    @tool
    def lookup_snomed(query: str, category: Optional[str] = None) -> str:
        """Explore the SNOMED vocabulary. Give a CODE (e.g. 'M-81403') to get its
        meaning, or a TERM to find matching codes. Exact substring matches come
        back as match='exact', codes related by MEANING as match='related', so an
        umbrella query ('solid tumor', 'inflammation') surfaces
        carcinoma/adenocarcinoma/sarcoma even though no description contains that
        phrase. Returns nothing when nothing is close enough — it will not guess.
        Optional `category` limits to 'morphology', 'etiology', or 'topography'.

        This is for LOOKUP and EXPLORATION — reading a code, or browsing what
        exists. To BUILD A COHORT from a diagnosis, use resolve_diagnosis
        instead: it splits the phrase across the topography and morphology axes
        and returns each complete code family, which is what query_cohort needs.
        Codes found here are a partial list, not a family.

        Also distinct from lookup_filter_values, which autocompletes values for a
        query_cohort filter."""
        from ..models import SnomedCode
        term = (query or "").strip()
        if not term:
            return _err("Provide a SNOMED code or a term to look up.")
        base = db.query(SnomedCode)
        if category:
            cat = category.strip().lower()
            if cat not in ("morphology", "etiology", "topography"):
                return _err("category must be morphology, etiology, or topography")
            base = base.filter(SnomedCode.category == cat)
        else:
            cat = None
        # A code contains digits; a term does not. Search the likely column first,
        # then fall back to the other so either direction resolves.
        looks_like_code = any(ch.isdigit() for ch in term)
        primary = SnomedCode.code if looks_like_code else SnomedCode.description
        secondary = SnomedCode.description if looks_like_code else SnomedCode.code
        rows = base.filter(primary.ilike(f"%{term}%")).limit(max_rows).all()
        if not rows:
            rows = base.filter(secondary.ilike(f"%{term}%")).limit(max_rows).all()
        exact = [{"code": r.code, "category": r.category,
                  "description": r.description, "match": "exact"} for r in rows]

        # Semantic augmentation: for TERM queries (not raw codes), add codes that
        # are related by meaning so conceptual/umbrella queries aren't dead ends.
        related = []
        if not looks_like_code and len(exact) < max_rows:
            try:
                from .snomed_index import semantic_search, EmbeddingsUnavailable
                have = {e["code"] for e in exact}
                for r in semantic_search(db, term, category=cat,
                                         top_k=min(10, max_rows)):
                    if r["code"] not in have:
                        related.append({"code": r["code"], "category": r["category"],
                                        "description": r["description"],
                                        "score": r["score"], "match": "related"})
            except EmbeddingsUnavailable:
                pass  # embedder not loaded — substring-only, still works
            except Exception as e:
                log.warning("SNOMED semantic lookup failed: %s", e)

        results = exact + related
        cat_txt = f" in {category}" if category else ""
        if exact:
            summary = (f"{len(exact)} exact"
                       + (f" + {len(related)} related" if related else "")
                       + f" SNOMED match(es) for '{term}'{cat_txt}")
        elif related:
            summary = (f"No exact SNOMED match for '{term}'{cat_txt}; "
                       f"{len(related)} semantically related code(s) shown — "
                       f"use these rather than re-searching the literal phrase")
        else:
            summary = f"No SNOMED matches for '{term}'{cat_txt}"
        return _dumps({"summary": summary, "results": results, "citations": []})


    @tool
    def resolve_diagnosis(topography: Optional[str] = None,
                          morphology: Optional[str] = None) -> str:
        """Turn a DIAGNOSIS into ready-to-use query_cohort code filters.

        A diagnosis spans two INDEPENDENT coding axes stored in two separate
        columns, so split the phrase yourself and pass each part:
          'colorectal adenocarcinoma' -> topography='colorectal', morphology='adenocarcinoma'
          'gastric MALT lymphoma'     -> topography='stomach', morphology='MALT lymphoma'
        Pass only the axis you have; either may be omitted.

        Each axis is expanded to its COMPLETE code family — 'colon' is not one
        code but 22 (cecum, sigmoid, flexures …), 'adenocarcinoma' is 6 (NOS,
        papillary, clear cell …). Filtering on the single obvious code silently
        misses most of the cohort.

        Returns per axis: `codes` (the family — pass to query_cohort's
        snomed_topo_codes / snomed_morph_codes), `related_not_included` (adjacent
        codes to accept or reject yourself, e.g. 'suspected adenocarcinoma'),
        probe counts, and coding coverage. Morphology codes carry a behavior
        label: '/6 malignant, metastatic' is a metastasis TO that site, not a
        primary. If an axis resolves to nothing it says so — it will not guess.

        To COUNT or LIST the cases rather than just get the codes, prefer
        find_cases: it runs this plus both retrieval paths and reports coded vs
        text-only evidence."""
        if not topography and not morphology:
            return _err("Give at least one of topography= or morphology=. For a "
                        "diagnosis phrase, split it: 'colorectal adenocarcinoma' -> "
                        "topography='colorectal', morphology='adenocarcinoma'.")
        out = _resolve_axes(db, topography, morphology)
        notes = out.pop("notes", [])
        out["citations"] = []
        parts = []
        if out.get("topography", {}).get("resolved"):
            t = out["topography"]
            parts.append(f"topography '{t['term']}' -> {len(t['codes'])} code(s) "
                         f"in {'/'.join(t['organ_families'])} ({t['total_probes']:,} probes)")
        if out.get("morphology", {}).get("resolved"):
            m = out["morphology"]
            parts.append(f"morphology '{m['term']}' -> {len(m['codes'])} code(s) "
                         f"({m['total_probes']:,} probes)")
        unresolved = [a for a in ("topography", "morphology")
                      if a in out and not out[a].get("resolved")]
        if unresolved:
            parts.append("UNRESOLVED: " + ", ".join(unresolved))
        out["summary"] = ("Resolved " + "; ".join(parts) if parts
                          else "Nothing resolved.") + (" | " + " ".join(notes) if notes else "")
        out["next_step"] = ("Pass topography.codes as query_cohort(snomed_topo_codes=…) and "
                            "morphology.codes as query_cohort(snomed_morph_codes=…) — or call "
                            "find_cases to get the cases directly, including uncoded ones. "
                            "Review related_not_included first — those are judgement calls.")
        return _dumps(out)

    @tool
    def find_cases(topography: Optional[str] = None,
                   morphology: Optional[str] = None,
                   date_from: Optional[str] = None,
                   date_to: Optional[str] = None,
                   report_type: str = "microscopy",
                   text_term: Optional[str] = None,
                   max_rows: int = 25) -> str:
        """FIND ALL CASES in an organ — the tool for 'find/count all X'.

        Answers what neither retrieval path can answer alone. Only ~25% of probes
        carry a morphology code, so a code-based cohort (query_cohort) finds the
        coded cases and silently misses the rest; free-text search finds mentions
        but cannot filter by morphology. This runs BOTH over the same
        topography+date scope and reconciles them:

          coded      — SNOMED morphology code says this diagnosis. Reliable.
          both       — coded AND the report text says it too.
          text_only  — the report text mentions it but NO code says so. These are
                       CANDIDATES REQUIRING REVIEW, not confirmed cases, for two
                       reasons: the same text match is produced by 'no evidence of
                       adenocarcinoma' or a mention of prior history; and on a
                       multi-organ submission the text cannot be attributed to one
                       probe, so the finding may belong to another site (flagged
                       as `ambiguous_site`). Each carries a `excerpt` with the
                       match marked <<…>> so you can judge — quote it, don't
                       assume.

        REQUIRED: topography= (the organ scope the exhaustive text arm searches
        within — split it off the diagnosis: 'colorectal adenocarcinoma' ->
        topography='colorectal').

        The FEATURE you are looking for can be either or both of:
          - morphology= a SNOMED diagnosis ('adenocarcinoma') — enables the coded
            arm AND is searched in text.
          - text_term= a FREE-TEXT feature that is NOT a SNOMED morphology code
            ('signet ring cell', 'mucinous', 'poorly differentiated'). This is the
            RIGHT tool for exactly that: it runs the exhaustive text arm scoped to
            the organ's codes. Use it instead of semantic_report_search, which is a
            top-k SAMPLE (cannot answer 'find ALL') and cannot scope by code.
        Give at least one. If morphology= is given but is not a real SNOMED code,
        there is simply no coded arm — the text arm carries the answer and the
        result says so, rather than failing.

        When reporting, give the coded count (if any) as the firm number and the
        text-only count as cases needing review. NEVER add them into a single total
        and present it as the answer.

        report_type defaults to 'microscopy' (where diagnoses live)."""
        core = _find_cases_core(db, topography, morphology, date_from, date_to,
                                report_type, text_term, max_rows=max_rows)
        if not core.get("ok"):
            return _dumps({"summary": core.get("error", "find_cases could not run."),
                           "resolved": core.get("resolved", {}), "results": [],
                           "citations": []})
        notes, counts, scope = core["notes"], core["counts"], core["scope"]
        morph_resolved, search_term = core["morph_resolved"], core["search_term"]
        report_type = core["report_type"]

        # Model-facing rows: fence excerpts, add review guidance. (Coded rows carry
        # no excerpt; the text-only candidates are the ones needing judgement.)
        results = list(core["coded_list"])
        for r in core["text_list"]:
            row = {"submission_id": r["submission_id"], "date": r["date"],
                   "evidence": "text_only", "confirmed": False,
                   "topographies": r.get("topographies") or [],
                   "likely_negated": r["likely_negated"],
                   "needs_review": "text mentions the term but no code says so; may be a "
                                   "negation or prior history — read the excerpt (match "
                                   "marked <<…>>)",
                   "excerpt": fence_untrusted(r.get("excerpt") or "")}
            if r.get("ambiguous_site"):
                row["ambiguous_site"] = (
                    r["ambiguous_site"] + " — the report text cannot be attributed to one "
                    "probe, so the finding may belong to a different site than searched")
            results.append(row)

        # Cards block: one card per submission so the result set is scannable AND
        # exportable, not just cited. Snippets stay FENCED (the stream layer unfences
        # cards for display); the `export` descriptor lets the UI download the FULL
        # set — this inline preview is capped at max_rows per arm.
        total = core["coded_total"] + core["text_only_total"]
        card_items = []
        for r in results:
            tags = [r["evidence"]]
            if r.get("likely_negated"):
                tags.append("negated?")
            if r.get("ambiguous_site"):
                tags.append("multi-organ")
            card_items.append({"title": r["submission_id"], "subtitle": " · ".join(tags),
                               "date": r.get("date"), "snippet": r.get("excerpt") or ""})
        export_args = {k: v for k, v in
                       {"topography": topography, "morphology": morphology,
                        "date_from": date_from, "date_to": date_to,
                        "report_type": report_type, "text_term": text_term}.items()
                       if v is not None}
        block = _excerpt_cards_block(card_items, total=total)
        block["export"] = {"tool": "find_cases", "args": export_args,
                           "count": total, "level": "submission"}

        cites = [{"type": "submission", "id": r["submission_id"], "label": r["submission_id"]}
                 for r in results if r.get("submission_id")]
        if morph_resolved:
            summary = (
                f"{counts['coded']} CODED case(s) of '{morphology}' in {scope} — this is the "
                f"firm number. Plus {counts['text_only_candidates']} further submission(s) "
                f"whose {report_type} text mentions '{search_term}' but carry NO morphology "
                "code: CANDIDATES needing review, not confirmed cases (a text match can be a "
                "negation or prior history). Report the two separately; do not add them "
                "together.")
        else:
            neg = counts["text_only_likely_negated"]
            neg_txt = (f" Of these, {neg} appear NEGATED/absent (e.g. 'no evidence of…') — "
                       "check `likely_negated` on each row and exclude them from a positive "
                       "count." if neg else "")
            summary = (
                f"No SNOMED morphology code for '{morphology or search_term}', so there is no "
                f"coded arm. {counts['text_only_candidates']} submission(s) in {scope} have "
                f"{report_type} text mentioning '{search_term}': these are CANDIDATES needing "
                "review, not confirmed cases — a text match can be a negation ('no evidence "
                "of…'), prior history, or (on a multi-organ submission) belong to another "
                f"site.{neg_txt} Cite the excerpts; do NOT present the count as a confirmed "
                "total.")
        if total > len(results):
            summary += (f" Showing the first {len(results)} of {total}; use the Download "
                        "button to export all as CSV/JSON.")
        return _dumps({
            "summary": summary + (" | " + " ".join(notes) if notes else ""),
            "counts": counts,
            "resolved": {"topography_codes": core["topo_codes"],
                         "morphology_codes": core["morph_codes"],
                         "morphology_detail": core["morph_detail"]},
            "scope": scope,
            "results": results,
            "blocks": [block],
            "truncated": total > len(results),
            "citations": cites,
        })

    @tool
    def search_documentation(query: str, top_k: Optional[int] = None) -> str:
        """Look up PathoDB's own documentation and canonical glossary: definitions
        of domain terms (Scan vs slide, Cohort vs Custom list, project/TMA types,
        stains), platform capabilities and how the system is organized. Use for
        'what does X mean here', 'difference between A and B', or 'what can this
        platform do' questions. This is DOC/GLOSSARY retrieval — distinct from
        semantic_report_search, which searches patient report text."""
        from .knowledge import search_docs, KnowledgeUnavailable
        try:
            hits = search_docs(query, top_k=top_k)
        except KnowledgeUnavailable as e:
            return _err(f"Documentation index unavailable: {e}")
        if not hits:
            return _dumps({"summary": f"No documentation matches for '{query}'.",
                           "results": [], "citations": []})
        return _dumps({
            "summary": f"{len(hits)} documentation section(s) matched '{query}'",
            "results": [{"source": h["file"], "section": h["heading"],
                         "excerpt": fence_untrusted(h["excerpt"])} for h in hits],
            "citations": [{"type": "doc", "id": h["file"],
                           "label": f'{h["file"]} — {h["heading"]}'} for h in hits],
        })

    @tool
    def guideline_search(query: str, organ: Optional[str] = None,
                         top_k: Optional[int] = None) -> str:
        """Search external cancer-reporting GUIDELINES (CAP protocols + ICCR
        datasets) for authoritative staging/grading thresholds and REQUIRED
        reporting elements. Use for questions about standards — e.g. 'what defines
        pT3 in colorectal carcinoma?', 'CAP required elements for adrenal cortical
        carcinoma', 'is lymphovascular invasion an ICCR core element for lung?'.
        Optional `organ` softly narrows to a body site ('colon', 'breast', 'lung').
        Returns cited, VERSION-STAMPED excerpts — always cite the protocol +
        version in your answer. This is EXTERNAL STANDARDS retrieval — distinct from
        semantic_report_search (a patient's report text) and search_documentation
        (PathoDB platform/glossary terms)."""
        if not settings.guideline_search_enabled:
            return _err("Guideline search is disabled.")
        from .guideline_rag import retrieve
        from .embeddings import EmbeddingsUnavailable
        try:
            chunks = retrieve(db, query, top_k=top_k, organ=organ)
        except EmbeddingsUnavailable as e:
            return _err(f"Guideline search unavailable (embeddings not loaded): {e}.")
        except Exception as e:
            return _err(f"Guideline search unavailable: {e}.")
        if not chunks:
            return _dumps({"summary": f"No guideline passages matched '{query}'"
                           + (f" for organ '{organ}'" if organ else "") + ".",
                           "results": [], "citations": []})
        # NOT data-fenced: guideline text is trusted, curated reference the model
        # SHOULD apply — unlike patient report text (see guardrails.fence_untrusted).
        return _dumps({
            "summary": f"{len(chunks)} guideline passage(s) retrieved"
                       + (f" for '{organ}'" if organ else ""),
            "results": [{"source_org": c.source_org, "title": c.title,
                         "organ": c.organ, "version": c.version, "section": c.section,
                         "excerpt": c.chunk_text[:700]} for c in chunks],
            "citations": [c.to_citation() for c in chunks],
        })

    @tool
    def list_guideline_elements(cancer_type: str, source_org: Optional[str] = None) -> str:
        """Enumerate the REPORTING ELEMENTS a guideline defines for a cancer type.
        Use this for 'list / what are the reporting elements for X', 'what must be
        reported for X', 'required (core) elements', or 'which elements are core'.
        Returns the ACTUAL, COMPLETE element list (e.g. Histologic Type, Tumor
        Deposits, pT Category, Lymphovascular Invasion) grouped by section, each
        with its status (core / non-core / optional / conditional) and a version
        stamp — read straight from the structured guideline, not by semantic
        guessing. Prefer this over guideline_search for enumeration; use
        guideline_search only for a SPECIFIC question (one threshold/definition).
        Optional source_org ('CAP' or 'ICCR') restricts to one authority."""
        if not settings.guideline_search_enabled:
            return _err("Guideline search is disabled.")
        from .guideline_rag import list_elements
        try:
            docs = list_elements(db, cancer_type, source_org=source_org)
        except Exception as e:
            return _err(f"Guideline element listing unavailable: {e}.")
        if not docs:
            return _dumps({"summary": f"No guideline document matched '{cancer_type}'"
                           + (f" ({source_org})" if source_org else "")
                           + ". Try a different term, or use guideline_search.",
                           "results": [], "citations": []})
        total = sum(len(d["elements"]) for d in docs)
        # Trusted reference (not data-fenced), like guideline_search.
        return _dumps({
            "summary": f"{total} reporting element(s) across {len(docs)} guideline "
                       f"document(s) for '{cancer_type}'",
            "results": [{"source_org": d["source_org"], "title": d["title"],
                         "organ": d["organ"], "version": d["version"],
                         "element_count": len(d["elements"]),
                         "elements": d["elements"]} for d in docs],
            "citations": [{"type": "guideline", "id": d["doc_slug"],
                           "label": f"{d['source_org']} {d['organ']} {d['version']}".strip()}
                          for d in docs],
        })

    @tool
    def semantic_report_search(query: str, top_k: Optional[int] = None,
                               date_from: Optional[str] = None,
                               date_to: Optional[str] = None,
                               report_type: Optional[str] = None,
                               patient_code: Optional[str] = None,
                               malignancy_flag: Optional[bool] = None,
                               topographies: Optional[List[str]] = None,
                               snomed_topo_codes: Optional[List[str]] = None,
                               submission_ids: Optional[List[str]] = None) -> str:
        """Hybrid search over pathology report text (macro/microscopy): combines
        dense semantic (meaning/paraphrase) with lexical full-text (exact rare
        terms — drug names, mutations, codes) and fuses them, then optionally
        reranks. Use for free-text questions about wording/findings, e.g. 'cases
        mentioning perineural invasion'. Returns matching report excerpts with
        citations.

        ALWAYS PASS THE FILTERS THE QUESTION IMPLIES. The corpus is ~2.5M report
        chunks; searching all of it returns loosely-related excerpts from anywhere
        in 20+ years of data. Narrowing first ("zoom in") makes the answer both
        more relevant and much faster. If the user says "in 2024", "last year",
        "colon cases", "for this patient", "in malignant cases" — put it in a
        filter, do not just add the words to `query`.

        Filters (all optional, all AND together):
        - date_from / date_to: ISO dates (YYYY-MM-DD), inclusive. Reports with no
          date are excluded when either is set.
        - report_type: 'macro' or 'microscopy'. Microscopy holds the diagnostic
          findings; macro holds the gross description.
        - patient_code: the LIS patient code (as returned by universal_search).
          Not the numeric patient_id.
        - malignancy_flag: true = malignant cases only, false = non-malignant.
        - topographies: EXACT topography descriptions — validate them with
          lookup_filter_values(field='topo_description') first, e.g. 'colon'.
        - snomed_topo_codes: SNOMED topography codes (e.g. the `codes` family that
          resolve_diagnosis returns for an organ) — pass these DIRECTLY to scope by
          organ without hand-picking descriptions. Prefer this when you already
          resolved the topography. NOTE: this returns a ranked top-k SAMPLE; to find
          ALL cases of a diagnosis/feature in an organ, use find_cases (exhaustive).
        - submission_ids: LIS submission IDs to restrict to. Use this to chain
          from query_cohort for filters this tool has no field for (stain,
          morphology, magnification): run query_cohort, then pass its submission
          IDs here. Prefer the fields above when they can express the filter.

        Falls back gracefully if embeddings are not loaded — in that case, use
        search_reports_keyword instead."""
        from .rag import retrieve, ReportFilter, FilterError
        from .embeddings import EmbeddingsUnavailable
        from ..models import Submission

        f = ReportFilter(date_from=date_from, date_to=date_to,
                         report_type=report_type, malignancy_flag=malignancy_flag,
                         topographies=topographies, snomed_topo_codes=snomed_topo_codes)

        # patient_code -> patient_id. Resolved here, never taken as an id from the
        # model: patient_id and patient_code are different namespaces that can
        # collide, so accepting an id would silently scope to a WRONG patient.
        if patient_code:
            pat = db.query(Patient).filter(Patient.patient_code == patient_code).first()
            if not pat:
                return _err(f"Patient '{patient_code}' not found — cannot scope the search.")
            f.patient_id = pat.id

        # LIS submission IDs -> internal ids (the filter is on the FK).
        if submission_ids:
            rows = (db.query(Submission.id, Submission.lis_submission_id)
                    .filter(Submission.lis_submission_id.in_(list(submission_ids)))
                    .all())
            if not rows:
                return _err(f"None of the {len(submission_ids)} submission ID(s) were found.")
            f.submission_ids = [r[0] for r in rows]
            missing = set(submission_ids) - {r[1] for r in rows}
            if missing:
                log.info("semantic_report_search: %d unknown submission id(s) ignored",
                         len(missing))

        try:
            result = retrieve(db, query, top_k=top_k, filters=f)
        except FilterError as e:
            return _err(f"Invalid search filter: {e}")
        except EmbeddingsUnavailable as e:
            return _err(f"Semantic search unavailable (embeddings not loaded): {e}. "
                        "Try search_reports_keyword as a fallback.")
        except Exception as e:
            return _err(f"Semantic search unavailable (RAG index not ready): {e}. "
                        "Try search_reports_keyword as a fallback.")

        scope = result.scope
        # Tell the model what was actually searched. Without this it cannot tell an
        # empty result caused by too-narrow a filter from a genuine absence of
        # matching text, and would report "no such cases" for a typo'd topography.
        if scope.filtered:
            narrowed = (f"{scope.matched_chunks}+" if scope.capped
                        else str(scope.matched_chunks))
            scope_txt = f" within {scope.description} ({narrowed} chunk(s) in scope)"
        else:
            scope_txt = " across the whole corpus"

        if not result.chunks:
            hint = (" The filter matched no report chunks at all — check the "
                    "topography spelling with lookup_filter_values, or widen the "
                    "date range." if scope.filtered and scope.matched_chunks == 0
                    else "")
            return _dumps({"summary": f"No report excerpts matched '{query}'{scope_txt}.{hint}",
                           "scope": scope.to_dict(), "results": [], "citations": []})

        # Resolve patient_id for every hit in one query so the citations (and the
        # cards) link to the patient page — submissions have no page of their own.
        sub_ids = {c.submission_id for c in result.chunks}
        # Fetch patient_id AND report_date per submission in one query: the date
        # goes on each card so a submission-level table shows the REAL report date
        # — otherwise the synthesizer has no per-row date and has been observed to
        # fill the column with the query's filter window (fabricated data).
        pat_by_sub, date_by_sub = {}, {}
        if sub_ids:
            for sid, pid, rdate in db.query(
                    Submission.id, Submission.patient_id, Submission.report_date
            ).filter(Submission.id.in_(sub_ids)).all():
                pat_by_sub[sid] = pid
                date_by_sub[sid] = rdate

        # A `cards` block: each matched excerpt as a clickable card with its score.
        # The excerpt is fenced (model reads it as inert data); the stream layer
        # strips the fence for display.
        items, citations, seen = [], [], set()
        for c in result.chunks:
            pid = pat_by_sub.get(c.submission_id)
            url = f"/patients/{pid}" if pid is not None else None
            rdate = date_by_sub.get(c.submission_id)
            items.append({
                "title": c.lis_submission_id,
                "subtitle": c.report_type,
                "date": str(rdate) if rdate else None,
                "score": round(c.score, 3),
                "snippet": fence_untrusted(c.chunk_text[:600]),
                "url": url,
            })
            if c.lis_submission_id not in seen:
                seen.add(c.lis_submission_id)
                citations.append(_submission_citation(c.lis_submission_id, pid))
        return _dumps({
            "summary": f"{len(result.chunks)} report excerpt(s) retrieved{scope_txt}",
            "scope": scope.to_dict(),
            "blocks": [_excerpt_cards_block(items)],
            "citations": citations,
        })

    @tool
    def universal_search(q: str) -> str:
        """Exact-match lookup of a patient code, B-number, submission ID or probe ID.
        Each result carries both `patient_id` (internal, for URLs) and
        `patient_code` (the LIS code). To then fetch that patient's history, pass
        the result's `patient_code` to get_patient_history — never the
        `patient_id` (the two namespaces can collide and return a wrong patient)."""
        from ..routers.search import universal_search as _search
        try:
            hits = _search(q=q, db=db, _=user)
        except Exception as e:
            return _err(f"Search failed: {e}")
        citations = [{"type": h.get("type"), "id": h.get("label"),
                      "label": h.get("label"), "url": h.get("url")} for h in hits]
        return _dumps({"summary": f"{len(hits)} exact match(es) for '{q}'",
                       "results": hits, "citations": citations})

    @tool
    def get_stats(patient_code: Optional[str] = None, b_number: Optional[str] = None) -> str:
        """Aggregate statistics (patient/block counts, malignancy rate, scanned %),
        optionally narrowed by a patient code or B-number."""
        from ..routers.stats import get_stats as _stats
        try:
            data = _stats(patient_code=patient_code, b_number=b_number, db=db, _=user)
        except Exception as e:
            return _err(f"Stats failed: {e}")
        return _dumps({"summary": "Aggregate statistics", "stats": data, "citations": []})

    @tool
    def slide_info(scan_id: int) -> str:
        """Clinical metadata for one slide/scan (stain, block, probe, submission,
        patient, reports). Does not open the image file."""
        from ..routers.slides import _slide_info
        try:
            info = _slide_info(scan_id, db, include_technical=False)
        except Exception as e:
            return _err(f"Slide lookup failed: {e}")
        cites = [{"type": "scan", "id": scan_id, "label": f"scan {scan_id}", "url": f"/viewer/{scan_id}"}]
        if info.get("lis_submission_id"):
            cites.append({"type": "submission", "id": info["lis_submission_id"], "label": info["lis_submission_id"]})
        return _dumps({"summary": f"Metadata for scan {scan_id}", "info": info, "citations": cites})

    @tool
    def patient_summary(patient_id: int) -> str:
        """Return the cached longitudinal summary for a patient (if generated) plus
        their submission list. If no summary exists, use get_patient_history for
        raw structured data instead."""
        patient = db.get(Patient, patient_id)
        if not patient:
            return _err(f"Patient {patient_id} not found")
        subs = [s.lis_submission_id for s in patient.submissions]
        cite = [{"type": "patient", "id": patient.patient_code,
                 "label": patient.patient_code, "url": f"/patients/{patient_id}"}]
        return _dumps({
            "summary": (patient.summary_text or
                        "No cached summary. Use get_patient_history for structured data, "
                        "or generate_patient_summary to create one."),
            "patient_code": patient.patient_code,
            "submission_ids": subs,
            "citations": cite,
        })

    @tool
    def list_analysis_models() -> str:
        """List the available AI analysis models (the catalog)."""
        from ..routers.analysis import _load_catalog
        catalog = _load_catalog()
        return _dumps({"summary": f"{len(catalog)} analysis model(s) available",
                       "models": [{"id": m.get("id"), "name": m.get("name"),
                                   "description": m.get("description"),
                                   "result_type": m.get("result_type")} for m in catalog],
                       "citations": []})

    # ==========================================================================
    # TIER 1 — DIRECT RECORD ACCESS (no embeddings needed)
    # ==========================================================================

    @tool
    def get_report_text(submission_id: str) -> str:
        """Fetch the full macroscopy and microscopy report text for a submission.
        Use this when asked about a specific patient's report or findings.
        Does NOT require embeddings — reads directly from the database."""
        from ..models import Submission, Report
        sub = db.query(Submission).filter(
            Submission.lis_submission_id == submission_id
        ).first()
        if not sub:
            return _err(f"Submission '{submission_id}' not found")
        reports = db.query(Report).filter(Report.submission_id == sub.id).all()
        if not reports:
            return _err(f"No reports found for submission '{submission_id}'")
        result = {}
        for r in reports:
            result[r.report_type] = {
                "text": fence_untrusted(r.report_text or "(empty)"),
                "date": str(r.report_date) if r.report_date else None,
            }
        cite = [{"type": "submission", "id": submission_id,
                 "label": submission_id, "url": f"/patients/{sub.patient_id}"}]
        return _dumps({
            "summary": f"Report for {submission_id} ({', '.join(result.keys())})",
            "reports": result,
            "citations": cite,
        })

    @tool
    def get_submission_hierarchy(submission_id: str) -> str:
        """Full detail tree for one submission: probes (with topography/SNOMED),
        blocks, scans (with stain/format/magnification), and reports.
        Does NOT require embeddings."""
        from ..models import Submission, Probe, Block, Scan, Report, Stain
        from sqlalchemy.orm import joinedload
        sub = (
            db.query(Submission)
            .options(
                joinedload(Submission.reports),
                joinedload(Submission.probes)
                    .joinedload(Probe.blocks)
                    .joinedload(Block.scans)
                    .joinedload(Scan.stain),
                joinedload(Submission.patient),
            )
            .filter(Submission.lis_submission_id == submission_id)
            .first()
        )
        if not sub:
            return _err(f"Submission '{submission_id}' not found")
        pat = sub.patient
        hierarchy = {
            "submission_id": sub.lis_submission_id,
            "patient_code": pat.patient_code if pat else None,
            "patient_id": pat.id if pat else None,
            "report_date": str(sub.report_date) if sub.report_date else None,
            "malignancy": sub.malignancy_flag,
            "reports": {r.report_type: fence_untrusted((r.report_text or "")[:300])
                        for r in sub.reports},
            "probes": [],
        }
        for probe in sub.probes:
            p = {
                "probe_id": probe.lis_probe_id,
                "submission_type": probe.submission_type,
                "snomed_topo_code": probe.snomed_topo_code,
                "topo_description": probe.topo_description,
                "snomed_morph_codes": enrich_snomed_codes(db, probe.snomed_morph_codes),
                "snomed_etio_codes": enrich_snomed_codes(db, probe.snomed_etio_codes),
                "blocks": [],
            }
            for block in probe.blocks:
                b = {
                    "block_label": block.block_label,
                    "tissue_count": block.tissue_count,
                    "scans": [],
                }
                for scan in block.scans:
                    b["scans"].append({
                        "scan_id": scan.id,
                        "stain": scan.stain.stain_name if scan.stain else None,
                        "format": scan.file_format,
                        "magnification": float(scan.magnification) if scan.magnification else None,
                    })
                p["blocks"].append(b)
            hierarchy["probes"].append(p)
        cite = [{"type": "submission", "id": submission_id,
                 "label": submission_id, "url": f"/patients/{pat.id if pat else ''}"}]
        return _dumps({"summary": f"Hierarchy for {submission_id}", "hierarchy": hierarchy,
                       "citations": cite})

    @tool
    def get_patient_history(patient_code: str) -> str:
        """Raw structured history for a patient: all submissions in chronological
        order with dates, topography, morphology, etiology, malignancy flags,
        probe/block/scan counts, and report availability. Does NOT require
        embeddings and always works even when no cached summary exists.

        IMPORTANT: `patient_code` is the LIS patient code — use the
        `patient_code` field from universal_search's results, NOT the numeric
        `patient_id` and NOT a submission/B-number. patient_id and patient_code
        are different namespaces that can collide, so passing an id here can
        silently return a DIFFERENT patient."""
        pat = db.query(Patient).filter(Patient.patient_code == patient_code).first()
        if not pat:
            return _err(f"Patient '{patient_code}' not found")
        from ..models import Submission, Probe, Block, Scan, Report
        subs = (
            db.query(Submission)
            .filter(Submission.patient_id == pat.id)
            .order_by(Submission.report_date.asc().nullslast())
            .all()
        )
        entries = []

        def _code_labels(codes: list) -> list:
            """Dedupe SNOMED codes and render each as its description (falling
            back to the raw code when the master vocabulary has no description)."""
            uniq = list(dict.fromkeys(codes))
            return [e["description"] or e["code"] for e in enrich_snomed_codes(db, uniq)]

        for sub in subs:
            probes = db.query(Probe).filter(Probe.submission_id == sub.id).all()
            topo_set = set()
            morph_codes: list = []
            etio_codes: list = []
            block_count = 0
            scan_count = 0
            for probe in probes:
                if probe.topo_description:
                    topo_set.add(probe.topo_description)
                morph_codes.extend(probe.snomed_morph_codes or [])
                etio_codes.extend(probe.snomed_etio_codes or [])
                blocks = db.query(Block).filter(Block.probe_id == probe.id).all()
                block_count += len(blocks)
                for block in blocks:
                    scan_count += db.query(Scan).filter(Scan.block_id == block.id).count()
            reports = db.query(Report).filter(Report.submission_id == sub.id).all()
            report_types = [r.report_type for r in reports]
            entries.append({
                "submission_id": sub.lis_submission_id,
                "date": str(sub.report_date) if sub.report_date else None,
                "malignancy": sub.malignancy_flag,
                "topographies": list(topo_set),
                "morphologies": _code_labels(morph_codes),
                "etiologies": _code_labels(etio_codes),
                "probe_count": len(probes),
                "block_count": block_count,
                "scan_count": scan_count,
                "reports_available": report_types,
            })
        cite = [{"type": "patient", "id": patient_code,
                 "label": patient_code, "url": f"/patients/{pat.id}"}]
        return _dumps({
            "summary": f"{len(entries)} submission(s) for {patient_code}"
                       + (f" ({subs[0].report_date} to {subs[-1].report_date})"
                          if len(subs) >= 2 and subs[0].report_date and subs[-1].report_date else ""),
            "patient_id": pat.id,
            "sex": pat.sex,
            "dob": str(pat.date_of_birth) if pat.date_of_birth else None,
            "has_cached_summary": bool(pat.summary_text),
            "submissions": entries[:max_rows],
            "total": len(entries),
            "citations": cite,
        })

    @tool
    def search_reports_keyword(keyword: str, submission_id: Optional[str] = None,
                               limit: int = 20) -> str:
        """Simple keyword (text) search across pathology report text. Use this as
        a fallback when semantic_report_search is unavailable (embeddings not loaded),
        or for exact phrase matching. Does NOT require embeddings.
        Can be scoped to a single submission with submission_id."""
        from ..models import Report, Submission
        q = db.query(Report, Submission).join(
            Submission, Report.submission_id == Submission.id
        ).filter(
            Report.report_text.ilike(f"%{keyword}%")
        )
        if submission_id:
            q = q.filter(Submission.lis_submission_id == submission_id)
        q = q.limit(min(limit, max_rows))
        rows = q.all()
        # Excerpt cards (same shape as semantic_report_search) + deduped, clickable
        # submission citations. patient_id comes straight off the joined row.
        items, citations, seen = [], [], set()
        for report, sub in rows:
            text = report.report_text or ""
            lower = text.lower()
            idx = lower.find(keyword.lower())
            start = max(0, idx - 100)
            end = min(len(text), idx + len(keyword) + 100)
            excerpt = ("..." if start > 0 else "") + text[start:end] + ("..." if end < len(text) else "")
            url = f"/patients/{sub.patient_id}" if sub.patient_id is not None else None
            items.append({
                "title": sub.lis_submission_id,
                "subtitle": report.report_type,
                "snippet": fence_untrusted(excerpt),
                "url": url,
            })
            if sub.lis_submission_id not in seen:
                seen.add(sub.lis_submission_id)
                citations.append(_submission_citation(sub.lis_submission_id, sub.patient_id))
        return _dumps({
            "summary": f"{len(items)} report(s) contain '{keyword}'"
                       + (f" in {submission_id}" if submission_id else ""),
            "blocks": [_excerpt_cards_block(items)],
            "citations": citations,
        })

    # ==========================================================================
    # TIER 2 — ANALYSIS JOBS & DATA EXPLORATION (no embeddings needed)
    # ==========================================================================

    @tool
    def list_analysis_jobs(scan_id: Optional[int] = None,
                           status: Optional[str] = None,
                           model_id: Optional[str] = None,
                           limit: int = 20) -> str:
        """List AI analysis jobs, optionally filtered by scan_id, status
        (queued/running/completed/failed), or model_id."""
        from ..models import AnalysisJob, Scan
        q = db.query(AnalysisJob).order_by(AnalysisJob.created_at.desc())
        if scan_id:
            q = q.filter(AnalysisJob.scan_id == scan_id)
        if status:
            q = q.filter(AnalysisJob.status == status)
        if model_id:
            q = q.filter(AnalysisJob.model_id == model_id)
        jobs = q.limit(min(limit, max_rows)).all()
        results = []
        for j in jobs:
            results.append({
                "job_id": j.id,
                "scan_id": j.scan_id,
                "model_id": j.model_id,
                "status": j.status,
                "progress": j.progress,
                "error": j.error_message,
                "created_at": str(j.created_at) if j.created_at else None,
            })
        return _dumps({
            "summary": f"{len(results)} analysis job(s) found",
            "jobs": results,
            "citations": [],
        })

    @tool
    def get_job_result(job_id: int) -> str:
        """Read the output of a completed analysis job: status, model used,
        result path, and any error message."""
        from ..models import AnalysisJob
        job = db.get(AnalysisJob, job_id)
        if not job:
            return _err(f"Job {job_id} not found")
        cite = [{"type": "scan", "id": job.scan_id,
                 "label": f"scan {job.scan_id}", "url": f"/viewer/{job.scan_id}"}]
        return _dumps({
            "summary": f"Job {job_id}: {job.status} ({job.model_id})",
            "job_id": job.id,
            "scan_id": job.scan_id,
            "model_id": job.model_id,
            "status": job.status,
            "progress": job.progress,
            "scope": job.scope,
            "result_path": job.result_path,
            "error": job.error_message,
            "params": job.params_json,
            "created_at": str(job.created_at) if job.created_at else None,
            "citations": cite,
        })

    @tool
    def read_analysis_result(job_id: int) -> str:
        """Read and summarize the actual OUTPUT of a completed analysis job — the
        model's findings, not just its status/path. Returns interpretable results:
        lymph-node metastasis status + measurements (metassist), or tissue-class
        composition percentages (tissue segmentation). Use for "what did the
        analysis find?", "summarize this run", or comparing outputs across jobs.
        Does NOT return raw GeoJSON/overlay geometry."""
        from ..models import AnalysisJob
        job = db.get(AnalysisJob, job_id)
        if not job:
            return _err(f"Job {job_id} not found")
        if job.status != "done":
            return _err(f"Job {job_id} is '{job.status}', not done — no result to read yet.")

        result_file = _find_result_json(job, settings.analysis_results_dir)
        if result_file is None:
            return _err(f"Result file not found for job {job_id}.")
        try:
            data = json.loads(result_file.read_text(encoding="utf-8"))
        except Exception as e:
            return _err(f"Failed to read result.json for job {job_id}: {e}")

        cite = [{"type": "scan", "id": job.scan_id,
                 "label": f"scan {job.scan_id}", "url": f"/viewer/{job.scan_id}"}]

        # Batch result — a list of per-scan outcomes.
        if isinstance(data.get("scans"), list):
            scans = data["scans"]
            summaries = []
            for s in scans[:max_rows]:
                summ = _summarize_outcome(s.get("outcome"), s.get("model_id") or job.model_id)
                summ["scan_id"] = s.get("scan_id")
                summaries.append(summ)
            return _dumps({
                "summary": f"Job {job_id} ({job.model_id}): batch result over {len(scans)} scan(s).",
                "job_id": job.id, "model_id": job.model_id, "scan_count": len(scans),
                "results": summaries, "citations": cite,
            })

        summarized = _summarize_outcome(data.get("outcome"), data.get("model_id") or job.model_id)
        return _dumps({
            "summary": f"Job {job_id} ({job.model_id}) result: {summarized.get('headline', 'see details')}",
            "job_id": job.id, "scan_id": job.scan_id,
            "model_id": data.get("model_id") or job.model_id,
            "scope": data.get("scope"),
            "result": summarized,
            "total_time_s": (data.get("timing") or {}).get("total_s"),
            "citations": cite,
        })

    @tool
    def compute_cell_spatial_features(job_id: int, neighbor_radius_um: float = 30.0) -> str:
        """Compute spatial single-cell features from a completed HoVer-NeXt
        (multiclass_detection) job by reading the cell GeoJSON it produced:
        per-class counts and fractions, immune/lymphoid fractions, the
        lymphoid-to-epithelial ratio, and a tumor-infiltration metric — the
        fraction of epithelial (tumor) cells with a lymphoid cell within
        neighbor_radius_um micrometres (converted to pixels via the slide's
        level-0 mpp). Use for TIL / immune-infiltration questions that go beyond
        the counts in read_analysis_result. Returns aggregates only, never
        per-cell geometry. 30 µm ≈ a few cell diameters."""
        from pathlib import Path
        from ..models import AnalysisJob
        job = db.get(AnalysisJob, job_id)
        if not job:
            return _err(f"Job {job_id} not found")
        if job.status != "done":
            return _err(f"Job {job_id} is '{job.status}', not done.")
        rj = _find_result_json(job, settings.analysis_results_dir)
        if rj is None:
            return _err(f"Result file not found for job {job_id}.")
        try:
            data = json.loads(rj.read_text(encoding="utf-8"))
        except Exception as e:
            return _err(f"Failed to read result.json: {e}")

        gj = (data.get("files") or {}).get("download_file")
        gj_path = Path(gj) if gj else None
        if gj_path is None or not gj_path.exists():
            matches = list(rj.parent.glob("*_cells.geojson"))
            gj_path = matches[0] if matches else None
        if gj_path is None or not gj_path.exists():
            return _err(f"Cell GeoJSON not found for job {job_id}. "
                        "Is this a HoVer-NeXt detection job?")

        # GeoJSON coords are in level-0 slide pixels → convert µm radius via mpp.
        mpp = _slide_base_mpp(data.get("scan_path"))
        radius_px = (neighbor_radius_um / mpp) if mpp else None

        feats = _cell_spatial_features(str(gj_path), radius_px,
                                       max_cells=settings.agent_max_cells)
        if "error" in feats:
            return _err(feats["error"])

        if feats.get("spatial") is not None:
            feats["spatial"]["neighbor_radius_um"] = neighbor_radius_um
            feats["spatial"]["neighbor_radius_px"] = round(radius_px, 1)
            feats["spatial"]["slide_mpp_um_px"] = round(mpp, 4)
        elif mpp is None:
            feats["spatial_note"] = ("slide mpp unavailable (scan_path missing/unreadable); "
                                     "cannot convert µm→px, so the infiltration metric was skipped.")

        cite = [{"type": "scan", "id": job.scan_id,
                 "label": f"scan {job.scan_id}", "url": f"/viewer/{job.scan_id}"}]
        headline = f"{feats['total_cells']} cells, immune {feats.get('immune_fraction') or 0:.0%}"
        if feats.get("spatial"):
            headline += (f", {feats['spatial']['epithelial_infiltrated_fraction']:.0%} of epithelial "
                         f"cells infiltrated within {neighbor_radius_um:g}µm")
        approx = (feats.get("spatial") or {}).get("approximate")
        return _dumps({
            "summary": f"Job {job_id} spatial cell features — {headline}"
                       + (" (spatial metric approximate: cell cap hit)" if approx else ""),
            "job_id": job.id, "scan_id": job.scan_id,
            "features": feats, "citations": cite,
        })

    @tool
    def compute_tumor_infiltration(detection_job_id: int, segmentation_job_id: int,
                                   front_width_um: float = 250.0) -> str:
        """Combine a HoVer-NeXt cell-detection job with a CRC tissue-segmentation
        job on the SAME slide to measure immune infiltration in tumor context:
        intratumoral vs extratumoral lymphoid load, invasion-front vs
        tumor-center gradient, and an immune-exclusion ratio (<1 = lymphocytes
        excluded to the periphery). front_width_um is the invasion-margin width
        (tumor within it of the boundary is the 'front'). Use for 'are the
        lymphocytes inside the tumor or excluded?' / TIL-topology questions.
        Both jobs must be done and on the same scan. Aggregates only."""
        from pathlib import Path
        from ..models import AnalysisJob
        det = db.get(AnalysisJob, detection_job_id)
        seg = db.get(AnalysisJob, segmentation_job_id)
        if not det or not seg:
            return _err("Detection or segmentation job not found.")
        if det.status != "done" or seg.status != "done":
            return _err("Both jobs must be 'done'.")
        if det.scan_id != seg.scan_id:
            return _err(f"Jobs are on different scans ({det.scan_id} vs {seg.scan_id}); "
                        "both must be run on the same slide.")

        def _gj(job, pat):
            rj = _find_result_json(job, settings.analysis_results_dir)
            if rj is None:
                return None, None
            try:
                data = json.loads(rj.read_text(encoding="utf-8"))
            except Exception:
                return None, None
            g = (data.get("files") or {}).get("download_file")
            p = Path(g) if g else None
            if p is None or not p.exists():
                matches = list(rj.parent.glob(pat))
                p = matches[0] if matches else None
            return (p if (p and p.exists()) else None), data

        cells_gj, det_data = _gj(det, "*_cells.geojson")
        tumor_gj, _ = _gj(seg, "*.geojson")
        if cells_gj is None:
            return _err(f"Cell GeoJSON not found for detection job {detection_job_id}.")
        if tumor_gj is None:
            return _err(f"Segmentation GeoJSON not found for job {segmentation_job_id}.")

        mpp = _slide_base_mpp((det_data or {}).get("scan_path"))
        if not mpp:
            return _err("Slide mpp unavailable; cannot convert the invasion-front width to pixels.")

        tumor_mask, eff_ds = _tumor_mask_from_crc_geojson(str(tumor_gj))
        feats = _tumor_infiltration_features(str(cells_gj), tumor_mask, eff_ds, mpp,
                                             front_width_um, settings.agent_max_cells)
        if "error" in feats:
            return _err(feats["error"])

        cite = [{"type": "scan", "id": det.scan_id,
                 "label": f"scan {det.scan_id}", "url": f"/viewer/{det.scan_id}"}]
        intra, extra = feats["intratumoral"], feats["extratumoral"]
        headline = (f"intratumoral lymphoid {intra['lymphoid_fraction'] or 0:.0%} vs "
                    f"extratumoral {extra['lymphoid_fraction'] or 0:.0%}")
        return _dumps({
            "summary": f"Tumor infiltration (jobs {detection_job_id}+{segmentation_job_id}) — {headline}"
                       + (" (approximate: cell cap hit)" if feats.get("approximate") else ""),
            "detection_job_id": det.id, "segmentation_job_id": seg.id,
            "scan_id": det.scan_id, "features": feats, "citations": cite,
        })

    @tool
    def get_data_overview(group_by: str = "stain") -> str:
        """Aggregate breakdown of the database. group_by is one of:
        stain, topography, submission_type, year, format.
        Use for exploration questions like 'what stains do we have?' or
        'how many slides per year?'."""
        from ..models import Scan, Stain, Probe, Block, Submission
        from sqlalchemy import func as sqlfunc
        try:
            if group_by == "stain":
                rows = (db.query(Stain.stain_name, Stain.stain_category,
                                 sqlfunc.count(Scan.id).label("scan_count"))
                        .join(Scan, Scan.stain_id == Stain.id)
                        .group_by(Stain.stain_name, Stain.stain_category)
                        .order_by(sqlfunc.count(Scan.id).desc())
                        .limit(50).all())
                data = [{"stain": r[0], "category": r[1], "scan_count": r[2]} for r in rows]
            elif group_by == "topography":
                rows = (db.query(Probe.topo_description,
                                 sqlfunc.count(Probe.id).label("probe_count"))
                        .filter(Probe.topo_description.isnot(None))
                        .group_by(Probe.topo_description)
                        .order_by(sqlfunc.count(Probe.id).desc())
                        .limit(50).all())
                data = [{"topography": r[0], "probe_count": r[1]} for r in rows]
            elif group_by == "submission_type":
                rows = (db.query(Probe.submission_type,
                                 sqlfunc.count(Probe.id).label("count"))
                        .filter(Probe.submission_type.isnot(None))
                        .group_by(Probe.submission_type)
                        .order_by(sqlfunc.count(Probe.id).desc())
                        .all())
                data = [{"type": r[0], "count": r[1]} for r in rows]
            elif group_by == "year":
                rows = (db.query(sqlfunc.extract("year", Submission.report_date).label("year"),
                                 sqlfunc.count(Submission.id).label("count"))
                        .filter(Submission.report_date.isnot(None))
                        .group_by("year")
                        .order_by("year")
                        .all())
                data = [{"year": int(r[0]) if r[0] else None, "count": r[1]} for r in rows]
            elif group_by == "format":
                rows = (db.query(Scan.file_format,
                                 sqlfunc.count(Scan.id).label("count"))
                        .filter(Scan.file_format.isnot(None))
                        .group_by(Scan.file_format)
                        .order_by(sqlfunc.count(Scan.id).desc())
                        .all())
                data = [{"format": r[0], "count": r[1]} for r in rows]
            else:
                return _err(f"Unknown group_by '{group_by}'. Use: stain, topography, submission_type, year, format.")
            return _dumps({"summary": f"Data overview grouped by {group_by} ({len(data)} groups)",
                           "data": data, "citations": []})
        except Exception as e:
            return _err(f"Overview failed: {e}")

    @tool
    def compare_submissions(submission_ids: List[str]) -> str:
        """Side-by-side comparison of 2-5 submissions: topography, report date,
        malignancy, stains applied, scan count, and report excerpts."""
        from ..models import Submission, Probe, Block, Scan, Report, Stain
        if len(submission_ids) > 5:
            return _err("Compare at most 5 submissions at a time.")
        comparisons = []
        citations = []
        for sid in submission_ids:
            sub = db.query(Submission).filter(
                Submission.lis_submission_id == sid
            ).first()
            if not sub:
                comparisons.append({"submission_id": sid, "error": "not found"})
                continue
            probes = db.query(Probe).filter(Probe.submission_id == sub.id).all()
            topos = list({p.topo_description for p in probes if p.topo_description})
            # Collect stains
            stains = set()
            scan_count = 0
            for probe in probes:
                blocks = db.query(Block).filter(Block.probe_id == probe.id).all()
                for block in blocks:
                    scans = db.query(Scan).filter(Scan.block_id == block.id).all()
                    scan_count += len(scans)
                    for scan in scans:
                        if scan.stain:
                            st = db.query(Stain).get(scan.stain_id)
                            if st:
                                stains.add(st.stain_name)
            reports = db.query(Report).filter(Report.submission_id == sub.id).all()
            report_excerpts = {}
            for r in reports:
                report_excerpts[r.report_type] = fence_untrusted((r.report_text or "")[:200])
            comparisons.append({
                "submission_id": sid,
                "date": str(sub.report_date) if sub.report_date else None,
                "malignancy": sub.malignancy_flag,
                "topographies": topos,
                "stains": list(stains),
                "scan_count": scan_count,
                "report_excerpts": report_excerpts,
            })
            citations.append(_submission_citation(sid, sub.patient_id))
        return _dumps({"summary": f"Comparison of {len(submission_ids)} submission(s)",
                       "comparisons": comparisons, "citations": citations})

    # ==========================================================================
    # TIER 3 — PROJECTS & ANNOTATIONS (no embeddings needed)
    # ==========================================================================

    @tool
    def list_projects() -> str:
        """List annotation/analysis projects visible to the current user
        (owned or shared). Returns name, type, scan count, creation date."""
        from ..models import Project, ProjectShare, ProjectScan
        from sqlalchemy import or_
        projects = (
            db.query(Project)
            .filter(or_(
                Project.owner_id == user.id,
                Project.id.in_(
                    db.query(ProjectShare.project_id)
                    .filter(ProjectShare.shared_with_user_id == user.id)
                )
            ))
            .order_by(Project.updated_at.desc())
            .limit(max_rows)
            .all()
        )
        results = []
        for p in projects:
            scan_count = db.query(ProjectScan).filter(
                ProjectScan.project_id == p.id
            ).count()
            results.append({
                "project_id": p.id,
                "name": p.name,
                "type": p.project_type,
                "description": p.description,
                "scan_count": scan_count,
                "owner": "you" if p.owner_id == user.id else "shared",
                "created_at": str(p.created_at) if p.created_at else None,
            })
        return _dumps({"summary": f"{len(results)} project(s) visible to you",
                       "projects": results, "citations": []})

    @tool
    def get_project_summary(project_id: int) -> str:
        """Annotation statistics for a project: class distribution, total
        annotations, scan count. Works for cell_detection, region_annotation,
        and TMA projects."""
        from ..models import Project, ProjectScan, Annotation, ProjectShare
        from sqlalchemy import func as sqlfunc, or_
        proj = db.get(Project, project_id)
        if not proj:
            return _err(f"Project {project_id} not found")
        # Access check
        has_access = (
            proj.owner_id == user.id or
            db.query(ProjectShare).filter(
                ProjectShare.project_id == project_id,
                ProjectShare.shared_with_user_id == user.id
            ).first() is not None
        )
        if not has_access:
            return _err("You do not have access to this project.")
        scan_count = db.query(ProjectScan).filter(
            ProjectScan.project_id == project_id
        ).count()
        total_annotations = db.query(Annotation).filter(
            Annotation.project_id == project_id
        ).count()
        # Class distribution
        class_rows = (
            db.query(Annotation.class_name, sqlfunc.count(Annotation.id))
            .filter(Annotation.project_id == project_id)
            .group_by(Annotation.class_name)
            .all()
        )
        class_dist = {r[0] or "(unclassified)": r[1] for r in class_rows}
        return _dumps({
            "summary": f"Project '{proj.name}': {total_annotations} annotations across {scan_count} slide(s)",
            "project_id": proj.id,
            "name": proj.name,
            "type": proj.project_type,
            "classes_defined": proj.classes,
            "class_distribution": class_dist,
            "total_annotations": total_annotations,
            "scan_count": scan_count,
            "citations": [],
        })

    # ==========================================================================
    # TIER 4 — SAFE ACTIONS (confirmation-gated)
    # ==========================================================================

    @tool
    def submit_analysis_job(scan_id: int, model_id: str, scope: str = "whole_slide") -> str:
        """Submit an AI analysis job for a slide. Requires user confirmation."""
        from ..routers.analysis import submit_job
        from ..schemas import AnalysisRunRequest
        try:
            req = AnalysisRunRequest(model_id=model_id, scope=scope, params={})
            job = submit_job(req, scan_id=scan_id, db=db, user=user)
            job_id = getattr(job, "id", None)
            return _dumps({"summary": f"Submitted {model_id} on scan {scan_id} (job {job_id}, status {getattr(job,'status',None)})",
                           "job_id": job_id,
                           "citations": [{"type": "scan", "id": scan_id, "label": f"scan {scan_id}", "url": f"/viewer/{scan_id}"}]})
        except Exception as e:
            return _err(f"Could not submit job: {getattr(e, 'detail', e)}")

    @tool
    def save_cohort(name: str, description: Optional[str] = None,
                    return_level: str = "scan",
                    topo_description_search: Optional[str] = None,
                    snomed_topo_codes: Optional[List[str]] = None,
                    snomed_morph_codes: Optional[List[str]] = None,
                    morph_description_search: Optional[List[str]] = None,
                    snomed_etiology_codes: Optional[List[str]] = None,
                    etiology_description_search: Optional[List[str]] = None,
                    submission_types: Optional[List[str]] = None,
                    malignancy_flag: Optional[bool] = None,
                    submission_date_from: Optional[str] = None,
                    submission_date_to: Optional[str] = None,
                    has_scan: Optional[bool] = None,
                    stain_names: Optional[List[str]] = None,
                    stain_categories: Optional[List[str]] = None,
                    file_formats: Optional[List[str]] = None,
                    magnification_min: Optional[float] = None,
                    magnification_max: Optional[float] = None) -> str:
        """Save a query as a named cohort. Requires user confirmation.

        Takes the SAME filter arguments as query_cohort, with the same meaning —
        pass every one you passed to query_cohort. A cohort is a SAVED QUERY that
        re-runs on demand, so an argument you omit here is a filter that is gone
        for good: the cohort will silently resolve to a larger set than the one
        you counted, under a name that says otherwise."""
        from ..routers.cohorts import save_cohort as _save
        from ..schemas import CohortSave
        try:
            f = _cohort_filter(
                return_level,
                topo_description_search=topo_description_search,
                snomed_topo_codes=snomed_topo_codes,
                snomed_morph_codes=snomed_morph_codes,
                morph_description_search=morph_description_search,
                snomed_etiology_codes=snomed_etiology_codes,
                etiology_description_search=etiology_description_search,
                submission_types=submission_types,
                malignancy_flag=malignancy_flag,
                submission_date_from=submission_date_from,
                submission_date_to=submission_date_to,
                has_scan=has_scan,
                stain_names=stain_names,
                stain_categories=stain_categories,
                file_formats=file_formats,
                magnification_min=magnification_min,
                magnification_max=magnification_max,
            )
            problems = _validate_filter_values(db, f)
            if problems:
                return _dumps({
                    "summary": "Cohort NOT saved — these filter values match nothing, so "
                               "the saved cohort would not mean what its name says: "
                               + "; ".join(p["problem"] for p in problems),
                    "unresolved": problems, "citations": [],
                })
            cohort = _save(CohortSave(name=name, description=description, filter_json=f),
                           db=db, current_user=user)
            cid = getattr(cohort, "id", None)
            return _dumps({"summary": f"Saved cohort '{name}' (id {cid}, "
                                      f"{getattr(cohort,'result_count',None)} results) "
                                      f"— filter: {_describe_filter(f)}",
                           "cohort_id": cid, "filter": _describe_filter(f),
                           "citations": [{"type": "cohort", "id": cid, "label": name,
                                          "url": f"/saved-results/{cid}"}]})
        except Exception as e:
            return _err(f"Could not save cohort: {getattr(e, 'detail', e)}")

    @tool
    def generate_patient_summary(patient_id: int) -> str:
        """Trigger the AI summarizer (Ollama) to generate a longitudinal summary
        for a patient from their pathology reports. Requires user confirmation.
        The summary will be cached on the patient record for future use."""
        patient = db.get(Patient, patient_id)
        if not patient:
            return _err(f"Patient {patient_id} not found")
        from ..models import Report, Submission
        report_count = (
            db.query(Report)
            .join(Submission, Report.submission_id == Submission.id)
            .filter(Submission.patient_id == patient_id,
                    Report.report_type == "microscopy")
            .count()
        )
        if report_count == 0:
            return _err(f"No microscopy reports found for patient {patient_id}. Cannot generate summary.")
        return _dumps({
            "summary": f"Ready to generate summary for {patient.patient_code} "
                       f"({report_count} microscopy report(s)). "
                       "This will call the local LLM and may take 30-60 seconds.",
            "patient_id": patient_id,
            "patient_code": patient.patient_code,
            "report_count": report_count,
            "citations": [{"type": "patient", "id": patient.patient_code,
                           "label": patient.patient_code, "url": f"/patients/{patient_id}"}],
        })

    # ==========================================================================
    # RETURN ALL TOOLS
    # ==========================================================================

    return [
        # Tier 0
        query_cohort, lookup_filter_values, semantic_report_search, universal_search,
        get_stats, slide_info, patient_summary, list_analysis_models,
        # Knowledge grounding (glossary/docs + SNOMED vocabulary + guidelines)
        resolve_diagnosis, find_cases, lookup_snomed, search_documentation,
        guideline_search, list_guideline_elements,
        # Tier 1 — direct record access
        get_report_text, get_submission_hierarchy, get_patient_history,
        search_reports_keyword,
        # Tier 2 — analysis & exploration
        list_analysis_jobs, get_job_result, read_analysis_result,
        compute_cell_spatial_features, compute_tumor_infiltration,
        get_data_overview, compare_submissions,
        # Tier 3 — projects & annotations
        list_projects, get_project_summary,
        # Tier 4 — actions (confirmation-gated)
        submit_analysis_job, save_cohort, generate_patient_summary,
    ]