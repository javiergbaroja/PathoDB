#!/bin/bash
#SBATCH --mail-type=end,fail
#SBATCH --mail-user=javier.garcia@unibe.ch
#SBATCH --job-name="pathodb_embed"
#SBATCH --output="/storage/research/igmp_dp_workspace/garciabaroja_javier/PW_reports/database/pathodb/logs/pathodb_embed_%j.out"
#SBATCH --time=4:00:00
#SBATCH --mem=24G
#SBATCH --nodes=1
#SBATCH --account=invest
#SBATCH --partition=gpu-invest
#SBATCH --gres=gpu:rtx4090:1
#SBATCH --cpus-per-task=8
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
#   EMBED_BATCH         reports per DB commit       (default: 50)
#   EMBEDDING_DEVICE    cuda | cpu                  (default: cuda)
#   EMBEDDING_MODEL     HuggingFace model id        (default: from .env / config)
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
PGDATA="$PROJECT_DIR/pgdata"
ENV_FILE="$PROJECT_DIR/.env"

echo "=== PathoDB Embedding Worker ==="
echo "Started  : $(date)"
echo "Node     : $(hostname)"
echo ""

# ── Load modules ──────────────────────────────────────────────────────────────
module load Anaconda3
module load PostgreSQL
export PATH="/software.9/software/PostgreSQL/16.4-GCCcore-13.3.0/bin:$PATH"
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
# Use a distinct variable name — PGUSER is a psql env-var that would silently
# override the connecting username even on calls without -U, causing "superuser"
# psql commands to connect as the app user instead of the OS/cluster user.
APP_PGUSER="${POSTGRES_USER}"

# ── Manage PostgreSQL ─────────────────────────────────────────────────────────
# We track whether WE started the instance so we only stop it on exit if so.
PG_STARTED_BY_US=false

