"""Retrieval over guideline_chunks — hybrid dense + lexical, optional rerank.

A THIRD retrieval namespace (audit #5), parallel to report RAG (api/agent/rag.py)
and doc/glossary knowledge (api/agent/knowledge.py). Deliberately a separate
module so report retrieval stays untouched; it REUSES rag.py's fusion + FTS-config
whitelist and the shared embedder/reranker, differing only in the SQL (the
guideline_chunks table + an optional organ filter) and the returned metadata
(source_org / title / version / section for citation).

Same graceful degradation as rag.retrieve: embeddings down → lexical-only;
reranker absent/failed → fused order; no rows → [].
"""
import logging
from dataclasses import dataclass, asdict
from typing import List, Optional

from ..config import get_settings
from .embeddings import embed_query          # may raise EmbeddingsUnavailable
from .textutil import vector_literal
from .rag import _rrf_fuse, _CFG_RE           # reuse fusion + FTS-config whitelist

log = logging.getLogger("pathodb_agent")


@dataclass
class GuidelineChunk:
    id: int
    source_org: str
    doc_slug: str
    title: str
    organ: str
    specimen_type: Optional[str]
    version: str
    section: str
    chunk_text: str
    score: float

    def label(self) -> str:
        bits = [self.source_org, self.organ or self.title or self.doc_slug]
        if self.version:
            bits.append(self.version)
        head = " ".join(b for b in bits if b)
        return f"{head} — {self.section}" if self.section else head

    def to_citation(self) -> dict:
        return {"type": "guideline", "id": self.doc_slug, "label": self.label()}

    def to_dict(self) -> dict:
        return asdict(self)


# Columns every arm selects, in order, so a row maps straight onto a candidate.
_COLS = ("g.id, g.source_org, g.doc_slug, g.title, g.organ, g.specimen_type, "
         "g.version, g.section, g.chunk_text")


def _organ_clause(organ):
    """Optional soft organ filter (ILIKE over organ + title). Returns (sql, params)."""
    if not organ:
        return "", {}
    return ("AND (g.organ ILIKE :organ OR g.title ILIKE :organ)",
            {"organ": f"%{organ.strip()}%"})


def _dense_arm(db, qvec, pool, organ):
    from sqlalchemy import text
    oc, op = _organ_clause(organ)
    params = {"qvec": qvec, "pool": pool, **op}
    sql = text(f"""
        SELECT {_COLS}
        FROM guideline_chunks g
        WHERE g.embedding IS NOT NULL {oc}
        ORDER BY g.embedding <=> CAST(:qvec AS vector)
        LIMIT :pool
    """)
    return db.execute(sql, params).fetchall()


def _lexical_arm(db, query, pool, organ, cfg):
    """Postgres full-text arm (websearch_to_tsquery + ts_rank_cd). Returns [] (not
    an error) when FTS is unusable or matchless."""
    from sqlalchemy import text
    if not _CFG_RE.match(cfg):
        log.warning("Invalid rag_fts_config %r; skipping guideline lexical arm", cfg)
        return []
    oc, op = _organ_clause(organ)
    params = {"q": query, "pool": pool, **op}
    # cfg is whitelisted → safe to inline as an immutable literal (keeps the GIN
    # index eligible; must match db/schema.sql idx_guideline_chunks_fts).
    sql = text(f"""
        SELECT {_COLS}
        FROM guideline_chunks g,
             websearch_to_tsquery('{cfg}', :q) AS q
        WHERE to_tsvector('{cfg}', g.chunk_text) @@ q {oc}
        ORDER BY ts_rank_cd(to_tsvector('{cfg}', g.chunk_text), q) DESC
        LIMIT :pool
    """)
    try:
        return db.execute(sql, params).fetchall()
    except Exception as e:
        log.warning("Guideline lexical arm unavailable, using dense only: %s", e)
        db.rollback()
        return []


def _to_chunk(row, score) -> GuidelineChunk:
    return GuidelineChunk(
        id=row[0], source_org=row[1], doc_slug=row[2], title=row[3], organ=row[4],
        specimen_type=row[5], version=row[6], section=row[7], chunk_text=row[8],
        score=float(score),
    )


