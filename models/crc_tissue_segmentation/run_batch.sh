#!/bin/bash
# =============================================================================
# PathoDB BATCH Processing — SLURM inference script
# Submitted by the PathoDB API via sbatch.
# =============================================================================
#SBATCH --mail-type=fail
#SBATCH --mail-user=javier.garcia@unibe.ch
#SBATCH --time=23:59:59
#SBATCH --account=invest
#SBATCH --mem=80G
#SBATCH --nodes=1
#SBATCH --cpus-per-task=7
#SBATCH --partition=gpu-invest
#SBATCH --gres=gpu:rtx4090:1
#SBATCH --job-name=crc_tis_batch
#SBATCH --qos=job_gpu_igmp-tru

set -euo pipefail

CONTEXT_FILE=$1

echo "=== PathoDB CRC Tissue Segmentation (BATCH) ==="
echo "Started     : $(date)"
echo "Node        : $(hostname)"
echo "Job ID      : $SLURM_JOB_ID"
echo "Context     : ${CONTEXT_FILE}"
echo ""

# Clean environment and activate Conda safely
module purge
# module load Anaconda3
module load CUDA/11.8.0
module load GCCcore/10.3.0

export APPTAINER_BIND="/storage:/storage"

# ── Run batch inference ───────────────────────────────────────────────────────
SING_CONTAINER="/storage/research/igmp_slide_workspace/GRP Zlobec/Amjad/qupath/metassist-v1/MetAssist_expansion/crc-ugi/code/package_refactored/singularity/metassist_env.sif"
INFERENCE_SCRIPT="/storage/research/igmp_dp_workspace/garciabaroja_javier/PW_reports/database/pathodb/models/crc_tissue_segmentation/infer_batch.py"

# Pass the JSON file directly to Python
apptainer exec --nv "${SING_CONTAINER}" \
    /opt/conda/envs/metassist_infer/bin/python3 \
    "${INFERENCE_SCRIPT}" "${CONTEXT_FILE}"

echo ""
echo "=== Finished : $(date) ==="