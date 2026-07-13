"""Retrieval over report_embeddings — hybrid dense + lexical, optional rerank.

Uses parameterized raw SQL through the request's SQLAlchemy session so it shares
auth/transaction context. The query vector is passed as a text literal cast to
``vector`` — no pgvector Python adapter required at query time.

Pipeline (rag_hybrid on):
    dense arm  (pgvector cosine, HNSW)  ┐
                                        ├─ Reciprocal Rank Fusion ─┐
    lexical arm (Postgres FTS, tsvector)┘                          │
                                                                   ├─ [rerank] → top_k
                                        (optional cross-encoder) ──┘
Dense catches paraphrase/semantics; lexical catches exact rare tokens (drug
names, mutation strings, codes) that a bi-encoder blurs. RRF fuses both ranked
lists without score normalization and degrades to whichever arm returned rows.
With rag_hybrid off it is the original dense-only cosine search.
"""
import logging
import re
from dataclasses import dataclass, asdict
from typing import List, Optional, Sequence

from ..config import get_settings
from .embeddings import embed_query  # may raise EmbeddingsUnavailable
from .textutil import vector_literal, chunk_report  # re-exported for callers/tests

log = logging.getLogger("pathodb_agent")

# Backwards-compatible alias.
_vector_literal = vector_literal


@dataclass
class RetrievedChunk:
    report_id: int
    submission_id: int
    lis_submission_id: str
    report_type: str
    chunk_text: str
    score: float

    def to_citation(self) -> dict:
        return {
            "type": "submission",
            "id": self.lis_submission_id,
            "label": f"{self.lis_submission_id} ({self.report_type})",
            "report_id": self.report_id,
        }

    def to_dict(self) -> dict:
        return asdict(self)


# Columns every arm selects, in order, so a row maps straight onto a candidate.
_COLS = ("e.id, e.report_id, e.submission_id, s.lis_submission_id, "
         "r.report_type, e.chunk_text")


def _dense_arm(db, qvec, pool, scope):
    from sqlalchemy import text
    where = "WHERE e.submission_id = ANY(:scope)" if scope else ""
    params = {"qvec": qvec, "pool": pool}
    if scope:
        params["scope"] = list(scope)
    sql = text(
        f"""
        SELECT {_COLS}
        FROM report_embeddings e
        JOIN reports r      ON r.id = e.report_id
        JOIN submissions s  ON s.id = e.submission_id
        {where}
        ORDER BY e.embedding <=> CAST(:qvec AS vector)
        LIMIT :pool
        """
    )
    return db.execute(sql, params).fetchall()


# Whitelist for the tsvector config so it can be safely inlined as an SQL
# literal. A *literal* regconfig keeps to_tsvector(...) immutable, which is what
# lets the planner use the GIN expression index — a bound parameter would not.
_CFG_RE = re.compile(r"^[a-z_][a-z0-9_]*$")


def _lexical_arm(db, query, pool, scope, cfg):
    """Postgres full-text arm. Uses websearch_to_tsquery so operators like
    quotes and OR in the user's phrasing work; ts_rank_cd rewards term density
    and proximity. Returns [] (not an error) when FTS is unusable or matchless."""
    from sqlalchemy import text
    if not _CFG_RE.match(cfg):
        log.warning("Invalid rag_fts_config %r; skipping lexical arm", cfg)
        return []
    scope_and = "AND e.submission_id = ANY(:scope)" if scope else ""
    params = {"q": query, "pool": pool}
    if scope:
        params["scope"] = list(scope)
    # cfg is whitelisted above, so inlining it as a literal is injection-safe and
    # keeps the to_tsvector expression index-eligible (must match the index's
    # constant config exactly — see db/schema.sql idx_report_embeddings_fts).
    sql = text(
        f"""
        SELECT {_COLS}
        FROM report_embeddings e
        JOIN reports r      ON r.id = e.report_id
        JOIN submissions s  ON s.id = e.submission_id,
             websearch_to_tsquery('{cfg}', :q) AS q
        WHERE to_tsvector('{cfg}', e.chunk_text) @@ q
              {scope_and}
        ORDER BY ts_rank_cd(to_tsvector('{cfg}', e.chunk_text), q) DESC
        LIMIT :pool
        """
    )
    try:
        return db.execute(sql, params).fetchall()
    except Exception as e:
        # Missing FTS index or bad tsquery → fall back to dense-only silently.
        log.warning("Lexical retrieval arm unavailable, using dense only: %s", e)
        db.rollback()
        return []


