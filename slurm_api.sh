#!/bin/bash
#SBATCH --mail-type=end,fail
#SBATCH --mail-user=javier.garcia@unibe.ch
#SBATCH --job-name="pathodb_api"
#SBATCH --output="/storage/research/igmp_dp_workspace/garciabaroja_javier/PW_reports/database/pathodb/logs/pathodb_api_%j.out"
#SBATCH --time=8:00:00
#SBATCH --mem=90G
#SBATCH --nodes=1
#SBATCH --account=invest
#SBATCH --gres=gpu:rtx4090:1
#SBATCH --partition=gpu-invest
#SBATCH --cpus-per-task=16
#SBATCH --qos=job_gpu_igmp-tru

# =============================================================================
# PathoDB API Server — SLURM job script
#
# Before submitting:
#   1. Run create_admin.py once interactively to create the first admin user
#   2. Add JWT_SECRET and SCANNER_API_KEY to .env
#   3. Note which node the job runs on (printed below) for SSH tunnel setup
#
# If any changes are made to the API code, you can simply cancel the job and resubmit it:
#   scancel --name=pathodb_api && cd frontend && npm run build && cd .. && sbatch slurm_api.sh && squeue --me
#
# SSH tunnel from your local machine (run after job starts):
#   ssh -L 8080:<NODE>:8000 jg23p152@submit03.unibe.ch
#   Then open http://localhost:8080/docs
#
# =============================================================================

set -euo pipefail

# ── Paths — update PG_ENV if the conda env is ever moved ─────────────────────
PROJECT_DIR="/storage/research/igmp_dp_workspace/garciabaroja_javier/PW_reports/database/pathodb"
PG_ENV="/storage/research/igmp_dp_workspace/garciabaroja_javier/conda_envs/pathodb-pg"
PG_BIN="$PG_ENV/bin"
PGDATA="$PROJECT_DIR/pathodb_conda_data"
PGPORT=15432
ENV_FILE="$PROJECT_DIR/.env"
API_PORT=8000

# ── Shutdown hook — runs on EXIT or SLURM cancellation ───────────────────────
trap 'echo "Shutting down..."; kill $OLLAMA_PID 2>/dev/null; "$PG_BIN/pg_ctl" -D "$PGDATA" stop' EXIT

echo "=== PathoDB API Server ==="
echo "Started : $(date)"
echo "Node    : $(hostname)"
echo "Port    : $API_PORT"
echo ""
echo "To access the API, set up an SSH tunnel from your local machine:"
echo "  ssh -L 8080:$(hostname):${API_PORT} jg23p152@submit03.unibe.ch"
echo "  Then open: http://localhost:8080/docs"
echo ""

# ── Load modules — only Anaconda3 needed now (PostgreSQL module retired) ──────
module load Anaconda3
eval "$(conda shell.bash hook)"
conda activate langchain

# ── Move into project directory ───────────────────────────────────────────────
cd "$PROJECT_DIR"

# ── Load environment variables ────────────────────────────────────────────────
if [ ! -f "$ENV_FILE" ]; then
    echo "ERROR: .env not found at $ENV_FILE"
    exit 1
fi
set -a
source "$ENV_FILE"
set +a

PGDB="${POSTGRES_DB}"
PGUSER="${POSTGRES_USER}"

# ── Validate required secrets ─────────────────────────────────────────────────
if [ -z "${JWT_SECRET:-}" ]; then
    echo "ERROR: JWT_SECRET not set in .env"
    echo "Generate one with: python3 -c \"import secrets; print(secrets.token_hex(32))\""
    exit 1
fi

# ── Start PostgreSQL if not already running ───────────────────────────────────
PIDFILE="$PGDATA/postmaster.pid"
if [ -f "$PIDFILE" ]; then
    STORED_PID=$(head -1 "$PIDFILE")
    if ! kill -0 "$STORED_PID" 2>/dev/null; then
        echo "Removing stale PostgreSQL PID file (PID $STORED_PID is not running)..."
        rm -f "$PIDFILE"
    fi
fi

if "$PG_BIN/pg_ctl" -D "$PGDATA" status | grep -q "server is running"; then
    echo "PostgreSQL is already running."
else
    echo "Starting PostgreSQL (conda cluster at $PGDATA)..."
    "$PG_BIN/pg_ctl" -D "$PGDATA" -l "$PGDATA/logs/startup.log" start

    echo "Waiting for PostgreSQL to accept connections..."
    for i in $(seq 1 30); do
        "$PG_BIN/pg_isready" -h localhost -p "$PGPORT" -q && \
            echo "PostgreSQL ready after ${i}s." && break
        sleep 1
        if [ "$i" -eq 30 ]; then
            echo "ERROR: PostgreSQL did not become ready in 30 seconds."
            echo "Check: $PGDATA/logs/startup.log"
            exit 1
        fi
    done
fi

# ── Sync DB password with .env ────────────────────────────────────────────────
echo "Syncing database password..."
"$PG_BIN/psql" -h localhost -p "$PGPORT" -U "$PGUSER" -d postgres \
    -c "ALTER USER ${PGUSER} WITH PASSWORD '${POSTGRES_PASSWORD}';"

