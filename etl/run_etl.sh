#!/bin/bash
# =============================================================================
# PathoDB ETL — SLURM launcher script
# Submitted by the PathoDB API via sbatch.
# All parameters come from the JSON context file ($1).
# =============================================================================
#SBATCH --mail-type=fail
#SBATCH --mail-user=javier.garcia@unibe.ch
#SBATCH --time=06:00:00
#SBATCH --account=gratis
#SBATCH --mem-per-cpu=8G
#SBATCH --partition=cpu-invest
#SBATCH --qos=job_cpu_preemptable

set -euo pipefail

CONTEXT_FILE=$1

echo "=== PathoDB ETL Import ==="
echo "Started    : $(date)"
echo "Node       : $(hostname)"
echo "SLURM job  : $SLURM_JOB_ID"
echo "CPUs       : $SLURM_CPUS_PER_TASK"
echo "Context    : ${CONTEXT_FILE}"
echo ""

# ── Environment setup ────────────────────────────────────────────────────────
module purge
module load Anaconda3
eval "$(conda shell.bash hook)"

conda activate "/storage/research/igmp_slide_workspace/GRP Zlobec/Javier/conda_envs/langchain"

module load PostgreSQL
export PATH="/software.9/software/PostgreSQL/16.4-GCCcore-13.3.0/bin:$PATH"

# ── Load environment variables ────────────────────────────────────────────────
PROJECT_DIR="/storage/research/igmp_dp_workspace/garciabaroja_javier/PW_reports/database/pathodb"
ENV_FILE="${PROJECT_DIR}/.env"
if [ ! -f "$ENV_FILE" ]; then
    echo "ERROR: .env not found at $ENV_FILE"
    exit 1
fi
export $(grep -v '^#' "$ENV_FILE" | xargs)

# ── Set DB host from context (inter-node connectivity) ────────────────────────
DB_HOST="$(jq -r '.db_host // "localhost"' "${CONTEXT_FILE}")"
export POSTGRES_HOST="${DB_HOST}"
# export POSTGRES_HOST="cnode21"

echo "Job type   : $(jq -r '.job_type' "${CONTEXT_FILE}")"
echo "Source     : $(jq -r '.source_path' "${CONTEXT_FILE}")"
echo "DB host    : ${POSTGRES_HOST}:${POSTGRES_PORT}"
echo ""

# ── Run the ETL worker ────────────────────────────────────────────────────────
ETL_WORKER="${PROJECT_DIR}/etl/etl_worker.py"
python3 "${ETL_WORKER}" "${CONTEXT_FILE}"

echo ""
echo "=== Finished : $(date) ==="