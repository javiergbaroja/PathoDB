"""
PathoDB — Virchow2 Feature Extraction (BATCH MODE)
====================================================

Reads a PathoDB batch_context.json, runs extract_features.py on each target
slide, and writes progress.json + result.json in the PathoDB contract format.

Input (batch_context.json)
--------------------------
{
    "job_id":     "...",
    "result_dir": "/path/for/progress_and_result_json",
    "output_dir": "/path/for/feature_npz_files",
    "params": {
        "tile_size":  224,
        "resolution": 0,
        "batch_size": 128,
        "overwrite":  false
    },
    "targets": [
        {"scan_id": 123, "file_path": "/abs/path/to/slide.svs"},
        ...
    ]
}

Output contract (consumed by the PathoDB API and frontend)
----------------------------------------------------------
progress.json  — {"pct": 0-100, "message": "..."}
result.json    — {
    "model_id": "virchow2",
    "scope": "batch",
    "job_id": <int>,
    "job_status": "running" | "complete" | "failed",
    "params": {...},
    "batch_summary": {
        "total_slides": N,
        "successful":   N,
        "failed":       N
    },
    "scans": [
        {
            "scan_id":   <int>,
            "scan_path": "...",
            "status":    "done" | "failed" | "skipped",
            "outcome": {
                "status":          "features_extracted",
                "n_tiles":         <int>,
                "feature_dim":     <int>,
                "tile_size":       <int>,
                "resolution_mpp":  <float>,
                "feature_file":    "/abs/path/to/<slide_id>.npz"
            },
            "files": {
                "feature_file": "/abs/path/to/<slide_id>.npz"
            }
        }
    ]
}

Notes
-----
- extract_features.py is imported and called directly (not as a subprocess)
  to reuse the already-loaded Virchow2 model across all slides, saving the
  significant HuggingFace + GPU model-load time.
- The model is loaded once before the slide loop.
- This script intentionally does NOT trigger the annotation-import watcher
  because feature_extraction produces .npz files, not GeoJSON annotations.
- If SLURM times out mid-batch, re-submission (auto-retry via analysis.py)
  honours the "overwrite: false" default: already-extracted slides are skipped.
"""

from __future__ import annotations

import json
import os
import sys
import time
import traceback

import numpy as np
import torch
from timm.layers import SwiGLUPacked
import timm

# ── PathoDB Batch Context ──────────────────────────────────────────────────────
if len(sys.argv) < 2:
    print("Error: Missing batch_context.json argument.", file=sys.stderr)
    sys.exit(1)

CONTEXT_FILE = sys.argv[1]
with open(CONTEXT_FILE) as f:
    CONTEXT = json.load(f)

JOB_ID     = CONTEXT.get("job_id",     "unknown")
RESULT_DIR = CONTEXT.get("result_dir", os.getcwd())
OUTPUT_DIR = CONTEXT.get("output_dir", RESULT_DIR)
PARAMS     = CONTEXT.get("params",     {})
TARGETS    = CONTEXT.get("targets",    [])

MODEL_ID = "virchow2"

os.makedirs(RESULT_DIR, exist_ok=True)
os.makedirs(OUTPUT_DIR, exist_ok=True)

# ── Extract-features path setup ───────────────────────────────────────────────
# The extract_features.py script lives alongside this file.
SCRIPT_DIR  = os.path.dirname(os.path.abspath(__file__))
PACKAGE_DIR = (
    "/storage/research/igmp_slide_workspace/GRP Zlobec/Amjad/qupath/"
    "metassist-v1/MetAssist_expansion/crc-ugi/code/package_refactored"
)
sys.path.insert(0, os.path.dirname(SCRIPT_DIR))
sys.path.insert(0, PACKAGE_DIR)

# Import the per-slide inference function from the co-located script.
# This requires extract_features.py to be importable (no top-level side-effects).
from models.virchow2.extract_features import infer_wsi  # noqa: E402
from utils.wsi import ACCEPTED_WSI_TYPES               # noqa: E402


# ── Helpers ───────────────────────────────────────────────────────────────────

def _atomic_write_json(path: str, payload: dict) -> None:
    tmp = path + ".tmp"
    with open(tmp, "w") as fh:
        json.dump(payload, fh, indent=2)
    os.replace(tmp, path)