# ── Configure network access for cluster nodes ────────────────────────────────
NODE_IP=$(hostname -I | awk '{print $1}')
CLUSTER_SUBNET=$(echo "$NODE_IP" | cut -d. -f1-2).0.0/16

echo "Configuring PostgreSQL to accept cluster connections from $CLUSTER_SUBNET..."

if grep -q "^listen_addresses" "$PGDATA/postgresql.conf"; then
    sed -i "s/^listen_addresses.*/listen_addresses = '*'/" "$PGDATA/postgresql.conf"
else
    echo "listen_addresses = '*'" >> "$PGDATA/postgresql.conf"
fi

PG_HBA_RULE="host    all    $PGUSER    $CLUSTER_SUBNET    md5"
if ! grep -qF "$CLUSTER_SUBNET" "$PGDATA/pg_hba.conf"; then
    echo "$PG_HBA_RULE" >> "$PGDATA/pg_hba.conf"
    echo "Added pg_hba rule: $PG_HBA_RULE"
fi

"$PG_BIN/pg_ctl" -D "$PGDATA" restart

# Wait for PostgreSQL to be ready again after restart
for i in $(seq 1 30); do
    "$PG_BIN/pg_isready" -h localhost -p "$PGPORT" -q && \
        echo "PostgreSQL ready after restart (${i}s)." && break
    sleep 1
done

echo "PostgreSQL listening on $NODE_IP:$PGPORT"

# ── Install API dependencies ──────────────────────────────────────────────────
# echo ""
# echo "Installing API dependencies..."
# pip install -q -r api/requirements.txt

# ── Start Ollama ──────────────────────────────────────────────────────────────
echo ""
echo "Starting Ollama..."
export OLLAMA_MODELS="/storage/research/igmp_dp_workspace/garciabaroja_javier/ollama_models"
export OLLAMA_NUM_PARALLEL=1
export OLLAMA_HOST="127.0.0.1:11434"

~/opt/ollama/bin/ollama serve &
OLLAMA_PID=$!

echo "Waiting for Ollama to be ready..."
for i in $(seq 1 30); do
    curl -s http://localhost:11434/api/tags > /dev/null 2>&1 && \
        echo "Ollama ready after ${i}s." && break
    sleep 1
done

echo "Ollama running on $(hostname):11434 (PID $OLLAMA_PID)"
sleep 2

# ── Start API server ──────────────────────────────────────────────────────────
echo ""
echo "Starting FastAPI server..."
python3 -m uvicorn api.main:app \
    --host 0.0.0.0 \
    --port "$API_PORT" \
    --log-level info
    # --workers 4   # Uncomment for multi-worker (requires gunicorn or stateless sessions)

echo ""
echo "=== API Server stopped ==="
echo "Finished : $(date)"



# #!/bin/bash
# #SBATCH --mail-type=end,fail
# #SBATCH --mail-user=javier.garcia@unibe.ch
# #SBATCH --job-name="pathodb_api"
# #SBATCH --output="/storage/research/igmp_dp_workspace/garciabaroja_javier/PW_reports/database/pathodb/logs/pathodb_api_%j.out"
# #SBATCH --time=8:00:00
# #SBATCH --mem=90G
# #SBATCH --nodes=1
# #SBATCH --account=invest
# #SBATCH --gres=gpu:rtx4090:1
# #SBATCH --partition=gpu-invest
# #SBATCH --cpus-per-task=16
# #SBATCH --qos=job_gpu_igmp-tru


# # =============================================================================
# # PathoDB API Server — SLURM job script
# #
# # Before submitting:
# #   1. Run create_admin.py once interactively to create the first admin user
# #   2. Add JWT_SECRET and SCANNER_API_KEY to .env
# #   3. Note which node the job runs on (printed below) for SSH tunnel setup
# #
# # If any changes are made to the API code, you can simply cancel the job and resubmit it.
# #   scancel --name=pathodb_api && cd frontend && npm run build && cd .. && sbatch slurm_api.sh && squeue --me
# #
# # SSH tunnel from your local machine (run after job starts):
# #   ssh -L 8080:<NODE>:8000 <your-cluster-login>
# #   Then open http://localhost:8080/docs
# # 
# # =============================================================================

# set -euo pipefail
# trap 'echo "Shutting down..."; kill $OLLAMA_PID 2>/dev/null; pg_ctl -D "$PGDATA" stop' EXIT

# PROJECT_DIR="/storage/research/igmp_dp_workspace/garciabaroja_javier/PW_reports/database/pathodb"
# ENV_FILE="$PROJECT_DIR/.env"
# API_PORT=8000

# echo "=== PathoDB API Server ==="
# echo "Started : $(date)"
# echo "Node    : $(hostname)"
# echo "Port    : $API_PORT"
# echo ""
# echo "To access the API, set up an SSH tunnel from your local machine:"
# echo "  ssh -L 8080:$(hostname):${API_PORT} jg23p152@submit03.unibe.ch"
# echo "  Then open: http://localhost:8080/docs"
# echo ""

