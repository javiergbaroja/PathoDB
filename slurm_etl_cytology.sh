#!/bin/bash
#SBATCH --mail-type=end,fail
#SBATCH --mail-user=javier.garcia@unibe.ch
#SBATCH --job-name="pathodb_etl_cyto"
#SBATCH --output="/storage/research/igmp_dp_workspace/garciabaroja_javier/PW_reports/database/pathodb/logs/pathodb_etl_cyto_%j.out"
#SBATCH --time=6:00:00
#SBATCH --mem=90G
#SBATCH --nodes=1
#SBATCH --account=invest
#SBATCH --gres=gpu:rtx4090:1
#SBATCH --partition=gpu-invest
#SBATCH --cpus-per-task=16
#SBATCH --qos=job_gpu_igmp-tru
# =============================================================================
# PathoDB CYTOLOGY ETL — SLURM job script
#
# Companion to slurm_etl.sh. Reconciles the PROBE layer of the cytology
# (Z-number) submissions, which are already present in the database (their
# patients/submissions/reports were loaded by the shared etl.py Phase 1).
#
# Cytology stops at the probe level — there are no blocks and no scans — so
# there is no per-year loop and no blocks/scans arguments. The probe and SNOMED
# exports are single files spanning all years (2011-2026).
#
# Before submitting:
#   1. Confirm the three input paths below.
#   2. Set DRY_RUN=true first to see the correction / insertion counts.
# =============================================================================

PG_ENV="/storage/research/igmp_dp_workspace/garciabaroja_javier/conda_envs/pathodb-pg"
PGDATA="/storage/research/igmp_dp_workspace/garciabaroja_javier/PW_reports/database/pathodb/pathodb_conda_data"
PG_BIN="$PG_ENV/bin"

# Clean stale PID if needed
PIDFILE="$PGDATA/postmaster.pid"
if [ -f "$PIDFILE" ]; then
    STORED_PID=$(head -1 "$PIDFILE")
    if ! kill -0 "$STORED_PID" 2>/dev/null; then
        echo "Removing stale PID file..."
        rm -f "$PIDFILE"
    fi
fi

set -euo pipefail

# ── Configuration — edit these ────────────────────────────────────────────────
PROJECT_DIR="/storage/research/igmp_dp_workspace/garciabaroja_javier/PW_reports/database/pathodb"
PROBES_XLSX="/storage/research/igmp_dp_workspace/garciabaroja_javier/PW_reports/Probes/cytology_2011-2026.xlsx"
SNOMED_XLSX="/storage/research/igmp_dp_workspace/garciabaroja_javier/PW_reports/SNOMED_codes/cytology_snomed.xlsx"
SNOMED_DICT="/storage/research/igmp_dp_workspace/garciabaroja_javier/PW_reports/SNOMED_codes/snomed_dict_en.json"

DRY_RUN=true   # Set to false to write to the database
# ─────────────────────────────────────────────────────────────────────────────

echo "=== PathoDB Cytology ETL Job ==="
echo "Started : $(date)"
echo "Node    : $(hostname)"
echo "DRY_RUN : $DRY_RUN"
echo ""

# Load modules
module load Anaconda3
source activate langchain

# Move into project directory so relative paths work
cd "$PROJECT_DIR"

# Load environment variables from .env
ENV_FILE="${PROJECT_DIR}/.env"
if [ ! -f "$ENV_FILE" ]; then
    echo "ERROR: .env not found in $PROJECT_DIR"
    exit 1
fi
export $(grep -v '^#' "$ENV_FILE" | xargs)

PGDB="${POSTGRES_DB}"
PGUSER="${POSTGRES_USER}"

# ── Start PostgreSQL ──────────────────────────────────────────────────────────
echo "Checking PostgreSQL server..."
PIDFILE="$PGDATA/postmaster.pid"
if [ -f "$PIDFILE" ]; then
    STORED_PID=$(head -1 "$PIDFILE")
    if ! kill -0 "$STORED_PID" 2>/dev/null; then
        echo "Stale PID file found (PID $STORED_PID is not running) — removing."
        rm -f "$PIDFILE"
    fi
fi

if "$PG_BIN/pg_ctl" -D "$PGDATA" status | grep -q "server is running"; then
    echo "Server is already running."
else
    echo "Server not running — starting..."
    "$PG_BIN/pg_ctl" -D "$PGDATA" -l "$PGDATA/logs/startup.log" start
    echo "Waiting for server to accept connections..."
    for i in $(seq 1 30); do
        if "$PG_BIN/pg_isready" -p "$PGPORT" -q; then
            echo "Server ready after ${i}s."
            break
        fi
        sleep 1
        if [ "$i" -eq 30 ]; then
            echo "ERROR: Server did not become ready in 30 seconds."
            echo "Check: $PGDATA/logs/startup.log"
            exit 1
        fi
    done
fi

# Disable timeouts for the ETL session
"$PG_BIN/psql" -p "$PGPORT" -d "$PGDB" -U "$PGUSER" -c "
    ALTER ROLE $PGUSER SET statement_timeout = 0;
    ALTER ROLE $PGUSER SET idle_in_transaction_session_timeout = 0;
    ALTER ROLE $PGUSER SET lock_timeout = 0;
"
echo "Timeouts disabled for ETL session."

# Keep-alive: ping the database every 2 minutes.
(
    while true; do
        sleep 120
        "$PG_BIN/pg_ctl" -D "$PGDATA" status > /dev/null 2>&1 || break
        "$PG_BIN/psql" -p "$PGPORT" -d "$PGDB" -U "$PGUSER" -c "SELECT 1;" > /dev/null 2>&1
    done
) &
KEEPALIVE_PID=$!
echo "Keep-alive process started (PID $KEEPALIVE_PID)"

# ── Install/update ETL dependencies ───────────────────────────────────────────
echo ""
echo "Installing ETL dependencies..."
pip install -q -r etl/requirements.txt

# ── Run cytology ETL ──────────────────────────────────────────────────────────
ETL_ARGS=(
    --probes      "$PROBES_XLSX"
    --snomed      "$SNOMED_XLSX"
    --snomed-dict "$SNOMED_DICT"
)

if [ "$DRY_RUN" = true ]; then
    ETL_ARGS+=(--dry-run)
    echo "Running cytology ETL in DRY RUN mode (no data will be written)..."
else
    echo "Running cytology ETL — writing to database..."
fi

echo ""
set +e
python etl/etl_cytology.py "${ETL_ARGS[@]}"
ETL_EXIT=$?
set -e

# ── Cleanup ───────────────────────────────────────────────────────────────────
kill "$KEEPALIVE_PID" 2>/dev/null || true
wait "$KEEPALIVE_PID" 2>/dev/null || true
echo "Keep-alive process stopped."

if [ "$ETL_EXIT" -ne 0 ]; then
    echo "ERROR: Cytology ETL exited with code $ETL_EXIT"
    exit "$ETL_EXIT"
fi

echo ""
echo "=== Cytology ETL Job Complete ==="
echo "Finished : $(date)"
