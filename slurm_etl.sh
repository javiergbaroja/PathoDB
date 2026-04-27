#!/bin/bash
#SBATCH --mail-type=end,fail
#SBATCH --mail-user=javier.garcia@unibe.ch
#SBATCH --job-name="pathodb_etl"
#SBATCH --output="/storage/research/igmp_dp_workspace/garciabaroja_javier/PW_reports/database/pathodb/logs/pathodb_etl_%j.out"
#SBATCH --time=6:00:00
#SBATCH --mem-per-cpu=24G
#SBATCH --account=gratis
#SBATCH --partition=cpu-invest
#SBATCH --cpus-per-task=1
#SBATCH --qos=job_cpu_preemptable
#SBATCH --dependency=afterany:1651725
# =============================================================================
# PathoDB ETL — SLURM job script
#
# Before submitting:
#   1. Run setup_postgres_hpc.sh once interactively to initialise the database
#   2. Edit .env (change passwords)
#   3. Edit the DATA_DIR path below to point to your CSV files
#   4. Choose DRY_RUN=true for a first validation pass
# =============================================================================
YEAR=2007   # Only used for naming log files, doesn't affect ETL logic

export PATH="/software.9/software/PostgreSQL/16.4-GCCcore-13.3.0/bin:$PATH"
PGDATA="/storage/research/igmp_dp_workspace/garciabaroja_javier/PW_reports/database/pathodb/pgdata"

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
DATA_DIR="/storage/research/igmp_dp_workspace/garciabaroja_javier/PW_reports/database/pathodb/data"
SUBMISSIONS_CSV="/storage/research/igmp_dp_workspace/garciabaroja_javier/PW_reports/Reports/search_${YEAR}_en_consolidated.csv"
BLOCKS_CSV="/storage/research/igmp_dp_workspace/garciabaroja_javier/PW_reports/Reports/search_${YEAR}_en_consolidated_blocks_processed.csv"
SCANS_CSV="/storage/research/igmp_dp_workspace/garciabaroja_javier/PW_reports/slide_df_valid.csv"
# SUBMISSIONS_CSV="/storage/research/igmp_dp_workspace/garciabaroja_javier/PW_reports/Reports/search_${YEAR}_en_consolidated.xlsx"
# BLOCKS_CSV="/storage/research/igmp_dp_workspace/garciabaroja_javier/PW_reports/Blocks/search_${YEAR}_final_expanded_en.xlsx"
# SCANS_CSV="/storage/research/igmp_dp_workspace/garciabaroja_javier/PW_reports/slide_df_valid.csv"

DRY_RUN=false   # Set to true for validation without writing to DB
# ─────────────────────────────────────────────────────────────────────────────

echo "=== PathoDB ETL Job ==="
echo "Started : $(date)"
echo "Node    : $(hostname)"
echo "DRY_RUN : $DRY_RUN"
echo ""

# Load modules
module load Anaconda3
module load PostgreSQL

# Ensure PostgreSQL binaries are in PATH regardless of module behaviour
export PATH="/software.9/software/PostgreSQL/16.4-GCCcore-13.3.0/bin:$PATH"

# Activate conda environment
source activate langchain

# Move into project directory so relative paths work
cd "$PROJECT_DIR"

# Load environment variables from .env
if [ ! -f "/storage/research/igmp_dp_workspace/garciabaroja_javier/PW_reports/database/pathodb/.env" ]; then
    echo "ERROR: .env not found in $PROJECT_DIR"
    echo "Run setup_postgres_hpc.sh first, then edit .env with your password."
    exit 1
fi
export $(grep -v '^#' /storage/research/igmp_dp_workspace/garciabaroja_javier/PW_reports/database/pathodb/.env | xargs)

# Alias .env variable names to what the script uses
PGDB="${POSTGRES_DB}"
PGUSER="${POSTGRES_USER}"

# ── Start PostgreSQL ──────────────────────────────────────────────────────────
echo "Checking PostgreSQL server..."

# Clean up stale PID file if the process it references is no longer running.
# This happens when a previous SLURM job was killed without a clean shutdown.
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

    # Wait until server is actually accepting connections (up to 30s)
    echo "Waiting for server to accept connections..."
    for i in $(seq 1 30); do
        if pg_isready -p "$PGPORT" -q; then
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
psql -p "$PGPORT" -d "$PGDB" -U "$PGUSER" -c "
    ALTER ROLE $PGUSER SET statement_timeout = 0;
    ALTER ROLE $PGUSER SET idle_in_transaction_session_timeout = 0;
    ALTER ROLE $PGUSER SET lock_timeout = 0;
"
echo "Timeouts disabled for ETL session."

# Keep-alive: ping the database every 2 minutes.
# Explicitly specifies -d and -U to avoid defaulting to the Unix username.
(
    while true; do
        sleep 120
        pg_ctl -D "$PGDATA" status > /dev/null 2>&1 || break
        psql -p "$PGPORT" -d "$PGDB" -U "$PGUSER" -c "SELECT 1;" > /dev/null 2>&1
    done
) &
KEEPALIVE_PID=$!
echo "Keep-alive process started (PID $KEEPALIVE_PID)"

# ── Install/update ETL dependencies ───────────────────────────────────────────
echo ""
echo "Installing ETL dependencies..."
pip install -q -r etl/requirements.txt

# ── Run ETL ───────────────────────────────────────────────────────────────────
ETL_ARGS=(
    --submissions "$SUBMISSIONS_CSV"
    --blocks      "$BLOCKS_CSV"
    --scans       "$SCANS_CSV"
    --year        "$YEAR"
)

if [ "$DRY_RUN" = true ]; then
    ETL_ARGS+=(--dry-run)
    echo "Running ETL in DRY RUN mode (no data will be written)..."
else
    echo "Running ETL — writing to database..."
fi

echo ""
python etl/etl.py "${ETL_ARGS[@]}"
ETL_EXIT=$?

# ── Cleanup ───────────────────────────────────────────────────────────────────
# Stop the keep-alive process now that ETL is done
kill "$KEEPALIVE_PID" 2>/dev/null
wait "$KEEPALIVE_PID" 2>/dev/null
echo "Keep-alive process stopped."

if [ $ETL_EXIT -ne 0 ]; then
    echo "ERROR: ETL exited with code $ETL_EXIT"
    exit $ETL_EXIT
fi

echo ""
echo "=== ETL Job Complete ==="
echo "Finished : $(date)"