#!/bin/bash
#SBATCH --mail-type=end,fail
#SBATCH --mail-user=javier.garcia@unibe.ch
#SBATCH --job-name="pathodb_embed"
#SBATCH --output="/storage/research/igmp_dp_workspace/garciabaroja_javier/PW_reports/database/pathodb/logs/pathodb_embed_%j.out"
#SBATCH --time=8:00:00
#SBATCH --mem=90G
#SBATCH --nodes=1
#SBATCH --account=invest
#SBATCH --partition=gpu-invest
#SBATCH --gres=gpu:rtx4090:1
#SBATCH --cpus-per-task=16
#SBATCH --qos=job_gpu_igmp-tru

# =============================================================================
# PathoDB — Build / refresh the report RAG index (report_embeddings table).
#
# Idempotent + resumable: only embeds reports that have no existing embeddings.
# Safe to re-run as the database grows or after adding new reports.
#
# USAGE
#   sbatch slurm_embed.sh              # embed all pending reports on GPU
#
# ENVIRONMENT OVERRIDES (set before sbatch, or export in your shell)
#   EMBED_REPORT_TYPE   microscopy | macro | all   (default: all)
#   EMBED_LIMIT         max reports to process in this run (default: unlimited)
#   EMBED_BATCH         chunks embedded/inserted per GPU flush (default: 1024)
#   EMBEDDING_DEVICE    cuda | cpu                  (default: cuda)
#   EMBEDDING_MODEL     HuggingFace model id        (default: from .env / config)
#   EMBEDDING_DIM       vector column dimension     (default: 1024 for bge-m3)
#   EMBED_REBUILD_INDEX true | false — drop the HNSW index before the load and
#                       rebuild it after (default: true; much faster for a full
#                       (re)index). Set false for small incremental top-ups.
#
# CPU-ONLY RUN (no GPU queuing):
#   Remove or comment out the --gres and --partition lines above, then:
#     EMBEDDING_DEVICE=cpu sbatch slurm_embed.sh
#
# RUNNING ALONGSIDE THE API:
#   If the API job is already running on a different node and owns PostgreSQL,
#   point DATABASE_URL directly at that node before submitting:
#     export DATABASE_URL=postgresql://user:pass@<api-node>:5432/pathodb
#     sbatch slurm_embed.sh
#
#   sbatch slurm_embed.sh && squeue --me
# =============================================================================

set -euo pipefail

PROJECT_DIR="/storage/research/igmp_dp_workspace/garciabaroja_javier/PW_reports/database/pathodb"
PG_ENV="/storage/research/igmp_dp_workspace/garciabaroja_javier/conda_envs/pathodb-pg"
PG_BIN="$PG_ENV/bin"
PGDATA="$PROJECT_DIR/pgdata"
ENV_FILE="$PROJECT_DIR/.env"

echo "=== PathoDB Embedding Worker ==="
echo "Started  : $(date)"
echo "Node     : $(hostname)"
echo ""

# ── Load modules ──────────────────────────────────────────────────────────────
module load Anaconda3
# module load PostgreSQL
# export PATH="/software.9/software/PostgreSQL/16.4-GCCcore-13.3.0/bin:$PATH"
source activate langchain

# ── Move into project directory ───────────────────────────────────────────────
cd "$PROJECT_DIR"

# ── Load environment ──────────────────────────────────────────────────────────
if [ ! -f "$ENV_FILE" ]; then
    echo "ERROR: .env not found at $ENV_FILE"
    exit 1
fi
set -a
source "$ENV_FILE"
set +a

PGDB="${POSTGRES_DB}"
APP_PGUSER=jg23p152
# PGUSER="${POSTGRES_USER}"

# ── Manage PostgreSQL ─────────────────────────────────────────────────────────
# We track whether WE started the instance so we only stop it on exit if so.
PG_STARTED_BY_US=false

cleanup() {
    if [ "$PG_STARTED_BY_US" = true ]; then
        echo ""
        echo "Stopping PostgreSQL (started by this job)..."
        "$PG_BIN/pg_ctl" -D "$PGDATA" stop -m fast 2>/dev/null || true
    fi
    echo "Cleanup done at $(date)"
}
trap cleanup EXIT

