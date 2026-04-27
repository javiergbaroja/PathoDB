#!/bin/bash
#SBATCH --mail-type=end,fail
#SBATCH --mail-user=javier.garcia@unibe.ch
#SBATCH --job-name="pathodb_api"
#SBATCH --output="/storage/research/igmp_dp_workspace/garciabaroja_javier/PW_reports/database/pathodb/logs/pathodb_api_%j.out"
#SBATCH --time=2:00:00
#SBATCH --mem-per-cpu=24G
#SBATCH --account=gratis
#SBATCH --partition=cpu-invest
#SBATCH --cpus-per-task=2
#SBATCH --qos=job_cpu_preemptable


# =============================================================================
# PathoDB API Server — SLURM job script
#
# Before submitting:
#   1. Run create_admin.py once interactively to create the first admin user
#   2. Add JWT_SECRET and SCANNER_API_KEY to .env
#   3. Note which node the job runs on (printed below) for SSH tunnel setup
#
# SSH tunnel from your local machine (run after job starts):
#   ssh -L 8080:<NODE>:8000 <your-cluster-login>
#   Then open http://localhost:8080/docs
# =============================================================================

set -euo pipefail

PROJECT_DIR="/storage/research/igmp_dp_workspace/garciabaroja_javier/PW_reports/database/pathodb"
ENV_FILE="$PROJECT_DIR/.env"
API_PORT=8000

echo "=== PathoDB API Server ==="
echo "Started : $(date)"
echo "Node    : $(hostname)"
echo "Port    : $API_PORT"
echo ""
echo "To access the API, set up an SSH tunnel from your local machine:"
echo "  ssh -L 8080:$(hostname):${API_PORT} jg23p152@submit03.unibe.ch"
echo "  Then open: http://localhost:8080/docs"
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
# export $(grep -v '^#' "$ENV_FILE" | xargs)
set -a
source /storage/research/igmp_dp_workspace/garciabaroja_javier/PW_reports/database/pathodb/.env
set +a

PGDB="${POSTGRES_DB}"
PGUSER="${POSTGRES_USER}"

# ── Check JWT_SECRET is set ───────────────────────────────────────────────────
if [ -z "${JWT_SECRET:-}" ]; then
    echo "ERROR: JWT_SECRET not set in .env"
    echo "Generate one with: python3 -c \"import secrets; print(secrets.token_hex(32))\""
    exit 1
fi

# ── Start PostgreSQL if not running ───────────────────────────────────────────
PIDFILE="$PGDATA/postmaster.pid"
if [ -f "$PIDFILE" ]; then
    STORED_PID=$(head -1 "$PIDFILE")
    if ! kill -0 "$STORED_PID" 2>/dev/null; then
        echo "Removing stale PostgreSQL PID file..."
        rm -f "$PIDFILE"
    fi
fi

if pg_ctl -D "$PGDATA" status | grep -q "server is running"; then
    echo "PostgreSQL is already running."
else
    echo "Starting PostgreSQL..."
    pg_ctl -D "$PGDATA" -l "$PGDATA/logs/startup.log" start
    for i in $(seq 1 30); do
        pg_isready -p "$PGPORT" -q && echo "PostgreSQL ready after ${i}s." && break
        sleep 1
    done
fi

# ── Install API dependencies ──────────────────────────────────────────────────
echo ""
echo "Installing API dependencies..."
pip install -q -r api/requirements.txt

# ── Start API server ──────────────────────────────────────────────────────────
echo ""
echo "Starting FastAPI server..."
uvicorn api.main:app \
    --host 0.0.0.0 \
    --port "$API_PORT" \
    --workers 2 \
    --log-level info

echo ""
echo "=== API Server stopped ==="
echo "Finished : $(date)"
