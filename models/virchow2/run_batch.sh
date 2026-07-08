#!/bin/bash
# =============================================================================
# PathoDB BATCH Processing — Virchow2 Feature Extraction
# Submitted by the PathoDB API via sbatch.
# =============================================================================
#SBATCH --mail-type=fail
#SBATCH --mail-user=javier.garcia@unibe.ch
#SBATCH --time=23:59:59
#SBATCH --account=invest
#SBATCH --mem=48G
#SBATCH --nodes=1
#SBATCH --cpus-per-task=8
#SBATCH --partition=gpu-invest
#SBATCH --gres=gpu:rtx4090:1
#SBATCH --job-name=virchow2_feat_batch
#SBATCH --qos=job_gpu_igmp-tru

set -euo pipefail

CONTEXT_FILE=$1

echo "=== PathoDB Virchow2 Feature Extraction (BATCH) ==="
echo "Started     : $(date)"
echo "Node        : $(hostname)"
echo "Job ID      : $SLURM_JOB_ID"
echo "Context     : ${CONTEXT_FILE}"
echo ""

module purge
module load CUDA/12.1.0
module load GCCcore/12.3.0

export PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True

# ── Activate the PathoDB conda env that has timm, torch, openslide, etc. ─────
CONDA_ENV="/storage/research/igmp_dp_workspace/garciabaroja_javier/PW_reports/database/pathodb/conda_envs/pathodb-pg"
source "$(conda info --base)/etc/profile.d/conda.sh"
conda activate "${CONDA_ENV}"

# ── Run batch inference ───────────────────────────────────────────────────────
PROJECT_DIR="/storage/research/igmp_dp_workspace/garciabaroja_javier/PW_reports/database/pathodb"
INFERENCE_SCRIPT="${PROJECT_DIR}/models/virchow2/infer_batch.py"

python3 "${INFERENCE_SCRIPT}" "${CONTEXT_FILE}"

echo ""
echo "=== Finished : $(date) ==="