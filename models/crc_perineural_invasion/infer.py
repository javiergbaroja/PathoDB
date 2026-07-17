"""
PathoDB — CRC Clinical suite
Perineural Invasion (PNI)
=========================
Reuses the `crc_tissue_segmentation` backbone (via crc_clinical_common): segments
the tissue at 1 µm/px — or reuses a prior segmentation for the slide — then reads
the ICCR "Perineural invasion" element from the Nerve / Tumor classes via the
pure logic in pni.py.

Intended block role (routed by the user from block-level info): tumour blocks.

Outputs written to PATHODB_RESULT_DIR:
  progress.json                 — polled every 5s by the API for the progress bar
  result.json                   — served to the browser when the job is done
  <wsi>_tissue.geojson          — full multi-class tissue overlay (context)
  <wsi>_tissue_overlay.ome.tif  — pyramidal RGBA tissue overlay
  <wsi>_pni.geojson             — nerves + PNI-positive nerves
  <wsi>_pni_overlay.ome.tif     — pyramidal RGBA perineural-invasion overlay
  error.txt                     — stack trace on failure (for cluster debugging)
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
MODEL_ID   = "crc_perineural_invasion"

os.makedirs(RESULT_DIR, exist_ok=True)

# ── Package paths (shared suite scaffolding + backbone) ────────────────────────
SCRIPT_DIR  = os.path.dirname(os.path.abspath(__file__))
PACKAGE_DIR = "/storage/research/igmp_slide_workspace/GRP Zlobec/Amjad/qupath/metassist-v1/MetAssist_expansion/crc-ugi/code/package_refactored"
sys.path.insert(0, SCRIPT_DIR)                 # for pni.py
sys.path.insert(0, os.path.dirname(SCRIPT_DIR))  # models/ — for crc_clinical_common
sys.path.insert(0, PACKAGE_DIR)

from utils.geometry import save_geojson_annotation
from utils.constants import COLORMAP

import crc_clinical_common as common
from crc_clinical_common import (LABEL2ID, IGNORE_CLASSES, write_progress as _wp,
                                 save_pyramidal_overlay_tiff, build_rgba,
                                 close_class, load_or_reuse_segmentation)
from pni import detect_pni, PNI_STATUS_LABELS

GPU_TYPE = torch.cuda.get_device_name(0) if torch.cuda.device_count() > 0 else "CPU"

# ── Derived "Perineural Invasion" overlay classes ──────────────────────────────
PNI_LABEL2ID = {"Tumour": 1, "Nerve": 2, "PNI-positive nerve": 3}
PNI_COLORS   = {
    "Tumour":              (117, 173, 81),   # light green (context)
    "Nerve":               (128, 128, 0),    # olive
    "PNI-positive nerve":  (230, 0, 46),     # crimson
}

# ── User-tunable parameters (exposed in catalog.json params[]) ─────────────────
BATCH_SIZE       = 256 if ("A100" in GPU_TYPE or "H100" in GPU_TYPE) else 90
TILE_SIZE        = int(PARAMS.get("tile_size", 336))
TILE_OVERLAP     = PARAMS.get("tile_overlap", 66.667)
USE_TISSUE_MASK  = PARAMS.get("use_tissue_mask", True)
TISSUE_DILATE_UM = float(PARAMS.get("tissue_mask_dilation_um", 500.0))
REUSE_SEG        = bool(PARAMS.get("reuse_segmentation", False))
MIN_NERVE_UM     = float(PARAMS.get("min_nerve_um", 50.0))
CONTACT_UM       = float(PARAMS.get("contact_um", 20.0))
ENCIRCLE_THRESH  = float(PARAMS.get("encircle_threshold", 0.33))
MIN_TUMOR_UM     = float(PARAMS.get("min_tumor_um", 200.0))


def write_progress(pct, message):
    _wp(RESULT_DIR, pct, message)


def main():
    wsi_name = os.path.splitext(os.path.basename(SCAN_PATH))[0]
    if not os.path.isfile(SCAN_PATH):
        raise FileNotFoundError(f"WSI not found: {SCAN_PATH}")

    print("=== PathoDB CRC Perineural Invasion ===")
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

    write_progress(72, "Post-processing tumour and nerve regions…")
    present = np.unique(pred_mask)
    if LABEL2ID["Tumor"] in present:
        pred_mask = close_class(pred_mask, LABEL2ID["Tumor"])
    if LABEL2ID["Nerve"] in present:
        pred_mask = close_class(pred_mask, LABEL2ID["Nerve"])
    torch.cuda.empty_cache()

    # ── Detection (pure logic) ──────────────────────────────────────────────────
    write_progress(78, "Detecting perineural invasion…")
    res = detect_pni(
        pred_mask, LABEL2ID, seg.mpp_seg,
        min_nerve_um=MIN_NERVE_UM, min_tumor_um=MIN_TUMOR_UM,
        contact_um=CONTACT_UM, encircle_threshold=ENCIRCLE_THRESH)
    print(f"PNI : {res.status} ({res.confidence}); "
          f"{res.pni_positive_nerves}/{res.nerves_examined} nerves, "
          f"max encirclement {res.max_encirclement_pct:.0f}%", flush=True)

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

    # ── Perineural-invasion overlay (derived) ───────────────────────────────────
    write_progress(90, "Building perineural-invasion overlay…")
    pni_mask = np.zeros_like(pred_mask, dtype=np.uint8)
    pni_mask[pred_mask == LABEL2ID["Tumor"]] = PNI_LABEL2ID["Tumour"]
    if res.nerve_mask is not None:
        pni_mask[res.nerve_mask > 0] = PNI_LABEL2ID["Nerve"]
    if res.positive_nerve_mask is not None:
        pni_mask[res.positive_nerve_mask > 0] = PNI_LABEL2ID["PNI-positive nerve"]

    pni_geojson = os.path.join(RESULT_DIR, f"{wsi_name}_pni.geojson")
    save_geojson_annotation(
        out_path=pni_geojson, mask=pni_mask, level=seg.level,
        level_downsampling=seg.ds_factor, category_dict=PNI_LABEL2ID)

    pni_alpha = {PNI_LABEL2ID["Tumour"]: 70, PNI_LABEL2ID["Nerve"]: 160,
                 PNI_LABEL2ID["PNI-positive nerve"]: 200}
    lut = np.zeros((256, 4), dtype=np.uint8)
    for name, cid in PNI_LABEL2ID.items():
        r, g, b = PNI_COLORS[name]
        lut[cid] = [r, g, b, pni_alpha[cid]]
    rgba_pni = lut[pni_mask]
    # Mark each PNI-positive nerve with a white crosshair.
    for (x, y, frac, is_pos) in res.nerve_points:
        if is_pos:
            cv2.drawMarker(rgba_pni, (int(x), int(y)), (255, 255, 255, 255),
                           markerType=cv2.MARKER_CROSS, markerSize=40, thickness=4)
    pni_tiff = os.path.join(RESULT_DIR, f"{wsi_name}_pni_overlay.ome.tif")
    save_pyramidal_overlay_tiff(rgba_pni, pni_tiff)

    # ── result.json ─────────────────────────────────────────────────────────────
    write_progress(96, "Writing result summary…")
    result = {
        "model_id":  MODEL_ID,
        "scan_path": SCAN_PATH,
        "scope":     SCOPE,
        "params": {
            "resolution": common.RESOLUTION, "batch_size": BATCH_SIZE,
            "tile_size": TILE_SIZE, "min_nerve_um": MIN_NERVE_UM,
            "min_tumor_um": MIN_TUMOR_UM, "contact_um": CONTACT_UM,
            "encircle_threshold": ENCIRCLE_THRESH,
            "reuse_segmentation": REUSE_SEG,
            "tissue_mask_dilation_um": TISSUE_DILATE_UM,
            "mpp_seg": round(seg.mpp_seg, 4),
        },
        "segmentation_source": seg.seg_source,
        "tissue_composition_pct": composition_pct,
        "timing": {"inference_s": round(seg.inf_time, 2), "total_s": round(seg.inf_time, 2)},
        "outcome": res.to_outcome(),
        "files": {
            "tissue_geojson":          tissue_geojson,
            "pni_geojson":             pni_geojson,
            "raster_overlay_tissue":   tissue_tiff,
            "raster_overlay_pni":      pni_tiff,
            "download_file":           pni_geojson,
        },
        "overlays": [
            {
                "name": "Perineural Invasion", "file_key": "raster_overlay_pni",
                "type": "tiled_image",
                "mask_width": int(pni_mask.shape[1]), "mask_height": int(pni_mask.shape[0]),
                "legend": {name: "#{:02x}{:02x}{:02x}".format(*rgb)
                           for name, rgb in PNI_COLORS.items()},
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
    print(f"Perineural invasion : {PNI_STATUS_LABELS.get(res.status, res.status)}")
    print(f"Nerves involved     : {res.pni_positive_nerves}/{res.nerves_examined}")
    print(f"Max encirclement    : {res.max_encirclement_pct:.0f}%")
    print(f"Segmentation source : {seg.seg_source}")


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
