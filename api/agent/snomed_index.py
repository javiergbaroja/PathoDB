"""Semantic index over the snomed_codes table.

lookup_snomed's substring match is a dead end for conceptual / umbrella queries:
"solid tumor" appears verbatim in no code description, so ILIKE returns nothing
and the agent has no way to discover that carcinoma/adenocarcinoma/sarcoma are
what it wants. This embeds the small SNOMED vocabulary (~500 rows) once per
process with the RAG embedder (bge-m3) and retrieves codes by MEANING.

Degrades gracefully: raises EmbeddingsUnavailable when the embedder can't load,
so the caller falls back to substring-only. The index is cached module-level and
rebuilt only when the row count changes (SNOMED codes change rarely).
"""
import logging

from .embeddings import embed_texts, embed_query, EmbeddingsUnavailable  # noqa: F401

log = logging.getLogger("pathodb_agent")

_vecs = None   # np.ndarray [N, dim], L2-normalized (embed_texts normalizes)
_meta = None   # list of {code, category, description}
_count = None  # row-count signature for cheap cache invalidation


def _build(db):
    global _vecs, _meta, _count
    import numpy as np
    from ..models import SnomedCode
    rows = db.query(SnomedCode).all()
    meta = [{"code": r.code, "category": r.category,
             "description": r.description or ""} for r in rows]
    # Only embed rows that actually have a description to match against.
    texts = [m["description"] for m in meta]
    vecs = embed_texts(texts) if texts else []       # may raise EmbeddingsUnavailable
    _vecs = np.asarray(vecs, dtype="float32") if len(vecs) else np.zeros((0, 0), "float32")
    _meta = meta
    _count = len(meta)
    log.info("Built SNOMED semantic index: %d codes", _count)


def _ensure(db):
    from ..models import SnomedCode
    cnt = db.query(SnomedCode).count()
    if _vecs is None or cnt != _count:
        _build(db)


def semantic_search(db, query, category=None, top_k=10, min_score=0.35):
    """Return SNOMED codes closest in MEANING to `query`, best first:
    [{code, category, description, score}]. `min_score` drops weak neighbours
    but at least the single best match is always returned. Raises
    EmbeddingsUnavailable if the embedder can't load."""
    import numpy as np
    _ensure(db)
    if _vecs is None or _vecs.shape[0] == 0:
        return []
    q = np.asarray(embed_query(query), dtype="float32")
    sims = _vecs @ q                      # cosine (both L2-normalized)
    order = np.argsort(-sims)
    out = []
    for i in order:
        m = _meta[int(i)]
        if category and m["category"] != category:
            continue
        s = float(sims[int(i)])
        if out and s < min_score:
            break
        out.append({**m, "score": round(s, 3)})
        if len(out) >= top_k:
            break
    return out
