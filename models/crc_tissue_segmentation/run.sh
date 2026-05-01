#!/bin/bash
# =============================================================================
# TIL Density — SLURM inference script
# Submitted by the PathoDB API via sbatch.
# All parameters arrive as environment variables exported by the API:
#
#   PATHODB_JOB_ID      PathoDB analysis_jobs.id
#   PATHODB_SCAN_ID     PathoDB scans.id
#   PATHODB_SCAN_PATH   Absolute path to the WSI file on NFS
#   PATHODB_RESULT_DIR  Directory to write result.json and progress.json
#   PATHODB_SCOPE       whole_slide | visible_region | roi
#   PATHODB_PARAMS      JSON string of user-specified parameters
#   PATHODB_ROI         JSON {x0,y0,x1,y1} or "null"
# =============================================================================
#SBATCH --mail-type=fail
#SBATCH --mail-user=javier.garcia@unibe.ch
#SBATCH --time=1:00:00
#SBATCH --account=gratis
#SBATCH --mem=80G
#SBATCH --nodes=1
#SBATCH --cpus-per-task=7
#SBATCH --partition=gpu-invest
#SBATCH --gres=gpu:a100:1
#SBATCH --job-name=crc_tis_seg
#SBATCH --qos=job_gpu_preemptable

set -euo pipefail

CONTEXT_FILE=$1

# 1. Read variables from the JSON file using jq
# -r gives raw strings (no quotes) for standard paths
# -c gives compact JSON strings (perfect for dictionaries/arrays)
export PATHODB_JOB_ID="$(jq -r '.job_id' "${CONTEXT_FILE}")"
export PATHODB_SCAN_PATH="$(jq -r '.scan_path' "${CONTEXT_FILE}")"
export PATHODB_RESULT_DIR="$(jq -r '.result_dir' "${CONTEXT_FILE}")"
export PATHODB_SCOPE="$(jq -r '.scope' "${CONTEXT_FILE}")"
export PATHODB_PARAMS="$(jq -c '.params' "${CONTEXT_FILE}")"
export PATHODB_ROI="$(jq -c '.roi' "${CONTEXT_FILE}")"

echo "=== PathoDB CRC Tissue Segmentation ==="
echo "Started     : $(date)"
echo "Node        : $(hostname)"
echo "Job ID      : $SLURM_JOB_ID"
echo "PathoDB job : ${PATHODB_JOB_ID}"
echo "Scan        : ${PATHODB_SCAN_PATH}"
echo "Params      : ${PATHODB_PARAMS}"
echo "ROI         : ${PATHODB_ROI}"
echo ""

# 2. Clean environment and activate Conda safely
module purge
module load Anaconda3
module load CUDA/11.8.0
module load GCCcore/10.3.0

source activate metassist

# ── Run inference ─────────────────────────────────────────────────────────────
# get absolute folder for this bash script.
PROJECT_DIR="/storage/research/igmp_dp_workspace/garciabaroja_javier/PW_reports/database/pathodb"
INFERENCE_SCRIPT="/storage/research/igmp_dp_workspace/garciabaroja_javier/PW_reports/database/pathodb/models/crc_tissue_segmentation/infer.py"
python3 "${INFERENCE_SCRIPT}"

echo ""
echo "=== Finished : $(date) ==="