"""Retrieval over report_embeddings (pgvector, cosine).

Uses parameterized raw SQL through the request's SQLAlchemy session so it shares
auth/transaction context. The query vector is passed as a text literal cast to
``vector`` — no pgvector Python adapter required at query time.
"""
import logging
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


def retrieve(
    db,
    query: str,
    top_k: Optional[int] = None,
    scope_submission_ids: Optional[Sequence[int]] = None,
) -> List[RetrievedChunk]:
    from sqlalchemy import text
    settings = get_settings()
    k = top_k or settings.rag_top_k
    qvec = vector_literal(embed_query(query))

    where = ""
    params = {"qvec": qvec, "k": k}
    if scope_submission_ids:
        where = "WHERE e.submission_id = ANY(:scope)"
        params["scope"] = list(scope_submission_ids)

    sql = text(
        f"""
        SELECT e.report_id, e.submission_id, s.lis_submission_id, r.report_type,
               e.chunk_text, 1 - (e.embedding <=> CAST(:qvec AS vector)) AS score
        FROM report_embeddings e
        JOIN reports r      ON r.id = e.report_id
        JOIN submissions s  ON s.id = e.submission_id
        {where}
        ORDER BY e.embedding <=> CAST(:qvec AS vector)
        LIMIT :k
        """
    )
    rows = db.execute(sql, params).fetchall()
    return [
        RetrievedChunk(
            report_id=row[0], submission_id=row[1], lis_submission_id=row[2],
            report_type=row[3], chunk_text=row[4], score=float(row[5]),
        )
        for row in rows
    ]


def rag_available(db) -> bool:
    """True if pgvector + the report_embeddings table are present and queryable."""
    from sqlalchemy import text
    try:
        db.execute(text("SELECT 1 FROM report_embeddings LIMIT 1"))
        return True
    except Exception:
        return False
