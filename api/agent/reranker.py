"""Optional cross-encoder reranker for report RAG.

A bi-encoder (bge-m3) retrieves fast but scores query/doc independently; a
cross-encoder reads the (query, chunk) pair jointly and scores relevance far
more precisely — at the cost of one forward pass per candidate. So we only run
it over the small fused candidate pool, never the whole corpus.

Lazy-loaded singleton mirroring embeddings.py: raises RerankerUnavailable (not
ImportError) so retrieval degrades to the fused order when the model is absent.
Disabled entirely when `rag_reranker_model` is empty.
"""
import logging
from typing import List, Sequence, Tuple

from ..config import get_settings

log = logging.getLogger("pathodb_agent")


class RerankerUnavailable(RuntimeError):
    """Raised when reranking is disabled or the model can't be loaded."""


_model = None


def reranker_enabled() -> bool:
    return bool(get_settings().rag_reranker_model)


def _get_model():
    global _model
    if _model is not None:
        return _model
    settings = get_settings()
    if not settings.rag_reranker_model:
        raise RerankerUnavailable("rag_reranker_model is empty (reranking disabled)")
    try:
        from sentence_transformers import CrossEncoder
    except ImportError as e:  # pragma: no cover - env dependent
        raise RerankerUnavailable(f"sentence-transformers not installed: {e}")
    try:
        _model = CrossEncoder(settings.rag_reranker_model,
                              device=settings.rag_reranker_device,
                              max_length=settings.embedding_max_seq_length or 512)
    except Exception as e:  # pragma: no cover - env dependent
        raise RerankerUnavailable(
            f"failed to load reranker '{settings.rag_reranker_model}': {e}")
    log.info("Loaded reranker %s on %s", settings.rag_reranker_model,
             settings.rag_reranker_device)
    return _model


def rerank(query: str, docs: Sequence[str]) -> List[float]:
    """Return a relevance score per doc (higher = more relevant). Raises
    RerankerUnavailable if the model is disabled or fails to load."""
    if not docs:
        return []
    model = _get_model()
    settings = get_settings()
    pairs = [(query, d or "") for d in docs]
    scores = model.predict(pairs, batch_size=settings.rag_reranker_batch_size,
                           show_progress_bar=False)
    return [float(s) for s in scores]


def rerank_order(query: str, docs: Sequence[str]) -> List[Tuple[int, float]]:
    """Rerank and return (original_index, score) pairs, best first."""
    scores = rerank(query, docs)
    order = sorted(range(len(scores)), key=lambda i: scores[i], reverse=True)
    return [(i, scores[i]) for i in order]


def reranker_available() -> bool:
    try:
        _get_model()
        return True
    except RerankerUnavailable:
        return False
