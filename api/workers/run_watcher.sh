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

# 1. Load required modules
module load Anaconda3
module load PostgreSQL

# 2. Ensure PostgreSQL binaries are in PATH
export PATH="/software.9/software/PostgreSQL/16.4-GCCcore-13.3.0/bin:$PATH"

# 3. Activate conda environment
source activate langchain

# 4. Load environment variables from .env
ENV_FILE="/storage/research/igmp_dp_workspace/garciabaroja_javier/PW_reports/database/pathodb/.env"
if [ ! -f "$ENV_FILE" ]; then
    echo "ERROR: .env not found at $ENV_FILE"
    exit 1
fi
export $(grep -v '^#' "$ENV_FILE" | xargs)

# 5. Run the python ingestion script
# Adjust this path if your api folder is located somewhere else!
WATCHER_PY="/storage/research/igmp_dp_workspace/garciabaroja_javier/PW_reports/database/pathodb/api/workers/ingest_watcher.py"

echo "Starting Python watcher script..."
python3 "$WATCHER_PY" "$WATCH_DIR" "$CONTEXT_FILE"

echo "Watcher finished successfully."