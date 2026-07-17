"""Retrieval over report_embeddings — metadata pre-filter, hybrid dense + lexical, optional rerank.

Uses parameterized raw SQL through the request's SQLAlchemy session so it shares
auth/transaction context. The query vector is passed as a text literal cast to
``vector`` — no pgvector Python adapter required at query time.

Pipeline (rag_hybrid on):

    ReportFilter ─► scope ─┬─ dense  arm (pgvector cosine, HNSW) ─┐
      (date/patient/       │                                      ├─ RRF ─┬─ [rerank] → top_k
       topography/…)       └─ lexical arm (Postgres FTS)  ────────┘       │
                                             (optional cross-encoder) ────┘

PRE-FILTERING ("zoom in"). Searching ~2.5M chunks is both imprecise and slow when
the question only concerns a slice of the corpus. ReportFilter narrows it FIRST,
against the `rag_meta` side table — one narrow row per report carrying
report_date / report_type / patient_id / malignancy_flag / topography (see
db/rag_prefilter_migration.sql, which also explains why it is a side table and not
columns on report_embeddings: populating those would UPDATE 2.55M rows, and MVCC
would force a rebuild of the 17 GB HNSW index even though no vector changes).

TWO STRATEGIES, chosen by how many chunks the filter matches:

  * EXACT (scope <= rag_exact_scan_max_chunks) — materialize the scope, then scan
    just those chunks. 100% recall and FASTER than ANN at this size, because the
    planner BitmapAnds the rag_meta indexes and never touches HNSW. Measured:
    colon + 2024 + microscopy = 12,025 chunks in 144 ms (vs 15 ms unfiltered over
    everything, and 4.0 s for the old submission-id-array path).
  * BROAD (scope > threshold) — an exact scan of hundreds of thousands of chunks
    would take many seconds, so take an ANN pool widened by corpus/scope and
    post-filter it. Approximate, but a scope that large is a big enough share of
    the corpus that the pool still fills.

The scope is sized by counting `rag_meta` alone — no join — which is accurate
because the corpus is ~1 chunk per report (2,554,043 of 2,554,052 chunks are
chunk_index 0), and cheap because it is index-only and LIMIT-bounded.

Both retrieval arms get the same filter; applying it to only one would let the
other leak out-of-scope chunks into the fused result.

Dense catches paraphrase/semantics; lexical catches exact rare tokens (drug names,
mutation strings, codes) that a bi-encoder blurs. RRF fuses both ranked lists
without score normalization and degrades to whichever arm returned rows. With
rag_hybrid off it is the original dense-only cosine search.
"""
import logging
import re
from dataclasses import dataclass, asdict
from datetime import date
from typing import List, Optional, Sequence, Union

from ..config import get_settings
from .embeddings import embed_query  # may raise EmbeddingsUnavailable
from .textutil import vector_literal, chunk_report  # re-exported for callers/tests

log = logging.getLogger("pathodb_agent")

# Backwards-compatible alias.
_vector_literal = vector_literal

REPORT_TYPES = ("macro", "microscopy")


class FilterError(ValueError):
    """A pre-filter argument was invalid — surfaced to the agent so it can retry
    with a corrected value rather than silently searching the wrong scope."""


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


@dataclass
class ScopeInfo:
    """What the pre-filter narrowed the corpus to, for the tool summary and audit.

    `matched_chunks` is counted with a LIMIT so a broad filter never pays for a
    full count; when `capped` is True the true total is only known to be >= it.
    `strategy` is what retrieval actually did: 'exact' scans the whole scope
    (100% recall); 'broad' post-filters an ANN pool (approximate).
    """
    filtered: bool
    matched_chunks: Optional[int] = None   # None = not counted (no filter)
    capped: bool = False
    strategy: str = "ann"                  # 'exact' | 'broad' | 'ann' (unfiltered)
    description: str = "whole corpus"

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class RetrievalResult:
    chunks: List[RetrievedChunk]
    scope: ScopeInfo

    def __iter__(self):
        # Lets callers/tests treat the result as the chunk list it used to be.
        return iter(self.chunks)

    def __len__(self):
        return len(self.chunks)


def _parse_date(value, label: str) -> Optional[date]:
    if value is None or value == "":
        return None
    if isinstance(value, date):
        return value
    try:
        return date.fromisoformat(str(value).strip())
    except ValueError:
        raise FilterError(f"{label} must be an ISO date (YYYY-MM-DD), got {value!r}")


