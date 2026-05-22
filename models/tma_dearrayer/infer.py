import math
import numpy as np
import cv2
import openslide

from dataclasses import dataclass
from typing import List, Tuple, Optional

from scipy.ndimage import uniform_filter, uniform_filter1d
from skimage import measure, morphology
from skimage.filters import threshold_triangle
from skimage.segmentation import watershed
from scipy import ndimage as ndi


# ----------------------------
# Utilities mirroring QuPath
# ----------------------------

def parse_tma_label_string(s: str) -> List[str]:
    """
    Approximation of PathObjectTools.parseTMALabelString.
    Supports:
      - "1-16", "A-J"
      - space-separated discontinuous lists
    """
    s = s.strip()
    if not s:
        return []
    if " " in s:
        return [x for x in s.split() if x]

    if "-" in s:
        a, b = s.split("-", 1)
        a, b = a.strip(), b.strip()
        if a.isdigit() and b.isdigit():
            ia, ib = int(a), int(b)
            step = 1 if ib >= ia else -1
            return [str(i) for i in range(ia, ib + step, step)]
        if len(a) == 1 and len(b) == 1 and a.isalpha() and b.isalpha():
            oa, ob = ord(a.upper()), ord(b.upper())
            step = 1 if ob >= oa else -1
            return [chr(i) for i in range(oa, ob + step, step)]

    return [s]


def choose_downsample_qupath_like(w: int, h: int, microns_per_pixel: Optional[float]) -> float:
    """
    Matches the logic in TMADearrayerPluginIJ.Dearrayer.runDetection():
      dimRequested = 1200
      downsample = 2^(round(log2(maxDim/dimRequested)))
      if mpp available:
        downsample2 = round(25 / mpp)
        if downsample2 > 1 and maxDim/downsample2 < dimRequested*2: use downsample2
    """
    max_dim = max(w, h)
    dim_requested = 1200.0
    downsample = 2 ** round(math.log(max_dim / dim_requested, 2))

    if microns_per_pixel is not None and microns_per_pixel > 0:
        preferred_pixel_size_um = 25.0
        downsample2 = round(preferred_pixel_size_um / microns_per_pixel)
        if downsample2 > 1 and (max_dim / downsample2 < dim_requested * 2):
            downsample = downsample2

    return float(max(1.0, downsample))


def get_mpp_from_openslide(slide: openslide.OpenSlide) -> Optional[float]:
    """
    Best-effort microns-per-pixel from OpenSlide properties.
    """
    props = slide.properties
    x = props.get("openslide.mpp-x", None)
    y = props.get("openslide.mpp-y", None)
    try:
        if x is not None and y is not None:
            return 0.5 * (float(x) + float(y))
        if x is not None:
            return float(x)
        if y is not None:
            return float(y)
    except Exception:
        return None
    return None


def read_wsi_at_downsample(slide: openslide.OpenSlide, downsample: float) -> Tuple[np.ndarray, float]:
    """
    QuPath requests an arbitrary downsample; OpenSlide provides discrete levels.
    For QuPath-like behavior without QuPath, we:
      - read the closest level
      - then (optionally) resample to the exact requested downsample (to reduce mismatch)
    Returns (rgb_uint8, effective_downsample_used).
    """
    downs = np.array(slide.level_downsamples, dtype=float)
    level = int(np.argmin(np.abs(downs - downsample)))
    w, h = slide.level_dimensions[level]
    rgba = slide.read_region((0, 0), level, (w, h))
    rgb = np.array(rgba)[:, :, :3].astype(np.uint8)
    used = float(downs[level])

    # If level downsample differs from requested, resample to requested size
    if abs(used - downsample) / downsample > 0.05:  # 5% mismatch threshold
        w0, h0 = slide.level_dimensions[0]
        target_w = int(round(w0 / downsample))
        target_h = int(round(h0 / downsample))
        rgb = cv2.resize(rgb, (target_w, target_h), interpolation=cv2.INTER_AREA)
        used = float(downsample)

    return rgb, used


def to_gray_uint8(rgb: np.ndarray) -> np.ndarray:
    # ImageJ ColorProcessor->Byte conversion differs slightly; this is a reasonable approximation.
    return cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)


# ----------------------------
# QuPath-like TMADearrayer
# ----------------------------

