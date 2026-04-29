"""
PathoDB — CRC Tissue Segmentation Detector
==========================================
Single-stage Mask2Former pipeline:
  Infers the entire slide (or tissue mask) to detect Tumor, 
  Mucin, Stroma, Fat, Normal Mucosa, etc., in one pass.

All inputs arrive as environment variables exported by the PathoDB API
(via sbatch --export). Outputs written to PATHODB_RESULT_DIR:
  progress.json  — polled every 5s by the API for the progress bar
  result.json    — served to the browser when the job is done
  <wsi>.geojson  — primary multi-class overlay
  error.txt      — stack trace on failure (for cluster debugging)
"""

import json
import os
import sys
import traceback

import cv2
import numpy as np
import torch
import tifffile

# ── PathoDB environment ────────────────────────────────────────────────────────
SCAN_PATH  = os.environ["PATHODB_SCAN_PATH"]
RESULT_DIR = os.environ["PATHODB_RESULT_DIR"]
SCOPE      = os.environ.get("PATHODB_SCOPE", "whole_slide")
PARAMS     = json.loads(os.environ.get("PATHODB_PARAMS", "{}"))
ROI        = os.environ.get("PATHODB_ROI",    "null")
if isinstance(ROI, str):
    ROI = ROI.strip().strip('"')
MODEL_ID   = "crc_tissue_seg"

os.makedirs(RESULT_DIR, exist_ok=True)

# ── Third-party package paths ──────────────────────────────────────────────────
SCRIPT_DIR  = os.path.dirname(os.path.abspath(__file__))
# Adjust this package directory to where your utils are located
PACKAGE_DIR = "/storage/research/igmp_slide_workspace/GRP Zlobec/Amjad/qupath/metassist-v1/MetAssist_expansion/crc-ugi/code/package_refactored"
sys.path.insert(0, os.path.dirname(SCRIPT_DIR))
sys.path.insert(0, PACKAGE_DIR)

from models.model_io import create_mask2former_from_checkpoint
from engine.inference import infer_wsi
from utils.wsi import prepare_read_from_slide, detect_tissue_mask
from utils.geometry import save_geojson_annotation, create_mask_from_contours
from utils.visualization import COLORMAP

# ── System constants ─────────────────────────────────────────────────────────────
NR_GPUS = torch.cuda.device_count()
GPU_TYPE = torch.cuda.get_device_name(0) if NR_GPUS > 0 else "CPU"


# ── Model constants (not user-tunable) ────────────────────────────────────────

CHECKPOINT_PATH = "/storage/research/igmp_slide_workspace/GRP Zlobec/Amjad/qupath/metassist-v1/MetAssist_expansion/crc-ugi/results/Virchow_deepest_crc_met_multiclass_55_plus_back/dinov2-h-virchow2_swin-large-cityscapes-semantic_res_1.0_tile_size_336_step_size_280/checkpoints/dinov2-h-virchow2_swin-large-cityscapes-semantic_res_1.0_tile_size_336_step_size_280_fold_5.pt"
ENCODER_MODEL   = "dinov2-h-virchow2"
DECODER_MODEL   = "swin-large-cityscapes-semantic"
FEATURE_LAYERS  = [16, 20, 24, 31]

# Reconstructed from your label2id string
LABEL2ID = {
    "Unanotated": 0,
    "Background": 1,
    "Fat": 2,
    "Normal Mucosa": 3,
    "Lymphoid tissue": 4,
    "Stroma": 5,
    "Mucous": 6,
    "Tumor": 7,
    "Necrosis/debris": 8,
    "Muscle/vessel": 9,
    "Nerve": 10,
    "Blood": 11
}

