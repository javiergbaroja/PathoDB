"""
PathoDB — HoVer-Net Next Wrapper
=================================
Runs HoVer-NeXt inference and post-processing on the cluster,
then converts the raw class_inst.json output into a PathoDB-compatible
GeoJSON and result.json.

Environment variables (set by the PathoDB API via the SLURM context file):
    PATHODB_SCAN_PATH   — absolute path to the WSI
    PATHODB_RESULT_DIR  — directory for all outputs
    PATHODB_SCOPE       — "whole_slide" | "roi"
    PATHODB_PARAMS      — JSON string of user-supplied model parameters

Output contract (consumed by the PathoDB frontend):
    result.json
      ├── files.download_file  →  <RESULT_DIR>/<wsi_name>_cells.geojson
      └── outcome
            ├── status         →  "detection_complete"
            ├── total_cells    →  int
            └── class_counts   →  { "lymphocyte": 1234, ... }
"""

import glob
import json
import os
import sys
import time
import threading
import subprocess
import traceback
import openslide
import numpy as np
import cv2

# ── Path setup ─────────────────────────────────────────────────────────────────
SCRIPT_DIR  = os.path.dirname(os.path.abspath(__file__))
PACKAGE_DIR = (
    "/storage/research/igmp_slide_workspace/GRP Zlobec/Amjad/qupath/"
    "metassist-v1/MetAssist_expansion/crc-ugi/code/package_refactored"
)
sys.path.insert(0, os.path.dirname(SCRIPT_DIR))
sys.path.insert(0, PACKAGE_DIR)

from utils.wsi import prepare_read_from_slide
from utils.geometry import create_mask_from_contours

# ── Runtime constants ──────────────────────────────────────────────────────────
PYTHON     = sys.executable   # propagate the active conda env to all subprocesses
SCAN_PATH  = os.environ["PATHODB_SCAN_PATH"]
RESULT_DIR = os.environ["PATHODB_RESULT_DIR"]
SCOPE      = os.environ.get("PATHODB_SCOPE", "whole_slide")
PARAMS     = json.loads(os.environ.get("PATHODB_PARAMS", "{}"))
ROI        = os.environ.get("PATHODB_ROI",    "null")
if isinstance(ROI, str):
    ROI = ROI.strip().strip('"')
MODEL_ID   = "hover_next"

HOVERNEXT_MAIN_PY = (
    "/storage/research/igmp_dp_workspace/baumann_elias/"
    "hover_next_inference/main.py"
)

# ── Class definitions ──────────────────────────────────────────────────────────
# Integer label → class name — must match catalog.json "classes" list.
ID2LABEL = {
    1: "neutrophil",
    2: "epithelial-cell",
    3: "lymphocyte",
    4: "plasma-cell",
    5: "eosinophil",
    6: "connective-tissue-cell",
    7: "mitosis",
}

# Canonical display colours — defined once here so they flow through to
# result.json → viewer legend → UI outcome summary.
# Palette chosen for perceptual distinctiveness on a dark background.
CLASS_COLORS = {
    "neutrophil":             "#225cfc",   # deep blue
    "epithelial-cell":        "#31b160",   # blue
    "lymphocyte":             "#1e3a8a",   # navy blue
    "plasma-cell":            "#22d3ee",   # cyan
    "eosinophil":             "#572388",   # red
    "connective-tissue-cell": "#ec4899",   # dark pink
    "mitosis":                "#fbbf24",   # amber
}

os.makedirs(RESULT_DIR, exist_ok=True)


# ─────────────────────────────────────────────────────────────────────────────
# HELPERS
# ─────────────────────────────────────────────────────────────────────────────