def rank_filter_min(img: np.ndarray, radius: int) -> np.ndarray:
    k = 2 * radius + 1
    return cv2.erode(img, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k)))

def rank_filter_max(img: np.ndarray, radius: int) -> np.ndarray:
    k = 2 * radius + 1
    return cv2.dilate(img, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k)))

def rank_filter_median(img: np.ndarray, radius: int) -> np.ndarray:
    # ImageJ RankFilters median radius=1 ~ 3x3 median
    k = 2 * radius + 1
    k = k if k % 2 == 1 else k + 1
    return cv2.medianBlur(img, k)


def make_binary_image_qupath_like(gray: np.ndarray, core_diameter_px: float) -> np.ndarray:
    """
    Mirrors TMADearrayer.makeBinaryImage for brightfield (isFluorescence=false).
    Output: binary uint8 {0,255}.
    """
    ip = gray.copy()

    # Small median filter radius 1.0
    ip = rank_filter_median(ip, radius=1)

    # Brightfield: invert
    ip = 255 - ip

    # Background suppression using min then max on a downsampled copy
    filter_radius = core_diameter_px * 0.6
    ip2 = ip.copy()

    downsample = int(round(filter_radius / 10.0))
    if downsample > 1:
        small = cv2.resize(ip2, (int(ip2.shape[1] / downsample + 0.5),
                                int(ip2.shape[0] / downsample + 0.5)),
                           interpolation=cv2.INTER_AREA)

        r_small = max(1, int(round(filter_radius / downsample)))
        small = rank_filter_min(small, r_small)
        small = rank_filter_max(small, r_small)

        ip2 = cv2.resize(small, (ip.shape[1], ip.shape[0]), interpolation=cv2.INTER_LINEAR)

    # Subtract
    ip = cv2.subtract(ip, ip2)

    # Smooth slightly (ImageJ ip.smooth() ~ 3x3 mean)
    ip = cv2.blur(ip, (3, 3))

    # Triangle threshold
    t = threshold_triangle(ip.astype(np.float32) / 255.0)
    bw = (ip.astype(np.float32) / 255.0 > t).astype(np.uint8) * 255

    # Gentle morphological cleaning:
    r2 = int(max(1.0, core_diameter_px * 0.02))
    bw = rank_filter_max(bw, r2)
    bw = rank_filter_min(bw, r2)
    bw = rank_filter_min(bw, r2)
    bw = rank_filter_max(bw, r2)

    # Fill holes (QuPath uses RoiLabeling.fillHoles)
    bw_bool = bw > 0
    bw_filled = morphology.remove_small_holes(bw_bool, area_threshold=int((core_diameter_px**2) * 0.02))
    return (bw_filled.astype(np.uint8) * 255)


def identify_good_cores_centroids(binary: np.ndarray, core_diameter_px: float,
                                 min_circularity: float = 0.8) -> Tuple[np.ndarray, np.ndarray]:
    """
    Mirrors identifyGoodCores(..., minArea,maxArea,minCircularity).
    Returns: (centroids Nx2 float, mask_of_good_cores uint8).
    """
    est_area = math.pi * (core_diameter_px ** 2) * 0.25
    min_area = est_area * 0.5
    max_area = est_area * 2.0

    lbl = measure.label(binary > 0)
    props = measure.regionprops(lbl)

    mask = np.zeros_like(binary, dtype=np.uint8)
    cents = []

    for p in props:
        area = p.area
        if area < min_area or area > max_area:
            continue
        perim = p.perimeter
        if perim <= 0:
            continue
        circ = (4 * math.pi * area) / (perim * perim)
        if circ < min_circularity:
            continue
        cy, cx = p.centroid
        cents.append((cx, cy))
        mask[lbl == p.label] = 255

    return np.array(cents, dtype=np.float32), mask


def estimate_rotation_qupath_like(centroids: np.ndarray, core_diameter_px: float) -> float:
    """
    Mirrors TMADearrayer.estimateRotation: median angle of near-horizontal neighbor pairs.
    """
    angles = []
    n = len(centroids)
    if n < 2:
        return float("nan")
    for i in range(n):
        x, y = centroids[i]
        for j in range(n):
            x2, y2 = centroids[j]
            if (x2 > x) and ((x2 - x) < core_diameter_px * 2) and (abs(y - y2) < core_diameter_px):
                angles.append(math.degrees(math.atan2(y2 - y, x2 - x)))
    if not angles:
        return float("nan")
    angles.sort()
    mid = len(angles) // 2
    return angles[mid] if len(angles) % 2 else 0.5 * (angles[mid - 1] + angles[mid])


