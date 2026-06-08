"""
PathoDB — CRC Tissue Segmentation Detector (BATCH MODE)
=========================================================
Single-stage Mask2Former pipeline for Batch Processing:
  Loads the model into GPU memory once, then iterates over a list
  of WSIs provided in the batch_context.json.

Inputs arrive via the batch_context.json file passed as sys.argv[1].
Outputs written to the custom RESULT_DIR:
  progress.json  — polled every 5s by the API for the live tracking
  result.json    — aggregated summary of all slides processed
  <wsi>.geojson  — primary multi-class overlay (per slide)
  error.txt      — stack trace on global failure
"""

import json
import os
import sys
import traceback

import cv2
import numpy as np
import torch

# ── PathoDB Batch Context ──────────────────────────────────────────────────────
if len(sys.argv) < 2:
    print("Error: Missing batch_context.json argument.", file=sys.stderr)
    sys.exit(1)

CONTEXT_FILE = sys.argv[1]
with open(CONTEXT_FILE, "r") as f:
    CONTEXT = json.load(f)

JOB_ID             = CONTEXT.get("job_id", "unknown")
RESULT_DIR         = CONTEXT.get("result_dir", os.getcwd()) # For progress.json / result.json
OUTPUT_DIR         = CONTEXT.get("output_dir", os.getcwd()) # For heavy GeoJSONs
PARAMS             = CONTEXT.get("params", {})
TARGETS            = CONTEXT.get("targets", [])  # List of {"scan_id": int, "file_path": str}
MODEL_ID           = "crc_tissue_seg"
SAVE_VISUALIZATION = bool(PARAMS.get("save_visualization", False))

os.makedirs(RESULT_DIR, exist_ok=True)

# ── Third-party package paths ──────────────────────────────────────────────────
SCRIPT_DIR  = os.path.dirname(os.path.abspath(__file__))
PACKAGE_DIR = "/storage/research/igmp_slide_workspace/GRP Zlobec/Amjad/qupath/metassist-v1/MetAssist_expansion/crc-ugi/code/package_refactored"
sys.path.insert(0, os.path.dirname(SCRIPT_DIR))
sys.path.insert(0, PACKAGE_DIR)

from models.model_io import create_mask2former_from_checkpoint
from engine.inference import infer_wsi
from utils.wsi import prepare_read_from_slide, detect_tissue_mask
from utils.geometry import save_geojson_annotation
from utils.constants import COLORMAP

# ── System constants ─────────────────────────────────────────────────────────────
NR_GPUS = torch.cuda.device_count()
GPU_TYPE = torch.cuda.get_device_name(0) if NR_GPUS > 0 else "CPU"

# ── Model constants (not user-tunable) ────────────────────────────────────────
CHECKPOINT_PATH = "/storage/research/igmp_slide_workspace/GRP Zlobec/Amjad/qupath/metassist-v1/MetAssist_expansion/crc-ugi/results/Virchow_deepest_crc_met_multiclass_55_plus_back/dinov2-h-virchow2_swin-large-cityscapes-semantic_res_1.0_tile_size_336_step_size_280/checkpoints/dinov2-h-virchow2_swin-large-cityscapes-semantic_res_1.0_tile_size_336_step_size_280_fold_5.pt"
ENCODER_MODEL   = "dinov2-h-virchow2"
DECODER_MODEL   = "swin-large-cityscapes-semantic"
FEATURE_LAYERS  = [16, 20, 24, 31]

LABEL2ID = {
    "Unanotated": 0, "Background": 1, "Fat": 2, "Normal Mucosa": 3,
    "Lymphoid tissue": 4, "Stroma": 5, "Mucous": 6, "Tumor": 7,
    "Necrosis/debris": 8, "Muscle/vessel": 9, "Nerve": 10, "Blood": 11
}

IGNORE_IDS = [LABEL2ID.get("Unanotated", 0), LABEL2ID.get("Background", 1)]
ID2LABEL = {v: k for k, v in LABEL2ID.items()}

