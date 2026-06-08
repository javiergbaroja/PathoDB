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
# Start on-demand only — do not leave running when agent is not needed.
#
#   bash scripts/start_vllm.sh          ← recommended (handles .env update)
#   sbatch slurm_vllm.sh                ← direct submit (manual .env update needed)
#
# Stop when done:
#   scancel --name=pathodb_vllm
#
# =============================================================================

set -euo pipefail

PROJECT_DIR="/storage/research/igmp_dp_workspace/garciabaroja_javier/PW_reports/database/pathodb"
MODEL="${VLLM_MODEL:-Qwen/Qwen2.5-14B-Instruct-AWQ}"
PORT="${VLLM_PORT:-8001}"
ADDR_FILE="$PROJECT_DIR/vllm_address.txt"

_shutdown() {
    echo "vLLM shutting down at $(date)"
    rm -f "$ADDR_FILE"
}
trap '_shutdown' EXIT

echo "=== PathoDB vLLM ==="
echo "Started : $(date)"
echo "Node    : $(hostname)"
echo "Model   : $MODEL"
echo "Port    : $PORT"
echo ""

source "$(conda info --base)/etc/profile.d/conda.sh"
conda activate langchain

# Write address file once the server is about to start
ADDR_TMP=$(mktemp "$PROJECT_DIR/.vllm_address.XXXXXX")
echo "$(hostname):${PORT}" > "$ADDR_TMP"
mv "$ADDR_TMP" "$ADDR_FILE"
echo "vLLM address written → $ADDR_FILE"
echo ""

# Run vLLM in the foreground (NOT exec — the shell must survive so the
# EXIT trap can clean up vllm_address.txt when the job ends)
python -m vllm.entrypoints.openai.api_server \
  --model "$MODEL" \
  --quantization awq \
  --served-model-name "$MODEL" \
  --max-model-len 8192 \
  --gpu-memory-utilization 0.90 \
  --enable-auto-tool-choice \
  --tool-call-parser hermes \
  --host 0.0.0.0 \
  --port "$PORT"