cleanup() {
    if [ "$PG_STARTED_BY_US" = true ]; then
        echo ""
        echo "Stopping PostgreSQL (started by this job)..."
        pg_ctl -D "$PGDATA" stop -m fast 2>/dev/null || true
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
if pg_isready -p "$PGPORT" -q 2>/dev/null; then
    echo "PostgreSQL is already running on port $PGPORT — reusing it."
else
    echo "Starting PostgreSQL..."
    pg_ctl -D "$PGDATA" -l "$PGDATA/logs/startup.log" start
    PG_STARTED_BY_US=true
    for i in $(seq 1 30); do
        pg_isready -p "$PGPORT" -q && echo "PostgreSQL ready after ${i}s." && break
        sleep 1
    done
    pg_isready -p "$PGPORT" -q || { echo "ERROR: PostgreSQL did not become ready in 30s"; exit 1; }
fi

# ── Ensure pgvector extension and report_embeddings table exist ───────────────
# Two privilege tiers:
#   • No -U (OS/cluster user = PostgreSQL superuser): CREATE EXTENSION vector
#   • -U $APP_PGUSER (app user):                     owns nothing here, so we
#     run everything as the superuser and GRANT DML to the app user.
# This avoids the "must be owner" and "permission denied to create extension"
# errors that occur when the app user runs the full schema.sql.
echo ""
echo "Ensuring pgvector extension is enabled (superuser)..."
psql -p "$PGPORT" -d "$PGDB" --set ON_ERROR_STOP=1 \
    -c "CREATE EXTENSION IF NOT EXISTS vector;" \
    && echo "  pgvector: OK" \
    || { echo "ERROR: could not create pgvector extension."; \
         echo "  Ensure the server-side pgvector library is installed and rerun."; exit 1; }

echo "Ensuring report_embeddings table and indexes exist..."
psql -p "$PGPORT" -d "$PGDB" --set ON_ERROR_STOP=1 <<SQL
CREATE TABLE IF NOT EXISTS report_embeddings (
    id            SERIAL      PRIMARY KEY,
    report_id     INTEGER     NOT NULL REFERENCES reports (id) ON DELETE CASCADE,
    submission_id INTEGER     NOT NULL REFERENCES submissions (id),
    chunk_index   INTEGER     NOT NULL DEFAULT 0,
    chunk_text    TEXT        NOT NULL,
    embedding     vector(768),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (report_id, chunk_index)
);
CREATE INDEX IF NOT EXISTS idx_report_embeddings_report_id
    ON report_embeddings (report_id);
CREATE INDEX IF NOT EXISTS idx_report_embeddings_submission
    ON report_embeddings (submission_id);
CREATE INDEX IF NOT EXISTS idx_report_embeddings_vec
    ON report_embeddings USING hnsw (embedding vector_cosine_ops);

-- Grant DML to the app user so embed_reports.py can INSERT/SELECT
GRANT SELECT, INSERT, UPDATE, DELETE
    ON report_embeddings TO ${APP_PGUSER};
GRANT USAGE, SELECT
    ON SEQUENCE report_embeddings_id_seq TO ${APP_PGUSER};
SQL
echo "  report_embeddings: OK"

# ── Install Python dependencies ───────────────────────────────────────────────
echo ""
echo "Installing/verifying API dependencies..."
pip install -q -r api/requirements.txt

# ── Configure embedding run ───────────────────────────────────────────────────
export EMBEDDING_DEVICE="${EMBEDDING_DEVICE:-cuda}"
REPORT_TYPE="${EMBED_REPORT_TYPE:-all}"

EXTRA_ARGS=()
if [ -n "${EMBED_LIMIT:-}" ]; then
    EXTRA_ARGS+=(--limit "$EMBED_LIMIT")
fi
EXTRA_ARGS+=(--report-batch "${EMBED_BATCH:-50}")

echo ""
echo "──────────────────────────────────────────────"
echo "  Embedding configuration"
echo "──────────────────────────────────────────────"
echo "  Report type     : $REPORT_TYPE"
echo "  Device          : $EMBEDDING_DEVICE"
echo "  Model           : ${EMBEDDING_MODEL:-BAAI/bge-base-en-v1.5}"
echo "  Batch (reports) : ${EMBED_BATCH:-50}"
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

PENDING=$(psql -p "$PGPORT" -U "$APP_PGUSER" -d "$PGDB" -At -c "
    SELECT COUNT(*)
    FROM reports r
    WHERE r.report_text IS NOT NULL
      AND length(trim(r.report_text)) > 0
      $REPORT_TYPE_COND
      AND NOT EXISTS (
          SELECT 1 FROM report_embeddings e WHERE e.report_id = r.id
      );
" 2>/dev/null || echo "?")

ALREADY=$(psql -p "$PGPORT" -U "$APP_PGUSER" -d "$PGDB" -At -c "
    SELECT COUNT(DISTINCT report_id) FROM report_embeddings;
" 2>/dev/null || echo "?")

TOTAL=$(psql -p "$PGPORT" -U "$APP_PGUSER" -d "$PGDB" -At -c "
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
    echo "Nothing to do — all reports are already embedded."
    exit 0
fi

# ── Run embedding worker ──────────────────────────────────────────────────────
echo "Starting embedding pipeline..."
echo ""

python api/workers/embed_reports.py \
    --report-type "$REPORT_TYPE" \
    "${EXTRA_ARGS[@]}"

# ── Post-run summary ──────────────────────────────────────────────────────────
echo ""
REMAINING=$(psql -p "$PGPORT" -U "$APP_PGUSER" -d "$PGDB" -At -c "
    SELECT COUNT(*)
    FROM reports r
    WHERE r.report_text IS NOT NULL
      AND length(trim(r.report_text)) > 0
      $REPORT_TYPE_COND
      AND NOT EXISTS (
          SELECT 1 FROM report_embeddings e WHERE e.report_id = r.id
      );
" 2>/dev/null || echo "?")

FINAL_EMBEDDED=$(psql -p "$PGPORT" -U "$APP_PGUSER" -d "$PGDB" -At -c "
    SELECT COUNT(DISTINCT report_id) FROM report_embeddings;
" 2>/dev/null || echo "?")

TOTAL_CHUNKS=$(psql -p "$PGPORT" -U "$APP_PGUSER" -d "$PGDB" -At -c "
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