# Remove stale PID file left by a killed/crashed previous job on another node
PIDFILE="$PGDATA/postmaster.pid"
if [ -f "$PIDFILE" ]; then
    STORED_PID=$(head -1 "$PIDFILE")
    if ! kill -0 "$STORED_PID" 2>/dev/null; then
        echo "Removing stale PostgreSQL PID file (PID $STORED_PID no longer running)..."
        rm -f "$PIDFILE"
    fi
fi

# Start PostgreSQL only if it is not already reachable on this node
if "$PG_BIN/pg_isready" -p "$PGPORT" -q 2>/dev/null; then
    echo "PostgreSQL is already running on port $PGPORT — reusing it."
else
    echo "Starting PostgreSQL..."
    "$PG_BIN/pg_ctl" -D "$PGDATA" -l "$PGDATA/logs/startup.log" start
    PG_STARTED_BY_US=true
    for i in $(seq 1 30); do
        "$PG_BIN/pg_isready" -p "$PGPORT" -q && echo "PostgreSQL ready after ${i}s." && break
        sleep 1
    done
    "$PG_BIN/pg_isready" -p "$PGPORT" -q || { echo "ERROR: PostgreSQL did not become ready in 30s"; exit 1; }
fi

# ── Apply schema (idempotent — IF NOT EXISTS throughout) ─────────────────────
# Ensures report_embeddings, chat tables, etc. exist even on a DB that was
# created before those tables were added. Safe to run on an up-to-date DB.
echo ""
# echo "Applying schema (idempotent)..."
# "$PG_BIN/psql" -p "$PGPORT" -U "$PGUSER" -d "$PGDB" -f db/schema.sql \
#     && echo "Schema OK." \
#     || { echo "ERROR: schema apply failed — check db/schema.sql output above"; exit 1; }
"$PG_BIN/psql" -p "$PGPORT" -d "$PGDB" --set ON_ERROR_STOP=1 \
    -c "CREATE EXTENSION IF NOT EXISTS vector;" \
    && echo "  pgvector: OK" \
    || { echo "ERROR: could not create pgvector extension."; \
         echo "  Ensure the server-side pgvector library is installed and rerun."; exit 1; }

EMBEDDING_DIM="${EMBEDDING_DIM:-1024}"
EMBED_REBUILD_INDEX="${EMBED_REBUILD_INDEX:-true}"

echo "Ensuring report_embeddings table (dim=${EMBEDDING_DIM}) and indexes exist..."
"$PG_BIN/psql" -p "$PGPORT" -d "$PGDB" --set ON_ERROR_STOP=1 <<SQL
CREATE TABLE IF NOT EXISTS report_embeddings (
    id            SERIAL      PRIMARY KEY,
    report_id     INTEGER     NOT NULL REFERENCES reports (id) ON DELETE CASCADE,
    submission_id INTEGER     NOT NULL REFERENCES submissions (id),
    chunk_index   INTEGER     NOT NULL DEFAULT 0,
    chunk_text    TEXT        NOT NULL,
    embedding     vector(${EMBEDDING_DIM}),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (report_id, chunk_index)
);

-- Migrate the vector column if the stored dimension differs from the target
-- (e.g. switching embedding models). Vectors from a different model live in a
-- different space, so existing rows are dropped and the corpus is re-embedded.
-- For pgvector, atttypmod holds the declared dimension directly.
DO \$\$
DECLARE cur_dim int;
BEGIN
    SELECT atttypmod INTO cur_dim
    FROM   pg_attribute
    WHERE  attrelid = 'report_embeddings'::regclass AND attname = 'embedding';
    IF cur_dim IS DISTINCT FROM ${EMBEDDING_DIM} THEN
        RAISE NOTICE 'Migrating embedding column dim % -> %, truncating for re-embed',
                     cur_dim, ${EMBEDDING_DIM};
        DROP INDEX IF EXISTS idx_report_embeddings_vec;
        TRUNCATE report_embeddings;
        ALTER TABLE report_embeddings
            ALTER COLUMN embedding TYPE vector(${EMBEDDING_DIM});
    END IF;
END
\$\$;

CREATE INDEX IF NOT EXISTS idx_report_embeddings_report_id
    ON report_embeddings (report_id);
CREATE INDEX IF NOT EXISTS idx_report_embeddings_submission
    ON report_embeddings (submission_id);


-- Grant DML to the app user so embed_reports.py can INSERT/SELECT

GRANT SELECT, INSERT, UPDATE, DELETE
    ON report_embeddings TO ${APP_PGUSER};