def update_progress(
    state: dict,
    global_pct: int | None = None,
    global_msg: str | None = None,
) -> None:
    if global_pct is not None:
        state["pct"] = max(0, min(100, int(global_pct)))
    if global_msg is not None:
        state["message"] = global_msg
        print(f"[{state['pct']:3d}%] {global_msg}", flush=True)
    _atomic_write_json(os.path.join(RESULT_DIR, "progress.json"), state)


def write_result_json(payload: dict) -> None:
    _atomic_write_json(os.path.join(RESULT_DIR, "result.json"), payload)


def _npz_out_path(slide_path: str) -> str:
    slide_id = os.path.splitext(os.path.basename(slide_path))[0]
    return os.path.join(OUTPUT_DIR, f"{slide_id}.npz")


def _is_done(slide_path: str, overwrite: bool) -> bool:
    """Return True if the .npz already exists and we should skip this slide."""
    if overwrite:
        return False
    return os.path.exists(_npz_out_path(slide_path))


# ── Main ──────────────────────────────────────────────────────────────────────

def main() -> None:
    # Params exposed via catalog.json
    tile_size:  int   = int(PARAMS.get("tile_size",  224))
    resolution: int   = int(PARAMS.get("resolution", 0))
    batch_size: int   = int(PARAMS.get("batch_size", 128))
    overwrite:  bool  = bool(PARAMS.get("overwrite", False))

    total     = len(TARGETS)
    successful = 0
    failed     = 0
    scans: list[dict] = []

    state: dict = {
        "pct":     0,
        "message": "Initialising…",
        "slides":  {str(t["scan_id"]): {"status": "pending", "progress": 0} for t in TARGETS},
    }

    # ── Build a base result that we overwrite after each slide ────────────────
    base_result: dict = {
        "model_id":      MODEL_ID,
        "scope":         "batch",
        "job_id":        JOB_ID,
        "job_status":    "running",
        "params":        PARAMS,
        "batch_summary": {"total_slides": total, "successful": 0, "failed": 0},
        "scans":         [],
    }

    if total == 0:
        update_progress(state, 100, "No targets provided. Nothing to do.")
        base_result["job_status"] = "complete"
        write_result_json(base_result)
        return

    update_progress(state, 0, "Loading Virchow2 model…")
    write_result_json(base_result)

    # ── Load model once ───────────────────────────────────────────────────────
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    model = timm.create_model(
        "hf-hub:paige-ai/Virchow2",
        pretrained=True,
        mlp_layer=SwiGLUPacked,
        act_layer=torch.nn.SiLU,
    )
    model = model.eval().to(device)
    update_progress(state, 2, f"Model loaded on {device}. Processing {total} slides…")

    start_all = time.time()

    for idx, target in enumerate(TARGETS):
        scan_id    = target.get("scan_id")
        slide_path = target.get("file_path", "")
        slide_id   = os.path.splitext(os.path.basename(slide_path))[0]

        # ── Pre-flight checks ─────────────────────────────────────────────────
        if not slide_path or not os.path.isfile(slide_path):
            scans.append({
                "scan_id":   scan_id,
                "scan_path": slide_path,
                "status":    "failed",
                "error":     "WSI not found on disk",
                "files":     {},
            })
            state["slides"][str(scan_id)]["status"]   = "failed"
            state["slides"][str(scan_id)]["message"]  = "WSI not found on disk"
            failed += 1
            pct = 2 + int((idx + 1) / total * 95)
            update_progress(state, pct, f"[{idx+1}/{total}] Skipped (file missing): {slide_id}")
            base_result.update({"batch_summary": {"total_slides": total, "successful": successful, "failed": failed}, "scans": scans})
            write_result_json(base_result)
            continue

        ext = os.path.splitext(slide_path)[1].lower()
        if ext not in ACCEPTED_WSI_TYPES:
            scans.append({
                "scan_id":   scan_id,
                "scan_path": slide_path,
                "status":    "failed",
                "error":     f"Unsupported file type: {ext}",
                "files":     {},
            })
            state["slides"][str(scan_id)]["status"]  = "failed"
            state["slides"][str(scan_id)]["message"] = f"Unsupported file type: {ext}"
            failed += 1
            pct = 2 + int((idx + 1) / total * 95)
            update_progress(state, pct, f"[{idx+1}/{total}] Skipped (unsupported type): {slide_id}")
            base_result.update({"batch_summary": {"total_slides": total, "successful": successful, "failed": failed}, "scans": scans})
            write_result_json(base_result)
            continue

        # ── Skip if already done ──────────────────────────────────────────────
        if _is_done(slide_path, overwrite):
            npz_path = _npz_out_path(slide_path)
            try:
                data = np.load(npz_path, allow_pickle=False)
                n_tiles, feature_dim = data["features"].shape
            except Exception:
                n_tiles = feature_dim = 0

            scans.append({
                "scan_id":   scan_id,
                "scan_path": slide_path,
                "status":    "skipped",
                "outcome": {
                    "status":         "features_extracted",
                    "n_tiles":        n_tiles,
                    "feature_dim":    feature_dim,
                    "tile_size":      tile_size,
                    "resolution_mpp": resolution,
                    "feature_file":   npz_path,
                },
                "files": {"feature_file": npz_path},
            })
            state["slides"][str(scan_id)]["status"]   = "skipped"
            state["slides"][str(scan_id)]["progress"] = 100
            pct = 2 + int((idx + 1) / total * 95)
            update_progress(state, pct, f"[{idx+1}/{total}] Skipped (already done): {slide_id}")
            successful += 1
            base_result.update({"batch_summary": {"total_slides": total, "successful": successful, "failed": failed}, "scans": scans})
            write_result_json(base_result)
            continue

        # ── Run extraction ────────────────────────────────────────────────────
        pct_start = 2 + int(idx / total * 95)
        update_progress(state, pct_start, f"[{idx+1}/{total}] Extracting: {slide_id}")
        state["slides"][str(scan_id)]["status"] = "running"

        t0 = time.time()
        try:
            out_path = infer_wsi(
                wsi_path=slide_path,
                out_folder=OUTPUT_DIR,
                resolution=resolution,
                tile_size=tile_size,
                batch_size=batch_size,
                model=model,
            )

            # Read back the .npz to report tile count and feature dimension
            data = np.load(out_path, allow_pickle=False)
            n_tiles, feature_dim = data["features"].shape

            elapsed = round(time.time() - t0, 1)
            scans.append({
                "scan_id":   scan_id,
                "scan_path": slide_path,
                "status":    "done",
                "elapsed_s": elapsed,
                "outcome": {
                    "status":         "features_extracted",
                    "n_tiles":        n_tiles,
                    "feature_dim":    feature_dim,
                    "tile_size":      tile_size,
                    "resolution_mpp": resolution,
                    "feature_file":   out_path,
                },
                "files": {"feature_file": out_path},
            })
            state["slides"][str(scan_id)]["status"]   = "done"
            state["slides"][str(scan_id)]["progress"] = 100
            successful += 1

            pct_end = 2 + int((idx + 1) / total * 95)
            update_progress(state, pct_end, f"[{idx+1}/{total}] Done ({elapsed}s, {n_tiles} tiles): {slide_id}")

        except Exception:
            tb = traceback.format_exc()
            elapsed = round(time.time() - t0, 1)
            print(f"[fail] {slide_id}\n{tb}", flush=True)
            scans.append({
                "scan_id":   scan_id,
                "scan_path": slide_path,
                "status":    "failed",
                "elapsed_s": elapsed,
                "error":     tb,
                "files":     {},
            })
            state["slides"][str(scan_id)]["status"]  = "failed"
            state["slides"][str(scan_id)]["message"] = "Inference error — see SLURM log"
            failed += 1

            pct_end = 2 + int((idx + 1) / total * 95)
            update_progress(state, pct_end, f"[{idx+1}/{total}] FAILED: {slide_id}")

        # Write running result.json after every slide so the UI can follow progress.
        base_result.update({
            "batch_summary": {"total_slides": total, "successful": successful, "failed": failed},
            "scans": scans,
        })
        write_result_json(base_result)

    # ── Finalise ──────────────────────────────────────────────────────────────
    total_elapsed = round(time.time() - start_all, 1)
    final_msg = (
        f"Complete — {successful}/{total} slides extracted in {total_elapsed}s"
        + (f" | {failed} failed" if failed else "")
    )
    base_result["job_status"] = "complete"
    write_result_json(base_result)
    update_progress(state, 100, final_msg)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        tb = traceback.format_exc()
        print(tb, file=sys.stderr)
        err_path = os.path.join(RESULT_DIR, "error.txt")
        with open(err_path, "w") as f:
            f.write(tb)
        try:
            _atomic_write_json(
                os.path.join(RESULT_DIR, "progress.json"),
                {"pct": 0, "message": "Fatal error — see error.txt"},
            )
        except Exception:
            pass
        sys.exit(1)