def rotate_image(img: np.ndarray, angle_deg: float) -> np.ndarray:
    h, w = img.shape[:2]
    M = cv2.getRotationMatrix2D((w / 2.0, h / 2.0), angle_deg, 1.0)
    return cv2.warpAffine(img, M, (w, h), flags=cv2.INTER_NEAREST, borderValue=0)


def rotate_points(points_xy: np.ndarray, w: int, h: int, angle_deg: float) -> np.ndarray:
    cx, cy = w / 2.0, h / 2.0
    theta = math.radians(angle_deg)
    R = np.array([[math.cos(theta), -math.sin(theta)],
                  [math.sin(theta),  math.cos(theta)]], dtype=np.float64)
    pts = points_xy.astype(np.float64)
    pts -= np.array([cx, cy])
    pts = pts @ R.T
    pts += np.array([cx, cy])
    return pts.astype(np.float32)


def maximum_finder_like(profile: np.ndarray, n_maxima: int, min_separation: int) -> List[int]:
    """
    QuPath uses ImageJ MaximumFinder.findMaxima then keeps peaks with sufficient separation.
    We'll approximate by: find local maxima, sort by height, greedy select with min_separation.
    """
    prof = profile.astype(np.float64)
    # local maxima
    maxima = np.where((prof[1:-1] >= prof[:-2]) & (prof[1:-1] >= prof[2:]))[0] + 1
    # sort by height desc
    maxima = sorted(maxima, key=lambda i: prof[i], reverse=True)

    chosen = []
    for idx in maxima:
        if all(abs(idx - c) >= min_separation for c in chosen):
            chosen.append(int(idx))
            if len(chosen) == n_maxima:
                break
    return sorted(chosen)


