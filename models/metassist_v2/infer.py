"""
PathoDB — LVI / LN Metastasis Detector
========================================
Two-stage Mask2Former pipeline:
  Stage 1 — Lymph node segmentation
  Stage 2 — Metastasis / deposit detection within LN boundaries

All inputs arrive as environment variables exported by the PathoDB API
(via sbatch --export). Outputs written to PATHODB_RESULT_DIR:
  progress.json             — polled every 5s by the API for the progress bar
  result.json               — served to the browser when the job is done
  <wsi>_ln.geojson          — LN boundary overlay (QuPath-compatible)
  <wsi>_metastasis.geojson  — metastasis/deposit overlay
  <wsi>_ln_overlay.ome.tif  — pyramidal RGBA overlay: all Stage 1 tissue classes
  <wsi>_met_overlay.ome.tif — pyramidal RGBA overlay: metastasis deposits only
  error.txt                 — stack trace on failure (for cluster debugging)
"""

import json
import os
import sys
import traceback

import cv2
import numpy as np
import openslide
import torch
import tifffile
from scipy.ndimage import binary_fill_holes

# ── PathoDB environment ────────────────────────────────────────────────────────
SCAN_PATH  = os.environ["PATHODB_SCAN_PATH"]
RESULT_DIR = os.environ["PATHODB_RESULT_DIR"]
SCOPE      = os.environ.get("PATHODB_SCOPE", "whole_slide")
PARAMS     = json.loads(os.environ.get("PATHODB_PARAMS", "{}"))
ROI        = json.loads(os.environ.get("PATHODB_ROI",    "null"))
MODEL_ID   = "metassist_v2"

os.makedirs(RESULT_DIR, exist_ok=True)

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

# ── Model constants (not user-tunable) ────────────────────────────────────────

LN_CHECKPOINT  = "/storage/research/igmp_slide_workspace/GRP Zlobec/Amjad/qupath/metassist-v1/MetAssist_expansion/crc-ugi/results/Virchow_deep_LN_Tumor_Normal_Vessel_Fat_Mucin_v2/checkpoints/dinov2-h-virchow2_swin-large-cityscapes-semantic_res_8.0_tile_size_672_step_size_504_fold_1.pt"
MET_CHECKPOINT = "/storage/research/igmp_slide_workspace/GRP Zlobec/Amjad/qupath/metassist-v1/MetAssist_expansion/crc-ugi/results/Virchow_deepest_crcugi_met/dinov2-h-virchow2_swin-large-cityscapes-semantic_res_1.0_tile_size_336_step_size_280/checkpoints/dinov2-h-virchow2_swin-large-cityscapes-semantic_res_1.0_tile_size_336_step_size_280_fold_4.pt"
ENCODER_MODEL  = "dinov2-h-virchow2"  
DECODER_MODEL  = "swin-large-cityscapes-semantic"   
LN_FEATURE_LAYERS = [12,16,20,24]
MET_FEATURE_LAYERS = [16,20,24,31]

LN_LABEL2ID  = {"Background": 0, "Fat tissue":4, "Vessels":5, "Lymph node":1, "Tumor deposits":2, "Primary tumor":2, "Primary tissue":3, "Mucin":6}
MET_LABEL2ID = {"Background": 0, "Metastasis": 2, "Training region": 1}

# ── Overlay colour maps ────────────────────────────────────────────────────────
# (R, G, B) tuples; alpha is set per-class below
LN_COLORMAP = {
    "Lymph node":     ( 65, 105, 225),   # cornflower blue
    "Tumor deposits": (255, 140,   0),   # dark orange
    "Primary tissue": (144, 238, 144),   # light green
    "Fat tissue":     (255, 255, 153),   # light yellow
    "Vessels":        (139,   0,   0),   # dark red
    "Mucin":          (186,  85, 211),   # medium orchid
    "Primary tumor":  (255, 140,   0),   # same as Tumor deposits
}
LN_ALPHA = {
    "Lymph node":     100,
    "Tumor deposits": 160,
    "Primary tissue":  90,
    "Fat tissue":      80,
    "Vessels":        130,
    "Mucin":          100,
    "Primary tumor":  160,
}
MET_COLORMAP = {"Metastasis": (220, 20, 60)}   # crimson
MET_ALPHA     = {"Metastasis": 200}

