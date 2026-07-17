#!/bin/bash
# =============================================================================
# CRC Extent of Invasion (pT) — SLURM inference script
# Submitted by the PathoDB API via sbatch.
# All parameters arrive as environment variables read from the context JSON:
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
#SBATCH --gres=gpu:rtx4090:1
#SBATCH --job-name=crc_invasion
#SBATCH --qos=job_gpu_preemptable
#SBATCH --output=/storage/research/igmp_dp_workspace/garciabaroja_javier/PW_reports/database/pathodb/logs/crc_invasion_extent_%j.out
#SBATCH --error=/storage/research/igmp_dp_workspace/garciabaroja_javier/PW_reports/database/pathodb/logs/crc_invasion_extent_%j.err

set -euo pipefail

CONTEXT_FILE=$1

# 1. Read variables from the JSON context file using jq
export PATHODB_JOB_ID="$(jq -r '.job_id' "${CONTEXT_FILE}")"
export PATHODB_SCAN_PATH="$(jq -r '.scan_path' "${CONTEXT_FILE}")"
export PATHODB_RESULT_DIR="$(jq -r '.result_dir' "${CONTEXT_FILE}")"
export PATHODB_SCOPE="$(jq -r '.scope' "${CONTEXT_FILE}")"
export PATHODB_PARAMS="$(jq -c '.params' "${CONTEXT_FILE}")"
export PATHODB_ROI="$(jq -c '.roi' "${CONTEXT_FILE}")"

echo "=== PathoDB CRC Extent of Invasion (pT) ==="
echo "Started     : $(date)"
echo "Node        : $(hostname)"
echo "Job ID      : $SLURM_JOB_ID"
echo "PathoDB job : ${PATHODB_JOB_ID}"
echo "Scan        : ${PATHODB_SCAN_PATH}"
echo "Params      : ${PATHODB_PARAMS}"
echo "ROI         : ${PATHODB_ROI}"
echo ""

# 2. Clean environment — use the shared Apptainer container (same env as CRC seg)
module purge
export APPTAINER_BIND="/storage:/storage"
module load CUDA/11.8.0
module load GCCcore/10.3.0

container_path="/storage/research/igmp_slide_workspace/GRP Zlobec/Amjad/qupath/metassist-v1/MetAssist_expansion/crc-ugi/code/package_refactored/singularity/metassist_env.sif"

# ── Run inference ─────────────────────────────────────────────────────────────
PROJECT_DIR="/storage/research/igmp_dp_workspace/garciabaroja_javier/PW_reports/database/pathodb"
INFERENCE_SCRIPT="${PROJECT_DIR}/models/crc_invasion_extent/infer.py"

apptainer exec --nv "${container_path}" \
    /opt/conda/envs/metassist_infer/bin/python3 \
    "${INFERENCE_SCRIPT}"

echo ""
echo "=== Finished : $(date) ==="
