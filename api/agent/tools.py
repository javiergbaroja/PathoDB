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
# NOTE: enrich_snomed_codes is imported lazily inside get_tools() rather than at
# module load. It lives in api.routers.patients, and api.routers.__init__ eagerly
# imports the assistant router -> agent.graph -> this module; a top-level import
# here would form a circular import whenever the agent is imported before the
# routers package is fully initialized (e.g. the eval harness, scripts, tests).

log = logging.getLogger("pathodb_agent")

ACTION_TOOL_NAMES = {"submit_analysis_job", "save_cohort", "generate_patient_summary"}


def _dumps(obj: dict) -> str:
    return json.dumps(obj, default=str)


def _err(msg: str) -> str:
    return _dumps({"summary": str(msg), "citations": []})


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
        sort: Optional[str] = None,
    ) -> str:
        """...
        return_level is one of patient, submission, probe, block, scan.
        Dates are ISO (YYYY-MM-DD). Validate topography/morphology/etiology/stain
        values with lookup_filter_values first. Cannot express negative-stain or
        count constraints.
        `sort`: 'recent' orders results by report_date (newest first), 'oldest'
        (newest last). Combine with max_rows to answer 'the N most recent …'.
        """
        from ..routers.cohorts import _get_results_for_cohort
        from ..schemas import CohortFilter
        raw = dict(
            return_level=return_level,
            topo_description_search=topo_description_search,
            snomed_topo_codes=snomed_topo_codes,
            snomed_morph_codes=snomed_morph_codes,
            morph_description_search=[morph_description_search] if morph_description_search else None,
            # CohortFilter's fields are snomed_etio_codes / etio_description_search;
            # the tool params keep the 'etiology' spelling (matching lookup_filter_values),
            # so map them here — otherwise pydantic (extra='ignore') silently drops them.
            snomed_etio_codes=snomed_etiology_codes,
            etio_description_search=[etiology_description_search] if etiology_description_search else None,
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
            sample = []
            for r in rows[:max_rows]:
                row = {k: v for k, v in r.items()
                       if k not in ("report_macro", "report_microscopy")}
                row["has_report"] = bool(r.get("report_macro") or r.get("report_microscopy"))
                sample.append(row)
            return _dumps({
                "summary": f"{total} result(s) at {return_level} level{ordered}"
                           + (f" (showing {max_rows})" if total > max_rows else ""),
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
    def lookup_snomed(query: str, category: Optional[str] = None) -> str:
        """Resolve the SNOMED codes PathoDB uses. Give a CODE (e.g. 'M-81403') to
        get its meaning, or a TERM to find matching codes. The term can be a
        precise entity ('adenocarcinoma') OR a broad/umbrella concept ('solid
        tumor', 'inflammation'): exact substring matches are returned as
        match='exact', and codes that are semantically RELATED (by meaning, not
        wording) as match='related'. So an umbrella query like 'solid tumor'
        surfaces carcinoma/adenocarcinoma/sarcoma even though no description
        contains that phrase. Optional `category` limits to 'morphology',
        'etiology', or 'topography'. Distinct from lookup_filter_values, which
        autocompletes filter values for building a query_cohort filter."""
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
                         "excerpt": h["excerpt"]} for h in hits],
            "citations": [{"type": "doc", "id": h["file"],
                           "label": f'{h["file"]} — {h["heading"]}'} for h in hits],
        })

    @tool
    def semantic_report_search(query: str, top_k: Optional[int] = None) -> str:
        """Hybrid search over pathology report text (macro/microscopy): combines
        dense semantic (meaning/paraphrase) with lexical full-text (exact rare
        terms — drug names, mutations, codes) and fuses them, then optionally
        reranks. Use for free-text questions about wording/findings, e.g. 'cases
        mentioning perineural invasion'. Returns matching report excerpts with
        citations. Falls back gracefully if embeddings are not loaded — in that
        case, use search_reports_keyword instead."""
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
        # Knowledge grounding (glossary/docs + SNOMED vocabulary)
        lookup_snomed, search_documentation,
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