# ── User-tunable parameters ────────────────────────────────────────────────────
RESOLUTION      = 1.0
BATCH_SIZE      = 256 if "A100" in GPU_TYPE else 256 if "H100" in GPU_TYPE else 90
TILE_SIZE       = int(PARAMS.get("tile_size", 336))
USE_TISSUE_MASK = PARAMS.get("use_tissue_mask", True) 
STEP_SIZE       = int(TILE_SIZE - (TILE_SIZE * PARAMS.get("tile_overlap", 66.667)  // 100))
CROP_PRED_EDGE  = 84 if PARAMS.get("tile_overlap", 66.667) > 25 else 50


# ─────────────────────────────────────────────────────────────────────────────
# HELPERS
# ─────────────────────────────────────────────────────────────────────────────

def close_tumor(pred_mask: np.ndarray, tumor_class: int) -> np.ndarray:
    """Close small gaps inside tumor regions."""
    kernel = np.ones((5, 5), np.uint8)
    tum_mask = (pred_mask == tumor_class).astype(np.uint8)
    tum_mask = cv2.morphologyEx(tum_mask, cv2.MORPH_CLOSE, kernel)
    pred_mask[tum_mask == 1] = tumor_class
    return pred_mask


# ─────────────────────────────────────────────────────────────────────────────
# MAIN BATCH LOOP
# ─────────────────────────────────────────────────────────────────────────────

def main() -> None:
    if not os.path.exists(CHECKPOINT_PATH):
        raise FileNotFoundError(f"Checkpoint not found: {CHECKPOINT_PATH}")
    assert STEP_SIZE <= TILE_SIZE, 'Step size should be less than or equal to tile size'
    assert CROP_PRED_EDGE / 2 <= (TILE_SIZE - STEP_SIZE), 'Crop pred edge should be <= half of tile overlap'

    total_slides = len(TARGETS)

    # ── Resume: load any results from a previous interrupted run ──────────────
    completed_scan_ids: set = set()
    prev_results: dict = {}

    prev_result_file = os.path.join(RESULT_DIR, "result.json")
    if os.path.exists(prev_result_file):
        try:
            with open(prev_result_file, "r") as f:
                prev_data = json.load(f)
            for scan_result in prev_data.get("scans", []):
                if scan_result.get("status") == "success":
                    sid = str(scan_result["scan_id"])
                    completed_scan_ids.add(sid)
                    prev_results[sid] = scan_result
            if completed_scan_ids:
                print(
                    f"[resume] {len(completed_scan_ids)} slide(s) already completed "
                    f"in a previous run — skipping them.",
                    flush=True,
                )
        except Exception as e:
            print(f"[resume] Could not load previous result.json: {e}", flush=True)

    # 1. Initialize the Live State Dictionary for progress.json
    state = {
        "pct": 0,
        "message": "Initializing batch...",
        "slides": {
            str(t["scan_id"]): {
                "scan_path": t.get("file_path"),
                "status":   "success" if str(t["scan_id"]) in completed_scan_ids else "pending",
                "progress": 100       if str(t["scan_id"]) in completed_scan_ids else 0,
                "message":  "Completed in previous run" if str(t["scan_id"]) in completed_scan_ids else "Queued",
            }
            for t in TARGETS
        }
    }

    def update_progress(global_pct=None, global_msg=None) -> None:
        """Write detailed live progress.json atomically."""
        if global_pct is not None:
            state["pct"] = max(0, min(100, int(global_pct)))
        if global_msg is not None:
            state["message"] = global_msg
            print(f"[{state['pct']:3d}%] {global_msg}", flush=True)

        tmp = os.path.join(RESULT_DIR, "progress.tmp")
        dst = os.path.join(RESULT_DIR, "progress.json")
        with open(tmp, "w") as f:
            json.dump(state, f, indent=2)
        os.replace(tmp, dst)

    if total_slides == 0:
        update_progress(100, "No targets provided. Exiting.")
        return

    print(f"=== PathoDB CRC Tissue Seg Detector (BATCH) ===")
    print(f"Result dir : {RESULT_DIR}")
    print(f"Targets    : {total_slides} slides")
    print(f"System     : {NR_GPUS} GPU(s) [{GPU_TYPE}]", flush=True)

    # ── 1. Load model once for the entire batch ────────────────────────────────
    update_progress(2, f"Loading model into memory [{GPU_TYPE}]...")
    model = create_mask2former_from_checkpoint(
        checkpoint_path=CHECKPOINT_PATH,
        label2id=LABEL2ID,
        encoder_name=ENCODER_MODEL,
        decoder_model=DECODER_MODEL,
        out_indices=FEATURE_LAYERS
    )

    empty_result = {
        "scan_id": None,
        "scan_path": None,
        "status": None,
        "error": None,
        "timing_s": None,
        "composition_pct": None,
        "files": {},
        "overlays": None
    }

    batch_results = [None] * len(TARGETS)
    successful = 0
    failed = 0

    # Pre-populate batch_results: carry forward any previously-successful slides
    for idx, target in enumerate(TARGETS):
        sid = str(target.get("scan_id"))
        if sid in completed_scan_ids:
            batch_results[idx] = prev_results[sid]
            successful += 1
        else:
            batch_results[idx] = {**empty_result, "scan_id": target.get("scan_id"), "scan_path": target.get("file_path")}

    with open(os.path.join(RESULT_DIR, "result.json"), "w") as f:
        json.dump({
            "model_id": MODEL_ID,
            "scope": "batch",
            "job_id": JOB_ID,
            "job_status": "running",
            "params": PARAMS,
            "batch_summary": {
                "total_slides": total_slides,
                "successful": successful,
                "failed": failed
            },
            "scans": batch_results
        }, f, indent=2)

    # ── 2. Process each slide ──────────────────────────────────────────────────
    for idx, target in enumerate(TARGETS):
        scan_id = target.get("scan_id")
        scan_id_str = str(scan_id)
        scan_path = target.get("file_path")
        wsi_name = os.path.splitext(os.path.basename(scan_path))[0]

        if scan_id_str in completed_scan_ids:
            print(f"[{idx+1}/{total_slides}] {wsi_name}: skipping (already completed).", flush=True)
            continue

        # Calculate base progress for this slide (leaves 2% for model load, 2% for final JSON)
        base_pct = 2 + (idx / total_slides) * 96
        
        def slide_prog(sub_pct, msg):
            """Updates both the global batch progress and the individual slide progress."""
            global_pct = int(base_pct + (sub_pct / 100.0) * (96 / total_slides))
            state["slides"][scan_id_str]["status"] = "running"
            state["slides"][scan_id_str]["progress"] = sub_pct
            state["slides"][scan_id_str]["message"] = msg
            update_progress(global_pct, f"[{idx+1}/{total_slides}] {wsi_name}: {msg}")

        try:
            if not os.path.isfile(scan_path):
                raise FileNotFoundError(f"WSI not found on disk: {scan_path}")

            slide_prog(10, "Detecting tissue mask and reading bounds...")
            (level, level_ds, exact_res, tile_ds_factor, orig_dim, read_origin) = prepare_read_from_slide(
                scan_path, resolution=RESOLUTION, file_type=os.path.splitext(scan_path)[1].lower()
            )

            if USE_TISSUE_MASK:
                tissue_mask, _ = detect_tissue_mask(scan_path)
            else:
                tissue_mask = np.ones((5, 5), dtype=np.uint8)

            # Inference
            slide_prog(30, "Running multi-class tissue inference...")
            pred_mask, _, _, _, _, _, inf_time, __ = infer_wsi(
                model, scan_path, tissue_mask,
                BATCH_SIZE, TILE_SIZE, STEP_SIZE, CROP_PRED_EDGE,
                RESOLUTION, 1
            )

            slide_prog(70, "Applying post-processing...")
            if LABEL2ID["Tumor"] in np.unique(pred_mask):
                pred_mask = close_tumor(pred_mask, LABEL2ID["Tumor"])

            # GeoJSON
            slide_prog(80, "Saving GeoJSON overlays...")
            geojson_mask = os.path.join(OUTPUT_DIR, f"{wsi_name}.geojson")
            save_geojson_annotation(
                out_path=geojson_mask,
                mask=pred_mask,
                level=level,
                level_downsampling=(level_ds * tile_ds_factor),
                category_dict={k: v for k, v in LABEL2ID.items() if k not in ("Unanotated", "Background")}
            )

            # Composition
            slide_prog(95, "Computing composition...")
            unique_classes, pixel_counts = np.unique(pred_mask, return_counts=True)
            raw_counts = dict(zip(unique_classes, pixel_counts))
            valid_pixels = {cid: count for cid, count in raw_counts.items() if cid not in IGNORE_IDS}
            total_tissue_pixels = sum(valid_pixels.values())

            tissue_composition = {}
            if total_tissue_pixels > 0:
                for cid, count in valid_pixels.items():
                    c_name = ID2LABEL.get(cid, f"Class_{cid}").replace("_", " ").title()
                    tissue_composition[c_name] = round((count / total_tissue_pixels) * 100, 2)
            
            tissue_composition = dict(sorted(tissue_composition.items(), key=lambda item: item[1], reverse=True))

            # Store result for this slide
            slide_files = {"download_file": geojson_mask}
            slide_overlays = None
            if SAVE_VISUALIZATION:
                slide_files["geojson_overlay"] = geojson_mask
                slide_overlays = [{
                    "name": "Tissue Classes",
                    "file_key": "geojson_overlay",
                    "type": "geojson",
                    "legend": {
                        c: "#{:02x}{:02x}{:02x}".format(*COLORMAP.get(c, (0, 0, 0)))
                        for c in LABEL2ID.keys() if c not in IGNORE_IDS
                    }
                }]

            batch_results[idx] = {
                "scan_id": scan_id,
                "scan_path": scan_path,
                "status": "success",
                "timing_s": round(inf_time, 2),
                "composition_pct": tissue_composition,
                "files": slide_files,
                "overlays": slide_overlays,
            }
            successful += 1

            # Mark slide finished in the live state
            state["slides"][scan_id_str]["status"] = "success"
            state["slides"][scan_id_str]["progress"] = 100
            state["slides"][scan_id_str]["message"] = "Processed successfully."
            update_progress()

        except Exception as e:
            tb = traceback.format_exc()
            print(f"\n[ERROR] Slide {wsi_name} failed:\n{tb}", file=sys.stderr)
            batch_results[idx] = {
                "scan_id": scan_id,
                "scan_path": scan_path,
                "status": "failed",
                "error": str(e)
            }
            failed += 1
            
            # Mark slide failed in the live state
            state["slides"][scan_id_str]["status"] = "failed"
            state["slides"][scan_id_str]["progress"] = 0
            state["slides"][scan_id_str]["message"] = f"Error: {str(e)}"
            update_progress()
            
        finally:
            # Free memory between slides to prevent creeping OOM errors
            torch.cuda.empty_cache()

        # Write intermediate result.json (Fallback sync)
        final_result = {
            "model_id": MODEL_ID,
            "scope": "batch",
            "job_id": JOB_ID,
            "job_status": "running",
            "params": PARAMS,
            "batch_summary": {
                "total_slides": total_slides,
                "successful": successful,
                "failed": failed
            },
            "scans": batch_results 
        }

        with open(os.path.join(RESULT_DIR, "result.json"), "w") as f:
            json.dump(final_result, f, indent=2)

    # change status to complete at the end (after all slides processed) to ensure API doesn't read partial results
    final_result["job_status"] = "complete"
    with open(os.path.join(RESULT_DIR, "result.json"), "w") as f:
        json.dump(final_result, f, indent=2)

    update_progress(100, f"Batch complete. {successful}/{total_slides} successful.")
    print(f"\n=== Batch Complete ===")
    print(f"Success: {successful} | Failed: {failed}")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        tb = traceback.format_exc()
        # Fallback state injection if catastrophic failure
        try:
            tmp = os.path.join(RESULT_DIR, "progress.tmp")
            dst = os.path.join(RESULT_DIR, "progress.json")
            with open(tmp, "w") as f:
                json.dump({"pct": 0, "message": "Fatal batch failure — see error.txt", "slides": {}}, f)
            os.replace(tmp, dst)
        except Exception:
            pass
        
        error_path = os.path.join(RESULT_DIR, "error.txt")
        with open(error_path, "w") as f:
            f.write(tb)
        print(tb, file=sys.stderr)
        sys.exit(1)