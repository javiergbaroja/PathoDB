"""
PathoDB — Report embedding ingestion (RAG index builder).

Embeds pathology report text into the `report_embeddings` pgvector table so the
agent's semantic_report_search tool can retrieve relevant excerpts.

Idempotent + resumable: only embeds reports that don't yet have embeddings.

Run from the repo root (conda env `langchain`):
    python api/workers/embed_reports.py --report-type all
    python api/workers/embed_reports.py --report-type microscopy --limit 500

Requires: pgvector enabled + schema applied (db/schema.sql), sentence-transformers,
and the embedding model configured in api/config.py (default BAAI/bge-base-en-v1.5).
"""
import argparse
import logging
import sys
import time
from pathlib import Path

# Allow running as a plain script: ensure repo root is importable.
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from sqlalchemy import text  # noqa: E402

from api.database import SessionLocal  # noqa: E402
from api.config import get_settings  # noqa: E402
from api.agent.embeddings import embed_texts  # noqa: E402
from api.agent.textutil import chunk_report  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("embed_reports")


def _vector_literal(vec) -> str:
    return "[" + ",".join(f"{x:.6f}" for x in vec) + "]"


def _warmup_model() -> int:
    """
    Force-load the embedding model and return its output dimension.
    Called BEFORE the DB connection is opened so that the several-minute
    GPU/model initialisation does not leave an idle connection that
    PostgreSQL may close.
    """
    log.info("Pre-loading embedding model (this may take a few minutes on first run)...")
    t0 = time.time()
    vecs = embed_texts(["pathology diagnostic embedding warmup"])
    dim = len(vecs[0])
    log.info("Embedding model ready: dim=%d  (%.1fs)", dim, time.time() - t0)
    return dim


def _check_db(db) -> bool:
    """
    Print diagnostic information about the DB connection and report_embeddings
    table. Returns True if the worker can proceed, False if a hard blocker is found.
    Called AFTER the model is loaded so no long idle time occurs between queries.
    """
    log.info("──── DB diagnostics ────")

    # 1. Connection identity
    row = db.execute(text("SELECT current_user, current_database(), version()")).fetchone()
    log.info("  Connected as : %s", row[0])
    log.info("  Database     : %s", row[1])
    log.info("  PG version   : %s", row[2].split(",")[0])

    # 2. pgvector extension
    vec_ok = db.execute(
        text("SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector')")
    ).scalar()
    log.info(
        "  pgvector ext : %s",
        "✓ installed" if vec_ok else "✗ MISSING — run: CREATE EXTENSION vector;",
    )

    # 3. report_embeddings table existence + owner
    tbl = db.execute(text("""
        SELECT tableowner
        FROM   pg_tables
        WHERE  schemaname = 'public' AND tablename = 'report_embeddings'
    """)).fetchone()
    if tbl:
        log.info("  table exists : ✓ (owner=%s)", tbl[0])
    else:
        log.error("  table exists : ✗ MISSING — apply db/schema.sql first")
        return False

    # 4. Effective privileges the current role has on report_embeddings
    privs = db.execute(text("""
        SELECT privilege_type
        FROM   information_schema.role_table_grants
        WHERE  table_schema = 'public'
          AND  table_name   = 'report_embeddings'
          AND  grantee      = current_user
        ORDER  BY privilege_type
    """)).fetchall()
    if privs:
        log.info("  privileges   : %s", ", ".join(r[0] for r in privs))
    else:
        # Might be superuser/owner — check directly
        can_select = db.execute(
            text("SELECT has_table_privilege(current_user, 'report_embeddings', 'SELECT')")
        ).scalar()
        can_insert = db.execute(
            text("SELECT has_table_privilege(current_user, 'report_embeddings', 'INSERT')")
        ).scalar()
        log.info(
            "  privileges   : (via ownership/superuser) SELECT=%s INSERT=%s",
            can_select, can_insert,
        )
        if not (can_select and can_insert):
            log.error(
                "  ✗ User '%s' lacks SELECT/INSERT on report_embeddings.\n"
                "  Fix — run as superuser:\n"
                "    GRANT SELECT, INSERT, UPDATE, DELETE\n"
                "      ON report_embeddings TO %s;\n"
                "    GRANT USAGE, SELECT\n"
                "      ON SEQUENCE report_embeddings_id_seq TO %s;",
                row[0], row[0], row[0],
            )
            return False

    log.info("────────────────────────")
    return True


def _count_pending(db, rtype: str) -> int:
    rtype_filter = "" if rtype == "all" else f"AND r.report_type = '{rtype}'"
    return db.execute(text(f"""
        SELECT COUNT(*)
        FROM   reports r
        WHERE  r.report_text IS NOT NULL
          AND  length(trim(r.report_text)) > 0
          {rtype_filter}
          AND  NOT EXISTS (
              SELECT 1 FROM report_embeddings e WHERE e.report_id = r.id
          )
    """)).scalar()