@dataclass
class ReportFilter:
    """A metadata pre-filter over the report corpus — the "zoom in" step.

    Every field maps to a column of `rag_meta`. All fields AND together; None means
    unconstrained.

    `submission_ids` is the escape hatch for filters this class cannot express
    natively (stain, morphology, magnification …): resolve them with query_cohort
    and pass the ids. It is deliberately capped (rag_max_scope_ids) because a large
    ANY(...) array is exactly what defeats the index — prefer the native fields.
    """
    # Dates arrive as ISO strings from the tool layer; validate() coerces them to
    # date objects in place, hence the union.
    date_from: Optional[Union[str, date]] = None
    date_to: Optional[Union[str, date]] = None
    report_type: Optional[str] = None
    patient_id: Optional[int] = None
    malignancy_flag: Optional[bool] = None
    topographies: Optional[List[str]] = None      # exact probes.topo_description values
    snomed_topo_codes: Optional[List[str]] = None
    submission_ids: Optional[List[int]] = None

    _FIELDS = ("date_from", "date_to", "report_type", "patient_id",
               "malignancy_flag", "topographies", "snomed_topo_codes",
               "submission_ids")

    def is_empty(self) -> bool:
        return not any(getattr(self, f) not in (None, [], "") for f in self._FIELDS)

    def validate(self) -> "ReportFilter":
        """Normalize + reject bad values. Returns self for chaining."""
        settings = get_settings()
        self.date_from = _parse_date(self.date_from, "date_from")
        self.date_to = _parse_date(self.date_to, "date_to")
        if self.date_from and self.date_to and self.date_from > self.date_to:
            raise FilterError(
                f"date_from ({self.date_from}) is after date_to ({self.date_to})")
        if self.report_type is not None:
            rt = str(self.report_type).strip().lower()
            if rt not in REPORT_TYPES:
                raise FilterError(
                    f"report_type must be one of {', '.join(REPORT_TYPES)}, got {self.report_type!r}")
            self.report_type = rt
        for name in ("topographies", "snomed_topo_codes"):
            v = getattr(self, name)
            if v is not None:
                if isinstance(v, str):
                    v = [v]
                v = [str(x).strip() for x in v if str(x).strip()]
                setattr(self, name, v or None)
        if self.submission_ids is not None:
            ids = [int(i) for i in self.submission_ids]
            cap = settings.rag_max_scope_ids
            if len(ids) > cap:
                raise FilterError(
                    f"submission_ids has {len(ids)} entries, over the {cap} cap. "
                    "Narrow with the native filters (date_from/date_to, topographies, "
                    "patient_id) instead of passing a large id list.")
            self.submission_ids = ids or None
        if not self.is_empty() and not settings.rag_filter_enabled:
            raise FilterError(
                "Report pre-filtering is disabled (rag_filter_enabled=false).")
        return self

    def to_sql(self) -> tuple:
        """Build the WHERE clauses + bind params. Every clause is on alias `m`
        (rag_meta), so the whole filter resolves inside that one small table."""
        clauses, params = [], {}
        if self.date_from:
            clauses.append("m.report_date >= :f_date_from")
            params["f_date_from"] = self.date_from
        if self.date_to:
            clauses.append("m.report_date <= :f_date_to")
            params["f_date_to"] = self.date_to
        if self.report_type:
            clauses.append("m.report_type = :f_report_type")
            params["f_report_type"] = self.report_type
        if self.patient_id is not None:
            clauses.append("m.patient_id = :f_patient_id")
            params["f_patient_id"] = int(self.patient_id)
        if self.malignancy_flag is not None:
            clauses.append("m.malignancy_flag = :f_malignancy")
            params["f_malignancy"] = bool(self.malignancy_flag)
        if self.topographies:
            # && = array overlap → uses the GIN index on topo_descriptions.
            clauses.append("m.topo_descriptions && CAST(:f_topos AS text[])")
            params["f_topos"] = list(self.topographies)
        if self.snomed_topo_codes:
            clauses.append("m.snomed_topo_codes && CAST(:f_topo_codes AS text[])")
            params["f_topo_codes"] = list(self.snomed_topo_codes)
        if self.submission_ids:
            clauses.append("m.submission_id = ANY(:f_sub_ids)")
            params["f_sub_ids"] = list(self.submission_ids)
        return clauses, params

    def describe(self) -> str:
        """Human-readable scope, for the tool summary and the audit trail."""
        bits = []
        if self.date_from and self.date_to:
            bits.append(f"{self.date_from} to {self.date_to}")
        elif self.date_from:
            bits.append(f"from {self.date_from}")
        elif self.date_to:
            bits.append(f"up to {self.date_to}")
        if self.report_type:
            bits.append(f"{self.report_type} reports")
        if self.patient_id is not None:
            bits.append(f"patient #{self.patient_id}")
        if self.malignancy_flag is not None:
            bits.append("malignant" if self.malignancy_flag else "non-malignant")
        if self.topographies:
            bits.append("topography " + "/".join(self.topographies))
        if self.snomed_topo_codes:
            bits.append("topo codes " + "/".join(self.snomed_topo_codes))
        if self.submission_ids:
            bits.append(f"{len(self.submission_ids)} scoped submission(s)")
        return ", ".join(bits) if bits else "whole corpus"


