"""Deterministic CSV/JSON exporters for agent result sets.

A result block in the chat carries an `export` descriptor: {tool, args}. The
/assistant/export endpoint re-runs the SAME query server-side, UNCAPPED, and
streams it. Re-running the tool — rather than shipping the truncated preview rows
that were embedded in the chat — means an export can never drift from what the tool
computed, and returns the FULL set the inline preview cuts off. Only read tools
that produce enumerable rows belong in EXPORTERS.
"""
import re
from typing import Callable, List, Tuple

from sqlalchemy.orm import Session

from ..models import User


def _safe_filename(*parts: str) -> str:
    name = "_".join(p for p in parts if p)
    return re.sub(r"[^A-Za-z0-9._-]+", "_", name).strip("_") or "export"


def _one_line(text: str) -> str:
    """Collapse a report excerpt to a single line for a tabular export.

    Report text carries newlines, and csv quotes them faithfully — a valid but
    multi-line cell that makes the file hard to scan and trips naive parsers. The
    excerpt is a one-line evidence snippet here, so flatten the whitespace.
    """
    return re.sub(r"\s+", " ", text or "").strip()


def _export_find_cases(db: Session, user: User, args: dict) -> Tuple[str, List[dict]]:
    """Full submission-level rows for a find_cases query (both arms, uncapped)."""
    from .tools import _find_cases_core
    from .guardrails import strip_fence

    core = _find_cases_core(
        db,
        topography=args.get("topography"),
        morphology=args.get("morphology"),
        date_from=args.get("date_from"),
        date_to=args.get("date_to"),
        report_type=args.get("report_type") or "microscopy",
        text_term=args.get("text_term"),
        max_rows=None,   # uncapped — the whole point of an export
    )
    if not core.get("ok"):
        raise ValueError(core.get("error", "find_cases could not run for export."))

    rows: List[dict] = []
    for r in core["coded_list"]:
        rows.append({"submission_id": r["submission_id"], "report_date": r["date"],
                     "evidence": r["evidence"], "likely_negated": "",
                     "ambiguous_site": "", "topographies": "", "excerpt": ""})
    for r in core["text_list"]:
        rows.append({"submission_id": r["submission_id"], "report_date": r["date"],
                     "evidence": r["evidence"],
                     "likely_negated": "yes" if r.get("likely_negated") else "",
                     "ambiguous_site": "yes" if r.get("ambiguous_site") else "",
                     "topographies": "; ".join(r.get("topographies") or []),
                     # strip_fence is a no-op on the core's already-raw excerpt, but
                     # guards against a future fenced source leaking markers to CSV.
                     "excerpt": _one_line(strip_fence(r.get("excerpt") or ""))})

    label = args.get("text_term") or args.get("morphology") or "cases"
    return _safe_filename("find_cases", args.get("topography", ""), label), rows


# tool name -> exporter(db, user, args) -> (filename_stem, rows)
EXPORTERS: dict[str, Callable[[Session, User, dict], Tuple[str, List[dict]]]] = {
    "find_cases": _export_find_cases,
}
