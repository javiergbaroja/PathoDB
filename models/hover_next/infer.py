"""
PathoDB — HoVer-Net Next Wrapper
==========================================
Runs the external hovernext inference script followed by its CPU
post-processing script sequentially, then converts the raw
class_inst.json output into a standard PathoDB GeoJSON + result.json.

All inputs arrive as environment variables exported by the PathoDB API.
Outputs written to PATHODB_RESULT_DIR.

Output contract (consumed by the PathoDB frontend auto-import pipeline):
  result.json
    ├── files.download_file  →  <RESULT_DIR>/<wsi_name>_cells.geojson
    └── outcome
          ├── status         →  "detection_complete"
          ├── total_cells    →  int
          └── class_counts   →  { "lymphocyte": 1234, ... }
"""

import glob
import json
import os
import sys
import time
import subprocess
import traceback

# Use the same Python interpreter that is running this wrapper for all
# subprocesses.  This guarantees we stay inside whichever conda environment
# run.sh activated, regardless of what `python3` resolves to on PATH.
PYTHON = sys.executable

# ── PathoDB environment ────────────────────────────────────────────────────────
SCAN_PATH  = os.environ["PATHODB_SCAN_PATH"]
RESULT_DIR = os.environ["PATHODB_RESULT_DIR"]
SCOPE      = os.environ.get("PATHODB_SCOPE", "whole_slide")
PARAMS     = json.loads(os.environ.get("PATHODB_PARAMS", "{}"))
MODEL_ID   = "hover_next"

# Integer label → class name (mirrors catalog.json "classes" list)
ID2LABEL = {
    1: "neutrophil",
    2: "epithelial-cell",
    3: "lymphocyte",
    4: "plasma-cell",
    5: "eosinophil",
    6: "connective-tissue-cell",
    7: "mitosis",
}

os.makedirs(RESULT_DIR, exist_ok=True)

# ── External script paths ──────────────────────────────────────────────────────
HOVERNEXT_MAIN_PY = "/storage/research/igmp_dp_workspace/baumann_elias/hover_next_inference/main.py"
CPU_PP_SH         = "/storage/research/igmp_dp_workspace/garciabaroja_javier/PW_reports/database/pathodb/models/hover_next/cpu_pp.sh"

# ─────────────────────────────────────────────────────────────────────────────
# HELPERS
# ─────────────────────────────────────────────────────────────────────────────

def write_progress(pct: int, message: str) -> None:
    """Write progress.json atomically so the API never reads a partial file."""
    pct = max(0, min(100, int(pct)))
    payload = {"pct": pct, "message": message}
    tmp = os.path.join(RESULT_DIR, "progress.tmp")
    dst = os.path.join(RESULT_DIR, "progress.json")
    with open(tmp, "w") as f:
        json.dump(payload, f)
    os.replace(tmp, dst)
    print(f"[{pct:3d}%] {message}", flush=True)


def run_cmd(cmd: list, label: str) -> None:
    """
    Run a subprocess, streaming its stdout/stderr live to the SLURM log AND
    capturing stderr so it is written to error.txt when the process fails.

    Without this, a non-zero exit from main.py only surfaces the return code —
    the actual Python traceback from the subprocess stays buried in the SLURM
    log file and is invisible to the PathoDB job error view.
    """
    import threading

    print(f"\n[run_cmd] {label}", flush=True)
    print(f"[run_cmd] Command: {chr(32).join(str(a) for a in cmd)}\n", flush=True)

    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
    )

    stderr_lines: list = []

    def _drain_stderr():
        for line in proc.stderr:
            stderr_lines.append(line)
            print(f"[stderr] {line}", end="", flush=True)

    stderr_thread = threading.Thread(target=_drain_stderr, daemon=True)
    stderr_thread.start()

    for line in proc.stdout:
        print(line, end="", flush=True)

    proc.wait()
    stderr_thread.join()

    if proc.returncode != 0:
        stderr_blob = "".join(stderr_lines).strip()
        error_path  = os.path.join(RESULT_DIR, "error.txt")

        msg_lines = [
            f"Subprocess '{label}' failed with exit code {proc.returncode}.",
            f"Command: {chr(32).join(str(a) for a in cmd)}",
            "",
        ]
        if stderr_blob:
            msg_lines += ["--- subprocess stderr ---", stderr_blob, ""]
        else:
            msg_lines.append("(no stderr captured — check the SLURM log for stdout)")

        full_msg = "\n".join(msg_lines)
        print(full_msg, flush=True)

        with open(error_path, "w") as ef:
            ef.write(full_msg)

        raise subprocess.CalledProcessError(proc.returncode, cmd)


