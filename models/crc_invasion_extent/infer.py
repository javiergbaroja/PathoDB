"""
PathoDB — CRC Clinical suite
Extent of Invasion (pT)
=======================
Reuses the `crc_tissue_segmentation` backbone (via crc_clinical_common): segments
the bowel wall at 1 µm/px — or reuses a prior segmentation for the slide — then
derives an ICCR "Extent of invasion" reading (pT category + depth beyond the
muscularis propria) via the pure logic in staging.py.

Intended block role (routed by the user from block-level info): the deepest,
transmural tumour block.

Outputs written to PATHODB_RESULT_DIR:
  progress.json                  — polled every 5s by the API for the progress bar
  result.json                    — served to the browser when the job is done
  <wsi>_tissue.geojson           — full multi-class tissue overlay (context)
  <wsi>_tissue_overlay.ome.tif   — pyramidal RGBA tissue overlay
  <wsi>_invasion.geojson         — muscularis band + intramural / beyond-MP tumour
  <wsi>_invasion_overlay.ome.tif — pyramidal RGBA invasion-front overlay
  error.txt                      — stack trace on failure (for cluster debugging)
"""

import json
import os
import sys
import traceback

import cv2
import numpy as np
import torch

# ── PathoDB environment ────────────────────────────────────────────────────────
SCAN_PATH  = os.environ["PATHODB_SCAN_PATH"]
RESULT_DIR = os.environ["PATHODB_RESULT_DIR"]
SCOPE      = os.environ.get("PATHODB_SCOPE", "whole_slide")
PARAMS     = json.loads(os.environ.get("PATHODB_PARAMS", "{}"))
MODEL_ID   = "crc_invasion_extent"

os.makedirs(RESULT_DIR, exist_ok=True)

# ── Package paths (shared suite scaffolding + backbone) ────────────────────────
SCRIPT_DIR  = os.path.dirname(os.path.abspath(__file__))
PACKAGE_DIR = "/storage/research/igmp_slide_workspace/GRP Zlobec/Amjad/qupath/metassist-v1/MetAssist_expansion/crc-ugi/code/package_refactored"
sys.path.insert(0, SCRIPT_DIR)                   # for staging.py
sys.path.insert(0, os.path.dirname(SCRIPT_DIR))  # models/ — for crc_clinical_common
sys.path.insert(0, PACKAGE_DIR)

from utils.geometry import save_geojson_annotation
from utils.constants import COLORMAP

import crc_clinical_common as common
from crc_clinical_common import (LABEL2ID, IGNORE_CLASSES, write_progress as _wp,
                                 save_pyramidal_overlay_tiff, build_rgba,
                                 close_class, load_or_reuse_segmentation)
from staging import stage_invasion, PT_STATUS_LABELS

GPU_TYPE = torch.cuda.get_device_name(0) if torch.cuda.device_count() > 0 else "CPU"

# ── Derived "Invasion Front" overlay classes ───────────────────────────────────
INV_LABEL2ID = {"Muscularis propria": 1, "Intramural tumour": 2, "Tumour beyond MP": 3}
INV_COLORS   = {
    "Muscularis propria": (128, 0, 0),     # maroon
    "Intramural tumour":  (212, 185, 60),  # amber
    "Tumour beyond MP":   (230, 0, 46),    # crimson
}

# ── User-tunable parameters (exposed in catalog.json params[]) ─────────────────
BATCH_SIZE       = 256 if ("A100" in GPU_TYPE or "H100" in GPU_TYPE) else 90
TILE_SIZE        = int(PARAMS.get("tile_size", 336))
TILE_OVERLAP     = PARAMS.get("tile_overlap", 66.667)
USE_TISSUE_MASK  = PARAMS.get("use_tissue_mask", True)
TISSUE_DILATE_UM = float(PARAMS.get("tissue_mask_dilation_um", 500.0))
REUSE_SEG        = bool(PARAMS.get("reuse_segmentation", False))
MIN_TUMOR_UM     = float(PARAMS.get("min_tumor_um", 300.0))
ADJ_UM           = float(PARAMS.get("adjacency_um", 120.0))


def write_progress(pct, message):
    _wp(RESULT_DIR, pct, message)


