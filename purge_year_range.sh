#!/bin/bash
#SBATCH --mail-type=end,fail
#SBATCH --mail-user=javier.garcia@unibe.ch
#SBATCH --job-name="pathodb_purge_json"
#SBATCH --output="/storage/research/igmp_dp_workspace/garciabaroja_javier/PW_reports/database/pathodb/logs/pathodb_purge_json_%j.out"
#SBATCH --time=6:00:00
#SBATCH --mem-per-cpu=75G
#SBATCH --account=gratis
#SBATCH --partition=cpu-invest
#SBATCH --cpus-per-task=1
#SBATCH --qos=job_cpu_preemptable
#SBATCH --dependency=afterany:1651725

# =============================================================================
# PathoDB JSON Purge — SLURM job script
# This script starts the local DB and purges submissions from a JSON file.
# =============================================================================

# ── Configuration ─────────────────────────────────────────────────────────────
JSON_FILE="/storage/research/igmp_dp_workspace/garciabaroja_javier/PW_reports/database/pathodb/to_delete.json"  # <-- UPDATE THIS PATH
DRY_RUN=false                          # Set to true for validation without deleting
KEEP_PATIENTS=false                    # Set to true to avoid deleting orphaned patients

PROJECT_DIR="/storage/research/igmp_dp_workspace/garciabaroja_javier/PW_reports/database/pathodb"
PGDATA="$PROJECT_DIR/pgdata"
ENV_FILE="$PROJECT_DIR/.env"
PYTHON_SCRIPT="/storage/research/igmp_dp_workspace/garciabaroja_javier/PW_reports/database/pathodb/purge_year_range.py"

export PATH="/software.9/software/PostgreSQL/16.4-GCCcore-13.3.0/bin:$PATH"

set -euo pipefail

echo "=== PathoDB JSON-Driven Purge ==="
echo "Started   : $(date)"
echo "Node      : $(hostname)"
echo "JSON File : ${JSON_FILE}"
echo "Mode      : $([ "$DRY_RUN" = true ] && echo 'DRY RUN' || echo 'LIVE DELETE')"
echo ""

# ── Environment Setup ─────────────────────────────────────────────────────────
module load Anaconda3
module load PostgreSQL
source activate langchain

cd "$PROJECT_DIR"

if [ ! -f "$ENV_FILE" ]; then
    echo "ERROR: .env not found in $PROJECT_DIR"
    exit 1
fi

if [ ! -f "$JSON_FILE" ]; then
    echo "ERROR: JSON file not found at $JSON_FILE"
    exit 1
fi

# Load environment variables
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

if pg_ctl -D "$PGDATA" status | grep -q "server is running"; then
    echo "Server is already running."
else
    echo "Server not running — starting..."
    pg_ctl -D "$PGDATA" -l "$PGDATA/logs/startup.log" start

    # Wait until server is ready
    for i in $(seq 1 30); do
        if pg_isready -p "$PGPORT" -q; then
            echo "Server ready after ${i}s."
            break
        fi
        sleep 1
        if [ "$i" -eq 30 ]; then
            echo "ERROR: Server did not become ready in 30 seconds."
            exit 1
        fi
    done
fi

# ── Keep-alive ───────────────────────────────────────────────────────────────
(
    while true; do
        sleep 120
        pg_ctl -D "$PGDATA" status > /dev/null 2>&1 || break
        psql -p "$PGPORT" -d "$PGDB" -U "$PGUSER" -c "SELECT 1;" > /dev/null 2>&1
    done
) &
KEEPALIVE_PID=$!
echo "Keep-alive process started (PID $KEEPALIVE_PID)"

# ── Run Purge ─────────────────────────────────────────────────────────────────
PURGE_ARGS=(
    "--json" "$JSON_FILE"
)

if [ "$DRY_RUN" = true ]; then
    PURGE_ARGS+=(--dry-run)
fi

if [ "$KEEP_PATIENTS" = true ]; then
    PURGE_ARGS+=(--keep-patients)
fi

PURGE_ARGS+=(--yes)

echo ""
echo "Running Python JSON purge script..."
python3 -u "$PYTHON_SCRIPT" "${PURGE_ARGS[@]}"
EXIT_CODE=$?

# ── Cleanup ───────────────────────────────────────────────────────────────────
kill "$KEEPALIVE_PID" 2>/dev/null
wait "$KEEPALIVE_PID" 2>/dev/null
echo "Keep-alive process stopped."

if [ $EXIT_CODE -ne 0 ]; then
    echo "ERROR: Purge script exited with code $EXIT_CODE"
    exit $EXIT_CODE
fi

echo ""
echo "=== Purge Job Complete ==="
echo "Finished : $(date)"