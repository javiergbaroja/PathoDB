#!/bin/bash
#SBATCH --mail-type=end,fail
#SBATCH --mail-user=javier.garcia@unibe.ch
#SBATCH --job-name="pathodb_vllm"
#SBATCH --output="/storage/research/igmp_dp_workspace/garciabaroja_javier/PW_reports/database/pathodb/logs/pathodb_vllm_%j.out"
#SBATCH --time=8:00:00
#SBATCH --mem=48G
#SBATCH --nodes=1
#SBATCH --account=invest
#SBATCH --gres=gpu:rtx4090:1
#SBATCH --partition=gpu-invest
#SBATCH --cpus-per-task=8
#SBATCH --qos=job_gpu_igmp-tru

# =============================================================================
# PathoDB Agent LLM — vLLM OpenAI-compatible server (one RTX-4090)
#
# Serves the conversational agent's LLM. Run this alongside slurm_api.sh; set
# VLLM_BASE_URL in the API's .env to http://<this-node>:8001/v1
#
#   sbatch slurm_vllm.sh && squeue --me
#   # note the node, then in the API .env: VLLM_BASE_URL=http://<node>:8001/v1
# =============================================================================

set -euo pipefail

MODEL="${VLLM_MODEL:-Qwen/Qwen2.5-14B-Instruct-AWQ}"
PORT="${VLLM_PORT:-8001}"

echo "=== PathoDB vLLM ($MODEL) on $(hostname) port $PORT ==="

# Activate the conda env that has vLLM installed
source "$(conda info --base)/etc/profile.d/conda.sh"
conda activate langchain

exec python -m vllm.entrypoints.openai.api_server \
  --model "$MODEL" \
  --quantization awq \
  --served-model-name "$MODEL" \
  --max-model-len 8192 \
  --gpu-memory-utilization 0.90 \
  --host 0.0.0.0 \
  --port "$PORT"
