"""
PathoDB — CRC Clinical suite: shared inference scaffolding
==========================================================
Common building blocks for the ICCR-reporting tools that sit on top of the
`crc_tissue_segmentation` Mask2Former backbone (extent-of-invasion, perineural
invasion, …). Keeps each tool's infer.py thin and the reuse/overlay logic in one
place.

NOTE: this module imports the heavy backbone packages at import time, so it is
only ever imported by the in-container infer.py scripts — never by the pure,
GPU-free staging/detection modules (those take a `label2id` argument instead).
It reads NO environment variables and runs nothing at import.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass

import cv2
import numpy as np
import tifffile
import torch

# Backbone packages (present inside the metassist Apptainer container).
from models.model_io import create_mask2former_from_checkpoint
from engine.inference import infer_wsi
from utils.wsi import prepare_read_from_slide, detect_tissue_mask
from utils.geometry import decode_geojson_to_mask

# ── Shared CRC tissue-segmentation backbone constants ──────────────────────────
CHECKPOINT_PATH = "/storage/research/igmp_slide_workspace/GRP Zlobec/Amjad/qupath/metassist-v1/MetAssist_expansion/crc-ugi/results/Virchow_deepest_crc_met_multiclass_55_plus_back/dinov2-h-virchow2_swin-large-cityscapes-semantic_res_1.0_tile_size_336_step_size_280/checkpoints/dinov2-h-virchow2_swin-large-cityscapes-semantic_res_1.0_tile_size_336_step_size_280_fold_5.pt"
ENCODER_MODEL  = "dinov2-h-virchow2"
DECODER_MODEL  = "swin-large-cityscapes-semantic"
FEATURE_LAYERS = [16, 20, 24, 31]
RESOLUTION     = 1.0            # µm/px the backbone runs at

LABEL2ID = {
    "Unanotated": 0, "Background": 1, "Fat": 2, "Normal Mucosa": 3,
    "Lymphoid tissue": 4, "Stroma": 5, "Mucous": 6, "Tumor": 7,
    "Necrosis/debris": 8, "Muscle/vessel": 9, "Nerve": 10, "Blood": 11,
}
IGNORE_CLASSES = {"Unanotated", "Background"}

# detect_tissue_mask runs at ~8 µm/px and drops pale fat; callers dilate it.
TISSUE_MASK_RES = 8.0


# ─────────────────────────────────────────────────────────────────────────────
# Progress + overlay helpers
# ─────────────────────────────────────────────────────────────────────────────

def write_progress(result_dir, pct, message):
    """Write progress.json atomically so the API never reads a partial file."""
    pct = max(0, min(100, int(pct)))
    tmp = os.path.join(result_dir, "progress.tmp")
    dst = os.path.join(result_dir, "progress.json")
    with open(tmp, "w") as f:
        json.dump({"pct": pct, "message": message}, f)
    os.replace(tmp, dst)
    print(f"[{pct:3d}%] {message}", flush=True)


def save_pyramidal_overlay_tiff(rgba, out_path, tile_size=256, compression="deflate"):
    """Write a fully pyramidal, tiled BigTIFF for use as an OpenSeadragon overlay."""
    if rgba.ndim != 3 or rgba.shape[2] != 4:
        raise ValueError(f"Expected (H, W, 4) RGBA array, got shape {rgba.shape}")
    if rgba.dtype != np.uint8:
        raise ValueError(f"Expected uint8 RGBA, got dtype {rgba.dtype}")
    levels, current = [rgba], rgba
    while max(current.shape[:2]) > tile_size:
        new_h = max(1, current.shape[0] // 2)
        new_w = max(1, current.shape[1] // 2)
        current = cv2.resize(current, (new_w, new_h), interpolation=cv2.INTER_NEAREST)
        levels.append(current)
    with tifffile.TiffWriter(out_path, bigtiff=True) as tif:
        for i, level_img in enumerate(levels):
            tif.write(level_img, subfiletype=1 if i > 0 else 0, photometric="rgb",
                      tile=(tile_size, tile_size), compression=compression)
    h, w = rgba.shape[:2]
    print(f"[pyramidal_tiff] Wrote {out_path}: base={w}x{h}, levels={len(levels)}", flush=True)


def build_rgba(label_mask, id2color, alpha=150):
    """Map an int label mask to an (H, W, 4) RGBA overlay via a LUT."""
    lut = np.zeros((256, 4), dtype=np.uint8)
    for cid, (r, g, b) in id2color.items():
        lut[cid] = [r, g, b, alpha]
    return lut[label_mask]


def close_class(mask, cls):
    """Close small gaps inside pixels of class `cls` (returns the modified mask)."""
    kernel = np.ones((5, 5), np.uint8)
    m = (mask == cls).astype(np.uint8)
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, kernel)
    mask[m == 1] = cls
    return mask


def tissue_composition_pct(pred_mask, ignore_ids=None):
    """Per-class area fraction (%) of a tissue label mask, sorted high→low.

    Matches the standalone crc_seg model's `outcome.composition_pct` so the
    segmentation card renders identically for real and derived crc_seg runs.
    """
    ignore = set(ignore_ids or [])
    id2label = {v: k for k, v in LABEL2ID.items()}
    ids, counts = np.unique(pred_mask, return_counts=True)
    valid = {int(i): int(c) for i, c in zip(ids, counts) if int(i) not in ignore}
    total = sum(valid.values())
    if total == 0:
        return {}
    comp = {id2label.get(i, f"Class {i}").replace("_", " ").title():
            round(c / total * 100, 2) for i, c in valid.items()}
    return dict(sorted(comp.items(), key=lambda kv: kv[1], reverse=True))


# ─────────────────────────────────────────────────────────────────────────────
# Segmentation acquisition (reuse-or-infer)
# ─────────────────────────────────────────────────────────────────────────────

@dataclass
class SegOutput:
    pred_mask: np.ndarray
    seg_source: str           # "fresh_inference" | "reused:<dir>"
    inf_time: float           # seconds (0.0 when reused)
    level: int
    ds_factor: float          # level_downsampling * tiling_downsample_factor
    mpp_seg: float            # µm/px of pred_mask


def load_or_reuse_segmentation(*, scan_path, progress,
                               reuse_geojson_path=None,
                               use_tissue_mask=True,
                               tissue_dilate_um=500.0, tile_size=336,
                               tile_overlap=66.667, batch_size=90):
    """
    Return a CRC tissue segmentation for `scan_path`, either by reusing a prior
    result or by running the backbone fresh.

    Reuse
    -----
    `reuse_geojson_path` is a tissue-segmentation GeoJSON resolved by the API
    from the DB (see routers/analysis.py; the same artifact the viewer downloads).
    The GeoJSON *is* the class predictions — self-describing (it carries
    ``mask_shape``, ``level_downsampling`` and ``category_dict``) — so the label
    mask is rebuilt losslessly-in-class via ``decode_geojson_to_mask``, with no
    dependency on any display overlay. If absent (or gone from disk) we run fresh.

    NB: reuse must only be offered for a *whole-slide* segmentation at the same
    resolution; the API enforces that (scope filter) before injecting the path.

    `progress` is a callable(pct, message) for the job progress bar.
    """
    # Slide geometry (needed for output scaling in both paths).
    progress(4, "Reading WSI bounds…")
    (level, level_downsampling, exact_resolution, tiling_downsample_factor,
     original_dim, read_origin) = prepare_read_from_slide(
        scan_path, resolution=RESOLUTION, file_type=os.path.splitext(scan_path)[1].lower())
    ds_factor = level_downsampling * tiling_downsample_factor
    mpp_seg   = exact_resolution * tiling_downsample_factor

    # ── Option A — reuse a prior segmentation from its GeoJSON ──────────────────
    if reuse_geojson_path and os.path.exists(reuse_geojson_path):
        progress(18, "Reusing cached tissue segmentation…")
        pred_mask = decode_geojson_to_mask(reuse_geojson_path).astype(np.uint8)
        print(f"Reusing segmentation from {reuse_geojson_path}", flush=True)
        return SegOutput(pred_mask, f"reused:{reuse_geojson_path}", 0.0,
                         level, ds_factor, mpp_seg)

    # ── Option B — fresh inference (default) ────────────────────────────────────
    if not os.path.exists(CHECKPOINT_PATH):
        raise FileNotFoundError(f"Checkpoint not found: {CHECKPOINT_PATH}")

    step_size = int(tile_size - (tile_size * tile_overlap // 100))
    crop_edge = 84 if tile_overlap > 25 else 50
    assert step_size <= tile_size, "Step size should be <= tile size"
    assert crop_edge / 2 <= (tile_size - step_size), "Crop edge <= half overlap"

    progress(2, "Loading tissue segmentation model into memory…")
    model = create_mask2former_from_checkpoint(
        checkpoint_path=CHECKPOINT_PATH, label2id=LABEL2ID,
        encoder_name=ENCODER_MODEL, decoder_model=DECODER_MODEL,
        out_indices=FEATURE_LAYERS)

    # Tissue mask: all tissue, or the automatic mask dilated so pale pericolic
    # fat (dropped by detect_tissue_mask) is included.
    progress(12, "Preparing tissue mask…")
    if use_tissue_mask:
        tissue_mask, _ = detect_tissue_mask(scan_path, resolution=TISSUE_MASK_RES)
        dil_px = max(1, int(round(tissue_dilate_um / TISSUE_MASK_RES)))
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * dil_px + 1, 2 * dil_px + 1))
        tissue_mask = cv2.dilate((tissue_mask > 0).astype(np.uint8), kernel, iterations=1)
        print(f"Tissue mask dilated by {tissue_dilate_um:.0f} µm "
              f"(~{dil_px}px @ {TISSUE_MASK_RES} µm/px) to include fat.", flush=True)
    else:
        tissue_mask = np.ones((5, 5), dtype=np.uint8)

    progress(25, "Running multi-class tissue segmentation…")
    pred_mask, _, _, _, _, _, inf_time, __ = infer_wsi(
        model, scan_path, tissue_mask, batch_size, tile_size, step_size,
        crop_edge, RESOLUTION, 1)
    torch.cuda.empty_cache()

    return SegOutput(pred_mask, "fresh_inference", inf_time, level, ds_factor, mpp_seg)