def main():
    wsi_name = os.path.splitext(os.path.basename(SCAN_PATH))[0]
    if not os.path.isfile(SCAN_PATH):
        raise FileNotFoundError(f"WSI not found: {SCAN_PATH}")

    print("=== PathoDB CRC Extent of Invasion (pT) ===")
    print(f"WSI        : {SCAN_PATH}")
    print(f"Result dir : {RESULT_DIR}")
    print(f"System running on {torch.cuda.device_count()} GPU(s) [{GPU_TYPE}]", flush=True)

    # ── Segmentation (reuse or fresh) ───────────────────────────────────────────
    seg = load_or_reuse_segmentation(
        scan_path=SCAN_PATH, progress=write_progress,
        reuse_geojson_path=PARAMS.get("_reuse_seg_geojson"),
        use_tissue_mask=USE_TISSUE_MASK,
        tissue_dilate_um=TISSUE_DILATE_UM, tile_size=TILE_SIZE,
        tile_overlap=TILE_OVERLAP, batch_size=BATCH_SIZE)
    pred_mask = seg.pred_mask

    write_progress(72, "Post-processing tumour regions…")
    if LABEL2ID["Tumor"] in np.unique(pred_mask):
        pred_mask = close_class(pred_mask, LABEL2ID["Tumor"])
    torch.cuda.empty_cache()

    # ── Staging (pure logic) ────────────────────────────────────────────────────
    write_progress(78, "Estimating extent of invasion (pT)…")
    res = stage_invasion(
        pred_mask, LABEL2ID, seg.mpp_seg,
        min_tumor_um=MIN_TUMOR_UM, adj_um=ADJ_UM)
    print(f"pT estimate : {res.status} ({res.confidence}); "
          f"beyond MP {res.depth_beyond_mp_mm:.2f} mm", flush=True)

    # ── Tissue-context overlay ──────────────────────────────────────────────────
    write_progress(84, "Saving tissue overlays…")
    ignore_ids = [LABEL2ID[k] for k in IGNORE_CLASSES]
    composition_pct = common.tissue_composition_pct(pred_mask, ignore_ids)
    tissue_geojson = os.path.join(RESULT_DIR, f"{wsi_name}_tissue.geojson")
    save_geojson_annotation(
        out_path=tissue_geojson, mask=pred_mask, level=seg.level,
        level_downsampling=seg.ds_factor,
        category_dict={k: v for k, v in LABEL2ID.items() if v not in ignore_ids})
    tissue_colors = {v: COLORMAP.get(k, (0, 0, 0)) for k, v in LABEL2ID.items()
                     if v not in ignore_ids}
    tissue_tiff = os.path.join(RESULT_DIR, f"{wsi_name}_tissue_overlay.ome.tif")
    save_pyramidal_overlay_tiff(build_rgba(pred_mask, tissue_colors), tissue_tiff)

    # ── Invasion-front overlay (derived) ────────────────────────────────────────
    write_progress(90, "Building invasion-front overlay…")
    inv_mask = np.zeros_like(pred_mask, dtype=np.uint8)
    if res.muscle_band_mask is not None:
        inv_mask[res.muscle_band_mask > 0] = INV_LABEL2ID["Muscularis propria"]
    if res.intramural_tumor_mask is not None:
        inv_mask[res.intramural_tumor_mask > 0] = INV_LABEL2ID["Intramural tumour"]
    if res.beyond_mp_tumor_mask is not None:
        inv_mask[res.beyond_mp_tumor_mask > 0] = INV_LABEL2ID["Tumour beyond MP"]

    inv_geojson = os.path.join(RESULT_DIR, f"{wsi_name}_invasion.geojson")
    save_geojson_annotation(
        out_path=inv_geojson, mask=inv_mask, level=seg.level,
        level_downsampling=seg.ds_factor, category_dict=INV_LABEL2ID)

    inv_colors = {INV_LABEL2ID[name]: rgb for name, rgb in INV_COLORS.items()}
    rgba_inv = build_rgba(inv_mask, inv_colors, alpha=170)
    if res.deepest_point_xy is not None:
        x, y = res.deepest_point_xy
        cv2.drawMarker(rgba_inv, (int(x), int(y)), (255, 255, 255, 255),
                       markerType=cv2.MARKER_CROSS, markerSize=40, thickness=4)
    inv_tiff = os.path.join(RESULT_DIR, f"{wsi_name}_invasion_overlay.ome.tif")
    save_pyramidal_overlay_tiff(rgba_inv, inv_tiff)

    # ── result.json ─────────────────────────────────────────────────────────────
    write_progress(96, "Writing result summary…")
    result = {
        "model_id":  MODEL_ID,
        "scan_path": SCAN_PATH,
        "scope":     SCOPE,
        "params": {
            "resolution": common.RESOLUTION, "batch_size": BATCH_SIZE,
            "tile_size": TILE_SIZE, "min_tumor_um": MIN_TUMOR_UM,
            "adjacency_um": ADJ_UM, "reuse_segmentation": REUSE_SEG,
            "tissue_mask_dilation_um": TISSUE_DILATE_UM,
            "mpp_seg": round(seg.mpp_seg, 4),
        },
        "segmentation_source": seg.seg_source,
        "tissue_composition_pct": composition_pct,
        "timing": {"inference_s": round(seg.inf_time, 2), "total_s": round(seg.inf_time, 2)},
        "outcome": res.to_outcome(),
        "files": {
            "tissue_geojson":          tissue_geojson,
            "invasion_geojson":        inv_geojson,
            "raster_overlay_tissue":   tissue_tiff,
            "raster_overlay_invasion": inv_tiff,
            "download_file":           inv_geojson,
        },
        "overlays": [
            {
                "name": "Invasion Front", "file_key": "raster_overlay_invasion",
                "type": "tiled_image",
                "mask_width": int(inv_mask.shape[1]), "mask_height": int(inv_mask.shape[0]),
                "legend": {name: "#{:02x}{:02x}{:02x}".format(*rgb)
                           for name, rgb in INV_COLORS.items()},
            },
            {
                "name": "Tissue Classes", "file_key": "raster_overlay_tissue",
                "type": "tiled_image",
                "mask_width": int(pred_mask.shape[1]), "mask_height": int(pred_mask.shape[0]),
                "legend": {k: "#{:02x}{:02x}{:02x}".format(*COLORMAP.get(k, (0, 0, 0)))
                           for k in LABEL2ID if LABEL2ID[k] not in ignore_ids},
            },
        ],
    }
    with open(os.path.join(RESULT_DIR, "result.json"), "w") as f:
        json.dump(result, f, indent=2)

    write_progress(100, "Done")
    print("\n=== Complete ===")
    print(f"pT (AI estimate) : {PT_STATUS_LABELS.get(res.status, res.status)}")
    print(f"Confidence       : {res.confidence}")
    print(f"Beyond MP        : {res.depth_beyond_mp_mm:.2f} mm")
    print(f"Segmentation     : {seg.seg_source}")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        tb = traceback.format_exc()
        try:
            write_progress(0, "Failed — see error.txt in result directory")
        except Exception:
            pass
        with open(os.path.join(RESULT_DIR, "error.txt"), "w") as f:
            f.write(tb)
        print(tb, file=sys.stderr)
        sys.exit(1)