GRANT USAGE, SELECT
    ON SEQUENCE report_embeddings_id_seq TO ${APP_PGUSER};
SQL
echo "  report_embeddings: OK"


# ── Defer the HNSW index for a full (re)build ────────────────────────────────
# Maintaining the HNSW graph on every INSERT is far slower (and yields worse
# recall) than bulk-loading first and building the index once at the end. For
# incremental top-ups keep the existing index (EMBED_REBUILD_INDEX=false).
if [ "$EMBED_REBUILD_INDEX" = "true" ]; then
    echo "  Dropping HNSW + FTS indexes for bulk load (rebuilt after ingest)..."
    "$PG_BIN/psql" -p "$PGPORT" -d "$PGDB" --set ON_ERROR_STOP=1 \
        -c "DROP INDEX IF EXISTS idx_report_embeddings_vec;
            DROP INDEX IF EXISTS idx_report_embeddings_fts;"
else
    echo "  Keeping HNSW + FTS indexes (incremental mode)..."
    "$PG_BIN/psql" -p "$PGPORT" -d "$PGDB" --set ON_ERROR_STOP=1 \
        -c "CREATE INDEX IF NOT EXISTS idx_report_embeddings_vec
                ON report_embeddings USING hnsw (embedding vector_cosine_ops);
            CREATE INDEX IF NOT EXISTS idx_report_embeddings_fts
                ON report_embeddings USING gin (to_tsvector('english', chunk_text));"
fi


# ── Install Python dependencies ───────────────────────────────────────────────
# echo ""
# echo "Installing/verifying API dependencies..."
# pip install -q -r api/requirements.txt

# ── Configure embedding run ───────────────────────────────────────────────────
export EMBEDDING_DEVICE="${EMBEDDING_DEVICE:-cuda}"
# Keep the Python config's vector dim aligned with the column built above.
export EMBEDDING_DIM
REPORT_TYPE="${EMBED_REPORT_TYPE:-all}"

EXTRA_ARGS=()
if [ -n "${EMBED_LIMIT:-}" ]; then
    EXTRA_ARGS+=(--limit "$EMBED_LIMIT")
fi
embed_batch=1024
EXTRA_ARGS+=(--embed-batch "${EMBED_BATCH:-$embed_batch}")

echo ""
echo "──────────────────────────────────────────────"
echo "  Embedding configuration"
echo "──────────────────────────────────────────────"
echo "  Report type     : $REPORT_TYPE"
echo "  Device          : $EMBEDDING_DEVICE"
echo "  Model           : ${EMBEDDING_MODEL:-BAAI/bge-m3}"
echo "  Vector dim      : $EMBEDDING_DIM"
echo "  Batch (chunks)  : ${EMBED_BATCH:-$embed_batch}"
echo "  Rebuild index   : $EMBED_REBUILD_INDEX"
if [ -n "${EMBED_LIMIT:-}" ]; then
    echo "  Limit           : $EMBED_LIMIT reports"
fi
echo "──────────────────────────────────────────────"

# ── Show pre-run pending count ────────────────────────────────────────────────
echo ""
REPORT_TYPE_COND=""
if [ "$REPORT_TYPE" != "all" ]; then
    REPORT_TYPE_COND="AND r.report_type = '$REPORT_TYPE'"
fi

