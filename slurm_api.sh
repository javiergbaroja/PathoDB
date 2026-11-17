#!/bin/bash
#SBATCH --mail-type=end,fail
#SBATCH --mail-user=javier.garcia@unibe.ch
#SBATCH --job-name="pathodb_api"
#SBATCH --output="/storage/research/igmp_dp_workspace/garciabaroja_javier/PW_reports/database/pathodb/logs/pathodb_api_%j.out"
#SBATCH --time=4:00:00
#SBATCH --mem=50G
#SBATCH --nodes=1
#SBATCH --account=gratis
#SBATCH --partition=cpu-invest
#SBATCH --cpus-per-task=16
#SBATCH --qos=job_cpu_preemptable
# Send SIGTERM to the batch shell 120s before preemption/walltime kill, so
# PostgreSQL gets a clean shutdown instead of a SIGKILL mid-write (see _term_handler).
#SBATCH --signal=B:TERM@120
# Only one pathodb_api job may RUN at a time. A duplicate that slips through is
# held PENDING (Reason=Dependency) until the current one ends, instead of racing
# it for port 8000 and $PGDATA.
#SBATCH --dependency=singleton
# The cluster has PreemptMode=REQUEUE: without this, a preemption would requeue
# THIS job *and* _shutdown would submit a new one — two servers on one $PGDATA.
# Restarts are owned solely by _shutdown below.
#SBATCH --no-requeue

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
# CHECK FOR DUPLICATES:
#   bash scripts/start_api.sh --status
#   ↳ There must be exactly one pathodb_api job. Two of them share one $PGDATA
#     and one port, and the loser used to shut the live database down on its way
#     out — see the guards at the top of the script body.
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

# A job only restarts the service, and only stops PostgreSQL, once it has taken
# ownership below. Until then both are off, so an accidental duplicate exits
# without touching the live server's $PGDATA or spawning a successor.
OWNS_SERVICE=0
OWNS_PG=0
GOT_SIGTERM=0
START_EPOCH=$(date +%s)
# A server killed sooner than this didn't lose a race with the scheduler — it hit
# a startup error that a restart would hit again. Resubmitting on that is what
# turns one bad start into an unbounded chain of jobs.
MIN_UPTIME_FOR_RESUBMIT=180

# ── Refuse to run as a second copy ────────────────────────────────────────────
# --dependency=singleton normally prevents this, but a job submitted before that
# flag existed, or by a bare `sbatch`, can still land here. Bail out *before* the
# EXIT trap is installed: no PostgreSQL shutdown, no resubmit, nothing to clean up.
OTHER_JOBS=$(squeue --me --name=pathodb_api --states=RUNNING --noheader --format="%i" 2>/dev/null \
             | grep -vx "${SLURM_JOB_ID:-}" || true)
if [ -n "$OTHER_JOBS" ]; then
    echo "=== Refusing to start: pathodb_api already running as job(s) $(echo $OTHER_JOBS) ==="
    echo "This job ($SLURM_JOB_ID) is a duplicate and is exiting without resubmitting."
    echo "To restart the server, use: bash scripts/start_api.sh"
    exit 0
fi

# Same check for a server that isn't a SLURM job of ours (manual uvicorn, leftover
# process). Must stay ahead of the PostgreSQL section: once this job restarts the
# shared $PGDATA it has already pulled the database out from under whoever is live.
if (exec 3<>"/dev/tcp/127.0.0.1/${API_PORT}") 2>/dev/null; then
    exec 3>&- 2>/dev/null || true
    echo "=== Refusing to start: port $API_PORT is already in use on $(hostname) ==="
    echo "This job ($SLURM_JOB_ID) is exiting without resubmitting."
    exit 0
fi

# ── Collapse any queued duplicates ────────────────────────────────────────────
# singleton *queues* extra submissions rather than rejecting them, so stray jobs
# would otherwise sit in PENDING and each take a turn as the server later on.
# This job passed the guards and is the server now, so the queue behind it should
# be empty. Safe against two jobs cancelling each other: only PENDING jobs are
# touched, and singleton means no second job is ever RUNNING here.
STALE_PENDING=$(squeue --me --name=pathodb_api --states=PENDING --noheader --format="%i" 2>/dev/null \
                | grep -vx "${SLURM_JOB_ID:-}" || true)
if [ -n "$STALE_PENDING" ]; then
    echo "Cancelling queued duplicate job(s): $(echo $STALE_PENDING)"
    scancel $STALE_PENDING 2>/dev/null || true
fi

