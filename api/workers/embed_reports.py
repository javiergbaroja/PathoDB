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


def _check_db(db) -> bool:
    """
    Print diagnostic information about the DB connection and report_embeddings
    table. Returns True if the worker can proceed, False if a hard blocker is found.
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
    log.info("  pgvector ext : %s", "✓ installed" if vec_ok else "✗ MISSING — run: CREATE EXTENSION vector;")

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

    # 4. Privileges the current role has on report_embeddings
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
        # May be superuser or owner — double-check with has_table_privilege
        can_select = db.execute(
            text("SELECT has_table_privilege(current_user, 'report_embeddings', 'SELECT')")
        ).scalar()
        can_insert = db.execute(
            text("SELECT has_table_privilege(current_user, 'report_embeddings', 'INSERT')")
        ).scalar()
        log.info("  privileges   : (via ownership/superuser) SELECT=%s INSERT=%s", can_select, can_insert)
        if not (can_select and can_insert):
            log.error(
                "  ✗ Current user '%s' lacks SELECT/INSERT on report_embeddings.\n"
                "  Fix: run as superuser:\n"
                "    GRANT SELECT, INSERT, UPDATE, DELETE\n"
                "      ON report_embeddings TO %s;\n"
                "    GRANT USAGE, SELECT\n"
                "      ON SEQUENCE report_embeddings_id_seq TO %s;",
                row[0], row[0], row[0],
            )
            return False

    # 5. Embedding model load
    log.info("  Loading embedding model (this may take a moment)...")
    t0 = time.time()
    try:
        test_vec = embed_texts(["pathology diagnostic embedding test"])
        log.info(
            "  model ready  : ✓ dim=%d  (%.1fs)",
            len(test_vec[0]), time.time() - t0,
        )
    except Exception as exc:
        log.error("  model error  : ✗ %s", exc)
        return False

    log.info("────────────────────────")
    return True


def main():
    ap = argparse.ArgumentParser(description="Embed pathology reports into report_embeddings.")
    ap.add_argument("--report-type", choices=["microscopy", "macro", "all"], default="all")
    ap.add_argument("--limit", type=int, default=None, help="Max reports to process this run.")
    ap.add_argument("--report-batch", type=int, default=50, help="Reports per commit.")
    args = ap.parse_args()

    settings = get_settings()
    db = SessionLocal()
    total_reports = 0
    total_chunks = 0
    try:
        # ── Pre-flight checks ─────────────────────────────────────────────────
        if not _check_db(db):
            sys.exit(1)

        # ── Fetch pending reports ─────────────────────────────────────────────
        limit_sql = "LIMIT :limit" if args.limit else ""
        rows = db.execute(text(f"""
            SELECT r.id, r.submission_id, r.report_text
            FROM reports r
            WHERE r.report_text IS NOT NULL
              AND length(trim(r.report_text)) > 0
              AND (:rtype = 'all' OR r.report_type = :rtype)
              AND NOT EXISTS (SELECT 1 FROM report_embeddings e WHERE e.report_id = r.id)
            ORDER BY r.id
            {limit_sql}
        """), {"rtype": args.report_type, **({"limit": args.limit} if args.limit else {})}).fetchall()

        n_pending = len(rows)
        log.info("Found %d report(s) needing embeddings (type=%s).", n_pending, args.report_type)
        if n_pending == 0:
            log.info("Nothing to do.")
            return

        # ── Embed ─────────────────────────────────────────────────────────────
        pending = 0
        t_start = time.time()

        for idx, (rid, sid, rtext) in enumerate(rows, 1):
            chunks = chunk_report(rtext, settings.rag_max_chunk_chars, settings.rag_chunk_overlap_chars)
            if not chunks:
                continue
            vectors = embed_texts(chunks)
            for ci, (chunk, vec) in enumerate(zip(chunks, vectors)):
                db.execute(text("""
                    INSERT INTO report_embeddings
                        (report_id, submission_id, chunk_index, chunk_text, embedding)
                    VALUES (:rid, :sid, :ci, :ct, CAST(:emb AS vector))
                    ON CONFLICT (report_id, chunk_index) DO NOTHING
                """), {"rid": rid, "sid": sid, "ci": ci, "ct": chunk, "emb": _vector_literal(vec)})
                total_chunks += 1
            total_reports += 1
            pending += 1

            if pending >= args.report_batch:
                db.commit()
                pending = 0
                elapsed = time.time() - t_start
                rate = total_reports / elapsed if elapsed > 0 else 0
                remaining = n_pending - idx
                eta_s = remaining / rate if rate > 0 else 0
                eta_h = eta_s / 3600
                log.info(
                    "Progress: %d/%d reports | %d chunks | %.1f rep/s | ETA %.1fh",
                    total_reports, n_pending, total_chunks, rate, eta_h,
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