def _where(clauses: Sequence[str], extra: Optional[str] = None) -> str:
    parts = [c for c in (list(clauses) + ([extra] if extra else [])) if c]
    return ("WHERE " + " AND ".join(parts)) if parts else ""


# Final projection. report_type comes from rag_meta, which removes the `reports`
# join from every path. Both joins run AFTER the LIMIT, over `pool` rows only —
# joined into the ranked query instead they would run per candidate (measured at
# ~99k lookups / 4s for a one-year filter).
_OUTER = """
    SELECT c.id, c.report_id, c.submission_id, s.lis_submission_id,
           mm.report_type, c.chunk_text, c.score
    FROM c
    JOIN submissions s ON s.id = c.submission_id
    JOIN rag_meta mm   ON mm.report_id = c.report_id
    ORDER BY {order_by}
"""


def _scope_size(db, clauses, params, cap: int) -> tuple:
    """Bounded count of reports matching the filter → (count, capped).

    Counts rag_meta ALONE (no join to report_embeddings): the corpus is ~1 chunk
    per report, so this is an accurate chunk estimate and stays index-only.
    LIMIT-bounded on purpose — a broad filter must not pay for an exact count just
    to decide how to search.
    """
    from sqlalchemy import text
    sql = text(f"""
        SELECT count(*) FROM (
            SELECT 1 FROM rag_meta m {_where(clauses)} LIMIT :cap
        ) t
    """)
    n = db.execute(sql, {**params, "cap": cap}).scalar() or 0
    return n, n >= cap


def _dense_exact(db, qvec, pool, clauses, params):
    """EXACT: materialize the scope, then rank only those chunks.

    AS MATERIALIZED is load-bearing. Inlined, the planner is free to use the HNSW
    index and post-filter the join — which silently returns FEWER than top_k rows
    (or none), because the global nearest neighbours need not be in scope, and a
    join predicate is not something pgvector's iterative scan can recheck.
    Materializing forces scope-first, giving a deterministic exact scan.
    """
    from sqlalchemy import text
    sql = text(f"""
        WITH scope AS MATERIALIZED (
            SELECT m.report_id FROM rag_meta m {_where(clauses)}
        ), c AS (
            SELECT e.id, e.report_id, e.submission_id, e.chunk_text,
                   e.embedding <=> CAST(:qvec AS vector) AS score
            FROM report_embeddings e
            JOIN scope sc ON sc.report_id = e.report_id
            ORDER BY e.embedding <=> CAST(:qvec AS vector)
            LIMIT :pool
        )
        {_OUTER.format(order_by="c.score ASC")}
    """)
    return db.execute(sql, {**params, "qvec": qvec, "pool": pool}).fetchall()


def _dense_broad(db, qvec, pool, wide, clauses, params):
    """BROAD: rank a widened ANN pool first, then post-filter it.

    For a scope of hundreds of thousands of chunks an exact scan costs many
    seconds, so trade recall for latency. `wide` is sized from corpus/scope so the
    pool still yields top_k after filtering; AS MATERIALIZED keeps the ANN LIMIT
    from being collapsed into the outer one.
    """
    from sqlalchemy import text
    sql = text(f"""
        WITH pool AS MATERIALIZED (
            SELECT e.id, e.report_id, e.submission_id, e.chunk_text,
                   e.embedding <=> CAST(:qvec AS vector) AS score
            FROM report_embeddings e
            ORDER BY e.embedding <=> CAST(:qvec AS vector)
            LIMIT :wide
        ), c AS (
            SELECT p.* FROM pool p
            JOIN rag_meta m ON m.report_id = p.report_id
            {_where(clauses)}
            ORDER BY p.score ASC
            LIMIT :pool
        )
        {_OUTER.format(order_by="c.score ASC")}
    """)
    return db.execute(sql, {**params, "qvec": qvec, "pool": pool, "wide": wide}).fetchall()