def qupath_geojson_to_tissue_mask(
    slide_path: str,
    geojson_path: str,
    downsampling: int = 32,
) -> np.ndarray:
    """
    Convert a raw QuPath GeoJSON annotation export into a binary tissue mask
    that is directly compatible with WholeSlideDataset.

    QuPath exports annotations in a coordinate system whose origin sits at
    (BOUNDS_X, BOUNDS_Y) for formats that define those properties (most
    notably MRXS). WholeSlideDataset, however, builds its sampling grid over
    the full openslide level-0 extent. This function bridges the two by:

        openslide_coord = qupath_coord + (BOUNDS_X, BOUNDS_Y)

    The returned mask covers the entire level_dimensions[0] area at the
    requested downsampling so that every grid point produced by
    WholeSlideDataset can be looked up directly.

    Parameters
    ----------
    slide_path : str
        Path to the WSI (.svs, .mrxs, .tif, .ndpi, .czi).
    geojson_path : str
        Path to the raw QuPath GeoJSON export.
    downsampling : int, optional
        Downsampling factor for the output mask.  32 (≈ 1 µm/px at 40×)
        is a good default: small enough to preserve annotation boundaries,
        large enough to keep the mask lightweight.

    Returns
    -------
    np.ndarray
        Binary uint8 mask of shape
        (ceil(level0_height / ds), ceil(level0_width / ds))
        with 1 = tissue / ROI and 0 = background.
    """
    extension = os.path.splitext(slide_path)[1].lower()

    if extension == ".czi":
        # If you have czi_wrapper available, import and use it here.
        # from <module> import czi_wrapper
        # sl = czi_wrapper(slide_path)
        raise NotImplementedError(
            "Pass czi_wrapper instance or add the import for your project."
        )
    else:
        sl = openslide.open_slide(slide_path)

    full_w, full_h = sl.level_dimensions[0]

    # ── Determine QuPath → openslide offset ──────────────────────────
    #
    # QuPath sets its coordinate origin to (BOUNDS_X, BOUNDS_Y) when
    # those properties exist.  Formats without them (most SVS, TIF)
    # default to (0, 0) and no shift is needed.
    bounds_x = int(sl.properties.get("openslide.bounds-x", 0))
    bounds_y = int(sl.properties.get("openslide.bounds-y", 0))

    # ── Create empty mask in full openslide space ─────────────────────
    mask_w = int(np.ceil(full_w / downsampling))
    mask_h = int(np.ceil(full_h / downsampling))
    mask = np.zeros((mask_h, mask_w), dtype=np.uint8)

    # ── Parse GeoJSON ─────────────────────────────────────────────────
    with open(geojson_path, "r") as f:
        gj = json.load(f)

    # QuPath can export either a FeatureCollection or a bare list.
    if isinstance(gj, list):
        features = gj
    elif isinstance(gj, dict) and "features" in gj:
        features = gj["features"]
    else:
        raise ValueError(
            "GeoJSON must be a FeatureCollection or a list of Features."
        )

    # ── Rasterise every Polygon / MultiPolygon ────────────────────────
    for feature in features:
        geom = feature.get("geometry", {})
        geom_type = geom.get("type", "")
        coords = geom.get("coordinates", [])

        if geom_type == "Polygon":
            _fill_polygon(mask, coords, bounds_x, bounds_y, downsampling)
        elif geom_type == "MultiPolygon":
            for poly_coords in coords:
                _fill_polygon(mask, poly_coords, bounds_x, bounds_y, downsampling)
        # Points / LineStrings do not define area → skip silently.

    return mask


def _fill_polygon(
    mask: np.ndarray,
    polygon_coords: list,
    bounds_x: int,
    bounds_y: int,
    downsampling: int,
) -> None:
    """Rasterise one GeoJSON Polygon (outer ring + holes) into *mask*."""
    if not polygon_coords:
        return

    # Outer ring
    outer = np.asarray(polygon_coords[0], dtype=np.float64)
    if outer.ndim != 2 or outer.shape[0] < 3:
        return
    outer[:, 0] = (outer[:, 0] + bounds_x) / downsampling
    outer[:, 1] = (outer[:, 1] + bounds_y) / downsampling
    cv2.fillPoly(mask, [outer.astype(np.int32)], 1)

    # Holes
    for hole_coords in polygon_coords[1:]:
        hole = np.asarray(hole_coords, dtype=np.float64)
        if hole.ndim != 2 or hole.shape[0] < 3:
            continue
        hole[:, 0] = (hole[:, 0] + bounds_x) / downsampling
        hole[:, 1] = (hole[:, 1] + bounds_y) / downsampling
        cv2.fillPoly(mask, [hole.astype(np.int32)], 0)

def write_progress(pct: int, message: str) -> None:
    """Write progress.json atomically so the API never reads a partial file."""
    pct     = max(0, min(100, int(pct)))
    tmp     = os.path.join(RESULT_DIR, "progress.tmp")
    dst     = os.path.join(RESULT_DIR, "progress.json")
    with open(tmp, "w") as f:
        json.dump({"pct": pct, "message": message}, f)
    os.replace(tmp, dst)
    print(f"[{pct:3d}%] {message}", flush=True)