# ── Cleanup + optional self-resubmit on any exit ─────────────────────────────
_shutdown() {
    echo ""
    echo "=== PathoDB shutting down at $(date) ==="

    # Remove server address so clients know we're offline
    rm -f "$ADDR_FILE"

    kill "${OLLAMA_PID:-}" 2>/dev/null || true

    if [ "$OWNS_PG" = 1 ]; then
        # -m fast + -w: roll back open transactions, write a shutdown checkpoint, and
        # WAIT for it to land. Without -w this returns before the checkpoint is durable,
        # which is how the control file can end up ahead of the WAL (corruption on 2026-07-30).
        "$PG_BIN/pg_ctl" -D "$PGDATA" stop -m fast -w -t 90 2>/dev/null || true
    else
        echo "PostgreSQL not started by this job — leaving it alone."
    fi

    # ── Restart decision ──────────────────────────────────────────────────────
    UPTIME=$(( $(date +%s) - START_EPOCH ))

    if [ -f "$SUPPRESS_FILE" ] && grep -qx "${SLURM_JOB_ID:-}" "$SUPPRESS_FILE" 2>/dev/null; then
        # start_api.sh lists the job ids it is cancelling, so a cancelled job
        # stays down while unrelated jobs keep their right to restart.
        echo "Job $SLURM_JOB_ID is in the suppress list — skipping auto-resubmit."
    elif [ "$GOT_SIGTERM" = 1 ]; then
        # Preemption or walltime, at any stage of startup: the scheduler ended a
        # healthy job, so a successor is exactly what's wanted. Checked before the
        # guards below so a preemption mid-startup still comes back.
        echo "Auto-resubmitting after SIGTERM (uptime ${UPTIME}s)..."
        _resubmit
    elif [ "$OWNS_SERVICE" != 1 ]; then
        echo "Died before the API server started — skipping auto-resubmit."
        echo "Fix the error above, then: bash scripts/start_api.sh"
    elif [ "$UPTIME" -lt "$MIN_UPTIME_FOR_RESUBMIT" ]; then
        echo "Exited after ${UPTIME}s without SIGTERM — looks like a startup failure,"
        echo "not preemption. Skipping auto-resubmit to avoid a restart loop."
        echo "Fix the error above, then: bash scripts/start_api.sh"
    else
        echo "Auto-resubmitting pathodb_api (uptime ${UPTIME}s, clean API exit)..."
        _resubmit
    fi
}

_resubmit() {
    # Never stack successors. If anything else is already queued or running under
    # this name, that job *is* the successor — submitting another is how a standing
    # queue of pending jobs builds up, one per generation, that never drains.
    QUEUED=$(squeue --me --name=pathodb_api --noheader --format="%i" 2>/dev/null \
             | grep -vx "${SLURM_JOB_ID:-}" || true)
    if [ -n "$QUEUED" ]; then
        echo "✓ Successor already queued as job(s) $(echo $QUEUED) — not submitting another."
        return
    fi

    # The successor inherits --dependency=singleton, so it waits in PENDING until
    # this job is fully gone rather than starting alongside it.
    NEW_JOB=$(sbatch --parsable "$PROJECT_DIR/slurm_api.sh" 2>/dev/null || echo "FAILED")
    if [ "$NEW_JOB" != "FAILED" ]; then
        echo "✓ Resubmitted as job $NEW_JOB"
    else
        echo "✗ Resubmit failed — restart manually with: bash scripts/start_api.sh"
    fi
}
trap '_shutdown' EXIT

# ── Graceful handler for SLURM preemption / walltime (see --signal=B:TERM@120) ─
# Stops the API first, then falls through to _shutdown (via EXIT) which stops
# PostgreSQL cleanly. Without this, SLURM's SIGKILL leaves the WAL half-written.
_term_handler() {
    GOT_SIGTERM=1
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

# From here on this job is responsible for stopping PostgreSQL. The guard above
# has established there is no other pathodb_api job, so a postmaster already up
# is an orphan from a previous generation and ours to adopt (and to shut down).
OWNS_PG=1

if "$PG_BIN/pg_ctl" -D "$PGDATA" status | grep -q "server is running"; then
    echo "PostgreSQL already running — adopting it."
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
# Keep this low. At 12 threads generation ranged from 0.3 to 27 tok/s depending on the
# node SLURM picked, and below ~1.2 tok/s Stage 1 summaries hit the 120s timeout.
# 4 threads gave 7-20 tok/s on all four placements tested (2026-11-06).
export OLLAMA_NUM_THREADS=4

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
OWNS_SERVICE=1
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