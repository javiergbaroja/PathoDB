"""In-process knowledge grounding over PathoDB's own docs (glossary + dev docs).

A SECOND retrieval namespace, deliberately distinct from report RAG
(api/agent/rag.py). The canonical GLOSSARY.md and project docs are small and
static, so we index them in process — split by markdown section, scored by
lexical token overlap — rather than embedding them in pgvector. That keeps doc
grounding dependency-free and ALWAYS available (even when vLLM/pgvector/the
embedder are down), and deterministic. It grounds the agent in governed
vocabulary (Scan vs slide, Cohort vs Custom list, project/TMA types, stains) so
it stops guessing domain terms.

The index is cached module-level and rebuilt automatically when a source file's
mtime changes, so editing GLOSSARY.md is picked up without a restart.
"""
import logging
import re
from pathlib import Path
from typing import List, Optional

from ..config import get_settings

log = logging.getLogger("pathodb_agent")

# api/agent/knowledge.py -> parents[2] is the project root.
_ROOT = Path(__file__).resolve().parents[2]

_WORD = re.compile(r"[a-z0-9]+")
# High-frequency words that carry little retrieval signal for short doc queries.
_STOP = {
    "the", "and", "for", "are", "with", "that", "this", "from", "into", "not",
    "what", "which", "does", "was", "were", "has", "have", "you", "your", "its",
    "a", "an", "of", "to", "in", "on", "is", "it", "as", "or", "by", "be",
    "mean", "means", "meaning", "difference", "between", "explain",
}


class KnowledgeUnavailable(RuntimeError):
    """Raised when no documentation sources can be read."""


# Cache: (index, signature). Signature is the set of (path, mtime) so any edit
# or config change invalidates it.
_INDEX = None
_SIG = None


def _doc_paths(settings) -> List[Path]:
    out = []
    for raw in (settings.knowledge_doc_paths or "").split(","):
        raw = raw.strip()
        if not raw:
            continue
        p = Path(raw)
        p = p if p.is_absolute() else _ROOT / p
        out.append(p)
    return out


def _signature(paths) -> tuple:
    sig = []
    for p in paths:
        try:
            sig.append((str(p), p.stat().st_mtime))
        except OSError:
            sig.append((str(p), None))
    return tuple(sig)


def _split_sections(text: str, rel_name: str) -> List[dict]:
    """Split a markdown doc into sections by ATX headings, tracking the heading
    stack so each section's title reads 'H1 > H2 > H3'. Preamble before the
    first heading becomes an '(intro)' section."""
    sections, stack, buf = [], [], []
    title = "(intro)"

    def flush():
        body = "\n".join(buf).strip()
        if body:
            sections.append({"file": rel_name, "heading": title, "body": body})

    for line in text.splitlines():
        m = re.match(r"^(#{1,6})\s+(.*)$", line)
        if m:
            flush()
            buf = []
            level = len(m.group(1))
            head = m.group(2).strip()
            stack[:] = stack[:level - 1]
            stack.append(head)
            title = " > ".join(stack)
        else:
            buf.append(line)
    flush()
    return sections


def _tokens(s: str) -> List[str]:
    return [t for t in _WORD.findall((s or "").lower()) if len(t) > 1 and t not in _STOP]


def _build_index(settings) -> List[dict]:
    index = []
    for p in _doc_paths(settings):
        try:
            text = p.read_text(encoding="utf-8")
        except OSError as e:
            log.warning("Knowledge source unreadable, skipping: %s (%s)", p, e)
            continue
        rel = str(p.relative_to(_ROOT)) if str(p).startswith(str(_ROOT)) else p.name
        for sec in _split_sections(text, rel):
            sec["heading_tokens"] = set(_tokens(sec["heading"]))
            # term-frequency map over the body for cheap scoring
            tf = {}
            for t in _tokens(sec["body"]):
                tf[t] = tf.get(t, 0) + 1
            sec["tf"] = tf
            index.append(sec)
    return index


def _get_index() -> List[dict]:
    global _INDEX, _SIG
    settings = get_settings()
    paths = _doc_paths(settings)
    sig = _signature(paths)
    if _INDEX is None or sig != _SIG:
        _INDEX = _build_index(settings)
        _SIG = sig
        log.info("Built knowledge index: %d section(s) from %d file(s)",
                 len(_INDEX), len(paths))
    if not _INDEX:
        raise KnowledgeUnavailable(
            f"no readable documentation sources (checked: "
            f"{', '.join(str(p) for p in paths) or 'none configured'})")
    return _INDEX


def _excerpt(body: str, q_tokens, max_chars: int) -> str:
    """A window of the body around the first query-term hit (else the head)."""
    if len(body) <= max_chars:
        return body
    low = body.lower()
    pos = -1
    for t in q_tokens:
        i = low.find(t)
        if i != -1 and (pos == -1 or i < pos):
            pos = i
    start = 0 if pos < 0 else max(0, pos - max_chars // 3)
    end = min(len(body), start + max_chars)
    snippet = body[start:end].strip()
    return ("… " if start > 0 else "") + snippet + (" …" if end < len(body) else "")


def search_docs(query: str, top_k: Optional[int] = None) -> List[dict]:
    """Rank doc sections against the query by lexical overlap. A term in a
    section heading counts far more than one in the body (headings ARE the
    concept label). Returns [{file, heading, excerpt, score}] best-first."""
    settings = get_settings()
    k = top_k or settings.knowledge_top_k
    index = _get_index()
    q_tokens = _tokens(query)
    if not q_tokens:
        return []
    q_set = set(q_tokens)
    scored = []
    for sec in index:
        body_hits = sum(sec["tf"].get(t, 0) for t in q_set)
        head_hits = len(q_set & sec["heading_tokens"])
        # distinct query terms matched anywhere — rewards coverage over repetition
        coverage = len({t for t in q_set if t in sec["tf"] or t in sec["heading_tokens"]})
        score = 5.0 * head_hits + 2.0 * coverage + 0.5 * body_hits
        if score > 0:
            scored.append((score, sec))
    scored.sort(key=lambda x: x[0], reverse=True)
    out = []
    for score, sec in scored[:k]:
        out.append({
            "file": sec["file"],
            "heading": sec["heading"],
            "excerpt": _excerpt(sec["body"], q_tokens, settings.knowledge_excerpt_chars),
            "score": float(score),
        })
    return out


def knowledge_available() -> bool:
    try:
        _get_index()
        return True
    except KnowledgeUnavailable:
        return False