def find_class_inst_json(result_dir: str, wsi_name: str) -> str:
    """
    Locate the class_inst.json produced by HoVer-NeXt post-processing.

    HoVer-NeXt writes into  <output_root>/<wsi_stem>/class_inst.json
    but the exact subdirectory name can vary (e.g. the model may strip
    the extension differently).  We try the canonical path first, then
    fall back to a glob so the wrapper stays robust to upstream changes.
    """
    canonical = os.path.join(result_dir, wsi_name, "class_inst.json")
    if os.path.exists(canonical):
        return canonical

    # Glob fallback: search one level deep
    hits = glob.glob(os.path.join(result_dir, "*", "class_inst.json"))
    if hits:
        # Prefer the most recently modified file in case of stale artefacts
        hits.sort(key=os.path.getmtime, reverse=True)
        return hits[0]

    raise FileNotFoundError(
        f"class_inst.json not found under {result_dir}. "
        "Check that the post-processing step completed successfully."
    )


def class_inst_to_geojson(class_inst: dict) -> tuple[dict, dict]:
    """
    Convert HoVer-NeXt's class_inst.json to a GeoJSON FeatureCollection
    of Point features and compute per-class cell counts.

    Input format:
        {"155": [6, [44529.97, 4214.98]], "156": [3, [12000.0, 8500.0]], ...}
        key   = instance id  (string)
        val[0]= integer class label
        val[1]= [x, y] centroid in level-0 slide pixels

    Output:
        geojson      — GeoJSON FeatureCollection (Point features)
        class_counts — {"lymphocyte": 1234, "neutrophil": 56, ...}
    """
    features     = []
    class_counts = {label: 0 for label in ID2LABEL.values()}

    for inst_id, payload in class_inst.items():
        class_label = int(payload[0])
        centroid    = payload[1]          # [x, y]

        class_name = ID2LABEL.get(class_label)
        if class_name is None:
            # Unknown label — skip rather than crash
            print(f"  [warn] Unknown class label {class_label} for instance {inst_id}, skipping.", flush=True)
            continue

        class_counts[class_name] += 1

        features.append({
            "type": "Feature",
            "properties": {
                # PathoDB import pipeline reads "classification.name"
                # (QuPath-compatible convention)
                "classification": {"name": class_name},
                "objectType":     "cell",
                "instance_id":    inst_id,
            },
            "geometry": {
                "type":        "Point",
                "coordinates": [centroid[0], centroid[1]],
            },
        })

    # Drop classes with zero detections from the counts summary
    class_counts = {k: v for k, v in class_counts.items() if v > 0}

    geojson = {
        "type":     "FeatureCollection",
        "features": features,
    }
    return geojson, class_counts


# ─────────────────────────────────────────────────────────────────────────────
# MAIN
# ─────────────────────────────────────────────────────────────────────────────