def _dense_unfiltered(db, qvec, pool):
    """No filter → the original pure-HNSW path (measured 15ms warm)."""
    from sqlalchemy import text
    sql = text(f"""
        WITH c AS (
            SELECT e.id, e.report_id, e.submission_id, e.chunk_text,
                   e.embedding <=> CAST(:qvec AS vector) AS score
            FROM report_embeddings e
            ORDER BY e.embedding <=> CAST(:qvec AS vector)
            LIMIT :pool
        )
        {_OUTER.format(order_by="c.score ASC")}
    """)
    return db.execute(sql, {"qvec": qvec, "pool": pool}).fetchall()


# Whitelist for the tsvector config so it can be safely inlined as an SQL
# literal. A *literal* regconfig keeps to_tsvector(...) immutable, which is what
# lets the planner use the GIN expression index — a bound parameter would not.
_CFG_RE = re.compile(r"^[a-z_][a-z0-9_]*$")


def _lexical_arm(db, query, pool, clauses, params, cfg):
    """Postgres full-text arm. Uses websearch_to_tsquery so operators like
    quotes and OR in the user's phrasing work; ts_rank_cd rewards term density
    and proximity. Returns [] (not an error) when FTS is unusable or matchless.

    No exact/broad split here: ts_rank_cd is not indexable, so Postgres must
    already visit every FTS match to rank it. Filtering via the rag_meta join is
    therefore exact by construction and cannot under-return.
    """
    from sqlalchemy import text
    if not _CFG_RE.match(cfg):
        log.warning("Invalid rag_fts_config %r; skipping lexical arm", cfg)
        return []
    join = "JOIN rag_meta m ON m.report_id = e.report_id" if clauses else ""
    # cfg is whitelisted above, so inlining it as a literal is injection-safe and
    # keeps the to_tsvector expression index-eligible (must match the index's
    # constant config exactly — see db/schema.sql idx_report_embeddings_fts).
    sql = text(f"""
        WITH c AS (
            SELECT e.id, e.report_id, e.submission_id, e.chunk_text,
                   ts_rank_cd(to_tsvector('{cfg}', e.chunk_text), q) AS score
            FROM report_embeddings e
            {join},
                 websearch_to_tsquery('{cfg}', :q) AS q
            {_where(clauses, f"to_tsvector('{cfg}', e.chunk_text) @@ q")}
            ORDER BY score DESC
            LIMIT :pool
        )
        {_OUTER.format(order_by="c.score DESC")}
    """)
    try:
        return db.execute(sql, {**params, "q": query, "pool": pool}).fetchall()
    except Exception as e:
        # Missing FTS index or bad tsquery → fall back to dense-only silently.
        log.warning("Lexical retrieval arm unavailable, using dense only: %s", e)
        db.rollback()
        return []


_FRAG_DELIM = " ... "   # ts_headline's default delimiter between MaxFragments
_NEG_CUE = re.compile(
    r"\b(no|not|non|without|absen\w+|negative|free\s+of|exclud\w+|"
    r"rule[d]?\s+out|r/o|neg\.?|lack\w*|devoid)\b", re.I)


def _likely_negated(excerpt: str) -> bool:
    """Heuristic: is the first highlighted match preceded by a negation cue within
    its own fragment? Flags 'no evidence of X', 'X excluded', 'no further X', so a
    caller can separate negated/absent mentions from positive findings in a
    find-all candidate list. Advisory only — negation scope is imperfect, so this
    FLAGS, it never drops a row. Looks only at the ~60 chars before the match and
    only within the current ts_headline fragment, to bound false positives from an
    unrelated earlier clause."""
    if not excerpt:
        return False
    i = excerpt.find("<<")
    if i < 0:
        return False
    before = excerpt[:i].rsplit(_FRAG_DELIM, 1)[-1]   # current fragment only
    return bool(_NEG_CUE.search(before[-60:]))


