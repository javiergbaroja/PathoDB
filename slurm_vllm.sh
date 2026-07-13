#!/bin/bash
#SBATCH --mail-type=end,fail
#SBATCH --mail-user=javier.garcia@unibe.ch
#SBATCH --job-name="pathodb_vllm"
#SBATCH --output="/storage/research/igmp_dp_workspace/garciabaroja_javier/PW_reports/database/pathodb/logs/pathodb_vllm_%j.out"
#SBATCH --time=8:00:00
#SBATCH --mem=80G
#SBATCH --nodes=1
#SBATCH --account=invest
#SBATCH --gres=gpu:rtx4090:1
#SBATCH --partition=gpu-invest
#SBATCH --cpus-per-task=16
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

module load Anaconda3
source activate langchain

# ── Context-window sizing (keep in sync with api/config.py) ───────────────────
# The agent trims each request's history to AGENT_MAX_CONTEXT_TOKENS
# (config.agent_max_context_tokens) and generates up to VLLM_MAX_TOKENS
# (config.vllm_max_tokens). vLLM's --max-model-len must exceed their sum plus
# some system-prompt headroom, or long conversations overflow the window. We
# derive a hard minimum and bump --max-model-len up to it, so a stale/low
# VLLM_MAX_MODEL_LEN (e.g. an old 8192) can never silently truncate the agent.
AGENT_MAX_CONTEXT_TOKENS="${AGENT_MAX_CONTEXT_TOKENS:-12000}"
VLLM_MAX_TOKENS="${VLLM_MAX_TOKENS:-2048}"
PROMPT_HEADROOM="${PROMPT_HEADROOM:-1024}"
MIN_MODEL_LEN=$(( AGENT_MAX_CONTEXT_TOKENS + VLLM_MAX_TOKENS + PROMPT_HEADROOM ))
MAX_MODEL_LEN="${VLLM_MAX_MODEL_LEN:-16384}"
if [ "$MAX_MODEL_LEN" -lt "$MIN_MODEL_LEN" ]; then
    echo "WARNING: VLLM_MAX_MODEL_LEN=$MAX_MODEL_LEN is below the agent minimum" \
         "$MIN_MODEL_LEN (ctx $AGENT_MAX_CONTEXT_TOKENS + out $VLLM_MAX_TOKENS" \
         "+ headroom $PROMPT_HEADROOM). Raising to $MIN_MODEL_LEN."
    MAX_MODEL_LEN="$MIN_MODEL_LEN"
fi
echo "Max model len : $MAX_MODEL_LEN (agent needs >= $MIN_MODEL_LEN)"
echo ""

# Write address file once the server is about to start
ADDR_TMP=$(mktemp "$PROJECT_DIR/.vllm_address.XXXXXX")
echo "$(hostname):${PORT}" > "$ADDR_TMP"
mv "$ADDR_TMP" "$ADDR_FILE"
echo "vLLM address written → $ADDR_FILE"
echo ""

# Quantization: default AWQ (production Qwen2.5-14B-AWQ). Override for other
# checkpoints — e.g. VLLM_QUANTIZATION=compressed-tensors for many community
# quants, or VLLM_QUANTIZATION=auto to let vLLM detect it from the model config.
QUANTIZATION="${VLLM_QUANTIZATION:-awq}"
QUANT_ARG=(--quantization "$QUANTIZATION")
if [ -z "$QUANTIZATION" ] || [ "$QUANTIZATION" = "auto" ]; then
    QUANT_ARG=()
fi
echo "Quantization  : ${QUANTIZATION:-auto}"

# Optional --max-num-seqs. vLLM defaults to 256 concurrent sequences and
# reserves memory for them (incl. the sampler warmup). The agent serves one
# request at a time, so a small value frees memory on tight cards (e.g. a 30B
# on a 24 GB 4090). Unset → vLLM default.
SEQS_ARG=()
if [ -n "${VLLM_MAX_NUM_SEQS:-}" ]; then
    SEQS_ARG=(--max-num-seqs "$VLLM_MAX_NUM_SEQS")
    echo "Max num seqs  : $VLLM_MAX_NUM_SEQS"
fi

# Optional reasoning parser (#10). When serving a Qwen3 "thinking" model for the
# planner/synthesizer, set VLLM_REASONING_PARSER=qwen3 (or deepseek_r1) so vLLM
# routes <think>…</think> into a separate `reasoning_content` field and leaves
# `content` clean — no <think> leaks into plans or streamed answers.
REASONING_ARG=()
if [ -n "${VLLM_REASONING_PARSER:-}" ]; then
    REASONING_ARG=(--reasoning-parser "$VLLM_REASONING_PARSER")
    echo "Reasoning parse: $VLLM_REASONING_PARSER"
fi

# Tool-calling flags. On by default (the agent needs them). Set VLLM_ENABLE_TOOLS=false
# for a synthesis-only endpoint whose model has no tool chat-template (e.g. MedGemma),
# where --tool-call-parser hermes would be invalid.
TOOL_ARG=(--enable-auto-tool-choice --tool-call-parser hermes)
if [ "${VLLM_ENABLE_TOOLS:-true}" = "false" ]; then
    TOOL_ARG=()
    echo "Tool calling  : disabled (synthesis-only endpoint)"
fi

# Run vLLM in the foreground (NOT exec — the shell must survive so the
# EXIT trap can clean up vllm_address.txt when the job ends)
python -m vllm.entrypoints.openai.api_server \
  --model "$MODEL" \
  "${QUANT_ARG[@]}" \
  --served-model-name "$MODEL" \
  --max-model-len "$MAX_MODEL_LEN" \
  --gpu-memory-utilization "${VLLM_GPU_UTIL:-0.90}" \
  "${SEQS_ARG[@]}" \
  "${REASONING_ARG[@]}" \
  "${TOOL_ARG[@]}" \
  --host 0.0.0.0 \
  --port "$PORT"