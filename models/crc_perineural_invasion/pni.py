"""
PathoDB — CRC Clinical suite
Perineural Invasion (PNI) — detection post-processing
=====================================================

Pure, GPU-free logic that turns a CRC tissue-segmentation label mask (from the
`crc_tissue_segmentation` backbone) into an ICCR "Perineural invasion" reading:
present vs not identified, with the number of nerves involved and the maximum
circumferential tumour encirclement.

Signal used
-----------
The backbone segments `Nerve` and `Tumor` as distinct classes. For each nerve a
focus is called PNI-positive when either:
  * tumour surrounds >= `encircle_threshold` of the nerve's circumference
    (the classic "tumour around >=33% of the nerve perimeter" criterion), or
  * tumour sits inside the nerve outline (intraneural invasion).

Honest limits
-------------
This is a screening detector on an HE tissue map, not a morphological diagnosis:
small/unmyelinated nerves may be under-segmented (so a negative is not
definitive), and equivocal foci warrant S100/SOX10 IHC. Depends only on
numpy + opencv + scipy so it is unit-testable off the cluster (see test_pni.py).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import List, Optional

import cv2
import numpy as np
from scipy import ndimage

PNI_STATUS_LABELS = {
    "present":        "Present",
    "not_identified": "Not identified",
}

PNI_CAVEATS = [
    "Screening detection on the HE tissue map — confirm each focus "
    "morphologically.",
    "Small or unmyelinated nerves may be under-segmented, so a negative call "
    "is not definitive.",
    "S100/SOX10 IHC can confirm equivocal perineural foci.",
]


@dataclass
class PNIResult:
    status: str                       # "present" | "not_identified"
    label: int                        # 1 if present, else 0
    confidence: str                   # "high" | "moderate" | "low"
    nerves_examined: int
    pni_positive_nerves: int
    max_encirclement_pct: float       # 0-100
    # Per-nerve markers for the overlay: list of (x, y, frac, positive)
    nerve_points: List[tuple] = field(default_factory=list)
    nerve_mask: Optional[np.ndarray] = None            # all examined nerves
    positive_nerve_mask: Optional[np.ndarray] = None   # PNI-positive nerves

    def to_outcome(self) -> dict:
        status_label = PNI_STATUS_LABELS.get(self.status, self.status)
        severity = ("positive" if self.label == 1
                    else "warning" if self.confidence == "low" else "neutral")
        rows = [
            {"label": "Perineural invasion", "value": status_label,
             "highlight": severity != "neutral"},
            {"label": "Nerves involved",
             "value": f"{self.pni_positive_nerves} / {self.nerves_examined}", "mono": True},
        ]
        if self.label == 1 and self.max_encirclement_pct > 0:
            rows.append({"label": "Max encirclement",
                         "value": f"{round(self.max_encirclement_pct)}%", "mono": True})
        rows.append({"label": "Confidence", "value": self.confidence.title()})
        card = {
            "severity": severity,
            "rows": rows,
            "note": PNI_CAVEATS[1] if len(PNI_CAVEATS) > 1 else None,
        }
        return {
            "status":               self.status,
            "label":                int(self.label),
            "confidence":           self.confidence,
            "nerves_examined":      int(self.nerves_examined),
            "pni_positive_nerves":  int(self.pni_positive_nerves),
            "max_encirclement_pct": round(float(self.max_encirclement_pct), 1),
            "primary_metric": {
                "label": "Perineural invasion",
                "value": status_label,
            },
            "secondary_metric": {
                "label": "Nerves involved",
                "value": f"{self.pni_positive_nerves} / {self.nerves_examined}",
            },
            "caveats": PNI_CAVEATS,
            "card": card,
        }


def _clean_binary(mask: np.ndarray, min_area_px: int, close_px: int = 0) -> np.ndarray:
    """Remove specks below `min_area_px` and optionally close small gaps."""
    m = (mask > 0).astype(np.uint8)
    if close_px > 0:
        k = np.ones((close_px, close_px), np.uint8)
        m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, k)
    if min_area_px > 0:
        n, lbl, stats, _ = cv2.connectedComponentsWithStats(m, connectivity=8)
        keep = np.zeros_like(m)
        for i in range(1, n):
            if stats[i, cv2.CC_STAT_AREA] >= min_area_px:
                keep[lbl == i] = 1
        m = keep
    return m


def _disc_area_px(diameter_um: float, mpp: float) -> int:
    return int(round((diameter_um / mpp) ** 2 * np.pi / 4))


def detect_pni(
    seg: np.ndarray,
    label2id: dict,
    mpp: float,
    *,
    min_nerve_um: float = 50.0,
    min_tumor_um: float = 200.0,
    contact_um: float = 20.0,
    encircle_threshold: float = 0.33,
) -> PNIResult:
    """
    Detect perineural invasion from a tissue-segmentation label mask.

    Parameters
    ----------
    seg : (H, W) int array
        Per-pixel tissue class ids from the CRC tissue seg backbone.
    label2id : dict
        Class-name -> id map (must contain "Nerve" and "Tumor").
    mpp : float
        Microns per pixel of `seg`.
    min_nerve_um, min_tumor_um : float
        Minimum object diameters (µm) to treat a nerve / tumour region as real.
    contact_um : float
        Perineural apposition radius (µm): tumour within this of the nerve
        boundary counts as touching that stretch of circumference.
    encircle_threshold : float
        Fraction of nerve circumference contacted to call PNI (default 0.33).
    """
    if seg.ndim != 2:
        raise ValueError(f"Expected a 2-D label mask, got shape {seg.shape}")

    nerve_id = label2id["Nerve"]
    tumor_id = label2id["Tumor"]

    min_nerve_px = _disc_area_px(min_nerve_um, mpp)
    min_tumor_px = _disc_area_px(min_tumor_um, mpp)
    contact_px   = max(1, int(round(contact_um / mpp)))

    nerve = _clean_binary(seg == nerve_id, min_nerve_px, close_px=3)
    tumor = _clean_binary(seg == tumor_id, min_tumor_px, close_px=5)

    # No nerve to assess → cannot identify PNI (distinct from a confident negative).
    if nerve.sum() == 0:
        return PNIResult(
            status="not_identified", label=0, confidence="low",
            nerves_examined=0, pni_positive_nerves=0, max_encirclement_pct=0.0,
            nerve_mask=nerve, positive_nerve_mask=np.zeros_like(nerve))

    k3 = np.ones((3, 3), np.uint8)
    tumor_dil = cv2.dilate(tumor, cv2.getStructuringElement(
        cv2.MORPH_ELLIPSE, (2 * contact_px + 1, 2 * contact_px + 1)), iterations=1)

    n, lbl = cv2.connectedComponents(nerve, connectivity=8)
    positive_mask = np.zeros_like(nerve)
    points: List[tuple] = []
    max_frac = 0.0
    n_positive = 0

    for i in range(1, n):
        comp = (lbl == i).astype(np.uint8)
        filled = ndimage.binary_fill_holes(comp).astype(np.uint8)

        # Intraneural tumour: tumour inside the nerve outline (its holes).
        interior_holes = ((filled > 0) & (comp == 0))
        intraneural_area = int(((tumor > 0) & interior_holes).sum())

        # Circumferential contact: fraction of nerve perimeter touched by tumour.
        boundary = cv2.morphologyEx(filled, cv2.MORPH_GRADIENT, k3)
        b_total = int((boundary > 0).sum())
        contact = int(((boundary > 0) & (tumor_dil > 0)).sum())
        frac = (contact / b_total) if b_total > 0 else 0.0

        is_pos = (frac >= encircle_threshold) or (intraneural_area >= min_tumor_px * 0.25)

        ys, xs = np.where(comp > 0)
        cx, cy = int(xs.mean()), int(ys.mean())
        points.append((cx, cy, round(frac, 3), bool(is_pos)))

        max_frac = max(max_frac, frac)
        if is_pos:
            n_positive += 1
            positive_mask[comp > 0] = 1

    nerves_examined = n - 1
    label = 1 if n_positive > 0 else 0
    status = "present" if label else "not_identified"

    if label == 1:
        confidence = "high" if max_frac >= 0.5 else "moderate"
    else:
        confidence = "moderate" if nerves_examined >= 3 else "low"

    return PNIResult(
        status=status, label=label, confidence=confidence,
        nerves_examined=nerves_examined, pni_positive_nerves=n_positive,
        max_encirclement_pct=max_frac * 100.0,
        nerve_points=points, nerve_mask=nerve, positive_nerve_mask=positive_mask)