def text_evidence_submissions(db, term: str, topo_codes: Sequence[str],
                              date_from=None, date_to=None,
                              report_type: Optional[str] = "microscopy",
                              cap: int = 5000) -> dict:
    """EXHAUSTIVE full-text lookup of submissions whose report text mentions `term`
    within a topography/date scope → {submission_id: excerpt}.

    Deliberately NOT the ranked hybrid retrieval above. That answers "show me the
    most relevant passages" with a top-k sample; this answers "which cases mention
    this at all", which is a set and must not be sampled — a top-k of 20 over a
    scope containing 379 matches would silently under-report by 95%.

    So: no ANN, no ts_rank_cd, no LIMIT other than a safety cap. Just the GIN FTS
    index (idx_report_embeddings_fts) intersected with the rag_meta scope, which
    is the same code family the coded arm filters on — the two arms are then
    directly comparable.

    A MATCH IS NOT A DIAGNOSIS, on two counts, so callers must present these as
    CANDIDATES for review and never merge them into a coded count:

      * "no evidence of adenocarcinoma" matches the same tsquery as a positive
        finding, as does a mention of prior history.
      * rag_meta's topography is the DISTINCT set over the submission's probes,
        while a code-based cohort matches topography and morphology on the SAME
        probe. A submission carrying a colon polyp and a gastric carcinoma is in
        scope for 'colorectal', and its report text says 'adenocarcinoma' — about
        the stomach. Report text is per-report; it cannot be attributed to a
        probe, so this is a limit of the data model, not a bug to fix here.

    Each submission therefore comes back with `excerpt` — a ts_headline window
    around the actual match, not the head of the chunk, so a reviewer sees WHY it
    matched — and `topographies`, so a multi-organ submission is visible as such.
    """
    from sqlalchemy import text
    settings = get_settings()
    cfg = settings.rag_fts_config
    if not _CFG_RE.match(cfg):
        log.warning("Invalid rag_fts_config %r; text evidence arm skipped", cfg)
        return {}
    if not topo_codes:
        return {}

    clauses = ["m.snomed_topo_codes && :topo_codes"]
    params: dict = {"topo_codes": list(topo_codes)}
    if date_from:
        clauses.append("m.report_date >= :d_from")
        params["d_from"] = _parse_date(date_from, "date_from")
    if date_to:
        clauses.append("m.report_date <= :d_to")
        params["d_to"] = _parse_date(date_to, "date_to")
    if report_type:
        clauses.append("m.report_type = :rtype")
        params["rtype"] = report_type

    # cfg is whitelisted by _CFG_RE, so inlining it keeps to_tsvector immutable
    # and the expression index usable — a bound parameter would not (see
    # _lexical_arm).
    # phraseto_tsquery (not websearch_to_tsquery) so a multi-word feature matches
    # as an ADJACENT PHRASE: 'signet ring cell' -> 'signet'<->'ring'<->'cell', which
    # a report's 'signet-ring cell' still satisfies (the hyphen splits into adjacent
    # lexemes). websearch_to_tsquery ANDed the three lexemes, matching them scattered
    # anywhere in a chunk — far looser. It also treats the input as literal text, so
    # stray query operators in the term can't change the search. Single-word terms
    # behave identically under both.
    # ts_headline renders the window AROUND the match. Without it the caller can
    # only truncate the chunk head, which routinely cuts the match off entirely
    # (matches sit ~900 chars in) and leaves a reviewer looking at unrelated text.
    sql = text(f"""
        SELECT DISTINCT ON (m.submission_id)
               m.submission_id,
               ts_headline('{cfg}', e.chunk_text, q,
                           'MaxWords=45, MinWords=20, MaxFragments=2, '
                           'StartSel=<<, StopSel=>>') AS excerpt,
               m.topo_descriptions
        FROM report_embeddings e
        JOIN rag_meta m ON m.report_id = e.report_id,
             phraseto_tsquery('{cfg}', :q) AS q
        {_where(clauses, f"to_tsvector('{cfg}', e.chunk_text) @@ q")}
        ORDER BY m.submission_id
        LIMIT :cap
    """)
    try:
        rows = db.execute(sql, {**params, "q": term, "cap": cap}).fetchall()
    except Exception as e:
        log.warning("Text evidence arm unavailable: %s", e)
        db.rollback()
        return {}
    return {r[0]: {"excerpt": r[1], "topographies": list(r[2] or []),
                   "likely_negated": _likely_negated(r[1])} for r in rows}


def _rag_meta_missing(db) -> bool:
    """True if the `rag_meta` side table isn't there — i.e. the pre-filter
    migration hasn't been applied. Only consulted on an error path, so it costs
    nothing normally."""
    from sqlalchemy import text
    try:
        return db.execute(text("SELECT to_regclass('rag_meta')")).scalar() is None
    except Exception:
        return False


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


