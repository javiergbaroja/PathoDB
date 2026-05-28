"""
PathoDB — HoVer-Net Next Wrapper
==========================================
Runs the external hovernext inference script followed 
by its CPU post-processing script sequentially.

All inputs arrive as environment variables exported by the PathoDB API.
Outputs written to PATHODB_RESULT_DIR.
"""

import json
import os
import sys
import time
import subprocess
import traceback

# ── PathoDB environment ────────────────────────────────────────────────────────
SCAN_PATH  = os.environ["PATHODB_SCAN_PATH"]
RESULT_DIR = os.environ["PATHODB_RESULT_DIR"]
SCOPE      = os.environ.get("PATHODB_SCOPE", "whole_slide")
PARAMS     = json.loads(os.environ.get("PATHODB_PARAMS", "{}"))
MODEL_ID   = "hover_next"

LABEL2ID = {
    "neutrophil": 1,
    "epithelial-cell": 2,
    "lymphocyte": 3,
    "plasma-cell": 4,
    "eosinophil": 5,
    "connective-tissue-cell": 6,
    "mitosis": 7,
}
os.makedirs(RESULT_DIR, exist_ok=True)

# ── External script paths ──────────────────────────────────────────────────────
HOVERNEXT_MAIN_PY = "/storage/research/igmp_dp_workspace/baumann_elias/hover_next_inference/main.py"
POST_PROCESS_SH   = "/storage/research/igmp_dp_workspace/garciabaroja_javier/PW_reports/database/pathodb/models/hover_next/cpu_pp.sh"

# ─────────────────────────────────────────────────────────────────────────────
# HELPERS
# ─────────────────────────────────────────────────────────────────────────────

def write_progress(pct: int, message: str) -> None:
    """
    Write progress.json atomically so the API never reads a partial file.
    pct must be in [0, 100].
    """
    pct = max(0, min(100, int(pct)))
    payload = {"pct": pct, "message": message}
    tmp = os.path.join(RESULT_DIR, "progress.tmp")
    dst = os.path.join(RESULT_DIR, "progress.json")
    with open(tmp, "w") as f:
        json.dump(payload, f)
    os.replace(tmp, dst)
    print(f"[{pct:3d}%] {message}", flush=True)

# ─────────────────────────────────────────────────────────────────────────────
# MAIN
# ─────────────────────────────────────────────────────────────────────────────

def main() -> None:
    print(f"=== PathoDB HoVer-Net Next Wrapper ===")
    print(f"WSI        : {SCAN_PATH}")
    print(f"Result dir : {RESULT_DIR}")
    
    start_time = time.time()
    
    # User-tunable parameters (can be overridden via PathoDB UI/API)
    cp          = PARAMS.get("cp", "lizard_convnextv2_large")
    tta         = str(PARAMS.get("tta", 8))
    inf_workers = str(PARAMS.get("inf_workers", 12))
    inf_writers = str(PARAMS.get("inf_writers", 4))
    pp_mode     = PARAMS.get("pp_mode", "f1")

    # ── Phase 1: Inference ─────────────────────────────────────────────────────
    write_progress(10, "Starting HoVer-Net Next inference...")
    
    infer_cmd = [
        "python3", HOVERNEXT_MAIN_PY,
        "--input", SCAN_PATH,
        "--output_root", RESULT_DIR,
        "--cp", cp,
        "--tta", tta,
        "--only_inference",
        "--inf_workers", inf_workers,
        "--inf_writers", inf_writers,
        "--save_polygon"
    ]
    
    print(f"Executing: {' '.join(infer_cmd)}", flush=True)
    subprocess.run(infer_cmd, check=True)

    # ── Phase 2: Post-Processing ───────────────────────────────────────────────
    write_progress(75, "Running CPU post-processing...")
    
    # Run the bash script synchronously using bash
    pp_cmd = [
        "bash", POST_PROCESS_SH,
        SCAN_PATH,
        RESULT_DIR,
        cp,
        pp_mode
    ]
    
    print(f"Executing: {' '.join(pp_cmd)}", flush=True)
    subprocess.run(pp_cmd, check=True)

    # ── Phase 3: Result Registration ───────────────────────────────────────────
    write_progress(95, "Generating final result summary...")
    
    total_time = time.time() - start_time
    
    # Build standard result payload for PathoDB's frontend
    result = {
        "model_id":  MODEL_ID,
        "scan_path": SCAN_PATH,
        "scope":     SCOPE,
        "params":    PARAMS,
        "timing": {
            "total_s": round(total_time, 2),
        },
        "outcome": {
            "status": "segmentation_complete",
            "message": "Inference and post-processing finished successfully."
        },
        "files": {
            "output_dir": RESULT_DIR,
            # Note: You can add specific output files here if the frontend 
            # needs to render a GeoJSON (e.g. "download_file": f"{RESULT_DIR}/cells.geojson")
        },
        "overlays": []
    }

    result_path = os.path.join(RESULT_DIR, "result.json")
    with open(result_path, "w") as f:
        json.dump(result, f, indent=2)

    write_progress(100, "Done")
    print(f"\n=== Complete ===")
    print(f"Total Time : {total_time:.2f}s")


# ─────────────────────────────────────────────────────────────────────────────
# ENTRY POINT
# ─────────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    try:
        main()
    except subprocess.CalledProcessError as e:
        tb = traceback.format_exc()
        msg = f"Subprocess failed with exit code {e.returncode}."
        try:
            write_progress(0, "Failed during model execution — see error.txt")
        except:
            pass
        with open(os.path.join(RESULT_DIR, "error.txt"), "w") as f:
            f.write(msg + "\n" + tb)
        print(msg, file=sys.stderr)
        sys.exit(1)
    except Exception:
        tb = traceback.format_exc()
        try:
            write_progress(0, "Failed — see error.txt in result directory")
        except:
            pass
        with open(os.path.join(RESULT_DIR, "error.txt"), "w") as f:
            f.write(tb)
        print(tb, file=sys.stderr)
        sys.exit(1)