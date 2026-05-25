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

from sqlalchemy.orm import Session

from ..config import get_settings
from ..models import User, Patient

log = logging.getLogger("pathodb_agent")

ACTION_TOOL_NAMES = {"submit_analysis_job", "save_cohort"}


def _dumps(obj: dict) -> str:
    return json.dumps(obj, default=str)


def _err(msg: str) -> str:
    return _dumps({"summary": str(msg), "citations": []})


def get_tools(db: Session, user: User) -> list:
    """Build the per-request tool set. Lazily imports langchain_core."""
    from langchain_core.tools import tool

    settings = get_settings()
    max_rows = settings.agent_max_tool_rows

    # ── Read-only tools ────────────────────────────────────────────────────────

    @tool
    def query_cohort(
        return_level: str = "block",
        topo_description_search: Optional[str] = None,
        snomed_topo_codes: Optional[List[str]] = None,
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
    ) -> str:
        """Find patients/specimens/slides matching structured criteria.

        return_level is one of patient, submission, probe, block, scan.
        Dates are ISO (YYYY-MM-DD). Validate topography/stain values with
        lookup_filter_values first. Cannot express negative-stain or count
        constraints.
        """
        from ..routers.cohorts import _get_results_for_cohort
        from ..schemas import CohortFilter
        if return_level not in ("patient", "submission", "probe", "block", "scan"):
            return _err("return_level must be one of patient, submission, probe, block, scan")
        raw = dict(
            return_level=return_level,
            topo_description_search=topo_description_search,
            snomed_topo_codes=snomed_topo_codes,
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
        try:
            f = CohortFilter(**{k: v for k, v in raw.items() if v is not None})
            results, not_found = _get_results_for_cohort(f, db)
        except Exception as e:
            return _err(f"Query failed: {e}")
        sample = results[:max_rows]
        citations = []
        for r in sample:
            if r.get("scan_id"):
                citations.append({"type": "scan", "id": r["scan_id"],
                                  "label": f"scan {r['scan_id']}", "url": f"/viewer/{r['scan_id']}"})
            elif r.get("lis_submission_id"):
                citations.append({"type": "submission", "id": r["lis_submission_id"],
                                  "label": r["lis_submission_id"]})
        return _dumps({
            "summary": f"{len(results)} {return_level}(s) matched"
                       + (f"; showing first {len(sample)}" if len(results) > len(sample) else ""),
            "count": len(results),
            "return_level": return_level,
            "sample": sample,
            "not_found": not_found,
            "filter": f.model_dump(mode="json"),
            "citations": citations,
        })

    @tool
    def lookup_filter_values(field: str, q: str) -> str:
        """Look up valid values for a filter field before using query_cohort.
        field is one of snomed_topo_code, topo_description, stain_name."""
        from ..routers.stats import lookup_values
        try:
            values = lookup_values(field=field, q=q, db=db, _=user)
        except Exception as e:
            return _err(f"Lookup failed: {e}")
        return _dumps({"summary": f"{len(values)} matches for {field} ~ '{q}'",
                       "values": values, "citations": []})

    @tool
    def semantic_report_search(query: str, top_k: Optional[int] = None) -> str:
        """Semantic search over pathology report text (macro/microscopy). Use for
        free-text questions about wording/findings, e.g. 'cases mentioning
        perineural invasion'. Returns matching report excerpts with citations."""
        from .rag import retrieve
        from .embeddings import EmbeddingsUnavailable
        try:
            chunks = retrieve(db, query, top_k=top_k)
        except EmbeddingsUnavailable as e:
            return _err(f"Semantic search unavailable (embeddings not loaded): {e}")
        except Exception as e:
            return _err(f"Semantic search unavailable (RAG index not ready): {e}")
        return _dumps({
            "summary": f"{len(chunks)} report excerpt(s) retrieved",
            "results": [{"lis_submission_id": c.lis_submission_id, "report_type": c.report_type,
                         "score": round(c.score, 3), "excerpt": c.chunk_text[:600]} for c in chunks],
            "citations": [c.to_citation() for c in chunks],
        })

    @tool
    def universal_search(q: str) -> str:
        """Exact-match lookup of a patient code, B-number, submission ID or probe ID."""
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
        their submission list."""
        patient = db.get(Patient, patient_id)
        if not patient:
            return _err(f"Patient {patient_id} not found")
        subs = [s.lis_submission_id for s in patient.submissions]
        cite = [{"type": "patient", "id": patient.patient_code,
                 "label": patient.patient_code, "url": f"/patients/{patient_id}"}]
        return _dumps({
            "summary": (patient.summary_text or
                        "No cached summary yet — open the patient page to generate one."),
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

    # ── Safe actions (confirmation-gated) ───────────────────────────────────────

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
                    submission_types: Optional[List[str]] = None,
                    malignancy_flag: Optional[bool] = None,
                    submission_date_from: Optional[str] = None,
                    submission_date_to: Optional[str] = None,
                    has_scan: Optional[bool] = None,
                    stain_names: Optional[List[str]] = None,
                    stain_categories: Optional[List[str]] = None) -> str:
        """Save the current query as a named cohort. Requires user confirmation."""
        from ..routers.cohorts import save_cohort as _save
        from ..schemas import CohortSave, CohortFilter
        raw = dict(return_level=return_level, topo_description_search=topo_description_search,
                   snomed_topo_codes=snomed_topo_codes, submission_types=submission_types,
                   malignancy_flag=malignancy_flag, submission_date_from=submission_date_from,
                   submission_date_to=submission_date_to, has_scan=has_scan,
                   stain_names=stain_names, stain_categories=stain_categories)
        try:
            f = CohortFilter(**{k: v for k, v in raw.items() if v is not None})
            cohort = _save(CohortSave(name=name, description=description, filter_json=f),
                           db=db, current_user=user)
            cid = getattr(cohort, "id", None)
            return _dumps({"summary": f"Saved cohort '{name}' (id {cid}, {getattr(cohort,'result_count',None)} results)",
                           "cohort_id": cid,
                           "citations": [{"type": "cohort", "id": cid, "label": name,
                                          "url": f"/saved-results/{cid}"}]})
        except Exception as e:
            return _err(f"Could not save cohort: {getattr(e, 'detail', e)}")

    return [
        query_cohort, lookup_filter_values, semantic_report_search, universal_search,
        get_stats, slide_info, patient_summary, list_analysis_models,
        submit_analysis_job, save_cohort,
    ]