def run_cmd(cmd: list, label: str) -> None:
    """
    Run a subprocess, streaming stdout/stderr live to the SLURM log and
    capturing stderr so it lands in error.txt on failure.

    A plain subprocess.run(check=True) only surfaces the return code —
    the actual traceback stays buried in the SLURM log and is invisible
    to the PathoDB job error view.
    """
    print(f"\n[run_cmd] {label}",               flush=True)
    print(f"[run_cmd] Command: {' '.join(str(a) for a in cmd)}\n", flush=True)

    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
    )

    stderr_lines: list[str] = []

    def _drain_stderr() -> None:
        for line in proc.stderr:
            stderr_lines.append(line)
            print(f"[stderr] {line}", end="", flush=True)

    t = threading.Thread(target=_drain_stderr, daemon=True)
    t.start()

    for line in proc.stdout:
        print(line, end="", flush=True)

    proc.wait()
    t.join()

    if proc.returncode == 0:
        return

    stderr_blob = "".join(stderr_lines).strip()
    error_lines = [
        f"Subprocess '{label}' failed with exit code {proc.returncode}.",
        f"Command: {' '.join(str(a) for a in cmd)}",
        "",
        "--- subprocess stderr ---" if stderr_blob
            else "(no stderr captured — check the SLURM log for stdout)",
    ]
    if stderr_blob:
        error_lines.append(stderr_blob)

    error_msg = "\n".join(error_lines)
    print(error_msg, flush=True)

    with open(os.path.join(RESULT_DIR, "error.txt"), "w") as f:
        f.write(error_msg)

    raise subprocess.CalledProcessError(proc.returncode, cmd)


def find_class_inst_json(result_dir: str, wsi_name: str) -> str:
    """
    Locate class_inst.json written by HoVer-NeXt post-processing.

    HoVer-NeXt writes to <output_root>/<wsi_stem>/class_inst.json, but
    the subdirectory name can vary (e.g. extension handling differs across
    versions). The canonical path is tried first; a glob is the fallback.
    """
    canonical = os.path.join(result_dir, wsi_name, "class_inst.json")
    if os.path.exists(canonical):
        return canonical

    hits = glob.glob(os.path.join(result_dir, "*", "class_inst.json"))
    if hits:
        hits.sort(key=os.path.getmtime, reverse=True)
        return hits[0]

    raise FileNotFoundError(
        f"class_inst.json not found under {result_dir}. "
        "Ensure post-processing completed successfully."
    )


def class_inst_to_geojson(
    class_inst: dict,
    level_downsampling: float,
) -> tuple[dict, dict]:
    """
    Convert class_inst.json to a GeoJSON FeatureCollection of Point features.

    HoVer-NeXt coordinates are in inference-level pixel space (0.5 µm/px).
    Multiplying by level_downsampling maps them to level-0 slide pixel space,
    which is what the PathoDB viewer and annotation import pipeline expect.

    Returns:
        geojson      — GeoJSON FeatureCollection
        class_counts — { class_name: count, ... }  (zero-count classes omitted)
    """
    features:     list = []
    class_counts: dict = {label: 0 for label in ID2LABEL.values()}

    for inst_id, payload in class_inst.items():
        class_label = int(payload[0])
        centroid    = payload[1]          # [row, col] in inference space

        class_name = ID2LABEL.get(class_label)
        if class_name is None:
            print(
                f"  [warn] Unknown class label {class_label} "
                f"for instance {inst_id} — skipped.",
                flush=True,
            )
            continue

        class_counts[class_name] += 1
        features.append({
            "type": "Feature",
            "properties": {
                "classification": {"name": class_name},
                "objectType":     "cell",
                "instance_id":    inst_id,
            },
            "geometry": {
                "type":        "Point",
                # centroid is [row, col] → swap to [x=col, y=row] for GeoJSON,
                # then scale from inference space to level-0 slide pixels.
                "coordinates": [
                    centroid[1] * level_downsampling,
                    centroid[0] * level_downsampling,
                ],
            },
        })

    return (
        {"type": "FeatureCollection", "features": features},
        {k: v for k, v in class_counts.items() if v > 0},
    )


# ─────────────────────────────────────────────────────────────────────────────
# MAIN
# ─────────────────────────────────────────────────────────────────────────────

