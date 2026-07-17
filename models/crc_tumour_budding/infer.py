"""
PathoDB — CRC Clinical suite
Tumour Budding (ITBCC)
======================
Reuses the `crc_tissue_segmentation` backbone (via crc_clinical_common): segments
the tissue at 1 µm/px — or reuses a prior segmentation for the slide — then reads
the ICCR "Tumour budding" element from the Tumor class via the pure logic in
budding.py (buds = detached 1-4 cell tumour objects at the invasive front;
grade from the 0.785 mm² hotspot).

Intended block role (routed by the user from block-level info): the deepest,
transmural tumour block.

Outputs written to PATHODB_RESULT_DIR:
  progress.json                  — polled every 5s by the API for the progress bar
  result.json                    — served to the browser when the job is done
  <wsi>_tissue.geojson           — full multi-class tissue overlay (context)
  <wsi>_tissue_overlay.ome.tif   — pyramidal RGBA tissue overlay
  <wsi>_budding.geojson          — main tumour + buds
  <wsi>_budding_overlay.ome.tif  — pyramidal RGBA budding overlay (+ hotspot ring)
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
MODEL_ID   = "crc_tumour_budding"

os.makedirs(RESULT_DIR, exist_ok=True)

# ── Package paths (shared suite scaffolding + backbone) ────────────────────────
SCRIPT_DIR  = os.path.dirname(os.path.abspath(__file__))
PACKAGE_DIR = "/storage/research/igmp_slide_workspace/GRP Zlobec/Amjad/qupath/metassist-v1/MetAssist_expansion/crc-ugi/code/package_refactored"
sys.path.insert(0, SCRIPT_DIR)                   # for budding.py
sys.path.insert(0, os.path.dirname(SCRIPT_DIR))  # models/ — for crc_clinical_common
sys.path.insert(0, PACKAGE_DIR)

from utils.geometry import save_geojson_annotation
from utils.constants import COLORMAP

import crc_clinical_common as common
from crc_clinical_common import (LABEL2ID, IGNORE_CLASSES, write_progress as _wp,
                                 save_pyramidal_overlay_tiff, build_rgba,
                                 close_class, load_or_reuse_segmentation)
from budding import count_budding, BUDDING_STATUS_LABELS

GPU_TYPE = torch.cuda.get_device_name(0) if torch.cuda.device_count() > 0 else "CPU"

# ── Derived "Tumour Budding" overlay classes ───────────────────────────────────
BUD_LABEL2ID = {"Main tumour": 1, "Bud": 2}
BUD_COLORS   = {"Main tumour": (117, 173, 81), "Bud": (230, 0, 46)}

# ── User-tunable parameters (exposed in catalog.json params[]) ─────────────────
BATCH_SIZE       = 256 if ("A100" in GPU_TYPE or "H100" in GPU_TYPE) else 90
TILE_SIZE        = int(PARAMS.get("tile_size", 336))
TILE_OVERLAP     = PARAMS.get("tile_overlap", 66.667)
USE_TISSUE_MASK  = PARAMS.get("use_tissue_mask", True)
TISSUE_DILATE_UM = float(PARAMS.get("tissue_mask_dilation_um", 500.0))
REUSE_SEG        = bool(PARAMS.get("reuse_segmentation", False))
MAIN_TUMOR_CELLS = float(PARAMS.get("main_tumor_cells", 50.0))
FRONT_BAND_UM    = float(PARAMS.get("front_band_um", 500.0))


def write_progress(pct, message):
    _wp(RESULT_DIR, pct, message)


def main():
    wsi_name = os.path.splitext(os.path.basename(SCAN_PATH))[0]
    if not os.path.isfile(SCAN_PATH):
        raise FileNotFoundError(f"WSI not found: {SCAN_PATH}")

    print("=== PathoDB CRC Tumour Budding (ITBCC) ===")
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

    # ── Detection (pure logic) ──────────────────────────────────────────────────
    write_progress(78, "Counting tumour buds (ITBCC hotspot)…")
    res = count_budding(
        pred_mask, LABEL2ID, seg.mpp_seg,
        main_tumor_cells=MAIN_TUMOR_CELLS, front_band_um=FRONT_BAND_UM)
    print(f"Budding : {res.grade} — {res.bud_count_hotspot} buds / 0.785 mm² "
          f"({res.total_buds} total at front, {res.confidence})", flush=True)

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

    # ── Tumour-budding overlay (derived) ────────────────────────────────────────
    write_progress(90, "Building tumour-budding overlay…")
    bud_mask = np.zeros_like(pred_mask, dtype=np.uint8)
    if res.main_tumor_mask is not None:
        bud_mask[res.main_tumor_mask > 0] = BUD_LABEL2ID["Main tumour"]
    if res.bud_mask is not None:
        bud_mask[res.bud_mask > 0] = BUD_LABEL2ID["Bud"]

    bud_geojson = os.path.join(RESULT_DIR, f"{wsi_name}_budding.geojson")
    save_geojson_annotation(
        out_path=bud_geojson, mask=bud_mask, level=seg.level,
        level_downsampling=seg.ds_factor, category_dict=BUD_LABEL2ID)

    lut = np.zeros((256, 4), dtype=np.uint8)
    lut[BUD_LABEL2ID["Main tumour"]] = [*BUD_COLORS["Main tumour"], 60]
    lut[BUD_LABEL2ID["Bud"]]         = [*BUD_COLORS["Bud"], 220]
    rgba_bud = lut[bud_mask]
    # Buds are only a few px — ring each one so it is findable at low zoom.
    for (x, y) in res.bud_points:
        cv2.circle(rgba_bud, (int(x), int(y)), 12, (230, 0, 46, 255), 2)
    # Draw the 0.785 mm² hotspot field.
    if res.hotspot_center_xy is not None and res.field_radius_px > 0:
        cv2.circle(rgba_bud, res.hotspot_center_xy, int(res.field_radius_px),
                   (255, 255, 255, 255), 4)
    bud_tiff = os.path.join(RESULT_DIR, f"{wsi_name}_budding_overlay.ome.tif")
    save_pyramidal_overlay_tiff(rgba_bud, bud_tiff)

    # ── result.json ─────────────────────────────────────────────────────────────
    write_progress(96, "Writing result summary…")
    result = {
        "model_id":  MODEL_ID,
        "scan_path": SCAN_PATH,
        "scope":     SCOPE,
        "params": {
            "resolution": common.RESOLUTION, "batch_size": BATCH_SIZE,
            "tile_size": TILE_SIZE, "main_tumor_cells": MAIN_TUMOR_CELLS,
            "front_band_um": FRONT_BAND_UM, "reuse_segmentation": REUSE_SEG,
            "tissue_mask_dilation_um": TISSUE_DILATE_UM,
            "mpp_seg": round(seg.mpp_seg, 4),
        },
        "segmentation_source": seg.seg_source,
        "tissue_composition_pct": composition_pct,
        "timing": {"inference_s": round(seg.inf_time, 2), "total_s": round(seg.inf_time, 2)},
        "outcome": res.to_outcome(),
        "files": {
            "tissue_geojson":          tissue_geojson,
            "budding_geojson":         bud_geojson,
            "raster_overlay_tissue":   tissue_tiff,
            "raster_overlay_budding":  bud_tiff,
            "download_file":           bud_geojson,
        },
        "overlays": [
            {
                "name": "Tumour Budding", "file_key": "raster_overlay_budding",
                "type": "tiled_image",
                "mask_width": int(bud_mask.shape[1]), "mask_height": int(bud_mask.shape[0]),
                "legend": {name: "#{:02x}{:02x}{:02x}".format(*rgb)
                           for name, rgb in BUD_COLORS.items()},
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
    print(f"Tumour budding   : {BUDDING_STATUS_LABELS.get(res.status, res.status)}")
    print(f"Hotspot count    : {res.bud_count_hotspot} buds / 0.785 mm²")
    print(f"Total buds (front): {res.total_buds}")
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