# ── User-tunable parameters (exposed in catalog.json params[]) ─────────────────
LN_RESOLUTION            = 8.0
MET_RESOLUTION           = 1.0
LN_BATCH_SIZE            = 30
MET_BATCH_SIZE           = 100
LN_TILE_SIZE             = 672
LN_STEP_SIZE             = 112
MET_TILE_SIZE            = int(PARAMS.get("met_tile_size",             336))
met_overlap              = PARAMS.get("met_tile_overlap",             66.667) # in percent; converted to pixels below
MET_STEP_SIZE            = int(MET_TILE_SIZE - (MET_TILE_SIZE * met_overlap // 100))
LN_CROP_PRED_EDGE        = 50
MET_CROP_PRED_EDGE       = 84 if met_overlap > 25 else 50
COMPLEXITY_THRESHOLD  = 2.9
APPLY_POST_PROCESSING = True


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
    os.replace(tmp, dst)       # atomic on POSIX filesystems (NFS included)
    print(f"[{pct:3d}%] {message}", flush=True)


def save_pyramidal_overlay_tiff(
    rgba: np.ndarray,
    out_path: str,
    tile_size: int = 256,
    compression: str = "deflate",
) -> None:
    """Write a fully pyramidal, tiled BigTIFF for use as an OpenSeadragon overlay."""
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
        f"[pyramidal_tiff] Wrote {out_path}: base={w}x{h}, "
        f"levels={len(levels)}, deepest={levels[-1].shape[1]}x{levels[-1].shape[0]}",
        flush=True,
    )


def close_metastasis(pred_mask: np.ndarray, metastasis_class: int) -> np.ndarray:
    """Close small gaps inside metastasis regions."""
    kernel = np.ones((5, 5), np.uint8)
    met_mask = (pred_mask == metastasis_class).astype(np.uint8)
    met_mask = cv2.morphologyEx(met_mask, cv2.MORPH_CLOSE, kernel)
    pred_mask[met_mask == 1] = metastasis_class
    return pred_mask


def merge_mucin_and_ln(
    ln_seg: np.ndarray,
    ln_class: int,
    mucin_class: int,
) -> tuple[np.ndarray, np.ndarray]:
    """
    Merge mucin regions into LN if they are spatially adjacent, then
    fill holes in the resulting LN mask.

    Returns (updated_seg, filled_ln_binary_mask).

    Bug fix vs original: uses an explicit `mucin_class < 0` sentinel check
    instead of relying on `-1 not in array` which is fragile with NumPy
    integer arrays (would silently pass if the array ever contained -1).
    """
    ln_mask = (ln_seg == ln_class).astype(np.uint8)

    if mucin_class < 0 or mucin_class not in np.unique(ln_seg):
        return ln_seg, binary_fill_holes(ln_mask).astype(np.uint8)

    ln_dilated   = cv2.dilate(ln_mask, np.ones((5, 5), np.uint8), iterations=1)
    mucin_mask   = (ln_seg == mucin_class).astype(np.uint8)
    num, labeled = cv2.connectedComponents(mucin_mask, connectivity=8)

    for label in range(1, num):
        component = mucin_labeled = (labeled == label)
        if np.any(component & ln_dilated):
            ln_mask |= component
        else:
            ln_seg[component] = 0

    return ln_seg, binary_fill_holes(ln_mask).astype(np.uint8)


# ─────────────────────────────────────────────────────────────────────────────
# MAIN
# ─────────────────────────────────────────────────────────────────────────────

def main() -> None:
    wsi_name = os.path.splitext(os.path.basename(SCAN_PATH))[0]
    downsample_factor = 1

    # ── Pre-flight checks ──────────────────────────────────────────────────────
    if not os.path.isfile(SCAN_PATH):
        raise FileNotFoundError(f"WSI not found: {SCAN_PATH}")
    if not os.path.exists(LN_CHECKPOINT):
        raise FileNotFoundError(f"LN checkpoint not found: {LN_CHECKPOINT}")
    if not os.path.exists(MET_CHECKPOINT):
        raise FileNotFoundError(f"Metastasis checkpoint not found: {MET_CHECKPOINT}")

    print(f"=== PathoDB LVI / LN Metastasis Detector ===")
    print(f"WSI        : {SCAN_PATH}")
    print(f"Result dir : {RESULT_DIR}")
    print(f"Scope      : {SCOPE}")
    print(f"LN Resolution : {LN_RESOLUTION} µm/px")
    print(f"Metastasis Resolution : {MET_RESOLUTION} µm/px", flush=True)

    # ── Load models ────────────────────────────────────────────────────────────
    write_progress(0, "Loading models into memory…")

    ln_model = create_mask2former_from_checkpoint(LN_CHECKPOINT, LN_LABEL2ID, ENCODER_MODEL, DECODER_MODEL, LN_FEATURE_LAYERS)
    met_model = create_mask2former_from_checkpoint(MET_CHECKPOINT, MET_LABEL2ID, ENCODER_MODEL, DECODER_MODEL, MET_FEATURE_LAYERS)

    # ── WSI preparation ────────────────────────────────────────────────────────
    write_progress(8, "Preparing slide for reading…")

    (level, level_downsampling, exact_resolution, tiling_downsample_factor, original_dim, read_origin) = prepare_read_from_slide(SCAN_PATH, resolution=LN_RESOLUTION, file_type=os.path.splitext(SCAN_PATH)[1].lower())

    tissue_mask = np.ones((5, 5), dtype=np.uint8)

    # ── Stage 1 — Lymph node segmentation ─────────────────────────────────────
    write_progress(10, "Running lymph node segmentation…")

    ln_pred_mask, _, _, _, _, _, ln_time, __ = infer_wsi(
        ln_model, SCAN_PATH, tissue_mask,
        LN_BATCH_SIZE, LN_TILE_SIZE, LN_STEP_SIZE, LN_CROP_PRED_EDGE,
        LN_RESOLUTION, downsample_factor,
    )

    write_progress(40, "Applying LN post-processing…")

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

        # Filter detections in tissue-free / noise regions
        write_progress(47, "Filtering LN noise regions…")
        ln_class_mask        = (ln_pred_mask == LN_LABEL2ID["Lymph node"]).astype(np.uint8)
        num_labels, label_map = cv2.connectedComponents(ln_class_mask)
        slide_handle          = openslide.open_slide(SCAN_PATH)

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

    # Build LN boundary mask; release raw Stage 1 output
    ln_seg_all, met_boundary_mask = merge_mucin_and_ln(
        ln_pred_mask.copy(),
        LN_LABEL2ID["Lymph node"],
        LN_LABEL2ID.get("Mucin", -1),
    )
    del ln_pred_mask
    ds_ln = level_downsampling * tiling_downsample_factor
    torch.cuda.empty_cache()

    # ── Stage 2 — Metastasis segmentation ─────────────────────────────────────
    write_progress(55, "Running metastasis segmentation…")
    (level, level_downsampling, exact_resolution, tiling_downsample_factor, original_dim, read_origin) = prepare_read_from_slide(SCAN_PATH, resolution=MET_RESOLUTION, file_type=os.path.splitext(SCAN_PATH)[1].lower())

    met_pred_mask, _, _, _, _, _, met_time, __ = infer_wsi(
        met_model, SCAN_PATH, met_boundary_mask,
        MET_BATCH_SIZE, MET_TILE_SIZE, MET_STEP_SIZE, MET_CROP_PRED_EDGE,
        MET_RESOLUTION, downsample_factor,
    )

    if "Metastasis" in MET_LABEL2ID:
        met_pred_mask = close_metastasis(met_pred_mask, MET_LABEL2ID["Metastasis"])

    # ── Outputs ───────────────────────────────────────────────────────────────
    write_progress(82, "Saving GeoJSON overlays…")

    geojson_met = os.path.join(RESULT_DIR, f"{wsi_name}_metastasis.geojson")
    geojson_ln  = os.path.join(RESULT_DIR, f"{wsi_name}_ln.geojson")

    ds_met = level_downsampling * tiling_downsample_factor

    save_geojson_annotation(
        out_path     = geojson_met,
        mask         = met_pred_mask,
        level        = level,
        level_downsampling = ds_met,
        category_dict = {
            k: v for k, v in MET_LABEL2ID.items()
            if k not in ("Background", "Training region")
        },
    )
    save_geojson_annotation(
        out_path     = geojson_ln,
        mask         = met_boundary_mask,
        level        = level,
        level_downsampling = ds_ln,
        category_dict = {"Lymph node": 1},
    )

    # ── Raster overlays ────────────────────────────────────────────────────────
    write_progress(85, "Rasterizing overlays to pyramidal OME-TIFF…")

    tiff_ln_path  = os.path.join(RESULT_DIR, f"{wsi_name}_ln_overlay.ome.tif")
    tiff_met_path = os.path.join(RESULT_DIR, f"{wsi_name}_met_overlay.ome.tif")

    # LN overlay — all Stage 1 tissue classes (8 µm/px)
    lut_ln = np.zeros((256, 4), dtype=np.uint8)
    for class_name, class_id in LN_LABEL2ID.items():
        if class_name == "Background":
            continue
        r, g, b = LN_COLORMAP.get(class_name, (128, 128, 128))
        a        = LN_ALPHA.get(class_name, 100)
        lut_ln[class_id] = [r, g, b, a]
    rgba_ln = lut_ln[ln_seg_all]
    save_pyramidal_overlay_tiff(rgba_ln, tiff_ln_path)

    # Metastasis overlay — only Metastasis class highlighted (1 µm/px)
    lut_met = np.zeros((256, 4), dtype=np.uint8)
    for class_name, class_id in MET_LABEL2ID.items():
        r, g, b = MET_COLORMAP.get(class_name, (0, 0, 0))
        a        = MET_ALPHA.get(class_name, 0)
        lut_met[class_id] = [r, g, b, a]
    rgba_met = lut_met[met_pred_mask]
    save_pyramidal_overlay_tiff(rgba_met, tiff_met_path)

    # ── LN-level statistics ────────────────────────────────────────────────────
    write_progress(90, "Computing LN and metastasis counts…")

    ln_binary = (met_boundary_mask > 0).astype(np.uint8)
    n_ln_labels, ln_label_map = cv2.connectedComponents(ln_binary, connectivity=8)
    ln_count = max(0, n_ln_labels - 1)

    h_ln, w_ln = ln_seg_all.shape[:2]
    met_binary = (met_pred_mask == MET_LABEL2ID.get("Metastasis", 2)).astype(np.uint8)
    # Downscale met mask to LN resolution for per-node overlap check
    met_for_ln = cv2.resize(met_binary, (w_ln, h_ln), interpolation=cv2.INTER_NEAREST)

    positive_ln_count = 0
    for i in range(1, n_ln_labels):
        if np.any((ln_label_map == i) & (met_for_ln > 0)):
            positive_ln_count += 1

    # ── Slide-level clinical result ────────────────────────────────────────────
    write_progress(92, "Computing slide-level result…")

    status, label, measurement = get_slide_level_result(
        mask             = met_pred_mask,
        ln_seg_mask      = ln_seg_all,
        metastasis_class = MET_LABEL2ID.get("Metastasis", 1),
        ln_class         = LN_LABEL2ID["Lymph node"],
        deposit_class    = LN_LABEL2ID.get("Tumor deposits", 2),
        fat_class        = LN_LABEL2ID.get("Fat tissue", 4),
        mucin_class      = LN_LABEL2ID.get("Mucin",       6),
        resolution       = exact_resolution * tiling_downsample_factor,
    )

    # ── result.json — read by GET /analysis/jobs/{id}/result ─────────────────
    write_progress(96, "Writing result summary…")

    result = {
        "model_id":    MODEL_ID,
        "scan_path":   SCAN_PATH,
        "scope":       SCOPE,
        "params": {
            "ln_resolution":            LN_RESOLUTION,
            "ln_batch_size":            LN_BATCH_SIZE,
            "ln_tile_size":             LN_TILE_SIZE,
            "ln_step_size":             LN_STEP_SIZE,
            "met_resolution":           MET_RESOLUTION,
            "met_batch_size":           MET_BATCH_SIZE,
            "met_tile_size":            MET_TILE_SIZE,
            "met_step_size":            MET_STEP_SIZE,
            "complexity_threshold":  COMPLEXITY_THRESHOLD,
            "apply_post_processing": APPLY_POST_PROCESSING,
        },
        "timing": {
            "ln_inference_s":  round(ln_time,  2),
            "met_inference_s": round(met_time, 2),
            "total_s":         round(ln_time + met_time, 2),
        },
        "outcome": {
            "status":              status,
            "label":               label,
            "measurement_um":      round(float(measurement), 2),
            "ln_count":            ln_count,
            "positive_ln_count":   positive_ln_count,
            "primary_metric": {
                "label": "Max Extent",
                "value": f"{round(float(measurement) / 1000, 2)} mm" if measurement > 0 else "N/A",
            },
        },
        "files": {
            "metastasis_geojson":  geojson_met,
            "ln_geojson":          geojson_ln,
            "raster_overlay_ln":   tiff_ln_path,
            "raster_overlay_met":  tiff_met_path,
        },
        "overlays": [
            {
                "name":        "Lymph Nodes",
                "file_key":    "raster_overlay_ln",
                "type":        "tiled_image",
                "mask_width":  int(ln_seg_all.shape[1]),
                "mask_height": int(ln_seg_all.shape[0]),
                "legend": {
                    k: "#{:02x}{:02x}{:02x}".format(*LN_COLORMAP[k])
                    for k in LN_LABEL2ID
                    if k != "Background" and k in LN_COLORMAP
                },
            },
            {
                "name":        "Metastasis",
                "file_key":    "raster_overlay_met",
                "type":        "tiled_image",
                "mask_width":  int(met_pred_mask.shape[1]),
                "mask_height": int(met_pred_mask.shape[0]),
                "legend": {
                    k: "#{:02x}{:02x}{:02x}".format(*MET_COLORMAP[k])
                    for k in MET_LABEL2ID
                    if k in MET_COLORMAP
                },
            },
        ],
    }

    result_path = os.path.join(RESULT_DIR, "result.json")
    with open(result_path, "w") as f:
        json.dump(result, f, indent=2)

    write_progress(100, "Done")

    print(f"\n=== Complete ===")
    print(f"LN inference      : {ln_time:.2f}s")
    print(f"Met inference     : {met_time:.2f}s")
    print(f"Total             : {ln_time + met_time:.2f}s")
    print(f"LN detected       : {ln_count} ({positive_ln_count} positive)")
    print(f"Outcome           : {measurement:.2f} µm — {status} (label={label})")


# ─────────────────────────────────────────────────────────────────────────────
# ENTRY POINT
# ─────────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Write a progress update so the API knows something went wrong,
        # then dump the full traceback to error.txt for cluster debugging.
        tb = traceback.format_exc()
        try:
            write_progress(0, f"Failed — see error.txt in result directory")
        except Exception:
            pass
        error_path = os.path.join(RESULT_DIR, "error.txt")
        with open(error_path, "w") as f:
            f.write(tb)
        print(tb, file=sys.stderr)
        sys.exit(1)    # non-zero exit marks the SLURM job as FAILED