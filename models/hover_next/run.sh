#!/bin/bash
# =============================================================================
# HoVer-Net Next — SLURM inference script
# Submitted by the PathoDB API via sbatch.
# All parameters are extracted from the provided JSON context file.
# =============================================================================
#SBATCH --mail-type=fail
#SBATCH --mail-user=javier.garcia@unibe.ch
#SBATCH --time=1:00:00
#SBATCH --account=gratis
#SBATCH --mem=80G
#SBATCH --nodes=1
#SBATCH --cpus-per-task=16
#SBATCH --partition=gpu-invest
#SBATCH --gres=gpu:rtx4090:1
#SBATCH --job-name=hovernext
#SBATCH --qos=job_gpu_preemptable

set -euo pipefail

CONTEXT_FILE=$1

# 1. Read variables from the JSON context file
export PATHODB_JOB_ID="$(jq -r '.job_id'    "${CONTEXT_FILE}")"
export PATHODB_SCAN_PATH="$(jq -r '.scan_path'  "${CONTEXT_FILE}")"
export PATHODB_RESULT_DIR="$(jq -r '.result_dir' "${CONTEXT_FILE}")"
export PATHODB_SCOPE="$(jq -r '.scope'      "${CONTEXT_FILE}")"
export PATHODB_PARAMS="$(jq -c '.params'    "${CONTEXT_FILE}")"
export PATHODB_ROI="$(jq -c '.roi'       "${CONTEXT_FILE}")"

echo "=== PathoDB HoVer-Net Next Inference ==="
echo "Started     : $(date)"
echo "Node        : $(hostname)"
echo "SLURM job   : $SLURM_JOB_ID"
echo "PathoDB job : ${PATHODB_JOB_ID}"
echo "Scan        : ${PATHODB_SCAN_PATH}"
echo "Params      : ${PATHODB_PARAMS}"
echo "ROI         : ${PATHODB_ROI}"
echo ""

module purge
export APPTAINER_BINDPATH="/storage,/scratch"

module load Anaconda3
module load CUDA/11.8.0
module load GCCcore/10.3.0

source activate metassist

PROJECT_DIR="/storage/research/igmp_dp_workspace/garciabaroja_javier/PW_reports/database/pathodb"
INFERENCE_SCRIPT="${PROJECT_DIR}/models/hover_next/infer.py"

python3 "${INFERENCE_SCRIPT}"

echo ""
echo "=== Finished : $(date) ==="