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

        log.info("Found %d report(s) needing embeddings (type=%s).", len(rows), args.report_type)

        pending = 0
        for rid, sid, rtext in rows:
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
                log.info("Committed %d reports / %d chunks so far…", total_reports, total_chunks)
        db.commit()
        log.info("Done. Embedded %d report(s) into %d chunk(s).", total_reports, total_chunks)
    except Exception as e:
        db.rollback()
        log.error("Ingestion failed: %s", e, exc_info=True)
        raise
    finally:
        db.close()


if __name__ == "__main__":
    main()
