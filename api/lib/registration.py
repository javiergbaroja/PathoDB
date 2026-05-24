"""
PathoDB — Whole-slide registration math.

A registration maps coordinates of the *moving* slide (e.g. the right pane in
the compare viewer) into the *fixed* slide's full-resolution pixel space using a
2D similarity transform (uniform scale + rotation + translation):

    [xf]       [ cosθ  -sinθ ] [xm]   [tx]
    [yf] = s · [ sinθ   cosθ ] [ym] + [ty]

Similarity (4 DoF) is the right model for serial sections / re-stains of the
same block: the tissue is placed at an arbitrary offset, angle and (slightly)
different magnification, but is otherwise rigid at the whole-slide scale.

This module is intentionally dependency-free (pure Python) so the core estimator
and transform algebra can be unit-tested without FastAPI, NumPy or OpenCV. The
optional feature-based `auto_register_similarity` imports OpenCV/NumPy lazily.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Sequence, Tuple

Point = Tuple[float, float]


class RegistrationError(Exception):
    """Raised when a transform cannot be estimated."""


@dataclass(frozen=True)
class SimilarityTransform:
    scale: float
    rotation: float   # radians, maps moving -> fixed
    tx: float
    ty: float

    # ── application ──────────────────────────────────────────────────────────
    def apply(self, x: float, y: float) -> Point:
        c = math.cos(self.rotation)
        s = math.sin(self.rotation)
        return (
            self.scale * (c * x - s * y) + self.tx,
            self.scale * (s * x + c * y) + self.ty,
        )

    def inverse(self) -> "SimilarityTransform":
        """Transform mapping fixed -> moving."""
        if self.scale == 0:
            raise RegistrationError("non-invertible transform (zero scale)")
        inv_scale = 1.0 / self.scale
        inv_rot = -self.rotation
        c = math.cos(inv_rot)
        s = math.sin(inv_rot)
        # p_moving = inv_scale * R(-θ) * (p_fixed - t)
        tx = -inv_scale * (c * self.tx - s * self.ty)
        ty = -inv_scale * (s * self.tx + c * self.ty)
        return SimilarityTransform(inv_scale, inv_rot, tx, ty)

    # ── serialization ────────────────────────────────────────────────────────
    def to_dict(self) -> dict:
        return {
            "scale": self.scale,
            "rotation": self.rotation,
            "tx": self.tx,
            "ty": self.ty,
            "rotation_deg": math.degrees(self.rotation),
        }

    @classmethod
    def from_dict(cls, d: dict) -> "SimilarityTransform":
        return cls(
            scale=float(d["scale"]),
            rotation=float(d["rotation"]),
            tx=float(d["tx"]),
            ty=float(d["ty"]),
        )


def estimate_similarity(src: Sequence[Point], dst: Sequence[Point]) -> SimilarityTransform:
    """Least-squares similarity transform mapping ``src`` -> ``dst``.

    Closed-form Umeyama solution (exact for 2 pairs, least-squares for more).
    `src` are moving-slide points, `dst` the matching fixed-slide points.
    """
    n = len(src)
    if n < 2 or len(dst) != n:
        raise RegistrationError("need at least 2 matching point pairs")

    msx = sum(p[0] for p in src) / n
    msy = sum(p[1] for p in src) / n
    mdx = sum(p[0] for p in dst) / n
    mdy = sum(p[1] for p in dst) / n

    dot = 0.0    # Σ a·b
    cross = 0.0  # Σ a×b  (ax·by − ay·bx)
    var = 0.0    # Σ |a|²
    for (sx, sy), (dx, dy) in zip(src, dst):
        ax, ay = sx - msx, sy - msy
        bx, by = dx - mdx, dy - mdy
        dot += ax * bx + ay * by
        cross += ax * by - ay * bx
        var += ax * ax + ay * ay

    if var == 0:
        raise RegistrationError("degenerate source points (all coincident)")

    rotation = math.atan2(cross, dot)
    scale = math.hypot(dot, cross) / var
    if scale == 0:
        raise RegistrationError("degenerate point configuration (zero scale)")

    c = math.cos(rotation)
    s = math.sin(rotation)
    tx = mdx - scale * (c * msx - s * msy)
    ty = mdy - scale * (s * msx + c * msy)
    return SimilarityTransform(scale, rotation, tx, ty)


def rms_residual(transform: SimilarityTransform, src: Sequence[Point], dst: Sequence[Point]) -> float:
    """Root-mean-square fixed-space error of the fit (in fixed pixels)."""
    if not src:
        return 0.0
    total = 0.0
    for (sx, sy), (dx, dy) in zip(src, dst):
        px, py = transform.apply(sx, sy)
        total += (px - dx) ** 2 + (py - dy) ** 2
    return math.sqrt(total / len(src))


def auto_register_similarity(
    fixed_gray,
    moving_gray,
    fixed_downsample: float,
    moving_downsample: float,
    *,
    n_features: int = 2000,
    ratio: float = 0.75,
    min_matches: int = 8,
    ransac_reproj: float = 5.0,
) -> SimilarityTransform:
    """Feature-based similarity registration from downsampled grayscale thumbnails.

    `fixed_gray` / `moving_gray` are 2D uint8 NumPy arrays (thumbnails).
    `*_downsample` is full_res_width / thumbnail_width for each slide.
    Returns the transform in FULL-RESOLUTION moving->fixed pixel coordinates.

    OpenCV is imported lazily; callers should treat ImportError as "auto
    registration unavailable" (the manual landmark path always works).
    """
    import cv2  # noqa: WPS433  (lazy, optional dependency)
    import numpy as np  # noqa: WPS433

    orb = cv2.ORB_create(nfeatures=n_features)
    kf, df = orb.detectAndCompute(fixed_gray, None)
    km, dm = orb.detectAndCompute(moving_gray, None)
    if df is None or dm is None or len(kf) < 2 or len(km) < 2:
        raise RegistrationError("not enough features detected to align these slides")

    matcher = cv2.BFMatcher(cv2.NORM_HAMMING)
    raw = matcher.knnMatch(dm, df, k=2)  # query = moving, train = fixed
    good = [m for pair in raw if len(pair) == 2 for (m, n) in [pair] if m.distance < ratio * n.distance]
    if len(good) < min_matches:
        raise RegistrationError(f"too few reliable feature matches ({len(good)} < {min_matches})")

    src = np.float32([km[m.queryIdx].pt for m in good])  # moving thumbnail px
    dst = np.float32([kf[m.trainIdx].pt for m in good])  # fixed thumbnail px

    matrix, inliers = cv2.estimateAffinePartial2D(
        src, dst, method=cv2.RANSAC, ransacReprojThreshold=ransac_reproj,
    )
    if matrix is None:
        raise RegistrationError("RANSAC could not find a consistent transform")

    a, b = float(matrix[0, 0]), float(matrix[1, 0])
    s_thumb = math.hypot(a, b)
    theta = math.atan2(b, a)
    tx_thumb, ty_thumb = float(matrix[0, 2]), float(matrix[1, 2])
    if s_thumb == 0:
        raise RegistrationError("degenerate transform from feature matching")

    # Rescale thumbnail-space transform to full-resolution pixel space:
    #   p_fixed_full  = f_fix * p_fixed_thumb
    #   p_moving_full = f_mov * p_moving_thumb
    # => scale *= f_fix / f_mov ; translation *= f_fix ; rotation unchanged.
    scale = s_thumb * (fixed_downsample / moving_downsample)
    return SimilarityTransform(scale, theta, tx_thumb * fixed_downsample, ty_thumb * fixed_downsample)
