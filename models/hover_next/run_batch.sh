#!/bin/bash
# =============================================================================
# PathoDB BATCH Processing — HoVer-Net Next
# Submitted by the PathoDB API via sbatch.
# =============================================================================
#SBATCH --mail-type=fail
#SBATCH --mail-user=javier.garcia@unibe.ch
#SBATCH --time=23:59:59
#SBATCH --account=invest
#SBATCH --mem=80G
#SBATCH --nodes=1
#SBATCH --cpus-per-task=16
#SBATCH --partition=gpu-invest
#SBATCH --gres=gpu:rtx4090:1
#SBATCH --job-name=hovernext_batch
#SBATCH --qos=job_gpu_igmp-tru

set -euo pipefail

CONTEXT_FILE=$1

echo "=== PathoDB HoVer-Net Next (BATCH) ==="
echo "Started     : $(date)"
echo "Node        : $(hostname)"
echo "Job ID      : $SLURM_JOB_ID"
echo "Context     : ${CONTEXT_FILE}"
echo ""

module purge
export APPTAINER_BINDPATH="/storage,/scratch"
export PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True
module load Anaconda3
module load CUDA/11.8.0
module load GCCcore/10.3.0

source activate metassist

PROJECT_DIR="/storage/research/igmp_dp_workspace/garciabaroja_javier/PW_reports/database/pathodb"
INFERENCE_SCRIPT="${PROJECT_DIR}/models/hover_next/infer_batch.py"

python3 "${INFERENCE_SCRIPT}" "${CONTEXT_FILE}"

echo ""
echo "=== Finished : $(date) ==="
