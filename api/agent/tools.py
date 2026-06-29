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
from ..routers import enrich_snomed_codes

log = logging.getLogger("pathodb_agent")

ACTION_TOOL_NAMES = {"submit_analysis_job", "save_cohort", "generate_patient_summary"}


def _dumps(obj: dict) -> str:
    return json.dumps(obj, default=str)


def _err(msg: str) -> str:
    return _dumps({"summary": str(msg), "citations": []})


def get_tools(db: Session, user: User) -> list:
    """Build the per-request tool set. Lazily imports langchain_core."""
    from langchain_core.tools import tool

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
        morph_description_search: Optional[str] = None,
        snomed_etiology_codes: Optional[List[str]] = None,
        etiology_description_search: Optional[str] = None,
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
    ) -> str:
        """...
        return_level is one of patient, submission, probe, block, scan.
        Dates are ISO (YYYY-MM-DD). Validate topography/morphology/etiology/stain
        values with lookup_filter_values first. Cannot express negative-stain or
        count constraints.
        """
        from ..routers.cohorts import _run_cohort_query
        from ..schemas import CohortFilter
        raw = dict(
            return_level=return_level,
            topo_description_search=topo_description_search,
            snomed_topo_codes=snomed_topo_codes,
            snomed_morph_codes=snomed_morph_codes,
            morph_description_search=[morph_description_search] if morph_description_search else None,
            snomed_etiology_codes=snomed_etiology_codes,
            etiology_description_search=[etiology_description_search] if etiology_description_search else None,
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
            rows = _run_cohort_query(f, db)
            total = len(rows)
            sample = rows[:max_rows]
            return _dumps({
                "summary": f"{total} result(s) at {return_level} level"
                           + (f" (showing first {max_rows})" if total > max_rows else ""),
                "total": total, "results": sample, "citations": [],
            })
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
    def semantic_report_search(query: str, top_k: Optional[int] = None) -> str:
        """Semantic search over pathology report text (macro/microscopy). Use for
        free-text questions about wording/findings, e.g. 'cases mentioning
        perineural invasion'. Returns matching report excerpts with citations.
        Falls back gracefully if embeddings are not loaded — in that case,
        use search_reports_keyword instead."""
        from .rag import retrieve
        from .embeddings import EmbeddingsUnavailable
        try:
            chunks = retrieve(db, query, top_k=top_k)
        except EmbeddingsUnavailable as e:
            return _err(f"Semantic search unavailable (embeddings not loaded): {e}. "
                        "Try search_reports_keyword as a fallback.")
        except Exception as e:
            return _err(f"Semantic search unavailable (RAG index not ready): {e}. "
                        "Try search_reports_keyword as a fallback.")
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
                "text": r.report_text or "(empty)",
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
            "reports": {r.report_type: (r.report_text or "")[:300] for r in sub.reports},
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
        order with dates, topography, malignancy flags, probe/block/scan counts,
        and report availability. Does NOT require embeddings and always works
        even when no cached summary exists."""
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
        for sub in subs:
            probes = db.query(Probe).filter(Probe.submission_id == sub.id).all()
            topo_set = set()
            block_count = 0
            scan_count = 0
            for probe in probes:
                if probe.topo_description:
                    topo_set.add(probe.topo_description)
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
        from sqlalchemy import or_
        q = db.query(Report, Submission).join(
            Submission, Report.submission_id == Submission.id
        ).filter(
            Report.report_text.ilike(f"%{keyword}%")
        )
        if submission_id:
            q = q.filter(Submission.lis_submission_id == submission_id)
        q = q.limit(min(limit, max_rows))
        rows = q.all()
        results = []
        for report, sub in rows:
            text = report.report_text or ""
            # Extract a window around the keyword match
            lower = text.lower()
            idx = lower.find(keyword.lower())
            start = max(0, idx - 100)
            end = min(len(text), idx + len(keyword) + 100)
            excerpt = ("..." if start > 0 else "") + text[start:end] + ("..." if end < len(text) else "")
            results.append({
                "submission_id": sub.lis_submission_id,
                "report_type": report.report_type,
                "excerpt": excerpt,
            })
        citations = [{"type": "submission", "id": r["submission_id"],
                      "label": r["submission_id"]} for r in results]
        # Deduplicate citations
        seen = set()
        unique_citations = []
        for c in citations:
            if c["id"] not in seen:
                seen.add(c["id"])
                unique_citations.append(c)
        return _dumps({
            "summary": f"{len(results)} report(s) contain '{keyword}'"
                       + (f" in {submission_id}" if submission_id else ""),
            "results": results,
            "citations": unique_citations,
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
                report_excerpts[r.report_type] = (r.report_text or "")[:200]
            comparisons.append({
                "submission_id": sid,
                "date": str(sub.report_date) if sub.report_date else None,
                "malignancy": sub.malignancy_flag,
                "topographies": topos,
                "stains": list(stains),
                "scan_count": scan_count,
                "report_excerpts": report_excerpts,
            })
            citations.append({"type": "submission", "id": sid, "label": sid})
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
        # Tier 1 — direct record access
        get_report_text, get_submission_hierarchy, get_patient_history,
        search_reports_keyword,
        # Tier 2 — analysis & exploration
        list_analysis_jobs, get_job_result, get_data_overview, compare_submissions,
        # Tier 3 — projects & annotations
        list_projects, get_project_summary,
        # Tier 4 — actions (confirmation-gated)
        submit_analysis_job, save_cohort, generate_patient_summary,
    ]