# ── User-tunable parameters (exposed in catalog.json params[]) ─────────────────
RESOLUTION      = 1.0
BATCH_SIZE      = 256 if "A100" in GPU_TYPE else 256 if "H100" in GPU_TYPE else 90
TILE_SIZE       = int(PARAMS.get("tile_size", 336))
USE_TISSUE_MASK = PARAMS.get("use_tissue_mask", True) 
STEP_SIZE       = int(TILE_SIZE - (TILE_SIZE * PARAMS.get("tile_overlap", 66.667)  // 100))
CROP_PRED_EDGE  = 84 if PARAMS.get("tile_overlap", 66.667) > 25 else 50

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


def close_tumor(pred_mask: np.ndarray, tumor_class: int) -> np.ndarray:
    """Close small gaps inside tumor regions."""
    kernel = np.ones((5, 5), np.uint8)
    tum_mask = (pred_mask == tumor_class).astype(np.uint8)
    tum_mask = cv2.morphologyEx(tum_mask, cv2.MORPH_CLOSE, kernel)
    pred_mask[tum_mask == 1] = tumor_class
    return pred_mask

# ─────────────────────────────────────────────────────────────────────────────
# MAIN
# ─────────────────────────────────────────────────────────────────────────────

def main() -> None:
    wsi_name = os.path.splitext(os.path.basename(SCAN_PATH))[0]
    downsample_factor = 1

    # ── Pre-flight checks ──────────────────────────────────────────────────────
    if not os.path.isfile(SCAN_PATH):
        raise FileNotFoundError(f"WSI not found: {SCAN_PATH}")
    if not os.path.exists(CHECKPOINT_PATH):
        raise FileNotFoundError(f"Checkpoint not found: {CHECKPOINT_PATH}")
    
    assert STEP_SIZE <= TILE_SIZE, 'Step size should be less than or equal to tile size'
    assert CROP_PRED_EDGE / 2 <= (TILE_SIZE - STEP_SIZE), 'Crop pred edge should be <= half of tile overlap'

    print(f"=== PathoDB CRC Tissue Seg Detector ===")
    print(f"WSI        : {SCAN_PATH}")
    print(f"Result dir : {RESULT_DIR}")
    print(f"System running on {NR_GPUS} GPU(s) [{GPU_TYPE}]")
    print(f"Resolution : {RESOLUTION} µm/px", flush=True)

    # ── Load model ─────────────────────────────────────────────────────────────
    write_progress(0, "Loading Mask2Former model into memory...")
    
    model = create_mask2former_from_checkpoint(
        checkpoint_path=CHECKPOINT_PATH, 
        label2id=LABEL2ID, 
        encoder_name=ENCODER_MODEL, 
        decoder_model=DECODER_MODEL, 
        out_indices=FEATURE_LAYERS
    )

    # ── WSI preparation ────────────────────────────────────────────────────────
    write_progress(10, "Detecting tissue mask and reading WSI bounds...")

    (level, level_downsampling, exact_resolution, tiling_downsample_factor, original_dim, read_origin) = prepare_read_from_slide(
        SCAN_PATH, 
        resolution=RESOLUTION, 
        file_type=os.path.splitext(SCAN_PATH)[1].lower()
    )

    # Generate the global tissue mask (since ln_seg_path isn't provided dynamically yet)
    if USE_TISSUE_MASK and ROI is None:
        tissue_mask, _ = detect_tissue_mask(SCAN_PATH)
    elif ROI is not None:
        with open(ROI, "r") as f:
            roi_data = json.load(f)
        tissue_mask = create_mask_from_contours(
            geojson=roi_data,
            mask_shape=original_dim,
            level_downsampling=level_downsampling,
            category_dict={"user_roi": 1}
        )
    else:
        tissue_mask = np.ones((5, 5), dtype=np.uint8)

    # ── Inference ──────────────────────────────────────────────────────────────
    write_progress(25, "Running multi-class tissue segmentation inference...")

    pred_mask, _, _, _, _, _, inf_time, __ = infer_wsi(
        model, SCAN_PATH, tissue_mask,
        BATCH_SIZE, TILE_SIZE, STEP_SIZE, CROP_PRED_EDGE,
        RESOLUTION, downsample_factor
    )

    write_progress(75, "Applying post-processing...")
    if LABEL2ID["Tumor"] in np.unique(pred_mask):
        pred_mask = close_tumor(pred_mask, LABEL2ID["Tumor"])
    
    torch.cuda.empty_cache()

    # ── Outputs ───────────────────────────────────────────────────────────────
    write_progress(80, "Saving GeoJSON overlays...")

    geojson_mask = os.path.join(RESULT_DIR, f"{wsi_name}.geojson")
    
    ds_factor = level_downsampling * tiling_downsample_factor

    # Save primary predictions
    save_geojson_annotation(
        out_path           = geojson_mask,
        mask               = pred_mask,
        level              = level,
        level_downsampling = ds_factor,
        category_dict      = {k: v for k, v in LABEL2ID.items() if k not in ("Unanotated", "Background")}
    )

    write_progress(85, "Rasterizing mask to Pyramidal OME-TIFF...")

    tiff_path = os.path.join(RESULT_DIR, f"{wsi_name}_overlay.ome.tif")

    ignore_ids = [
        LABEL2ID.get("Unanotated", 0),
        LABEL2ID.get("Background", 1)
    ]

    # 1. Build an RGBA Look-Up Table (LUT)
    # Note: tifffile expects standard RGBA (Red, Green, Blue, Alpha)
    lut_rgba = np.zeros((256, 4), dtype=np.uint8)
    for class_name, class_id in LABEL2ID.items():
        if class_id in ignore_ids:
            lut_rgba[class_id] = [0, 0, 0, 0]  # Transparent
        else:
            r, g, b = COLORMAP.get(class_name, (0, 0, 0))
            lut_rgba[class_id] = [r, g, b, 150] # 150 Alpha for translucency

    # 2. Apply LUT to the mask
    rgba_mask = lut_rgba[pred_mask]

    # 3. Generate Pyramid Levels (halving resolution until < 512px)
    levels = [rgba_mask]
    current = rgba_mask
    while min(current.shape[:2]) > 512:
        current = cv2.resize(
            current, 
            (current.shape[1] // 2, current.shape[0] // 2), 
            interpolation=cv2.INTER_NEAREST # Use NEAREST to preserve solid class colors
        )
        levels.append(current)

    # 4. Save as Highly Compressed Pyramidal TIFF
    with tifffile.TiffWriter(tiff_path, bigtiff=True) as tif:
        for i, level_img in enumerate(levels):
            tif.write(
                level_img,
                subfiletype=1 if i > 0 else 0,
                photometric='rgb', 
                tile=(256, 256), 
                compression='deflate' # Lossless ZLIB compression
            )

    # ── Slide-level tissue composition ─────────────────────────────────────────
    write_progress(92, "Computing tissue composition percentages...")

    # Get raw pixel counts for every class in the prediction mask
    unique_classes, pixel_counts = np.unique(pred_mask, return_counts=True)
    raw_counts = dict(zip(unique_classes, pixel_counts))

    # Invert LABEL2ID for easy name lookup: {1: 'Background', 2: 'Fat', ...}
    ID2LABEL = {v: k for k, v in LABEL2ID.items()}

    tissue_composition = {}
    valid_pixels = {
        cid: count for cid, count in raw_counts.items() if cid not in ignore_ids
    }
    
    total_tissue_pixels = sum(valid_pixels.values())

    # Calculate percentages
    if total_tissue_pixels > 0:
        for cid, count in valid_pixels.items():
            class_name = ID2LABEL.get(cid, f"Class_{cid}")
            # Replace underscores with spaces for cleaner UI reading
            clean_name = class_name.replace("_", " ").title()
            
            percentage = (count / total_tissue_pixels) * 100
            tissue_composition[clean_name] = round(percentage, 2)

    # Sort dictionary by highest percentage first
    tissue_composition = dict(sorted(tissue_composition.items(), key=lambda item: item[1], reverse=True))

    # ── result.json — read by GET /analysis/jobs/{id}/result ─────────────────
    write_progress(96, "Writing result summary...")

    result = {
        "model_id":  MODEL_ID,
        "scan_path": SCAN_PATH,
        "scope":     SCOPE,
        "params": {
            "resolution":     RESOLUTION,
            "batch_size":     BATCH_SIZE,
            "tile_size":      TILE_SIZE,
            "step_size":      STEP_SIZE,
            "crop_pred_edge": CROP_PRED_EDGE,
        },
        "timing": {
            "inference_s": round(inf_time, 2),
            "total_s":     round(inf_time, 2),
        },
        "outcome": {
            "status": "segmentation_complete",
            "label": 0, 
            "total_tissue_pixels": int(total_tissue_pixels),
            "composition_pct": tissue_composition  
        },
        "files": {
            "raster_overlay": tiff_path,
        },
        "overlays": [
            {
                "name": "Tissue Classes",
                "file_key": "raster_overlay",
                "type": "tiled_image",
                "mask_width": int(rgba_mask.shape[1]),
                "mask_height": int(rgba_mask.shape[0]),
                "legend": {
                    class_name: "#{:02x}{:02x}{:02x}".format(*COLORMAP.get(class_name, "#000000")) for class_name in LABEL2ID.keys() if class_name not in ignore_ids
                }
            }
        ]
    }

    result_path = os.path.join(RESULT_DIR, "result.json")
    with open(result_path, "w") as f:
        json.dump(result, f, indent=2)

    write_progress(100, "Done")

    print(f"\n=== Complete ===")
    print(f"Inference Time : {inf_time:.2f}s")
    print(f"Composition    :")
    for name, pct in tissue_composition.items():
        print(f"  - {name}: {pct}%")


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
            write_progress(0, "Failed — see error.txt in result directory")
        except Exception:
            pass
        error_path = os.path.join(RESULT_DIR, "error.txt")
        with open(error_path, "w") as f:
            f.write(tb)
        print(tb, file=sys.stderr)
        sys.exit(1)    # non-zero exit marks the SLURM job as FAILED