def _iter_pending(db, rtype: str, limit: int | None, fetch_size: int):
    """
    Yield individual (id, submission_id, report_text) rows using keyset
    pagination so we never load more than `fetch_size` rows into memory at once.

    Keyset on r.id is safe here because:
      - reports are immutable once created
      - we only advance last_id to the max id seen, never skipping un-embedded rows
      - the NOT EXISTS filter ensures already-embedded rows are skipped correctly
    """
    last_id = 0
    total_yielded = 0

    while True:
        remaining = (limit - total_yielded) if limit is not None else fetch_size
        if remaining <= 0:
            break
        this_batch = min(fetch_size, remaining)

        rows = db.execute(text("""
            SELECT r.id, r.submission_id, r.report_text
            FROM   reports r
            WHERE  r.report_text IS NOT NULL
              AND  length(trim(r.report_text)) > 0
              AND  (:rtype = 'all' OR r.report_type = :rtype)
              AND  r.id > :last_id
              AND  NOT EXISTS (
                  SELECT 1 FROM report_embeddings e WHERE e.report_id = r.id
              )
            ORDER  BY r.id
            LIMIT  :batch_size
        """), {"rtype": rtype, "last_id": last_id, "batch_size": this_batch}).fetchall()

        if not rows:
            break

        for row in rows:
            yield row
            total_yielded += 1

        last_id = rows[-1][0]

        if len(rows) < this_batch:
            break  # no more rows to fetch


def main():
    ap = argparse.ArgumentParser(description="Embed pathology reports into report_embeddings.")
    ap.add_argument("--report-type", choices=["microscopy", "macro", "all"], default="all")
    ap.add_argument("--limit",        type=int, default=None,
                    help="Max reports to process this run.")
    ap.add_argument("--report-batch", type=int, default=50,
                    help="Reports per DB commit (default 50).")
    ap.add_argument("--fetch-size",   type=int, default=500,
                    help="Rows fetched from DB per round-trip (default 500).")
    args = ap.parse_args()

    settings = get_settings()

    # ── Step 1: warm up embedding model BEFORE opening the DB connection ──────
    # Loading a GPU model can take several minutes.  If the DB connection were
    # already open it would sit idle for that entire time and PostgreSQL may
    # close it (idle_in_transaction_session_timeout, OOM-kill, etc.).
    _warmup_model()

    # ── Step 2: open DB, run diagnostics, count pending ───────────────────────
    db = SessionLocal()
    total_reports = 0
    total_chunks  = 0
    try:
        if not _check_db(db):
            sys.exit(1)

        n_pending = _count_pending(db, args.report_type)
        log.info(
            "Reports pending embedding: %d (type=%s)",
            n_pending, args.report_type,
        )
        if n_pending == 0:
            log.info("Nothing to do.")
            return

        # ── Step 3: stream + embed + insert ──────────────────────────────────
        pending_commit = 0
        t_start = time.time()

        for rid, sid, rtext in _iter_pending(
            db, args.report_type, args.limit, args.fetch_size
        ):
            chunks  = chunk_report(rtext, settings.rag_max_chunk_chars,
                                   settings.rag_chunk_overlap_chars)
            if not chunks:
                continue

            vectors = embed_texts(chunks)

            for ci, (chunk, vec) in enumerate(zip(chunks, vectors)):
                db.execute(text("""
                    INSERT INTO report_embeddings
                        (report_id, submission_id, chunk_index, chunk_text, embedding)
                    VALUES (:rid, :sid, :ci, :ct, CAST(:emb AS vector))
                    ON CONFLICT (report_id, chunk_index) DO NOTHING
                """), {
                    "rid": rid, "sid": sid, "ci": ci,
                    "ct":  chunk, "emb": _vector_literal(vec),
                })
                total_chunks += 1

            total_reports += 1
            pending_commit += 1

            if pending_commit >= args.report_batch:
                db.commit()
                pending_commit = 0
                elapsed = time.time() - t_start
                rate    = total_reports / elapsed if elapsed > 0 else 0
                done_pct = 100 * total_reports / n_pending if n_pending else 0
                eta_h   = ((n_pending - total_reports) / rate / 3600) if rate > 0 else 0
                log.info(
                    "Progress: %d/%d reports (%.1f%%) | %d chunks | "
                    "%.1f rep/s | ETA %.1fh",
                    total_reports, n_pending, done_pct,
                    total_chunks, rate, eta_h,
                )

        db.commit()
        elapsed = time.time() - t_start
        log.info(
            "Done. Embedded %d report(s) into %d chunk(s) in %.1f min.",
            total_reports, total_chunks, elapsed / 60,
        )

    except Exception as e:
        db.rollback()
        log.error("Ingestion failed: %s", e, exc_info=True)
        raise
    finally:
        db.close()


if __name__ == "__main__":
    main()