def estimate_grid_qupath_like(good_mask: np.ndarray, n_horizontal: int, n_vertical: int, core_diameter_px: float):
    """
    Mirrors TMADearrayer.estimateGrid using 1D profile plots + maxima selection.
    """
    img = (good_mask > 0).astype(np.float32)

    # Profiles: sum over axis, QuPath uses ProfilePlot on full ROI
    prof_x = img.sum(axis=0)
    prof_y = img.sum(axis=1)

    # mild smoothing (QuPath does gaussian-ish behavior; we'll smooth to stabilize maxima)
    win = max(3, int(core_diameter_px // 4) | 1)
    prof_x = uniform_filter1d(prof_x, size=win, mode="nearest")
    prof_y = uniform_filter1d(prof_y, size=win, mode="nearest")

    min_sep = max(1, int(core_diameter_px))

    x_locs = maximum_finder_like(prof_x, n_horizontal, min_sep)
    y_locs = maximum_finder_like(prof_y, n_vertical, min_sep)

    if len(x_locs) == 0 or len(y_locs) == 0:
        return None

    return x_locs, y_locs


def refine_grid_coordinates_by_shifting_like(binary_rot: np.ndarray,
                                             grid_xy: np.ndarray,
                                             core_diameter_px: float) -> np.ndarray:
    """
    Approximation of TMADearrayer.refineGridCoordinatesByShifting.
    QuPath does:
      - watershed on binary
      - build density image from "good" regions
      - confirm points that already fall inside good region (snap to bbox center)
      - build Voronoi-like regions, penalize boundaries
      - mean filter density
      - pick closest maximum within oval ROI around original point

    We'll implement a close analogue using:
      - distance transform watershed to separate blobs
      - "density" = mean filtered binary
      - snap if inside sufficiently large connected component
      - otherwise shift to best local maximum near point with boundary penalty
    """
    bw = (binary_rot > 0)

    # watershed segmentation to split round structures
    dist = ndi.distance_transform_edt(bw)
    # markers from local maxima of distance
    coords = morphology.local_maxima(dist)
    markers = measure.label(coords)
    labels = watershed(-dist, markers, mask=bw)

    # density map (mean filter radius ~ 0.5*diam)
    r = max(1, int(round(core_diameter_px * 0.5)))
    k = 2 * r + 1
    dens = uniform_filter(bw.astype(np.float32), size=k, mode="nearest")

    h, w = binary_rot.shape[:2]
    out = grid_xy.copy()
    confirmed = np.zeros((len(out),), dtype=bool)

    # snap if point is inside a sufficiently large region
    min_diam = core_diameter_px * 0.7
    for i, (x, y) in enumerate(out):
        xi, yi = int(round(x)), int(round(y))
        if xi < 0 or yi < 0 or xi >= w or yi >= h:
            continue
        lab = labels[yi, xi]
        if lab == 0:
            continue
        ys, xs = np.where(labels == lab)
        if len(xs) == 0:
            continue
        x0, x1 = xs.min(), xs.max()
        y0, y1 = ys.min(), ys.max()
        if (x1 - x0) >= min_diam and (y1 - y0) >= min_diam:
            out[i, 0] = 0.5 * (x0 + x1)
            out[i, 1] = 0.5 * (y0 + y1)
            confirmed[i] = True
            # penalize this region so others won't drift into it
            dens[labels == lab] = -1e3

    # boundary penalty: erode mask and penalize outside
    core_mask = bw.astype(np.uint8) * 255
    er = cv2.erode(core_mask, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3)))
    dens[er == 0] = -1e3

    # find local best shift within an oval neighborhood
    for i, (x, y) in enumerate(out):
        if confirmed[i]:
            continue
        xi, yi = int(round(x)), int(round(y))
        rad = int(round(core_diameter_px * 0.5))
        x0, x1 = max(0, xi - rad), min(w - 1, xi + rad)
        y0, y1 = max(0, yi - rad), min(h - 1, yi + rad)

        window = dens[y0:y1 + 1, x0:x1 + 1]
        if window.size == 0:
            continue

        # build oval mask (like OvalRoi)
        yy, xx = np.ogrid[y0:y1 + 1, x0:x1 + 1]
        oval = ((xx - x) ** 2 + (yy - y) ** 2) <= (core_diameter_px * 0.5) ** 2

        masked = np.where(oval, window, -1e9)
        max_val = masked.max()
        if not np.isfinite(max_val) or max_val < -1e8:
            continue

        # tie-break: choose maximum closest to original point
        ys, xs = np.where(masked == max_val)
        if len(xs) == 0:
            continue
        pts = np.stack([xs + x0, ys + y0], axis=1).astype(np.float32)
        d2 = (pts[:, 0] - x) ** 2 + (pts[:, 1] - y) ** 2
        best = pts[int(np.argmin(d2))]
        out[i] = best
        confirmed[i] = True

    return out


def compute_densities_qupath_like(binary: np.ndarray, grid_xy: np.ndarray, core_diameter_px: float) -> np.ndarray:
    """
    Mirrors TMADearrayer.computeDensities:
      - convert to float
      - fp.max(1)
      - mean filter with radius = coreDiameterPx*0.5
      - sample at grid points
    """
    bw = (binary > 0).astype(np.float32)
    bw = np.maximum(bw, 1.0)  # QuPath does fp.max(1.0) after float conversion
    r = max(1, int(round(core_diameter_px * 0.5)))
    k = 2 * r + 1
    dens = uniform_filter(bw, size=k, mode="nearest")

    h, w = binary.shape[:2]
    out = np.zeros((len(grid_xy),), dtype=np.float64)
    for i, (x, y) in enumerate(grid_xy):
        xi, yi = int(x), int(y)
        if 0 <= xi < w and 0 <= yi < h:
            out[i] = float(dens[yi, xi])
    return out


@dataclass
class CoreResult:
    row: int
    col: int
    name: str
    x_fullres: float
    y_fullres: float
    missing: bool
    density: float


