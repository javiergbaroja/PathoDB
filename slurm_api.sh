#!/bin/bash
#SBATCH --mail-type=end,fail
#SBATCH --mail-user=javier.garcia@unibe.ch
#SBATCH --job-name="pathodb_api"
#SBATCH --output="/storage/research/igmp_dp_workspace/garciabaroja_javier/PW_reports/database/pathodb/logs/pathodb_api_%j.out"
#SBATCH --time=2:00:00
#SBATCH --mem=50G
#SBATCH --nodes=1
#SBATCH --account=gratis
#SBATCH --partition=cpu-invest
#SBATCH --cpus-per-task=16
#SBATCH --qos=job_cpu_preemptable
# Send SIGTERM to the batch shell 120s before preemption/walltime kill, so
# PostgreSQL gets a clean shutdown instead of a SIGKILL mid-write (see _term_handler).
#SBATCH --signal=B:TERM@120

# SBATCH --time=8:00:00
# SBATCH --mem=90G
# SBATCH --nodes=1
# SBATCH --account=invest
# SBATCH --gres=gpu:rtx4090:1
# SBATCH --partition=gpu-invest
# SBATCH --cpus-per-task=16
# SBATCH --qos=job_gpu_igmp-tru

# SBATCH --time=6:00:00
# SBATCH --mem=50G
# SBATCH --nodes=1
# SBATCH --account=gratis
# SBATCH --partition=cpu-invest
# SBATCH --cpus-per-task=16
# SBATCH --qos=job_cpu_preemptable

# =============================================================================
# PathoDB API Server — SLURM job script
#
# NORMAL STARTUP (first time or after cluster maintenance):
#   sbatch slurm_api.sh
#
# RESTART AFTER CODE CHANGES:
#   bash scripts/start_api.sh [--build-frontend]
#   ↳ Never cancel manually when updating — use start_api.sh so auto-resubmit
#     is suppressed and the new code is picked up cleanly.
#
# USER ACCESS:
#   Users run `pathodb` on their local machine (set up once via setup_pathodb.sh)
#
# AGENT (on-demand only, uses 1 GPU):
#   bash scripts/start_vllm.sh
#
# =============================================================================

set -euo pipefail

PROJECT_DIR="/storage/research/igmp_dp_workspace/garciabaroja_javier/PW_reports/database/pathodb"
ENV_FILE="$PROJECT_DIR/.env"
API_PORT=8000
ADDR_FILE="$PROJECT_DIR/server_address.txt"
SUPPRESS_FILE="$PROJECT_DIR/.suppress_resubmit"
PG_ENV="/storage/research/igmp_dp_workspace/garciabaroja_javier/conda_envs/pathodb-pg"
PG_BIN="$PG_ENV/bin"

# ── Cleanup + optional self-resubmit on any exit ─────────────────────────────
_shutdown() {
    echo ""
    echo "=== PathoDB shutting down at $(date) ==="

    # Remove server address so clients know we're offline
    rm -f "$ADDR_FILE"

    kill "${OLLAMA_PID:-}" 2>/dev/null || true

    # -m fast + -w: roll back open transactions, write a shutdown checkpoint, and
    # WAIT for it to land. Without -w this returns before the checkpoint is durable,
    # which is how the control file can end up ahead of the WAL (corruption on 2026-07-30).
    "$PG_BIN/pg_ctl" -D "$PGDATA" stop -m fast -w -t 90 2>/dev/null || true

    # Self-resubmit unless explicitly suppressed (e.g. by start_api.sh)
    if [ -f "$SUPPRESS_FILE" ]; then
        echo "Suppress flag found — skipping auto-resubmit."
        rm -f "$SUPPRESS_FILE"
    else
        echo "Auto-resubmitting pathodb_api..."
        NEW_JOB=$(sbatch --parsable "$PROJECT_DIR/slurm_api.sh" 2>/dev/null || echo "FAILED")
        if [ "$NEW_JOB" != "FAILED" ]; then
            echo "✓ Resubmitted as job $NEW_JOB"
        else
            echo "✗ Resubmit failed — restart manually with: sbatch slurm_api.sh"
        fi
    fi
}
trap '_shutdown' EXIT

# ── Graceful handler for SLURM preemption / walltime (see --signal=B:TERM@120) ─
# Stops the API first, then falls through to _shutdown (via EXIT) which stops
# PostgreSQL cleanly. Without this, SLURM's SIGKILL leaves the WAL half-written.
_term_handler() {
    echo ""
    echo "=== SIGTERM received at $(date) — graceful shutdown ==="
    if [ -n "${API_PID:-}" ]; then
        kill -TERM "$API_PID" 2>/dev/null || true
        for _ in $(seq 1 30); do
            kill -0 "$API_PID" 2>/dev/null || break
            sleep 1
        done
        kill -KILL "$API_PID" 2>/dev/null || true
    fi
    exit 0
}
trap '_term_handler' TERM INT

# ── Load modules ──────────────────────────────────────────────────────────────
module load Anaconda3
module load PostgreSQL
export PATH="/software.9/software/PostgreSQL/16.4-GCCcore-13.3.0/bin:$PATH"
source activate langchain