def _rrf_fuse(arms, rrf_k):
    """Reciprocal Rank Fusion. `arms` is a list of ranked row lists; a row's
    fused score is Σ 1/(rrf_k + rank) over the arms it appears in (rank 1-based).
    Keyed on the chunk PK (row[0]) so the same chunk found by both arms adds up.
    Returns (row, fused_score) best-first."""
    scores, rows = {}, {}
    for arm in arms:
        for rank, row in enumerate(arm, start=1):
            pk = row[0]
            scores[pk] = scores.get(pk, 0.0) + 1.0 / (rrf_k + rank)
            rows.setdefault(pk, row)
    ranked = sorted(scores.items(), key=lambda kv: kv[1], reverse=True)
    return [(rows[pk], sc) for pk, sc in ranked]


def _to_chunk(row, score):
    return RetrievedChunk(
        report_id=row[1], submission_id=row[2], lis_submission_id=row[3],
        report_type=row[4], chunk_text=row[5], score=float(score),
    )


def retrieve(
    db,
    query: str,
    top_k: Optional[int] = None,
    scope_submission_ids: Optional[Sequence[int]] = None,
) -> List[RetrievedChunk]:
    settings = get_settings()
    k = top_k or settings.rag_top_k
    scope = list(scope_submission_ids) if scope_submission_ids else None
    qvec = vector_literal(embed_query(query))

    # ── Dense-only (legacy path) ─────────────────────────────────────────────
    if not settings.rag_hybrid:
        # score = cosine similarity for interpretability in the dense-only path.
        from sqlalchemy import text
        where = "WHERE e.submission_id = ANY(:scope)" if scope else ""
        params = {"qvec": qvec, "k": k}
        if scope:
            params["scope"] = scope
        sql = text(
            f"""
            SELECT {_COLS}, 1 - (e.embedding <=> CAST(:qvec AS vector)) AS sim
            FROM report_embeddings e
            JOIN reports r      ON r.id = e.report_id
            JOIN submissions s  ON s.id = e.submission_id
            {where}
            ORDER BY e.embedding <=> CAST(:qvec AS vector)
            LIMIT :k
            """
        )
        rows = db.execute(sql, params).fetchall()
        return [_to_chunk(r, r[6]) for r in rows]

    # ── Hybrid: fuse dense + lexical over a wider candidate pool ──────────────
    pool = max(settings.rag_candidate_pool, k)
    dense = _dense_arm(db, qvec, pool, scope)
    lexical = _lexical_arm(db, query, pool, scope, settings.rag_fts_config)
    fused = _rrf_fuse([dense, lexical], settings.rag_rrf_k)
    if not fused:
        return []

    # ── Optional cross-encoder rerank over the fused pool ─────────────────────
    if settings.rag_reranker_model:
        try:
            from .reranker import rerank_order, RerankerUnavailable
            candidates = fused[:pool]
            order = rerank_order(query, [row[5] for row, _ in candidates])
            return [_to_chunk(candidates[i][0], sc) for i, sc in order[:k]]
        except RerankerUnavailable as e:
            log.warning("Reranker unavailable, using fused order: %s", e)
        except Exception as e:
            log.warning("Reranker failed, using fused order: %s", e)

    return [_to_chunk(row, sc) for row, sc in fused[:k]]


def rag_available(db) -> bool:
    """True if pgvector + the report_embeddings table are present and queryable."""
    from sqlalchemy import text
    try:
        db.execute(text("SELECT 1 FROM report_embeddings LIMIT 1"))
        return True
    except Exception:
        return False