# # ── Load modules ──────────────────────────────────────────────────────────────
# module load Anaconda3
# module load PostgreSQL
# export PATH="/software.9/software/PostgreSQL/16.4-GCCcore-13.3.0/bin:$PATH"
# source activate langchain

# # ── Move into project directory ───────────────────────────────────────────────
# cd "$PROJECT_DIR"

# # ── Load environment ──────────────────────────────────────────────────────────
# if [ ! -f "$ENV_FILE" ]; then
#     echo "ERROR: .env not found at $ENV_FILE"
#     exit 1
# fi
# # export $(grep -v '^#' "$ENV_FILE" | xargs)
# set -a
# source /storage/research/igmp_dp_workspace/garciabaroja_javier/PW_reports/database/pathodb/.env
# set +a

# PGDB="${POSTGRES_DB}"
# PGUSER="${POSTGRES_USER}"

# # ── Check JWT_SECRET is set ───────────────────────────────────────────────────
# if [ -z "${JWT_SECRET:-}" ]; then
#     echo "ERROR: JWT_SECRET not set in .env"
#     echo "Generate one with: python3 -c \"import secrets; print(secrets.token_hex(32))\""
#     exit 1
# fi

# # ── Start PostgreSQL if not running ───────────────────────────────────────────
# PIDFILE="$PGDATA/postmaster.pid"
# if [ -f "$PIDFILE" ]; then
#     STORED_PID=$(head -1 "$PIDFILE")
#     if ! kill -0 "$STORED_PID" 2>/dev/null; then
#         echo "Removing stale PostgreSQL PID file..."
#         rm -f "$PIDFILE"
#     fi
# fi

# if pg_ctl -D "$PGDATA" status | grep -q "server is running"; then
#     echo "PostgreSQL is already running."
# else
#     echo "Starting PostgreSQL..."
#     pg_ctl -D "$PGDATA" -l "$PGDATA/logs/startup.log" start
#     for i in $(seq 1 30); do
#         pg_isready -p "$PGPORT" -q && echo "PostgreSQL ready after ${i}s." && break
#         sleep 1
#     done
# fi
# echo "Syncing database password with .env file..."
# psql -p "$PGPORT" -d postgres -c "ALTER USER ${PGUSER} WITH PASSWORD '${POSTGRES_PASSWORD}';"
# # "PG_BIN/psql" -h localhost -p 15432 -U jg23p152 -d pathodb -f db/schema.sql

# NODE_IP=$(hostname -I | awk '{print $1}')
# CLUSTER_SUBNET=$(echo "$NODE_IP" | cut -d. -f1-2).0.0/16

# echo "Configuring PostgreSQL to accept cluster connections from $CLUSTER_SUBNET..."

# # Set listen_addresses = '*' (update existing line or append)
# if grep -q "^listen_addresses" "$PGDATA/postgresql.conf"; then
#     sed -i "s/^listen_addresses.*/listen_addresses = '*'/" "$PGDATA/postgresql.conf"
# else
#     echo "listen_addresses = '*'" >> "$PGDATA/postgresql.conf"
# fi

# # Add pg_hba rule for the cluster subnet (idempotent)
# PG_HBA_RULE="host    all    $PGUSER    $CLUSTER_SUBNET    md5"
# if ! grep -qF "$CLUSTER_SUBNET" "$PGDATA/pg_hba.conf"; then
#     echo "$PG_HBA_RULE" >> "$PGDATA/pg_hba.conf"
#     echo "Added pg_hba rule: $PG_HBA_RULE"
# fi

# # Reload config (no full restart needed)
# pg_ctl -D "$PGDATA" restart
# echo "PostgreSQL reloaded — now listening on $NODE_IP:$API_PORT"


# # ── Install API dependencies ──────────────────────────────────────────────────
# echo ""
# echo "Installing API dependencies..."
# pip install -q -r api/requirements.txt

# # ── Start Ollama ──────────────────────────────────────────────────────────────
# echo ""
# echo "Starting Ollama..."
# export OLLAMA_MODELS="/storage/research/igmp_dp_workspace/garciabaroja_javier/ollama_models"
# export OLLAMA_NUM_PARALLEL=1
# export OLLAMA_HOST="127.0.0.1:11434"

# ~/opt/ollama/bin/ollama serve &
# OLLAMA_PID=$!

# # Wait for Ollama to be ready
# for i in $(seq 1 30); do
#     curl -s http://localhost:11434/api/tags > /dev/null 2>&1 && \
#         echo "Ollama ready after ${i}s." && break
#     sleep 1
# done

# echo "Ollama running on $(hostname):11434 (PID $OLLAMA_PID)"
# sleep 2
# # ── Start API server ──────────────────────────────────────────────────────────
# echo ""
# echo "Starting FastAPI server..."
# python3 -m uvicorn api.main:app \
#     --host 0.0.0.0 \
#     --port "$API_PORT" \
#     --log-level info \
#     # --workers 4 

# echo ""
# echo "=== API Server stopped ==="
# echo "Finished : $(date)"