cd "$PROJECT_DIR"

# ── Load environment ──────────────────────────────────────────────────────────
if [ ! -f "$ENV_FILE" ]; then
    echo "ERROR: .env not found at $ENV_FILE"
    exit 1
fi
set -a; source "$ENV_FILE"; set +a

if [ -z "${JWT_SECRET:-}" ]; then
    echo "ERROR: JWT_SECRET not set in .env"
    exit 1
fi

echo "=== PathoDB API Server ==="
echo "Started  : $(date)"
echo "Node     : $(hostname)"
echo "Port     : $API_PORT"
echo "Job ID   : $SLURM_JOB_ID"
echo ""

# ── Start PostgreSQL ──────────────────────────────────────────────────────────
PIDFILE="$PGDATA/postmaster.pid"
if [ -f "$PIDFILE" ]; then
    STORED_PID=$(head -1 "$PIDFILE")
    if ! kill -0 "$STORED_PID" 2>/dev/null; then
        echo "Removing stale PostgreSQL PID file..."
        rm -f "$PIDFILE"
    fi
fi

if "$PG_BIN/pg_ctl" -D "$PGDATA" status | grep -q "server is running"; then
    echo "PostgreSQL already running."
else
    echo "Starting PostgreSQL..."
    "$PG_BIN/pg_ctl" -D "$PGDATA" -l "$PGDATA/logs/startup.log" start
    for i in $(seq 1 30); do
        "$PG_BIN/pg_isready" -p "$PGPORT" -q && echo "PostgreSQL ready after ${i}s." && break
        sleep 1
    done
fi

"$PG_BIN/psql" -p "$PGPORT" -d postgres -c "ALTER USER ${POSTGRES_USER} WITH PASSWORD '${POSTGRES_PASSWORD}';" > /dev/null

# Configure PostgreSQL to accept intra-cluster connections (idempotent)
NODE_IP=$(hostname -I | awk '{print $1}')
CLUSTER_SUBNET=$(echo "$NODE_IP" | cut -d. -f1-2).0.0/16
if grep -q "^listen_addresses" "$PGDATA/postgresql.conf"; then
    sed -i "s/^listen_addresses.*/listen_addresses = '*'/" "$PGDATA/postgresql.conf"
else
    echo "listen_addresses = '*'" >> "$PGDATA/postgresql.conf"
fi
PG_HBA_RULE="host    all    ${POSTGRES_USER}    $CLUSTER_SUBNET    md5"
if ! grep -qF "$CLUSTER_SUBNET" "$PGDATA/pg_hba.conf"; then
    echo "$PG_HBA_RULE" >> "$PGDATA/pg_hba.conf"
fi
# listen_addresses requires a full restart, not just reload
"$PG_BIN/pg_ctl" -D "$PGDATA" restart -l "$PGDATA/logs/startup.log" > /dev/null
for i in $(seq 1 15); do
    "$PG_BIN/pg_isready" -p "$PGPORT" -q && break
    sleep 1
done

# ── Start Ollama (CPU) ────────────────────────────────────────────────────────
echo ""
echo "Starting Ollama (CPU mode)..."
export OLLAMA_MODELS="/storage/research/igmp_dp_workspace/garciabaroja_javier/ollama_models"
export OLLAMA_NUM_PARALLEL=1
export OLLAMA_HOST="127.0.0.1:11434"
export OLLAMA_NUM_THREADS=12   # leave 4 threads for FastAPI + PostgreSQL

~/opt/ollama/bin/ollama serve &
OLLAMA_PID=$!

for i in $(seq 1 30); do
    curl -s http://localhost:11434/api/tags > /dev/null 2>&1 && \
        echo "Ollama ready after ${i}s (CPU, ${OLLAMA_NUM_THREADS} threads)." && break
    sleep 1
done

# ── Write server address (atomic write to avoid partial reads) ────────────────
ADDR_TMP=$(mktemp "$PROJECT_DIR/.server_address.XXXXXX")
echo "$(hostname):${API_PORT}" > "$ADDR_TMP"
mv "$ADDR_TMP" "$ADDR_FILE"
echo ""
echo "Server address written → $ADDR_FILE"
echo "Users can now run: pathodb"
echo ""

# ── Start API server ──────────────────────────────────────────────────────────
echo "Starting FastAPI server..."
# python3 -m uvicorn api.main:app \
# Run in the background and `wait` on it: bash defers trap handlers until the
# current foreground command returns, so a foreground uvicorn would swallow the
# SIGTERM warning and leave no time for a clean PostgreSQL stop.
"/storage/research/igmp_slide_workspace/GRP Zlobec/Javier/conda_envs/langchain/bin/python3" -m uvicorn api.main:app \
    --host 0.0.0.0 \
    --port "$API_PORT" \
    --log-level info &
API_PID=$!

# `wait` returns as soon as a trapped signal arrives, so loop until it's really gone.
while kill -0 "$API_PID" 2>/dev/null; do
    wait "$API_PID" || true
done

echo ""
echo "=== API server exited at $(date) ==="