PENDING=$("$PG_BIN/psql" -p "$PGPORT" -U "$APP_PGUSER" -d "$PGDB" -At -c "
    SELECT COUNT(*)
    FROM reports r
    WHERE r.report_text IS NOT NULL
      AND length(trim(r.report_text)) > 0
      $REPORT_TYPE_COND
      AND NOT EXISTS (
          SELECT 1 FROM report_embeddings e WHERE e.report_id = r.id
      );
" 2>/dev/null || echo "?")

ALREADY=$("$PG_BIN/psql" -p "$PGPORT" -U "$APP_PGUSER" -d "$PGDB" -At -c "
    SELECT COUNT(DISTINCT report_id) FROM report_embeddings;
" 2>/dev/null || echo "?")

TOTAL=$("$PG_BIN/psql" -p "$PGPORT" -U "$APP_PGUSER" -d "$PGDB" -At -c "
    SELECT COUNT(*)
    FROM reports r
    WHERE r.report_text IS NOT NULL
      AND length(trim(r.report_text)) > 0
      $REPORT_TYPE_COND;
" 2>/dev/null || echo "?")

echo "  Already embedded : $ALREADY"
echo "  Pending          : $PENDING / $TOTAL"
echo ""

if [ "$PENDING" = "0" ]; then
    # Deliberately NOT `exit 0`. With EMBED_REBUILD_INDEX=true (the default) the
    # HNSW + FTS indexes have ALREADY been dropped above in preparation for the
    # bulk load. Exiting here would leave the corpus permanently unindexed —
    # semantic search silently degrades to a sequential scan over millions of
    # vectors. Skip only the embedding step and fall through to the index phase,
    # which is idempotent (CREATE INDEX IF NOT EXISTS) and cheap when the indexes
    # already exist.
    echo "Nothing to embed — all reports are already embedded."
    echo "Continuing to the index phase (indexes are rebuilt/verified below)."
else
    # ── Run embedding worker ──────────────────────────────────────────────────
    echo "Starting embedding pipeline..."
    echo ""

    python3 api/workers/embed_reports.py \
        --report-type "$REPORT_TYPE" \
        "${EXTRA_ARGS[@]}"
fi

# ── Build the HNSW index (once, after the bulk load) ──────────────────────────
if [ "$EMBED_REBUILD_INDEX" = "true" ]; then
    echo ""
    echo "Building HNSW index over report_embeddings (this can take a while)..."
    # maintenance_work_mem + parallel workers dramatically speed the build.
    # max_parallel_maintenance_workers is bounded by --cpus-per-task above.
    "$PG_BIN/psql" -p "$PGPORT" -d "$PGDB" --set ON_ERROR_STOP=1 <<SQL
SET maintenance_work_mem = '60GB';
SET max_parallel_maintenance_workers = 15;
CREATE INDEX IF NOT EXISTS idx_report_embeddings_vec
    ON report_embeddings USING hnsw (embedding vector_cosine_ops);
-- Lexical arm of hybrid retrieval. 'english' must match config.rag_fts_config
-- and stay a constant literal so the planner can use this expression index.
CREATE INDEX IF NOT EXISTS idx_report_embeddings_fts
    ON report_embeddings USING gin (to_tsvector('english', chunk_text));
SQL
    echo "  HNSW + FTS indexes: OK"
fi

# Keep the agent's RAG pre-filter table in step with any reports this run added
# (rag_meta is derived from reports/submissions/probes — see
# db/rag_prefilter_migration.sql). No-op if the migration hasn't been applied.
python3 api/workers/embed_reports.py --refresh-metadata || \
    echo "  NOTE: rag_meta refresh skipped (apply db/rag_prefilter_migration.sql)"

# ── Post-run summary ──────────────────────────────────────────────────────────
echo ""
REMAINING=$("$PG_BIN/psql" -p "$PGPORT" -U "$APP_PGUSER" -d "$PGDB" -At -c "
    SELECT COUNT(*)
    FROM reports r
    WHERE r.report_text IS NOT NULL
      AND length(trim(r.report_text)) > 0
      $REPORT_TYPE_COND
      AND NOT EXISTS (
          SELECT 1 FROM report_embeddings e WHERE e.report_id = r.id
      );
" 2>/dev/null || echo "?")

FINAL_EMBEDDED=$("$PG_BIN/psql" -p "$PGPORT" -U "$APP_PGUSER" -d "$PGDB" -At -c "
    SELECT COUNT(DISTINCT report_id) FROM report_embeddings;
" 2>/dev/null || echo "?")

TOTAL_CHUNKS=$("$PG_BIN/psql" -p "$PGPORT" -U "$APP_PGUSER" -d "$PGDB" -At -c "
    SELECT COUNT(*) FROM report_embeddings;
" 2>/dev/null || echo "?")

echo "──────────────────────────────────────────────"
echo "  Post-run summary"
echo "──────────────────────────────────────────────"
echo "  Embedded reports : $FINAL_EMBEDDED"
echo "  Total chunks     : $TOTAL_CHUNKS"
echo "  Still pending    : $REMAINING"
if [ "$REMAINING" != "0" ] && [ "$REMAINING" != "?" ]; then
    echo ""
    echo "  NOTE: $REMAINING report(s) still need embedding."
    echo "        Re-run this job to continue (it is resumable)."
fi
echo "──────────────────────────────────────────────"
echo ""
echo "=== Embedding job finished at $(date) ==="
