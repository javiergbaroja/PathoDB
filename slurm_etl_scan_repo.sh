#!/bin/bash
#SBATCH --mail-type=end,fail
#SBATCH --mail-user=javier.garcia@unibe.ch
#SBATCH --job-name="scan_repo_etl"
#SBATCH --output="/storage/research/igmp_dp_workspace/garciabaroja_javier/PW_reports/database/pathodb/logs/scan_repo_etl_%j.out"
#SBATCH --time=6:00:00
#SBATCH --mem-per-cpu=24G
#SBATCH --account=gratis
#SBATCH --partition=cpu-invest
#SBATCH --cpus-per-task=1
#SBATCH --qos=job_cpu_preemptable

# =============================================================================
# Scan Repo Registration — SLURM job script
#
# Before submitting:
#   1. Edit the SLIDES_EXCEL path below to point to your research Excel file.
#   2. Adjust the PATH_TO_SCRIPT if etl_scan_repo.py is not in PROJECT_DIR.
#   3. Choose DRY_RUN=true for a first validation pass.
# =============================================================================

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
# Update this path to point to the actual Excel file for non-standard slides
SLIDES_EXCEL="/storage/research/igmp_slide_workspace/GRP Zlobec/Bern_Cohort_2021/Bern_Cohort_Lists/slide_lists/slide_repository_bern_cohort.xlsx" 

DRY_RUN=false   # Set to true for validation without writing to DB
VERBOSE=true    # Set to true to print row-by-row outcomes
# ─────────────────────────────────────────────────────────────────────────────

echo "=== Scan Repo Registration Job ==="
echo "Started : $(date)"
echo "Node    : $(hostname)"
echo "DRY_RUN : $DRY_RUN"
echo "VERBOSE : $VERBOSE"
echo "EXCEL   : $SLIDES_EXCEL"
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
if [ ! -f "$PROJECT_DIR/.env" ]; then
    echo "ERROR: .env not found in $PROJECT_DIR"
    echo "Run setup_postgres_hpc.sh first, then edit .env with your password."
    exit 1
fi
export $(grep -v '^#' "$PROJECT_DIR/.env" | xargs)

# Alias .env variable names to what the script uses
PGDB="${POSTGRES_DB}"
PGUSER="${POSTGRES_USER}"

# ── Start PostgreSQL ──────────────────────────────────────────────────────────
echo "Checking PostgreSQL server..."

# Clean up stale PID file again just in case
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
(
    while true; do
        sleep 120
        pg_ctl -D "$PGDATA" status > /dev/null 2>&1 || break
        psql -p "$PGPORT" -d "$PGDB" -U "$PGUSER" -c "SELECT 1;" > /dev/null 2>&1
    done
) &
KEEPALIVE_PID=$!
echo "Keep-alive process started (PID $KEEPALIVE_PID)"

# ── Install/update dependencies ───────────────────────────────────────────────
# echo ""
# echo "Installing/verifying python dependencies..."
# Assuming requirements are already satisfied by the langchain env, 
# but uncomment the line below if a requirements.txt needs to be run.
# pip install -q pandas openpyxl psycopg2-binary python-dotenv

# ── Run Script ────────────────────────────────────────────────────────────────
ETL_ARGS=(
    --excel "$SLIDES_EXCEL"
    --env-file "$PROJECT_DIR/.env"
)

if [ "$DRY_RUN" = true ]; then
    ETL_ARGS+=(--dry-run)
    echo "Running script in DRY RUN mode (no data will be written)..."
fi

if [ "$VERBOSE" = true ]; then
    ETL_ARGS+=(--verbose)
fi

echo ""
# NOTE: Update the path to etl_scan_repo.py if it is inside a subfolder (like etl/etl_scan_repo.py)
python3 -u "/storage/research/igmp_dp_workspace/garciabaroja_javier/PW_reports/database/pathodb/etl/etl_scan_repo.py" "${ETL_ARGS[@]}"
ETL_EXIT=$?

# ── Cleanup ───────────────────────────────────────────────────────────────────
# Stop the keep-alive process now that the script is done
kill "$KEEPALIVE_PID" 2>/dev/null
wait "$KEEPALIVE_PID" 2>/dev/null
echo "Keep-alive process stopped."

if [ $ETL_EXIT -ne 0 ]; then
    echo "ERROR: Script exited with code $ETL_EXIT"
    exit $ETL_EXIT
fi

echo ""
echo "=== Registration Job Complete ==="
echo "Finished : $(date)"