def main() -> None:
    print("=== PathoDB HoVer-Net Next Wrapper ===", flush=True)
    print(f"WSI        : {SCAN_PATH}",  flush=True)
    print(f"Result dir : {RESULT_DIR}", flush=True)

    wsi_name   = os.path.splitext(os.path.basename(SCAN_PATH))[0]
    start_time = time.time()

    # ── User-tunable parameters (exposed in catalog.json params[]) ─────────────
    cp         = PARAMS.get("cp",         "lizard_convnextv2_large")
    tta        = str(PARAMS.get("tta",    8))
    pp_tiling  = str(PARAMS.get("pp_tiling", 8))
    # Internal performance knobs (not exposed in the UI)
    inf_workers = str(PARAMS.get("inf_workers", 12))
    inf_writers = str(PARAMS.get("inf_writers",  4))

    # ── Phase 1: GPU Inference ─────────────────────────────────────────────────
    write_progress(5, "Starting HoVer-Net Next GPU inference…")

    infer_cmd = [
        PYTHON, HOVERNEXT_MAIN_PY,
        "--input",        SCAN_PATH,
        "--output_root",  RESULT_DIR,
        "--cp",           cp,
        "--tta",          tta,
        # "--only_inference",
        "--inf_workers",  inf_workers,
        "--inf_writers",  inf_writers,
        "--pp_workers",   inf_workers,  
        "--pp_tiling",    pp_tiling,
        # "--save_polygon",
    ]
    run_cmd(infer_cmd, "Phase 1: GPU inference")

    write_progress(90, "GPU inference complete.")


    # ── Phase 3: Result Conversion ─────────────────────────────────────────────
    write_progress(92, "Converting class_inst.json to GeoJSON…")

    class_inst_path = find_class_inst_json(RESULT_DIR, wsi_name)
    print(f"Reading: {class_inst_path}", flush=True)

    with open(class_inst_path, "r") as f:
        class_inst = json.load(f)

    geojson, class_counts = class_inst_to_geojson(class_inst)

    total_cells   = sum(class_counts.values())
    geojson_path  = os.path.join(RESULT_DIR, f"{wsi_name}_cells.geojson")

    with open(geojson_path, "w") as f:
        json.dump(geojson, f)          # no indent — keep file compact for large slides

    print(f"Wrote {total_cells} cell annotations → {geojson_path}", flush=True)
    for name, count in sorted(class_counts.items(), key=lambda x: -x[1]):
        print(f"  {name:<30s}: {count:>7,}", flush=True)

    # ── Phase 4: result.json ───────────────────────────────────────────────────
    write_progress(96, "Writing result summary…")

    total_time = time.time() - start_time

    result = {
        "model_id":  MODEL_ID,
        "scan_path": SCAN_PATH,
        "scope":     SCOPE,
        "params": {
            "cp":        cp,
            "tta":       int(tta),
            "pp_tiling": int(pp_tiling),
        },
        "timing": {
            "total_s": round(total_time, 2),
        },
        # ── Fields consumed by MultiClassDetectionSummary in the frontend ──
        "outcome": {
            "status":       "detection_complete",
            "total_cells":  total_cells,
            "class_counts": class_counts,
        },
        # ── Files consumed by handleAutoImport in the frontend ────────────
        # "download_file" key triggers the GeoJSON import pipeline.
        "files": {
            "download_file": geojson_path,
            "class_inst":    class_inst_path,
        },
        "overlays": [],
    }

    result_path = os.path.join(RESULT_DIR, "result.json")
    with open(result_path, "w") as f:
        json.dump(result, f, indent=2)

    write_progress(100, "Done")

    print(f"\n=== Complete ===",              flush=True)
    print(f"Total Time  : {total_time:.2f}s", flush=True)
    print(f"Total Cells : {total_cells:,}",   flush=True)


# ─────────────────────────────────────────────────────────────────────────────
# ENTRY POINT
# ─────────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    try:
        main()
    except subprocess.CalledProcessError as e:
        tb  = traceback.format_exc()
        msg = f"Subprocess failed with exit code {e.returncode}."
        try:
            write_progress(0, "Failed during model execution — see error.txt")
        except Exception:
            pass
        with open(os.path.join(RESULT_DIR, "error.txt"), "w") as ef:
            ef.write(msg + "\n" + tb)
        print(msg, file=sys.stderr)
        sys.exit(1)
    except Exception:
        tb = traceback.format_exc()
        try:
            write_progress(0, "Failed — see error.txt in result directory")
        except Exception:
            pass
        with open(os.path.join(RESULT_DIR, "error.txt"), "w") as ef:
            ef.write(tb)
        print(tb, file=sys.stderr)
        sys.exit(1)