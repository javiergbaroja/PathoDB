#!/bin/bash
#SBATCH --mail-type=end,fail
#SBATCH --mail-user=javier.garcia@unibe.ch
#SBATCH --job-name="pathodb_embed"
#SBATCH --output="/storage/research/igmp_dp_workspace/garciabaroja_javier/PW_reports/database/pathodb/logs/pathodb_embed_%j.out"
#SBATCH --time=4:00:00
#SBATCH --mem=24G
#SBATCH --nodes=1
#SBATCH --account=invest
#SBATCH --partition=gpu-invest
#SBATCH --gres=gpu:rtx4090:1
#SBATCH --cpus-per-task=8
#SBATCH --qos=job_gpu_igmp-tru

# =============================================================================
# PathoDB — Build/refresh the report RAG index (report_embeddings).
# Idempotent: only embeds reports without existing embeddings. Rerun as the
# database grows. Drop the --gres line to run CPU-only (slower).
#   EMBEDDING_DEVICE=cuda sbatch slurm_embed.sh
# =============================================================================

set -euo pipefail
PROJECT_DIR="/storage/research/igmp_dp_workspace/garciabaroja_javier/PW_reports/database/pathodb"
cd "$PROJECT_DIR"

source "$(conda info --base)/etc/profile.d/conda.sh"
conda activate langchain

python api/workers/embed_reports.py --report-type all