def main() -> None:
    print("=== PathoDB HoVer-Net Next Wrapper ===", flush=True)
    print(f"WSI        : {SCAN_PATH}",             flush=True)
    print(f"Result dir : {RESULT_DIR}",            flush=True)

    wsi_name   = os.path.splitext(os.path.basename(SCAN_PATH))[0]
    start_time = time.time()
    roi_path = ROI

    # ── Parameters (catalog.json exposes these to the UI) ──────────────────────
    cp         = PARAMS.get("cp",         "lizard_convnextv2_large")
    tta        = str(PARAMS.get("tta",    8))
    pp_tiling  = str(PARAMS.get("pp_tiling", 8))
    inf_workers = str(PARAMS.get("inf_workers", 12))
    inf_writers = str(PARAMS.get("inf_writers",  4))

    # Resolve the downsampling factor for the target inference resolution (0.5 µm/px)
    # before submitting the GPU job so we fail fast on a bad slide path.
    slide = openslide.open_slide(SCAN_PATH)
    level, level_downsampling, exact_resolution, tiling_downsample_factor, original_dim, read_origin = prepare_read_from_slide(
        slide,
        resolution=0.5,
    )

    if roi_path is not None and roi_path != "null":
            tissue_mask = qupath_geojson_to_tissue_mask(
                slide_path=SCAN_PATH,
                geojson_path=roi_path,
                downsampling=8)
        
            tissue_mask_path = os.path.join(RESULT_DIR, "tissue_mask.npy")
            np.save(tissue_mask_path, tissue_mask.astype(bool))
            roi_path = tissue_mask_path  # override ROI path to point to the mask
    
    print(f"Level downsampling : {level_downsampling:.4f}", flush=True)

    # ── Phase 1: Inference + post-processing ───────────────────────────────────
    write_progress(5, "Starting HoVer-Net Next inference…")
    cmd_list = [
        PYTHON, HOVERNEXT_MAIN_PY,
        "--input",       SCAN_PATH,
        "--output_root", RESULT_DIR,
        "--cp",          cp,
        "--tta",         tta,
        "--inf_workers", inf_workers,
        "--inf_writers", inf_writers,
        "--pp_workers",  inf_workers,
        "--pp_tiling",   pp_tiling,
    ]
    if roi_path is not None and roi_path != "null":
        cmd_list += ["--tissue_mask", roi_path]

    run_cmd(cmd_list, "Phase 1: inference + post-processing")

    write_progress(90, "Inference complete.")

    # ── Phase 2: Convert class_inst.json → GeoJSON ─────────────────────────────
    write_progress(92, "Converting class_inst.json to GeoJSON…")

    class_inst_path = find_class_inst_json(RESULT_DIR, wsi_name)
    print(f"Reading : {class_inst_path}", flush=True)

    with open(class_inst_path) as f:
        class_inst = json.load(f)

    geojson, class_counts = class_inst_to_geojson(class_inst, level_downsampling)
    total_cells  = sum(class_counts.values())
    geojson_path = os.path.join(RESULT_DIR, f"{wsi_name}_cells.geojson")

    with open(geojson_path, "w") as f:
        json.dump(geojson, f)   # no indent — keeps file compact for large cell counts

    # Clean up intermediate files written by HoVer-NeXt to the output subdirectory
    wsi_output_dir = os.path.dirname(class_inst_path)
    for fname in os.listdir(wsi_output_dir):
        if fname.endswith((".tsv", ".zip")):
            os.remove(os.path.join(wsi_output_dir, fname))

    print(f"Wrote {total_cells:,} cell annotations → {geojson_path}", flush=True)
    for name, count in sorted(class_counts.items(), key=lambda x: -x[1]):
        print(f"  {name:<30s}: {count:>7,}", flush=True)

    # ── Phase 3: result.json ───────────────────────────────────────────────────
    write_progress(96, "Writing result summary…")

    result = {
        "model_id":  MODEL_ID,
        "scan_path": SCAN_PATH,
        "scope":     SCOPE,
        "params": {
            "cp":        cp,
            "tta":       int(tta),
            "pp_tiling": int(pp_tiling),
        },
        "timing": {
            "total_s": round(time.time() - start_time, 2),
        },
        # Consumed by MultiClassDetectionSummary in the frontend
        "outcome": {
            "status":       "detection_complete",
            "total_cells":  total_cells,
            "class_counts": class_counts,
        },
        # "download_file" triggers the GeoJSON auto-import pipeline
        "files": {
            "download_file": geojson_path,
            "class_inst":    class_inst_path,
        },
        # Consumed by fetchAndRenderOverlay — only detected classes in the legend
        "overlays": [{
            "name":     "Cell Types",
            "file_key": "download_file",
            "type":     "points",
            "legend":   {
                cls: CLASS_COLORS[cls]
                for cls in CLASS_COLORS
                if class_counts.get(cls, 0) > 0
            },
        }],
    }

    with open(os.path.join(RESULT_DIR, "result.json"), "w") as f:
        json.dump(result, f, indent=2)
    
    # delete the tissue mask file if it was created
    if roi_path is not None and roi_path != "null" and os.path.exists(roi_path):
        os.remove(roi_path)

    write_progress(100, "Done")
    print(f"\n=== Complete — {round(time.time() - start_time, 2)}s | {total_cells:,} cells ===", flush=True)


# ─────────────────────────────────────────────────────────────────────────────
# ENTRY POINT
# ─────────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    try:
        main()
    except subprocess.CalledProcessError as e:
        msg = f"Subprocess failed with exit code {e.returncode}."
        try:
            write_progress(0, "Failed during model execution — see error.txt")
        except Exception:
            pass
        with open(os.path.join(RESULT_DIR, "error.txt"), "w") as f:
            f.write(msg + "\n" + traceback.format_exc())
        print(msg, file=sys.stderr)
        sys.exit(1)
    except Exception:
        tb = traceback.format_exc()
        try:
            write_progress(0, "Failed — see error.txt")
        except Exception:
            pass
        with open(os.path.join(RESULT_DIR, "error.txt"), "w") as f:
            f.write(tb)
        print(tb, file=sys.stderr)
        sys.exit(1)