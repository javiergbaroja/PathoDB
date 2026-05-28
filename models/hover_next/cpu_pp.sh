#!/bin/bash
#SBATCH --mail-user=javier.garcia@unibe.ch
#SBATCH --mail-type=end,fail
#SBATCH --job-name="sing_cpu"
#SBATCH --time=3:00:00
#SBATCH --nodes=1
#SBATCH --cpus-per-task=20
#SBATCH --mem-per-cpu=5900M
#SBATCH --partition=epyc2,bdw
#SBATCH --output=logs/pp_%A.out

# export APPTAINER_BIND="/storage:/storage"
# apptainer exec /storage/research/pathology_tru/Elias/container/nuc_torch_v18.sif \
python3 /storage/research/igmp_dp_workspace/baumann_elias/hover_next_inference/main.py \
    --input "${1}" \
    --output_root "${2}" \
	--cp "${3}" \
    --metric "${4}" 