def dearray_tma_qupath_like(
    slide_path: str,
    core_diameter_microns: float,
    labels_horizontal: str,
    labels_vertical: str,
    column_first: bool = True,
    density_threshold_percent: int = 5,
    bounds_scale_percent: int = 105,
) -> Tuple[dict, List[CoreResult]]:
    slide = openslide.OpenSlide(slide_path)
    w0, h0 = slide.level_dimensions[0]

    mpp = get_mpp_from_openslide(slide)
    if mpp is None:
        raise ValueError("Could not determine microns-per-pixel (mpp) from slide. Provide mpp or set OpenSlide properties.")

    # fullCoreDiameterPx = microns / (microns/pixel)
    full_core_diameter_px = core_diameter_microns / mpp

    # choose downsample like QuPath
    downsample = choose_downsample_qupath_like(w0, h0, mpp)

    rgb, used_downsample = read_wsi_at_downsample(slide, downsample)
    downsample = used_downsample

    gray = to_gray_uint8(rgb)

    h_labels = parse_tma_label_string(labels_horizontal)
    v_labels = parse_tma_label_string(labels_vertical)
    n_horizontal = len(h_labels)
    n_vertical = len(v_labels)

    core_diameter_px = full_core_diameter_px / downsample

    # Step 1: makeBinaryImage
    bw = make_binary_image_qupath_like(gray, core_diameter_px)

    # Step 2: identifyGoodCores + estimateRotation
    cents, good_mask = identify_good_cores_centroids(bw, core_diameter_px, min_circularity=0.8)
    angle = estimate_rotation_qupath_like(cents, core_diameter_px)

    # Step 3: rotate masks for grid estimation
    if not np.isnan(angle) and abs(angle) > 1e-6:
        bw_rot = rotate_image(bw, -angle)
        good_rot = rotate_image(good_mask, -angle)
    else:
        bw_rot, good_rot = bw, good_mask

    # Step 4: estimate grid peaks
    grid_lines = estimate_grid_qupath_like(good_rot, n_horizontal, n_vertical, core_diameter_px)
    if grid_lines is None:
        raise RuntimeError("Failed to estimate grid lines (no peaks). Check diameter/labels/thresholding.")

    x_locs, y_locs = grid_lines

    # Build grid in rotated coords (row-major)
    grid_xy = []
    for y in y_locs:
        for x in x_locs:
            grid_xy.append((float(x), float(y)))
    grid_xy = np.array(grid_xy, dtype=np.float32)

    # Step 5: refine grid coords (QuPath refineGridCoordinatesByShifting)
    grid_xy_refined = refine_grid_coordinates_by_shifting_like(bw_rot, grid_xy, core_diameter_px)

    # Step 6: rotate points back to unrotated image coords
    if not np.isnan(angle) and abs(angle) > 1e-6:
        grid_xy_refined = rotate_points(grid_xy_refined, bw.shape[1], bw.shape[0], angle)

    # Step 7: compute densities + missing
    densities = compute_densities_qupath_like(bw, grid_xy_refined, core_diameter_px)
    density_threshold = density_threshold_percent / 100.0

    results: List[CoreResult] = []
    idx = 0
    for row in range(n_vertical):
        for col in range(n_horizontal):
            if idx >= len(grid_xy_refined):
                break
            x_ds, y_ds = grid_xy_refined[idx]
            x_full = float(x_ds) * downsample
            y_full = float(y_ds) * downsample

            missing = float(densities[idx]) < density_threshold

            h = h_labels[col]
            v = v_labels[row]
            name = f"{h}-{v}" if column_first else f"{v}-{h}"

            results.append(CoreResult(
                row=row, col=col, name=name,
                x_fullres=x_full, y_fullres=y_full,
                missing=bool(missing),
                density=float(densities[idx]),
            ))
            idx += 1

    meta = {
        "slide_path": slide_path,
        "mpp_um_per_px": mpp,
        "core_diameter_microns": core_diameter_microns,
        "full_core_diameter_px": full_core_diameter_px,
        "downsample_used": downsample,
        "grid_width": n_horizontal,
        "grid_height": n_vertical,
        "rotation_deg_est": None if np.isnan(angle) else float(angle),
        "density_threshold": density_threshold,
        "bounds_scale_percent": bounds_scale_percent,
    }
    return meta, results


if __name__ == "__main__":
    meta, cores = dearray_tma_qupath_like(
        slide_path="your_slide.svs",
        core_diameter_microns=1200.0,
        labels_horizontal="1-16",
        labels_vertical="A-J",
        column_first=True,
        density_threshold_percent=5,
        bounds_scale_percent=105,
    )

    # Output: centers + missing flags (row-major)
    out = {
        "meta": meta,
        "cores": [
            {
                "row": c.row,
                "col": c.col,
                "name": c.name,
                "x_fullres": c.x_fullres,
                "y_fullres": c.y_fullres,
                "missing": c.missing,
                "density": c.density,
            }
            for c in cores
        ]
    }

    import json
    print(json.dumps(out, indent=2))