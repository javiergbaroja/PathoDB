"""Dependency-free text/vector helpers for RAG (stdlib only, unit-testable)."""
from typing import List, Sequence


def vector_literal(vec: Sequence[float]) -> str:
    """Serialize a vector as a pgvector text literal: '[1.000000,2.500000]'."""
    return "[" + ",".join(f"{x:.6f}" for x in vec) + "]"


def chunk_report(report_text: str, max_chars: int, overlap: int) -> List[str]:
    """Paragraph-aware character chunker. Most reports fit a single chunk."""
    text_clean = (report_text or "").strip()
    if not text_clean:
        return []
    if len(text_clean) <= max_chars:
        return [text_clean]
    chunks: List[str] = []
    start = 0
    n = len(text_clean)
    step = max(1, max_chars - overlap)
    while start < n:
        end = min(start + max_chars, n)
        if end < n:
            for sep in ("\n\n", "\n", ". "):
                cut = text_clean.rfind(sep, start + step // 2, end)
                if cut != -1:
                    end = cut + len(sep)
                    break
        chunks.append(text_clean[start:end].strip())
        if end >= n:
            break
        start = max(start + step, end - overlap)
    return [c for c in chunks if c]
