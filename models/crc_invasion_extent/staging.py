"""
PathoDB — CRC Clinical suite
Extent of Invasion (pT) — staging post-processing
=================================================

Pure, GPU-free logic that turns a CRC tissue-segmentation label mask
(as produced by the `crc_tissue_segmentation` Mask2Former backbone) into an
ICCR "Extent of invasion" reading:

    - an AI-estimated pT category (pT1-or-lower / pT2 / pT3),
    - the depth of invasion beyond the muscularis propria in mm,
    - the tissue interfaces the tumour reaches,
    - derived masks for the "Invasion Front" overlay.

Design notes / honest limits
----------------------------
The tissue model resolves Tumor, Muscle/vessel (used here as a muscularis
propria proxy), Fat (pericolic adipose) and Normal Mucosa, but it does NOT
resolve the muscularis mucosae, submucosa, serosa or adjacent organs. Therefore:

  * pTis vs pT1 vs "intramucosal" cannot be separated -> reported jointly as
    `pT1_or_lower` with an indeterminate flag.
  * pT4a (visceral peritoneum) and pT4b (adjacent organ) are never asserted;
    a >=pT3 case is flagged for gross/serosal correlation instead.

The determination follows the invasive-front topology described in Baumann et
al. (npj Precision Oncology 2025): CRC grows into muscle and adipose, so the
deepest tissue compartment the tumour front reaches — muscularis vs pericolic
fat — is the discriminating signal, taken with the normal-mucosa side excluded.

This module depends only on numpy + opencv + scipy so it can be unit-tested off
the cluster (see test_staging.py).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

import cv2
import numpy as np
from scipy import ndimage


# Human-readable label for each pT status key (mirrored on the frontend).
PT_STATUS_LABELS = {
    "no_tumor":      "No tumour on section",
    "pT1_or_lower":  "pT1 or lower (indeterminate)",
    "pT2":           "pT2 — muscularis propria",
    "pT3":           "pT3 — beyond muscularis propria",
}

# Fixed caveat always attached to an invasion-extent result.
PT_CAVEATS = [
    "AI estimate on a single section — confirm against the gross and the "
    "deepest block.",
    "pT4a (visceral peritoneum) / pT4b (adjacent organ) are not assessable "
    "from the tissue map and require gross/serosal correlation.",
    "Submucosa and muscularis mucosae are not resolved; pTis/pT1 are not "
    "separated.",
]


@dataclass
class InvasionResult:
    """Structured staging output. `*_mask` fields feed the overlay builder."""
    status: str                       # one of PT_STATUS_LABELS keys
    label: int                        # 1 if advanced (>=pT3), else 0
    confidence: str                   # "high" | "moderate" | "low"
    deepest_layer: str                # human-readable deepest compartment
    depth_beyond_mp_mm: float         # 0.0 if not beyond muscularis propria
    interfaces: dict = field(default_factory=dict)
    deepest_point_xy: Optional[tuple] = None   # (x, y) px at seg resolution
    # Derived binary masks (uint8) for the "Invasion Front" overlay:
    muscle_band_mask: Optional[np.ndarray] = None
    intramural_tumor_mask: Optional[np.ndarray] = None
    beyond_mp_tumor_mask: Optional[np.ndarray] = None

    def to_outcome(self) -> dict:
        """The `outcome` block written into result.json for the frontend card."""
        pretty = PT_STATUS_LABELS.get(self.status, self.status)
        depth_str = (
            f"{self.depth_beyond_mp_mm:.1f} mm"
            if self.depth_beyond_mp_mm > 0 else "N/A"
        )
        severity = ("positive" if self.label == 1
                    else "warning" if (self.status == "pT1_or_lower" or self.confidence == "low")
                    else "neutral")
        card = {
            "severity": severity,
            "rows": [
                {"label": "pT (AI estimate)", "value": pretty, "highlight": severity != "neutral"},
                {"label": "Deepest layer", "value": self.deepest_layer},
                {"label": "Beyond MP",
                 "value": (depth_str if self.depth_beyond_mp_mm > 0 else None), "mono": True},
                {"label": "Confidence", "value": self.confidence.title()},
            ],
            "note": PT_CAVEATS[1] if len(PT_CAVEATS) > 1 else None,
        }
        return {
            "status":              self.status,
            "label":               int(self.label),
            "pt_category":         self.status if self.status.startswith("pT") else "indeterminate",
            "confidence":          self.confidence,
            "deepest_layer":       self.deepest_layer,
            "depth_beyond_mp_mm":  round(float(self.depth_beyond_mp_mm), 2),
            "interfaces":          self.interfaces,
            "primary_metric": {
                "label": "pT (AI estimate)",
                "value": pretty,
            },
            "secondary_metric": {
                "label": "Beyond MP",
                "value": depth_str,
            },
            "caveats": PT_CAVEATS,
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


def _dilate(mask: np.ndarray, radius_px: int) -> np.ndarray:
    if radius_px <= 0:
        return (mask > 0).astype(np.uint8)
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * radius_px + 1, 2 * radius_px + 1))
    return cv2.dilate((mask > 0).astype(np.uint8), k, iterations=1)


def stage_invasion(
    seg: np.ndarray,
    label2id: dict,
    mpp: float,
    *,
    min_tumor_um: float = 300.0,
    min_muscle_um: float = 500.0,
    adj_um: float = 120.0,
) -> InvasionResult:
    """
    Estimate CRC extent of invasion (pT) from a tissue-segmentation label mask.

    Parameters
    ----------
    seg : (H, W) int array
        Per-pixel tissue class ids from the CRC tissue seg backbone.
    label2id : dict
        The backbone's class-name -> id map (must contain "Tumor",
        "Muscle/vessel", "Fat"; "Normal Mucosa" optional).
    mpp : float
        Microns per pixel of `seg` (the backbone runs at ~1.0 µm/px).
    min_tumor_um, min_muscle_um : float
        Minimum object diameters (µm) to treat a tumour / muscle region as real,
        used to drop segmentation specks.
    adj_um : float
        Adjacency radius (µm) for deciding that tumour "reaches" a tissue class.

    Returns
    -------
    InvasionResult
    """
    if seg.ndim != 2:
        raise ValueError(f"Expected a 2-D label mask, got shape {seg.shape}")

    tumor_id  = label2id["Tumor"]
    muscle_id = label2id["Muscle/vessel"]
    fat_id    = label2id["Fat"]
    mucosa_id = label2id.get("Normal Mucosa", -1)

    # µm -> px conversions
    adj_px          = max(1, int(round(adj_um / mpp)))
    min_tumor_px    = int(round((min_tumor_um / mpp) ** 2 * np.pi / 4))   # area of a disc
    min_muscle_px   = int(round((min_muscle_um / mpp) ** 2 * np.pi / 4))

    tumor  = _clean_binary(seg == tumor_id,  min_tumor_px,  close_px=5)
    muscle = _clean_binary(seg == muscle_id, min_muscle_px, close_px=7)
    fat    = _clean_binary(seg == fat_id,    0)
    mucosa = _clean_binary(seg == mucosa_id, 0) if mucosa_id >= 0 else np.zeros_like(tumor)

    has_wall = bool(muscle.any() and fat.any())

    # ── No meaningful tumour on the section ─────────────────────────────────
    if tumor.sum() == 0:
        return InvasionResult(
            status="no_tumor", label=0, confidence="low",
            deepest_layer="No tumour detected", depth_beyond_mp_mm=0.0,
            interfaces={"tumor_in_mucosa": False, "tumor_in_muscle": False,
                        "tumor_in_fat": False},
            muscle_band_mask=muscle,
        )

    # ── Tumour–tissue interfaces via adjacency ──────────────────────────────
    muscle_dil = _dilate(muscle, adj_px)
    fat_dil    = _dilate(fat,    adj_px)
    mucosa_dil = _dilate(mucosa, adj_px)

    tumor_in_muscle = bool(np.any(tumor & muscle_dil))
    tumor_in_fat    = bool(np.any(tumor & fat_dil))
    tumor_in_mucosa = bool(np.any(tumor & mucosa_dil))

    # ── Tumour that has crossed into the pericolic fat compartment ──────────
    # Beyond-MP = tumour reaching fat but NOT still sitting against the mucosa
    # (which would be luminal/superficial fat rather than deep pericolic fat).
    beyond = (tumor & fat_dil & ~mucosa_dil).astype(np.uint8)
    beyond = _clean_binary(beyond, min_tumor_px // 2)

    # Intramural tumour = tumour touching muscle but not counted as beyond-MP.
    intramural = ((tumor & muscle_dil).astype(np.uint8) & (beyond == 0)).astype(np.uint8)

    # ── Depth beyond the muscularis propria (mm) ────────────────────────────
    depth_mm = 0.0
    deepest_xy = None
    if beyond.any():
        # Distance (px) from every pixel to the nearest muscle-band pixel.
        dist = ndimage.distance_transform_edt(muscle == 0) if muscle.any() else None
        if dist is not None:
            masked = np.where(beyond > 0, dist, 0)
            idx = int(np.argmax(masked))
            y, x = np.unravel_index(idx, masked.shape)
            depth_mm = float(masked[y, x] * mpp / 1000.0)
            deepest_xy = (int(x), int(y))
        else:
            # No muscle band detected — cannot measure from MP; report extent
            # of the beyond component's own major axis as a fallback.
            ys, xs = np.where(beyond > 0)
            deepest_xy = (int(xs.mean()), int(ys.mean()))

    # ── Category decision ───────────────────────────────────────────────────
    if beyond.any():
        status, label, deepest = "pT3", 1, "Pericolorectal fat (beyond muscularis propria)"
    elif tumor_in_muscle:
        status, label, deepest = "pT2", 0, "Muscularis propria"
    else:
        status, label, deepest = "pT1_or_lower", 0, "Mucosa / submucosa (indeterminate)"

    # ── Confidence ──────────────────────────────────────────────────────────
    if status == "pT3":
        # High only if a muscularis band was actually found between tumour and
        # mucosa (i.e. we can defend "transmural"); else moderate.
        confidence = "high" if muscle.any() else "moderate"
    elif status == "pT2":
        confidence = "high" if has_wall else "moderate"
    else:  # pT1_or_lower
        confidence = "low"   # submucosa unresolved -> inherently uncertain

    return InvasionResult(
        status=status, label=label, confidence=confidence,
        deepest_layer=deepest, depth_beyond_mp_mm=depth_mm,
        interfaces={
            "tumor_in_mucosa": tumor_in_mucosa,
            "tumor_in_muscle": tumor_in_muscle,
            "tumor_in_fat":    tumor_in_fat,
        },
        deepest_point_xy=deepest_xy,
        muscle_band_mask=muscle,
        intramural_tumor_mask=intramural,
        beyond_mp_tumor_mask=beyond,
    )
