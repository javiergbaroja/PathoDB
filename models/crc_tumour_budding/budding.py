"""
PathoDB — CRC Clinical suite
Tumour Budding (ITBCC) — detection post-processing
==================================================

Pure, GPU-free logic that turns a CRC tissue-segmentation label mask (from the
`crc_tissue_segmentation` backbone) into an ICCR "Tumour budding" reading, per
the International Tumour Budding Consensus Conference (ITBCC 2016) method.

Definitions used
----------------
  * A **tumour bud** is a detached `Tumor` object of 1-4 cells at the invasive
    front. Cell count is estimated from the object's pixel area using the
    per-cell area (7.5 µm diameter); objects below a single-cell noise floor
    (2.5 µm radius) are discarded.
  * Grading is by the maximum bud count within a **0.785 mm² hotspot** (a
    1 mm-diameter 20x field): Bd1 = 0-4, Bd2 = 5-9, Bd3 = >= 10 buds.

Buds are counted only within a band along the main tumour's invasive (deep,
non-mucosal) front, following the front topology of Baumann et al. (npj Prec
Onc 2025): CRC advances into muscle/adipose, away from the luminal mucosa.

Honest limits
-------------
This runs on an HE tissue segmentation, not pan-cytokeratin IHC (the ITBCC
adjunct); cell counts are area-estimates, so dense clusters can merge. Depends
only on numpy + opencv + scipy so it is unit-testable off the cluster.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import List, Optional

import cv2
import numpy as np
from scipy.spatial import cKDTree

BUDDING_STATUS_LABELS = {
    "no_tumor": "No tumour on section",
    "Bd1":      "Bd1 — low",
    "Bd2":      "Bd2 — intermediate",
    "Bd3":      "Bd3 — high",
}

BUDDING_CAVEATS = [
    "Buds detected from the HE tissue segmentation — ITBCC recommends HE "
    "assessment with pan-cytokeratin as an adjunct in equivocal cases.",
    "Cells per bud are estimated from object area (7.5 µm cell); dense clusters "
    "may merge in the segmentation.",
    "Single-section hotspot count, normalised to a 0.785 mm² (20x) field.",
]


@dataclass
class BuddingResult:
    status: str                       # "Bd1" | "Bd2" | "Bd3" | "no_tumor"
    label: int                        # 1 if high-grade (Bd3), else 0
    confidence: str                   # "high" | "moderate" | "low"
    grade: str                        # "Bd1" | "Bd2" | "Bd3" | "-"
    bud_count_hotspot: int
    total_buds: int
    hotspot_center_xy: Optional[tuple] = None
    field_radius_px: float = 0.0
    bud_points: List[tuple] = field(default_factory=list)   # (x, y) of each bud
    main_tumor_mask: Optional[np.ndarray] = None
    bud_mask: Optional[np.ndarray] = None

    def to_outcome(self) -> dict:
        pretty = BUDDING_STATUS_LABELS.get(self.status, self.status)
        severity = ("positive" if self.label == 1
                    else "warning" if (self.status == "Bd2" or self.confidence == "low")
                    else "neutral")
        rows = [{"label": "Tumour budding", "value": pretty,
                 "highlight": severity != "neutral"}]
        if self.status != "no_tumor":
            rows.append({"label": "Buds / 0.785 mm²", "value": self.bud_count_hotspot, "mono": True})
            rows.append({"label": "Buds at front", "value": self.total_buds, "mono": True})
        rows.append({"label": "Confidence", "value": self.confidence.title()})
        card = {
            "severity": severity,
            "rows": rows,
            "note": BUDDING_CAVEATS[0] if BUDDING_CAVEATS else None,
        }
        return {
            "status":            self.status,
            "label":             int(self.label),
            "confidence":        self.confidence,
            "grade":             self.grade,
            "bud_count_hotspot": int(self.bud_count_hotspot),
            "total_buds":        int(self.total_buds),
            "primary_metric": {
                "label": "Tumour budding",
                "value": (f"{self.grade} ({self.bud_count_hotspot} buds / 0.785 mm²)"
                          if self.grade != "-" else pretty),
            },
            "secondary_metric": {
                "label": "Buds in hotspot",
                "value": str(self.bud_count_hotspot),
            },
            "caveats": BUDDING_CAVEATS,
            "card": card,
        }


def _grade(count: int) -> str:
    if count >= 10:
        return "Bd3"
    if count >= 5:
        return "Bd2"
    return "Bd1"


def count_budding(
    seg: np.ndarray,
    label2id: dict,
    mpp: float,
    *,
    main_tumor_cells: float = 50.0,
    front_band_um: float = 500.0,
    field_area_mm2: float = 0.785,
) -> BuddingResult:
    """
    Estimate CRC tumour budding (ITBCC) from a tissue-segmentation label mask.

    Parameters
    ----------
    seg : (H, W) int array
        Per-pixel tissue class ids from the CRC tissue seg backbone.
    label2id : dict
        Class-name -> id map (must contain "Tumor"; "Normal Mucosa" optional).
    mpp : float
        Microns per pixel of `seg`.
    main_tumor_cells : float
        A tumour object of at least this many cells (by area) is treated as the
        main tumour mass (used to locate the invasive front), not a bud.
    front_band_um : float
        Width (µm) of the invasive-front band around the main tumour in which
        buds are counted.
    field_area_mm2 : float
        Hotspot field area (default 0.785 mm² = a 1 mm-diameter 20x field).
    """
    if seg.ndim != 2:
        raise ValueError(f"Expected a 2-D label mask, got shape {seg.shape}")

    tumor_id  = label2id["Tumor"]
    mucosa_id = label2id.get("Normal Mucosa", -1)

    # ── The two required area constraints (in px² at this resolution) ───────────
    resolution = mpp
    min_object_area = ((2.5 / resolution) ** 2 * np.pi)          # single-cell noise floor
    cell_area       = np.pi * (((7.5 / 2) / resolution) ** 2)    # area of one 7.5 µm cell
    max_bud_area    = 4.0 * cell_area                            # a bud is <= 4 cells
    main_min_area   = main_tumor_cells * cell_area

    field_radius_px = float(np.sqrt(field_area_mm2 / np.pi) * 1000.0 / mpp)  # 500 µm default
    front_band_px   = max(1, int(round(front_band_um / mpp)))

    tumor = (seg == tumor_id).astype(np.uint8)
    if tumor.sum() == 0:
        return BuddingResult(
            status="no_tumor", label=0, confidence="low", grade="-",
            bud_count_hotspot=0, total_buds=0, field_radius_px=field_radius_px,
            main_tumor_mask=np.zeros_like(tumor), bud_mask=np.zeros_like(tumor))

    # ── Classify tumour objects: bud vs main mass (noise dropped) ───────────────
    n, lbl, stats, cent = cv2.connectedComponentsWithStats(tumor, connectivity=8)
    main_mask = np.zeros_like(tumor)
    bud_mask  = np.zeros_like(tumor)
    bud_candidates = []          # (x, y) for objects of 1-4 cells
    for i in range(1, n):
        area = stats[i, cv2.CC_STAT_AREA]
        if area < min_object_area:
            continue                                    # noise
        if area >= main_min_area:
            main_mask[lbl == i] = 1                      # main tumour mass
        elif area <= max_bud_area:
            cx, cy = cent[i]
            bud_candidates.append((int(cx), int(cy), i))  # candidate bud
        # objects of 5..(main_min) cells are poorly-differentiated clusters,
        # neither buds nor main mass — excluded from the bud count.

    # ── Invasive-front band (deep, non-mucosal side of the main tumour) ─────────
    if main_mask.any():
        k = cv2.getStructuringElement(
            cv2.MORPH_ELLIPSE, (2 * front_band_px + 1, 2 * front_band_px + 1))
        front_zone = (cv2.dilate(main_mask, k, iterations=1) & (main_mask == 0)).astype(np.uint8)
        if mucosa_id >= 0:
            mucosa = (seg == mucosa_id).astype(np.uint8)
            if mucosa.any():
                mk = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * front_band_px + 1,) * 2)
                front_zone[cv2.dilate(mucosa, mk, iterations=1) > 0] = 0
    else:
        front_zone = None   # no main mass -> cannot localise a front

    # ── Keep buds that lie in the invasive-front band ───────────────────────────
    buds = []
    for (x, y, i) in bud_candidates:
        if front_zone is None or front_zone[min(y, front_zone.shape[0] - 1),
                                            min(x, front_zone.shape[1] - 1)] > 0:
            buds.append((x, y))
            bud_mask[lbl == i] = 1

    total_buds = len(buds)

    # ── Hotspot: densest 0.785 mm² field (centred on each bud) ──────────────────
    # KD-tree so this stays O(n log n) even with thousands of buds on a slide.
    hotspot_count, hotspot_xy = 0, None
    if total_buds:
        pts = np.asarray(buds, dtype=np.float64)
        counts = cKDTree(pts).query_ball_point(pts, r=field_radius_px,
                                               return_length=True)
        idx = int(np.argmax(counts))
        hotspot_count = int(counts[idx])
        hotspot_xy = (int(buds[idx][0]), int(buds[idx][1]))

    grade = _grade(hotspot_count)
    label = 1 if grade == "Bd3" else 0

    if not main_mask.any():
        confidence = "low"                       # no main mass to anchor the front
    elif front_zone is not None and front_zone.any():
        confidence = "high"
    else:
        confidence = "moderate"

    return BuddingResult(
        status=grade, label=label, confidence=confidence, grade=grade,
        bud_count_hotspot=hotspot_count, total_buds=total_buds,
        hotspot_center_xy=hotspot_xy, field_radius_px=field_radius_px,
        bud_points=buds, main_tumor_mask=main_mask, bud_mask=bud_mask)
