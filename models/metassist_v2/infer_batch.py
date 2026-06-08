"""
PathoDB — LVI / LN Metastasis Detector (BATCH MODE)
=====================================================
Two-stage Mask2Former pipeline for batch processing:
  Loads both models (LN segmentation + metastasis detection) into GPU memory
  once, then iterates over all WSIs in batch_context.json.

Input: batch_context.json path passed as sys.argv[1]
  {
    "job_id":     int,
    "result_dir": str,   -- progress.json / result.json landing directory
    "output_dir": str,   -- GeoJSONs and OME-TIFFs (may differ from result_dir)
    "params":     {...},
    "targets":    [{"scan_id": int, "file_path": str}, ...]
  }

Outputs per slide (written to output_dir):
  <wsi>_ln.geojson          -- LN boundary overlay (QuPath-compatible)
  <wsi>_metastasis.geojson  -- metastasis/deposit overlay
  <wsi>_ln_overlay.ome.tif  -- pyramidal RGBA overlay: Stage 1 tissue classes
  <wsi>_met_overlay.ome.tif -- pyramidal RGBA overlay: metastasis deposits only

Aggregated outputs (written to result_dir):
  progress.json  -- polled every 5s by the API for live per-slide tracking
  result.json    -- aggregated summary; job_status="complete" when all done
  error.txt      -- stack trace on catastrophic (pre-loop) failure
"""

import csv
import json
import os
import sys
import time
import traceback

import cv2
import numpy as np
import openslide
import torch
import tifffile
from scipy.ndimage import binary_fill_holes

# ── Batch Context ──────────────────────────────────────────────────────────────
if len(sys.argv) < 2:
    print("Error: Missing batch_context.json argument.", file=sys.stderr)
    sys.exit(1)

CONTEXT_FILE = sys.argv[1]
with open(CONTEXT_FILE, "r") as f:
    CONTEXT = json.load(f)

JOB_ID     = CONTEXT.get("job_id", "unknown")
RESULT_DIR = CONTEXT.get("result_dir", os.getcwd())
OUTPUT_DIR = CONTEXT.get("output_dir", os.getcwd())
PARAMS     = CONTEXT.get("params", {})
TARGETS    = CONTEXT.get("targets", [])
MODEL_ID   = "metassist_v2"

os.makedirs(RESULT_DIR, exist_ok=True)
os.makedirs(OUTPUT_DIR, exist_ok=True)

# ── Third-party package paths ──────────────────────────────────────────────────
SCRIPT_DIR  = os.path.dirname(os.path.abspath(__file__))
PACKAGE_DIR = "/storage/research/igmp_slide_workspace/GRP Zlobec/Amjad/qupath/metassist-v1/MetAssist_expansion/crc-ugi/code/package_refactored"
sys.path.insert(0, os.path.dirname(SCRIPT_DIR))
sys.path.insert(0, PACKAGE_DIR)

from models.model_io import create_mask2former_from_checkpoint
from engine.inference import infer_wsi
from utils.wsi import prepare_read_from_slide, detect_colors
from utils.geometry import save_geojson_annotation
from utils.evaluation import get_slide_level_result
from utils.postprocessing import post_process

# ── System ─────────────────────────────────────────────────────────────────────
NR_GPUS  = torch.cuda.device_count()
GPU_TYPE = torch.cuda.get_device_name(0) if NR_GPUS > 0 else "CPU"

# ── Model constants ────────────────────────────────────────────────────────────
LN_CHECKPOINT  = "/storage/research/igmp_slide_workspace/GRP Zlobec/Amjad/qupath/metassist-v1/MetAssist_expansion/crc-ugi/results/Virchow_deep_LN_Tumor_Normal_Vessel_Fat_Mucin_v2/checkpoints/dinov2-h-virchow2_swin-large-cityscapes-semantic_res_8.0_tile_size_672_step_size_504_fold_1.pt"
MET_CHECKPOINT = "/storage/research/igmp_slide_workspace/GRP Zlobec/Amjad/qupath/metassist-v1/MetAssist_expansion/crc-ugi/results/Virchow_deepest_crcugi_met/dinov2-h-virchow2_swin-large-cityscapes-semantic_res_1.0_tile_size_336_step_size_280/checkpoints/dinov2-h-virchow2_swin-large-cityscapes-semantic_res_1.0_tile_size_336_step_size_280_fold_4.pt"
ENCODER_MODEL  = "dinov2-h-virchow2"
DECODER_MODEL  = "swin-large-cityscapes-semantic"
LN_FEATURE_LAYERS  = [12, 16, 20, 24]
MET_FEATURE_LAYERS = [16, 20, 24, 31]