def retrieve(db, query: str, top_k: Optional[int] = None,
             organ: Optional[str] = None) -> List[GuidelineChunk]:
    """Hybrid retrieve over the guideline corpus. `organ` softly narrows to a
    body site (ILIKE). Raises EmbeddingsUnavailable only if the embedder can't
    load AND the lexical arm can't stand in."""
    settings = get_settings()
    k = top_k or settings.guideline_top_k

    # ── Dense-only (legacy path) ─────────────────────────────────────────────
    if not settings.rag_hybrid:
        from sqlalchemy import text
        qvec = vector_literal(embed_query(query))
        oc, op = _organ_clause(organ)
        sql = text(f"""
            SELECT {_COLS}, 1 - (g.embedding <=> CAST(:qvec AS vector)) AS sim
            FROM guideline_chunks g
            WHERE g.embedding IS NOT NULL {oc}
            ORDER BY g.embedding <=> CAST(:qvec AS vector)
            LIMIT :k
        """)
        rows = db.execute(sql, {"qvec": qvec, "k": k, **op}).fetchall()
        return [_to_chunk(r, r[9]) for r in rows]

    # ── Hybrid: fuse dense + lexical over a wider candidate pool ──────────────
    pool = max(settings.rag_candidate_pool, k)
    try:
        qvec = vector_literal(embed_query(query))
        dense = _dense_arm(db, qvec, pool, organ)
    except Exception as e:
        # Embedder down → lexical-only rather than failing the whole search.
        log.warning("Guideline dense arm unavailable, using lexical only: %s", e)
        dense = []
    lexical = _lexical_arm(db, query, pool, organ, settings.rag_fts_config)
    fused = _rrf_fuse([dense, lexical], settings.rag_rrf_k)
    if not fused:
        return []

    # ── Optional cross-encoder rerank over the fused pool ─────────────────────
    if settings.rag_reranker_model:
        try:
            from .reranker import rerank_order, RerankerUnavailable
            candidates = fused[:pool]
            order = rerank_order(query, [row[8] for row, _ in candidates])
            return [_to_chunk(candidates[i][0], sc) for i, sc in order[:k]]
        except RerankerUnavailable as e:
            log.warning("Reranker unavailable, using fused order: %s", e)
        except Exception as e:
            log.warning("Reranker failed, using fused order: %s", e)

    return [_to_chunk(row, sc) for row, sc in fused[:k]]


def list_elements(db, cancer_type: str, source_org: Optional[str] = None,
                  max_docs: int = 2):
    """Enumerate reporting ELEMENTS for the guideline document(s) matching
    `cancer_type` — a structured, COMPLETE listing (unlike `retrieve`'s semantic
    top-k, which can't enumerate ~25 elements and surfaces boilerplate).

    Robust to the CAP/ICCR organ-naming mismatch (e.g. CAP labels colorectal as
    'Primary Carcinoma of the Colon and / or Rectum'): retrieval identifies the
    right document(s), then we list their ``kind='element'`` sections straight from
    the DB in document order, with derived core status. Returns
    [{doc_slug, source_org, title, organ, version, elements:[{category,name,core}]}].
    """
    from sqlalchemy import text
    from .guideline_meta import element_core_status

    # 1. Identify the document(s) via retrieval (the docs the top hits belong to).
    try:
        hits = retrieve(db, cancer_type, top_k=8)
    except Exception as e:
        log.warning("Guideline element listing: retrieval failed: %s", e)
        hits = []
    slugs = []
    for h in hits:
        if h.doc_slug not in slugs:
            slugs.append(h.doc_slug)
    if source_org:
        so = source_org.strip().lower()
        slugs = [s for s in slugs if s.startswith(so + ":")]

    out = []
    for slug in slugs[:max_docs]:
        rows = db.execute(text("""
            SELECT DISTINCT ON (section)
                   section, chunk_text, source_org, title, organ, version, chunk_index
            FROM guideline_chunks
            WHERE doc_slug = :slug AND kind = 'element' AND section <> ''
            ORDER BY section, chunk_index
        """), {"slug": slug}).fetchall()
        if not rows:
            continue
        rows = sorted(rows, key=lambda r: r[6])          # document order
        so, title, organ, ver = rows[0][2], rows[0][3], rows[0][4], rows[0][5]
        is_cap = (so or "").upper() == "CAP"
        elements = []
        for section, chunk_text, *_rest in rows:
            category, name = section.split(" — ", 1) if " — " in section else (None, section)
            # CAP elements sit under an ALL-CAPS category (have ' — '); a bare
            # category header or template preamble (no ' — ') is not an element.
            if is_cap and category is None:
                continue
            elements.append({"category": category, "name": name.strip(),
                             "core": element_core_status(so, section, chunk_text)})
        if elements:
            out.append({"doc_slug": slug, "source_org": so, "title": title,
                        "organ": organ, "version": ver, "elements": elements})
    return out


def guideline_available(db) -> bool:
    """True if the guideline_chunks table is present, queryable and non-empty."""
    from sqlalchemy import text
    try:
        return bool(db.execute(text("SELECT 1 FROM guideline_chunks LIMIT 1")).first())
    except Exception:
        return False
