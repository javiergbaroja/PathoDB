"""Sentence-transformers embedding layer for report RAG.

Lazy-loaded singleton; raises EmbeddingsUnavailable (not ImportError) so callers
can degrade gracefully. Default model is 768-dim to match the report_embeddings
schema; change `embedding_model`/`embedding_dim` in config together.
"""
import logging
from typing import List

from ..config import get_settings

log = logging.getLogger("pathodb_agent")


class EmbeddingsUnavailable(RuntimeError):
    """Raised when the embedding model can't be imported or loaded."""


_model = None


def _get_model():
    global _model
    if _model is not None:
        return _model
    settings = get_settings()
    try:
        from sentence_transformers import SentenceTransformer
    except ImportError as e:  # pragma: no cover - env dependent
        raise EmbeddingsUnavailable(f"sentence-transformers not installed: {e}")
    try:
        _model = SentenceTransformer(settings.embedding_model, device=settings.embedding_device)
    except Exception as e:  # pragma: no cover - env dependent
        raise EmbeddingsUnavailable(f"failed to load embedding model '{settings.embedding_model}': {e}")
    log.info("Loaded embedding model %s on %s", settings.embedding_model, settings.embedding_device)
    return _model


def embed_texts(texts: List[str]) -> List[List[float]]:
    settings = get_settings()
    model = _get_model()
    vecs = model.encode(
        texts,
        batch_size=settings.embedding_batch_size,
        normalize_embeddings=True,          # cosine-ready
        show_progress_bar=False,
    )
    return [[float(x) for x in v] for v in vecs]


def embed_query(text: str) -> List[float]:
    return embed_texts([text])[0]


def embeddings_available() -> bool:
    try:
        _get_model()
        return True
    except EmbeddingsUnavailable:
        return False