LN_LABEL2ID  = {"Background": 0, "Fat tissue": 4, "Vessels": 5, "Lymph node": 1,
                "Tumor deposits": 2, "Primary tumor": 2, "Primary tissue": 3, "Mucin": 6}
MET_LABEL2ID = {"Background": 0, "Metastasis": 2, "Training region": 1}

LN_COLORMAP = {
    "Lymph node":     ( 65, 105, 225),
    "Tumor deposits": (255, 140,   0),
    "Primary tissue": (144, 238, 144),
    "Fat tissue":     (255, 255, 153),
    "Vessels":        (139,   0,   0),
    "Mucin":          (186,  85, 211),
    "Primary tumor":  (255, 140,   0),
}
LN_ALPHA = {
    "Lymph node":     100, "Tumor deposits": 160, "Primary tissue":  90,
    "Fat tissue":      80, "Vessels":        130, "Mucin":           100, "Primary tumor": 160,
}
MET_COLORMAP = {"Metastasis": (220, 20, 60)}
MET_ALPHA     = {"Metastasis": 200}

# ── User-tunable parameters ────────────────────────────────────────────────────
LN_RESOLUTION         = 8.0
MET_RESOLUTION        = 1.0
LN_BATCH_SIZE         = 30
MET_BATCH_SIZE        = 100
LN_TILE_SIZE          = 672
LN_STEP_SIZE          = 112
LN_CROP_PRED_EDGE     = 50
MET_TILE_SIZE         = int(PARAMS.get("met_tile_size",  336))
_met_overlap          = PARAMS.get("met_tile_overlap",   66.667)
MET_STEP_SIZE         = int(MET_TILE_SIZE - (MET_TILE_SIZE * _met_overlap // 100))
MET_CROP_PRED_EDGE    = 84 if _met_overlap > 25 else 50
COMPLEXITY_THRESHOLD  = 2.9
APPLY_POST_PROCESSING = True


# ─────────────────────────────────────────────────────────────────────────────
# HELPERS
# ─────────────────────────────────────────────────────────────────────────────

def save_pyramidal_overlay_tiff(rgba, out_path, tile_size=256, compression="deflate"):
    if rgba.ndim != 3 or rgba.shape[2] != 4:
        raise ValueError(f"Expected (H, W, 4) RGBA array, got shape {rgba.shape}")
    if rgba.dtype != np.uint8:
        raise ValueError(f"Expected uint8 RGBA, got dtype {rgba.dtype}")

    levels = [rgba]
    current = rgba
    while max(current.shape[:2]) > tile_size:
        new_h = max(1, current.shape[0] // 2)
        new_w = max(1, current.shape[1] // 2)
        current = cv2.resize(current, (new_w, new_h), interpolation=cv2.INTER_NEAREST)
        levels.append(current)

    with tifffile.TiffWriter(out_path, bigtiff=True) as tif:
        for i, level_img in enumerate(levels):
            tif.write(
                level_img,
                subfiletype=1 if i > 0 else 0,
                photometric="rgb",
                tile=(tile_size, tile_size),
                compression=compression,
            )
    h, w = rgba.shape[:2]
    print(
        f"[pyramidal_tiff] {os.path.basename(out_path)}: base={w}x{h}, levels={len(levels)}",
        flush=True,
    )


def close_metastasis(pred_mask, metastasis_class):
    kernel = np.ones((5, 5), np.uint8)
    met_mask = (pred_mask == metastasis_class).astype(np.uint8)
    met_mask = cv2.morphologyEx(met_mask, cv2.MORPH_CLOSE, kernel)
    pred_mask[met_mask == 1] = metastasis_class
    return pred_mask


def merge_mucin_and_ln(ln_seg, ln_class, mucin_class):
    ln_mask = (ln_seg == ln_class).astype(np.uint8)
    if mucin_class < 0 or mucin_class not in np.unique(ln_seg):
        return ln_seg, binary_fill_holes(ln_mask).astype(np.uint8)

    ln_dilated = cv2.dilate(ln_mask, np.ones((5, 5), np.uint8), iterations=1)
    mucin_mask = (ln_seg == mucin_class).astype(np.uint8)
    num, labeled = cv2.connectedComponents(mucin_mask, connectivity=8)
    for label in range(1, num):
        component = (labeled == label)
        if np.any(component & ln_dilated):
            ln_mask |= component
        else:
            ln_seg[component] = 0

    return ln_seg, binary_fill_holes(ln_mask).astype(np.uint8)


# ─────────────────────────────────────────────────────────────────────────────
# PER-SLIDE PROCESSING
# ─────────────────────────────────────────────────────────────────────────────

def process_slide(scan_id, scan_path, ln_model, met_model, output_dir, slide_prog):
    """
    Full two-stage pipeline for one slide.
    Returns a result dict on success; raises on failure.
    Large numpy arrays are local and go out of scope after return.
    """
    wsi_name = os.path.splitext(os.path.basename(scan_path))[0]
    t_start  = time.time()

    if not os.path.isfile(scan_path):
        raise FileNotFoundError(f"WSI not found on disk: {scan_path}")

    # ── Stage 1 — Lymph node segmentation ─────────────────────────────────────
    slide_prog(5, "Preparing WSI at LN resolution…")
    (level, level_downsampling, exact_resolution,
     tiling_downsample_factor, original_dim, read_origin) = prepare_read_from_slide(
        scan_path, resolution=LN_RESOLUTION,
        file_type=os.path.splitext(scan_path)[1].lower(),
    )
    tissue_mask = np.ones((5, 5), dtype=np.uint8)

    slide_prog(10, "Running LN segmentation…")
    ln_pred_mask, _, _, _, _, _, ln_time, __ = infer_wsi(
        ln_model, scan_path, tissue_mask,
        LN_BATCH_SIZE, LN_TILE_SIZE, LN_STEP_SIZE, LN_CROP_PRED_EDGE,
        LN_RESOLUTION, 1,
    )

    slide_prog(35, "Post-processing LN detections…")
    if APPLY_POST_PROCESSING:
        min_ln_area = ((600 / 2) / (exact_resolution * tiling_downsample_factor)) ** 2 * np.pi
        ln_pred_mask = post_process(
            segmentation_mask    = ln_pred_mask,
            lymph_node_class     = LN_LABEL2ID["Lymph node"],
            classes_to_merge     = [LN_LABEL2ID.get("Primary tumor", -1), LN_LABEL2ID.get("Mucin", -1)],
            merge_thresholds     = [0.95, 0.05],
            erase_thresholds     = [0.01, 0.01],
            apply_opening        = [True, False],
            min_ln_area          = int(min_ln_area),
            complexity_threshold = COMPLEXITY_THRESHOLD,
        )

        slide_prog(42, "Filtering LN noise regions…")
        ln_class_mask         = (ln_pred_mask == LN_LABEL2ID["Lymph node"]).astype(np.uint8)
        num_labels, label_map = cv2.connectedComponents(ln_class_mask)
        slide_handle          = openslide.open_slide(scan_path)

        for i in range(1, num_labels):
            bbox = cv2.boundingRect((label_map == i).astype(np.uint8))
            x0   = int(read_origin[0] + bbox[0] * level_downsampling)
            y0   = int(read_origin[1] + bbox[1] * level_downsampling)
            rw   = int(bbox[2] * tiling_downsample_factor)
            rh   = int(bbox[3] * tiling_downsample_factor)
            crop = np.array(slide_handle.read_region((x0, y0), level, (rw, rh)))
            crop[crop[:, :, 3] == 0] = 255
            crop = cv2.cvtColor(crop, cv2.COLOR_RGBA2RGB)
            if tiling_downsample_factor > 1:
                crop = cv2.resize(
                    crop,
                    (crop.shape[1] // tiling_downsample_factor,
                     crop.shape[0] // tiling_downsample_factor),
                )
            roi_mask = ln_class_mask[bbox[1]:bbox[1] + bbox[3], bbox[0]:bbox[0] + bbox[2]]
            if not detect_colors(crop[roi_mask > 0], 0.025):
                ln_pred_mask[
                    bbox[1]:bbox[1] + bbox[3],
                    bbox[0]:bbox[0] + bbox[2],
                ] = LN_LABEL2ID.get("Background", 0)
        slide_handle.close()

    ln_seg_all, met_boundary_mask = merge_mucin_and_ln(
        ln_pred_mask.copy(),
        LN_LABEL2ID["Lymph node"],
        LN_LABEL2ID.get("Mucin", -1),
    )
    del ln_pred_mask
    ds_ln = level_downsampling * tiling_downsample_factor
    torch.cuda.empty_cache()

    # ── Stage 2 — Metastasis segmentation ─────────────────────────────────────
    slide_prog(50, "Running metastasis segmentation…")
    (level, level_downsampling, exact_resolution,
     tiling_downsample_factor, original_dim, read_origin) = prepare_read_from_slide(
        scan_path, resolution=MET_RESOLUTION,
        file_type=os.path.splitext(scan_path)[1].lower(),
    )
    met_pred_mask, _, _, _, _, _, met_time, __ = infer_wsi(
        met_model, scan_path, met_boundary_mask,
        MET_BATCH_SIZE, MET_TILE_SIZE, MET_STEP_SIZE, MET_CROP_PRED_EDGE,
        MET_RESOLUTION, 1,
    )
    if "Metastasis" in MET_LABEL2ID:
        met_pred_mask = close_metastasis(met_pred_mask, MET_LABEL2ID["Metastasis"])

    ds_met = level_downsampling * tiling_downsample_factor

    # ── GeoJSON overlays ───────────────────────────────────────────────────────
    slide_prog(75, "Saving GeoJSON overlays…")
    geojson_met = os.path.join(output_dir, f"{wsi_name}_metastasis.geojson")
    geojson_ln  = os.path.join(output_dir, f"{wsi_name}_ln.geojson")
    save_geojson_annotation(
        out_path=geojson_met, mask=met_pred_mask, level=level,
        level_downsampling=ds_met,
        category_dict={k: v for k, v in MET_LABEL2ID.items()
                       if k not in ("Background", "Training region")},
    )
    save_geojson_annotation(
        out_path=geojson_ln, mask=met_boundary_mask, level=level,
        level_downsampling=ds_ln, category_dict={"Lymph node": 1},
    )

    # ── Raster overlays ────────────────────────────────────────────────────────
    slide_prog(82, "Rasterizing OME-TIFF overlays…")
    tiff_ln_path  = os.path.join(output_dir, f"{wsi_name}_ln_overlay.ome.tif")
    tiff_met_path = os.path.join(output_dir, f"{wsi_name}_met_overlay.ome.tif")

    lut_ln = np.zeros((256, 4), dtype=np.uint8)
    for class_name, class_id in LN_LABEL2ID.items():
        if class_name == "Background":
            continue
        r, g, b = LN_COLORMAP.get(class_name, (128, 128, 128))
        lut_ln[class_id] = [r, g, b, LN_ALPHA.get(class_name, 100)]
    save_pyramidal_overlay_tiff(lut_ln[ln_seg_all], tiff_ln_path)

    lut_met = np.zeros((256, 4), dtype=np.uint8)
    for class_name, class_id in MET_LABEL2ID.items():
        r, g, b = MET_COLORMAP.get(class_name, (0, 0, 0))
        lut_met[class_id] = [r, g, b, MET_ALPHA.get(class_name, 0)]
    # Capture shapes before arrays are released
    ln_h, ln_w   = ln_seg_all.shape[:2]
    met_h, met_w = met_pred_mask.shape[:2]
    save_pyramidal_overlay_tiff(lut_met[met_pred_mask], tiff_met_path)

    # ── LN-level statistics ────────────────────────────────────────────────────
    slide_prog(90, "Computing LN and metastasis counts…")
    ln_binary = (met_boundary_mask > 0).astype(np.uint8)
    n_ln_labels, ln_label_map = cv2.connectedComponents(ln_binary, connectivity=8)
    ln_count   = max(0, n_ln_labels - 1)

    met_binary = (met_pred_mask == MET_LABEL2ID.get("Metastasis", 2)).astype(np.uint8)
    met_for_ln = cv2.resize(met_binary, (ln_w, ln_h), interpolation=cv2.INTER_NEAREST)

    positive_ln_count = 0
    for i in range(1, n_ln_labels):
        if np.any((ln_label_map == i) & (met_for_ln > 0)):
            positive_ln_count += 1

    # ── Slide-level clinical result ────────────────────────────────────────────
    slide_prog(94, "Computing slide-level result…")
    status, label, measurement = get_slide_level_result(
        mask             = met_pred_mask,
        ln_seg_mask      = ln_seg_all,
        metastasis_class = MET_LABEL2ID.get("Metastasis", 1),
        ln_class         = LN_LABEL2ID["Lymph node"],
        deposit_class    = LN_LABEL2ID.get("Tumor deposits", 2),
        fat_class        = LN_LABEL2ID.get("Fat tissue", 4),
        mucin_class      = LN_LABEL2ID.get("Mucin", 6),
        resolution       = exact_resolution * tiling_downsample_factor,
    )

    total_s = time.time() - t_start

    return {
        "scan_id":   scan_id,
        "scan_path": scan_path,
        "status":    "success",
        "error":     None,
        "timing_s": {
            "ln_s":    round(ln_time,  2),
            "met_s":   round(met_time, 2),
            "total_s": round(total_s,  2),
        },
        "outcome": {
            "status":            status,
            "label":             label,
            "measurement_um":    round(float(measurement), 2),
            "ln_count":          ln_count,
            "positive_ln_count": positive_ln_count,
            "primary_metric": {
                "label": "Max Extent",
                "value": f"{round(float(measurement) / 1000, 2)} mm" if measurement > 0 else "N/A",
            },
        },
        "files": {
            "metastasis_geojson": geojson_met,
            "ln_geojson":         geojson_ln,
            "raster_overlay_ln":  tiff_ln_path,
            "raster_overlay_met": tiff_met_path,
        },
        "overlays": [
            {
                "name":        "Lymph Nodes",
                "file_key":    "raster_overlay_ln",
                "type":        "tiled_image",
                "mask_width":  ln_w,
                "mask_height": ln_h,
                "legend": {
                    k: "#{:02x}{:02x}{:02x}".format(*LN_COLORMAP[k])
                    for k in LN_LABEL2ID if k != "Background" and k in LN_COLORMAP
                },
            },
            {
                "name":        "Metastasis",
                "file_key":    "raster_overlay_met",
                "type":        "tiled_image",
                "mask_width":  met_w,
                "mask_height": met_h,
                "legend": {
                    k: "#{:02x}{:02x}{:02x}".format(*MET_COLORMAP[k])
                    for k in MET_LABEL2ID if k in MET_COLORMAP
                },
            },
        ],
    }


# ─────────────────────────────────────────────────────────────────────────────
# MAIN BATCH LOOP
# ─────────────────────────────────────────────────────────────────────────────

def main():
    if not os.path.exists(LN_CHECKPOINT):
        raise FileNotFoundError(f"LN checkpoint not found: {LN_CHECKPOINT}")
    if not os.path.exists(MET_CHECKPOINT):
        raise FileNotFoundError(f"Metastasis checkpoint not found: {MET_CHECKPOINT}")

    total_slides = len(TARGETS)

    # ── Live state dict — written to progress.json after every update ──────────
    state = {
        "pct": 0,
        "message": "Initializing batch…",
        "slides": {
            str(t["scan_id"]): {
                "scan_path": t.get("file_path"),
                "status":   "pending",
                "progress": 0,
                "message":  "Queued",
            }
            for t in TARGETS
        },
    }

    def update_progress(global_pct=None, global_msg=None):
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

    print(f"=== PathoDB MetAssist v2 (BATCH) ===")
    print(f"Result dir : {RESULT_DIR}")
    print(f"Output dir : {OUTPUT_DIR}")
    print(f"Targets    : {total_slides} slides")
    print(f"System     : {NR_GPUS} GPU(s) [{GPU_TYPE}]", flush=True)

    # ── Load both models once for the entire batch ─────────────────────────────
    update_progress(2, f"Loading LN segmentation model [{GPU_TYPE}]…")
    ln_model = create_mask2former_from_checkpoint(
        LN_CHECKPOINT, LN_LABEL2ID, ENCODER_MODEL, DECODER_MODEL, LN_FEATURE_LAYERS
    )
    update_progress(5, "Loading metastasis detection model…")
    met_model = create_mask2former_from_checkpoint(
        MET_CHECKPOINT, MET_LABEL2ID, ENCODER_MODEL, DECODER_MODEL, MET_FEATURE_LAYERS
    )

    # Pre-populate so the API always reads a valid result.json
    batch_results = [
        {
            "scan_id": t["scan_id"], "scan_path": t["file_path"],
            "status": "pending", "error": None,
            "timing_s": None, "outcome": None, "files": {}, "overlays": None,
        }
        for t in TARGETS
    ]
    successful = 0
    failed     = 0

    def write_result(job_status="running"):
        tmp = os.path.join(RESULT_DIR, "result.tmp")
        dst = os.path.join(RESULT_DIR, "result.json")
        with open(tmp, "w") as f:
            json.dump({
                "model_id":    MODEL_ID,
                "scope":       "batch",
                "job_id":      JOB_ID,
                "job_status":  job_status,
                "params":      PARAMS,
                "batch_summary": {
                    "total_slides": total_slides,
                    "successful":   successful,
                    "failed":       failed,
                },
                "scans": batch_results,
            }, f, indent=2)
        os.replace(tmp, dst)

    CSV_PATH = os.path.join(OUTPUT_DIR, "result_slide_level.csv")
    CSV_HEADER = ["scan_path", "label", "status", "measurement_um"]

    def write_csv():
        """Rewrite result_slide_level.csv atomically with all slides processed so far."""
        tmp = CSV_PATH + ".tmp"
        with open(tmp, "w", newline="") as fh:
            writer = csv.writer(fh)
            writer.writerow(CSV_HEADER)
            for r in batch_results:
                outcome = r.get("outcome") or {}
                writer.writerow([
                    r.get("scan_path", ""),
                    outcome.get("label", ""),
                    outcome.get("status", r.get("status", "")),
                    outcome.get("measurement_um", ""),
                ])
        os.replace(tmp, CSV_PATH)

    write_result()   # empty skeleton so the API never reads a missing file

    # ── Per-slide loop ─────────────────────────────────────────────────────────
    for idx, target in enumerate(TARGETS):
        scan_id     = target.get("scan_id")
        scan_id_str = str(scan_id)
        scan_path   = target.get("file_path")
        wsi_name    = os.path.splitext(os.path.basename(scan_path))[0]

        # Progress budget: 5% model load | 93% slide body | 2% final write
        base_pct = 5 + (idx / total_slides) * 93

        # Default-argument capture avoids the loop-closure variable capture gotcha
        def slide_prog(
            sub_pct, msg,
            _sid=scan_id_str, _base=base_pct, _i=idx, _wsi=wsi_name,
        ):
            global_pct = int(_base + (sub_pct / 100.0) * (93 / total_slides))
            state["slides"][_sid]["status"]   = "running"
            state["slides"][_sid]["progress"] = sub_pct
            state["slides"][_sid]["message"]  = msg
            update_progress(global_pct, f"[{_i+1}/{total_slides}] {_wsi}: {msg}")

        try:
            result = process_slide(
                scan_id, scan_path, ln_model, met_model, OUTPUT_DIR, slide_prog
            )
            batch_results[idx] = result
            successful += 1

            outcome = result["outcome"]
            state["slides"][scan_id_str]["status"]   = "success"
            state["slides"][scan_id_str]["progress"] = 100
            state["slides"][scan_id_str]["message"]  = (
                f"{outcome['status']} — {outcome['measurement_um']:.0f} µm"
            )
            update_progress()

        except Exception as e:
            tb = traceback.format_exc()
            print(f"\n[ERROR] Slide {wsi_name} failed:\n{tb}", file=sys.stderr)
            batch_results[idx] = {
                "scan_id":   scan_id,
                "scan_path": scan_path,
                "status":    "failed",
                "error":     str(e),
                "timing_s":  None,
                "outcome":   None,
                "files":     {},
                "overlays":  None,
            }
            failed += 1
            state["slides"][scan_id_str]["status"]   = "failed"
            state["slides"][scan_id_str]["progress"] = 0
            state["slides"][scan_id_str]["message"]  = f"Error: {str(e)}"
            update_progress()

        finally:
            torch.cuda.empty_cache()

        write_result()   # intermediate write — survives premature job termination
        write_csv()

    write_result("complete")
    write_csv()
    update_progress(100, f"Batch complete. {successful}/{total_slides} successful.")
    print(f"\n=== Batch Complete ===")
    print(f"Success: {successful} | Failed: {failed}")


# ─────────────────────────────────────────────────────────────────────────────
# ENTRY POINT
# ─────────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    try:
        main()
    except Exception:
        tb = traceback.format_exc()
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