def _corpus_size(db) -> int:
    """Approximate live-tuple count of report_embeddings, from the planner's own
    stats — used only to size the widened BROAD pool, so an estimate is fine and
    a real count(*) over millions of rows would not be."""
    from sqlalchemy import text
    try:
        n = db.execute(text(
            "SELECT reltuples::bigint FROM pg_class WHERE oid = 'report_embeddings'::regclass"
        )).scalar()
        return int(n) if n and n > 0 else 0
    except Exception:
        return 0


def retrieve(
    db,
    query: str,
    top_k: Optional[int] = None,
    scope_submission_ids: Optional[Sequence[int]] = None,
    filters: Optional[ReportFilter] = None,
) -> RetrievalResult:
    """Pre-filter, then hybrid-retrieve over the report corpus.

    `filters` narrows the corpus before retrieval (see ReportFilter).
    `scope_submission_ids` is the older, narrower form of the same idea and is
    merged into `filters.submission_ids`.

    Raises FilterError on an invalid filter, and EmbeddingsUnavailable if the
    embedder cannot load (the dense arm is required for a semantic search).
    """
    settings = get_settings()
    k = top_k or settings.rag_top_k

    f = filters or ReportFilter()
    if scope_submission_ids:
        f.submission_ids = list(scope_submission_ids)
    f.validate()
    clauses, params = f.to_sql()
    filtered = bool(clauses)

    scope = ScopeInfo(filtered=filtered, description=f.describe())
    exact_max = max(1, settings.rag_exact_scan_max_chunks)
    wide = 0

    if filtered:
        # Size the scope, pick the strategy, and short-circuit an empty scope
        # before paying for an embedding call.
        try:
            n, capped = _scope_size(db, clauses, params, exact_max + 1)
        except Exception as e:
            db.rollback()
            if _rag_meta_missing(db):
                raise FilterError(
                    "the rag_meta pre-filter table is missing — apply "
                    "db/rag_prefilter_migration.sql (or set rag_filter_enabled=false "
                    "to search unfiltered). Unfiltered search still works.") from e
            raise
        scope.matched_chunks, scope.capped = n, capped
        scope.strategy = "broad" if capped else "exact"
        if n == 0:
            return RetrievalResult([], scope)

    qvec = vector_literal(embed_query(query))
    pool = max(settings.rag_candidate_pool, k) if settings.rag_hybrid else k

    if scope.strategy == "broad":
        # Widen the ANN pool by corpus/scope so enough rows survive the filter.
        corpus = _corpus_size(db)
        ratio = (corpus / scope.matched_chunks) if (corpus and scope.matched_chunks) else 1
        wide = min(settings.rag_broad_pool_max, max(pool, int(pool * ratio * 3)))

    def _dense(limit):
        if not filtered:
            return _dense_unfiltered(db, qvec, limit)
        if scope.strategy == "exact":
            return _dense_exact(db, qvec, limit, clauses, params)
        return _dense_broad(db, qvec, limit, max(wide, limit), clauses, params)

    # ── Dense-only (legacy path) ─────────────────────────────────────────────
    if not settings.rag_hybrid:
        rows = _dense(k)
        # score is cosine DISTANCE here; report similarity for interpretability,
        # matching this path's historical contract.
        return RetrievalResult([_to_chunk(r, 1.0 - float(r[6])) for r in rows], scope)

    # ── Hybrid: fuse dense + lexical over a wider candidate pool ──────────────
    dense = _dense(pool)
    lexical = _lexical_arm(db, query, pool, clauses, params, settings.rag_fts_config)
    fused = _rrf_fuse([dense, lexical], settings.rag_rrf_k)
    if not fused:
        return RetrievalResult([], scope)

    # ── Optional cross-encoder rerank over the fused pool ─────────────────────
    if settings.rag_reranker_model:
        try:
            from .reranker import rerank_order, RerankerUnavailable
            candidates = fused[:pool]
            order = rerank_order(query, [row[5] for row, _ in candidates])
            return RetrievalResult(
                [_to_chunk(candidates[i][0], sc) for i, sc in order[:k]], scope)
        except RerankerUnavailable as e:
            log.warning("Reranker unavailable, using fused order: %s", e)
        except Exception as e:
            log.warning("Reranker failed, using fused order: %s", e)

    return RetrievalResult([_to_chunk(row, sc) for row, sc in fused[:k]], scope)


def rag_available(db) -> bool:
    """True if pgvector + the report_embeddings table are present and queryable."""
    from sqlalchemy import text
    try:
        db.execute(text("SELECT 1 FROM report_embeddings LIMIT 1"))
        return True
    except Exception:
        return False
