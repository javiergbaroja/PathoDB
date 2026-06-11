#!/bin/bash
# =============================================================================
# MetAssist v2 — SLURM BATCH inference script
# Submitted by the PathoDB API via sbatch.
# The batch_context.json path is passed as the first (and only) argument.
# Both models are loaded once and kept in VRAM for the full batch.
# =============================================================================
#SBATCH --mail-type=fail
#SBATCH --mail-user=javier.garcia@unibe.ch
#SBATCH --time=5:59:59
#SBATCH --account=gratis
#SBATCH --mem=80G
#SBATCH --nodes=1
#SBATCH --cpus-per-task=7
#SBATCH --partition=gpu-invest
#SBATCH --gres=gpu:rtx4090:1
#SBATCH --job-name=metassist2_batch
#SBATCH --qos=job_gpu_preemptable

set -euo pipefail

CONTEXT_FILE=$1

echo "=== PathoDB MetAssist v2 (BATCH) ==="
echo "Started     : $(date)"
echo "Node        : $(hostname)"
echo "Job ID      : $SLURM_JOB_ID"
echo "Context     : ${CONTEXT_FILE}"
echo ""

# Clean environment — use Apptainer container (same env as single-slide run.sh)
module purge
export APPTAINER_BIND="/storage:/storage"
export PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True
module load CUDA/11.8.0
module load GCCcore/10.3.0

# ── Run batch inference ───────────────────────────────────────────────────────
container_path="/storage/research/igmp_slide_workspace/GRP Zlobec/Amjad/qupath/metassist-v1/MetAssist_expansion/crc-ugi/code/package_refactored/singularity/metassist_env.sif"
INFERENCE_SCRIPT="/storage/research/igmp_dp_workspace/garciabaroja_javier/PW_reports/database/pathodb/models/metassist_v2/infer_batch.py"

# Pass the JSON context file directly to Python (not via env vars)
apptainer exec --nv "${container_path}" \
    /opt/conda/envs/metassist_infer/bin/python3 \
    "${INFERENCE_SCRIPT}" "${CONTEXT_FILE}"

echo ""
echo "=== Finished : $(date) ==="
