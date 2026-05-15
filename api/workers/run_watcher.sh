#!/bin/bash
#SBATCH --mail-type=end,fail
#SBATCH --mail-user=javier.garcia@unibe.ch
#SBATCH --job-name="pathodb_watcher"
#SBATCH --output="/storage/research/igmp_dp_workspace/garciabaroja_javier/PW_reports/database/pathodb/logs/watcher_%j.out"
#SBATCH --time=6:00:00
#SBATCH --mem-per-cpu=8G
#SBATCH --account=gratis
#SBATCH --partition=cpu-invest
#SBATCH --cpus-per-task=2
#SBATCH --qos=job_cpu_preemptable

set -euo pipefail

WATCH_DIR=$1
CONTEXT_FILE=$2

echo "=== PathoDB DB Watcher Job ==="
echo "Started    : $(date)"
echo "Node       : $(hostname)"
echo "Watch Dir  : $WATCH_DIR"
echo "Context    : $CONTEXT_FILE"
echo ""

# 1. Clear default system modules
module purge

# 2. Load Anaconda and initialize bash hook
module load Anaconda3
eval "$(conda shell.bash hook)"

# 3. Activate the conda environment properly
conda activate "/storage/research/igmp_slide_workspace/GRP Zlobec/Javier/conda_envs/langchain"

# 4. Load PostgreSQL binaries
module load PostgreSQL
export PATH="/software.9/software/PostgreSQL/16.4-GCCcore-13.3.0/bin:$PATH"

# 5. Load environment variables from .env
ENV_FILE="/storage/research/igmp_dp_workspace/garciabaroja_javier/PW_reports/database/pathodb/.env"
if [ ! -f "$ENV_FILE" ]; then
    echo "ERROR: .env not found at $ENV_FILE"
    exit 1
fi
export $(grep -v '^#' "$ENV_FILE" | xargs)


# Before calling python, extract db_host from the context file
DB_HOST="$(jq -r '.db_host // "localhost"' "${CONTEXT_FILE}")"
export POSTGRES_HOST="${DB_HOST}"

echo "Connecting to PostgreSQL at ${POSTGRES_HOST}:${POSTGRES_PORT}"

# 6. Run the python ingestion script
WATCHER_PY="/storage/research/igmp_dp_workspace/garciabaroja_javier/PW_reports/database/pathodb/api/workers/ingest_watcher.py"
echo "Starting Python watcher script..."
python3 "$WATCHER_PY" "$WATCH_DIR" "$CONTEXT_FILE"