#!/bin/bash
# =============================================================================
# HoVer-Net Next — CPU post-processing script
# Called synchronously by infer.py via:  bash cpu_pp.sh <arg1> ... <arg5>
#
# Arguments:
#   $1  input WSI path
#   $2  output_root directory  (same RESULT_DIR used during inference)
#   $3  checkpoint name        (e.g. lizard_convnextv2_large)
#   $4  pp_tiling              (integer, default 10)
#   $5  python interpreter     (full path from sys.executable in infer.py)
#
# NOTE: This script is executed via `bash`, NOT submitted via sbatch.
#       Any #SBATCH directives here would be silently ignored — none are
#       included intentionally.
# =============================================================================

set -euo pipefail

INPUT_WSI="${1}"
OUTPUT_ROOT="${2}"
CP="${3}"
PP_TILING="${4:-10}"
# Use the same Python the caller is running under; fall back to `python3`
# only if somehow not provided (should not happen in normal operation).
PYTHON="${5:-python3}"
echo "Python interpreter: ${PYTHON}"

echo "=== HoVer-Net Next Post-Processing ==="
echo "Input     : ${INPUT_WSI}"
echo "Output    : ${OUTPUT_ROOT}"
echo "Checkpoint: ${CP}"
echo "PP tiling : ${PP_TILING}"
echo "Python    : ${PYTHON}"
echo ""

"${PYTHON}" /storage/research/igmp_dp_workspace/baumann_elias/hover_next_inference/main.py \
    --input        "${INPUT_WSI}" \
    --output_root  "${OUTPUT_ROOT}" \
    --cp           "${CP}" \
    --pp_tiling    "${PP_TILING}"

echo "=== Post-processing finished ==="