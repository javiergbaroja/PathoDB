"""
PathoDB API — Analysis Router
==============================
Manages DL model inference jobs submitted to the UBELIX HPC via sbatch.

Endpoints
---------
GET  /analysis/models                  — static model catalog (from catalog.json)
POST /analysis/jobs                    — submit a new inference job
GET  /analysis/jobs?scan_id=N          — list jobs for a slide
GET  /analysis/jobs/{job_id}           — single job detail + live status
DELETE /analysis/jobs/{job_id}         — cancel a queued or running job (scancel)
GET  /analysis/jobs/{job_id}/result    — serve the JSON result produced by the model

Job lifecycle
-------------
queued  →  running  →  done
                    →  failed
                    →  cancelled   (via DELETE)

The status endpoint calls squeue to get the live SLURM state and syncs it to
the DB. Progress (0-100) is read from a progress.json sidecar the model writes.
"""

import json
import os
import re
import shutil
import logging
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Optional
import io
import tiffslide
import math
import traceback
from PIL import Image
from pydantic import BaseModel
import socket

import gc
import threading
from collections import OrderedDict
from PIL import Image


from fastapi import APIRouter, Depends, HTTPException, Query, Response
from fastapi.responses import JSONResponse, FileResponse
from sqlalchemy.orm import Session

from .slides import _auth_token

from ..database import get_db
from ..models import AnalysisJob, Scan, User
from ..schemas import AnalysisJobResponse, AnalysisRunRequest
from ..auth import get_current_active_user
from ..config import get_settings

log      = logging.getLogger("pathodb_analysis")
settings = get_settings()

router = APIRouter(prefix="/analysis", tags=["analysis"])


# ── Tunables ──────────────────────────────────────────────────────────────────
# Hard cap on a single read_region call.  At 8192 RGBA, peak transient memory
# for one tile read is ~256 MB.  Above this we serve from the downsampled cache.
MAX_READ_DIM            = 8192
 
# Maximum dimension of the cached downsampled image per overlay TIFF.
# 4096 RGBA = 64 MB per cached overlay.  With DOWNSAMPLED_CACHE_MAX = 8 overlays,
# total budget is ~512 MB — tune to your Slurm memory allocation.
DOWNSAMPLED_MAX_DIM     = 4096
DOWNSAMPLED_CACHE_MAX   = 8
 
# Chunked-read step when building the downsampled cache from a non-pyramidal
# TIFF.  Peak memory during build = CHUNK² × 4 bytes = 64 MB at 4096.
CHUNK_READ_DIM          = 4096
 
# Bound on simultaneous read_region calls across all requests.  OSD fires
# 20–80 tile requests in parallel during zoom; uncapped, they pile up large
# transient buffers concurrently.  4 is conservative; raise if your I/O is fast.
MAX_CONCURRENT_READS    = 4
_read_semaphore         = threading.Semaphore(MAX_CONCURRENT_READS)
 
# Tile-byte cache (same pattern as slides.py)
_overlay_tile_cache: "OrderedDict[str, bytes]" = OrderedDict()
_OVERLAY_TILE_MAX = 512
_overlay_tile_lock = threading.Lock()
 
def _otile_key(job_id, file_key, level, x, y):
    return f"{job_id}/{file_key}/{level}/{x}/{y}"
 
def _otile_get(key):
    with _overlay_tile_lock:
        if key not in _overlay_tile_cache:
            return None
        _overlay_tile_cache.move_to_end(key)
        return _overlay_tile_cache[key]
 
def _otile_set(key, value):
    with _overlay_tile_lock:
        _overlay_tile_cache[key] = value
        _overlay_tile_cache.move_to_end(key)
        while len(_overlay_tile_cache) > _OVERLAY_TILE_MAX:
            _overlay_tile_cache.popitem(last=False)
 
 
# ── Open-handle pool ──────────────────────────────────────────────────────────
# Bounded LRU pool of TiffSlide handles, one per overlay TIFF path.
_slide_pool: "OrderedDict[str, dict]" = OrderedDict()
_SLIDE_POOL_MAX  = 16
_slide_pool_lock = threading.Lock()
 
def _get_pooled_slide(tiff_path: str):
    with _slide_pool_lock:
        if tiff_path in _slide_pool:
            _slide_pool.move_to_end(tiff_path)
            e = _slide_pool[tiff_path]
            return e["slide"], e["lock"]
 
        while len(_slide_pool) >= _SLIDE_POOL_MAX:
            _, oldest = _slide_pool.popitem(last=False)
            try: oldest["slide"].close()
            except Exception: pass
 
        slide = tiffslide.TiffSlide(tiff_path)
        entry = {"slide": slide, "lock": threading.Lock()}
        _slide_pool[tiff_path] = entry
        return slide, entry["lock"]
 
 
# ── result.json cache ─────────────────────────────────────────────────────────
_result_cache: "OrderedDict[int, dict]" = OrderedDict()
_RESULT_MAX = 64
_result_cache_lock = threading.Lock()
 
def _get_result_data(job_id: int) -> dict:
    with _result_cache_lock:
        if job_id in _result_cache:
            _result_cache.move_to_end(job_id)
            return _result_cache[job_id]
 
    result_file = _job_result_dir(job_id) / "result.json"
    if not result_file.exists():
        raise HTTPException(status_code=404, detail="result.json not found")
    try:
        data = json.loads(result_file.read_text(encoding="utf-8"))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to read result.json: {e}")
 
    with _result_cache_lock:
        _result_cache[job_id] = data
        _result_cache.move_to_end(job_id)
        while len(_result_cache) > _RESULT_MAX:
            _result_cache.popitem(last=False)
    return data
 
 
# ── Downsampled overlay cache (the OOM fix) ───────────────────────────────────
# For any overlay where a low-zoom tile would require an unsafe read_region,
# we serve from a pre-built downsampled PIL image instead of touching the TIFF.
# Built once per TIFF, then reused for every low-zoom tile request.
_downsampled_cache: "OrderedDict[str, Image.Image]" = OrderedDict()
_downsampled_lock = threading.Lock()
 
def _build_downsampled(slide: "tiffslide.TiffSlide", tiff_path: str) -> Image.Image:
    """
    Build an RGBA PIL Image of the whole overlay, downsampled so its longest
    side is ≤ DOWNSAMPLED_MAX_DIM. Safe for non-pyramidal TIFFs: reads in
    CHUNK_READ_DIM-sized chunks and downsamples each chunk before pasting.
    """
    w, h = slide.dimensions
    longest = max(w, h)
    if longest <= DOWNSAMPLED_MAX_DIM:
        # Small enough to load whole, but still subject to chunking if huge depth
        img = slide.read_region((0, 0), 0, (w, h)).convert("RGBA")
        return img
 
    # Find the smallest pyramid level that is still ≥ DOWNSAMPLED_MAX_DIM in
    # either dimension — reading from there minimises decode work.
    best_level = 0
    for lvl in range(slide.level_count):
        lw, lh = slide.level_dimensions[lvl]
        if max(lw, lh) >= DOWNSAMPLED_MAX_DIM:
            best_level = lvl
        else:
            break
    src_w, src_h = slide.level_dimensions[best_level]
    src_ds       = slide.level_downsamples[best_level]
 
    # Output dims
    scale_out = longest / DOWNSAMPLED_MAX_DIM
    out_w = max(1, int(w / scale_out))
    out_h = max(1, int(h / scale_out))
 
    out = Image.new("RGBA", (out_w, out_h), (0, 0, 0, 0))
 
    # Chunked read in the chosen level's coordinate space
    step = CHUNK_READ_DIM
    y_src = 0
    while y_src < src_h:
        x_src = 0
        ch = min(step, src_h - y_src)
        while x_src < src_w:
            cw = min(step, src_w - x_src)
 
            # Convert level-coords back to level-0 coords for read_region (its
            # location argument is always in level-0 pixels).
            lvl0_x = int(x_src * src_ds)
            lvl0_y = int(y_src * src_ds)
 
            chunk = slide.read_region((lvl0_x, lvl0_y), best_level, (cw, ch)).convert("RGBA")
 
            # Each chunk's size in OUTPUT coords
            chunk_out_w = max(1, int(cw * src_ds / scale_out))
            chunk_out_h = max(1, int(ch * src_ds / scale_out))
            small       = chunk.resize((chunk_out_w, chunk_out_h), Image.NEAREST)
 
            paste_x = int(lvl0_x / scale_out)
            paste_y = int(lvl0_y / scale_out)
            out.paste(small, (paste_x, paste_y))
 
            chunk.close(); small.close()
            x_src += step
        y_src += step
 
    log.info(
        f"[overlay_tile] Built downsampled cache for {tiff_path}: "
        f"src={w}x{h} levels={slide.level_count} "
        f"src_level={best_level}({src_w}x{src_h}) out={out_w}x{out_h}"
    )
    # Force a GC pass after building — release the chunk buffers immediately.
    gc.collect()
    return out
 
 
def _get_downsampled(tiff_path: str, slide: "tiffslide.TiffSlide", slide_lock) -> Image.Image:
    with _downsampled_lock:
        if tiff_path in _downsampled_cache:
            _downsampled_cache.move_to_end(tiff_path)
            return _downsampled_cache[tiff_path]
 
    # Build outside the cache lock so concurrent requests for OTHER overlays
    # aren't blocked.  Take the per-slide lock so we don't fight ourselves on
    # read_region.  A race here only causes a duplicate build, never corruption.
    with slide_lock:
        img = _build_downsampled(slide, tiff_path)
 
    with _downsampled_lock:
        _downsampled_cache[tiff_path] = img
        _downsampled_cache.move_to_end(tiff_path)
        while len(_downsampled_cache) > DOWNSAMPLED_CACHE_MAX:
            _, evicted = _downsampled_cache.popitem(last=False)
            try: evicted.close()
            except Exception: pass
    return img


# ─── Helpers ──────────────────────────────────────────────────────────────────

def _results_dir() -> Path:
    """Return the base results directory, creating it if needed."""
    d = Path(settings.analysis_results_dir)
    d.mkdir(parents=True, exist_ok=True)
    return d


def _models_dir() -> Path:
    return Path(settings.models_dir)


def _allowed_output_bases() -> List[Path]:
    """Configured absolute base directories under which batch output may live."""
    raw = getattr(settings, "analysis_output_base_dirs", "") or ""
    bases = []
    for part in raw.split(","):
        part = part.strip()
        if part:
            try:
                bases.append(Path(part).resolve())
            except Exception:
                continue
    return bases


def _is_within(path: Path, base: Path) -> bool:
    try:
        path.relative_to(base)
        return True
    except ValueError:
        return False


# System locations a batch job must never be allowed to write into / delete.
_FORBIDDEN_OUTPUT_ROOTS = (
    "/bin", "/boot", "/dev", "/etc", "/lib", "/lib64", "/proc",
    "/root", "/run", "/sbin", "/sys", "/usr", "/var",
)


def _convert_windows_unc_path(path_str: str) -> str:
    """Convert a Windows UNC resstore path to its HPC (Linux) equivalent.

    \\\\resstore.unibe.ch\\X\\Y  →  /storage/research/X/Y
    """
    normalized = path_str.replace("\\", "/")
    m = re.match(r"^//resstore\.unibe\.ch/(.+)", normalized, re.IGNORECASE)
    if m:
        return "/storage/research/" + m.group(1).rstrip("/")
    return normalized


def _validate_output_directory(output_directory: str) -> Path:
    """Resolve and authorize a user-supplied batch output directory.

    - When `analysis_output_base_dirs` is configured, the path must resolve
      inside one of those bases (recommended for production).
    - Otherwise, the path must be absolute and must not fall in a sensitive
      system location. This closes the worst case (creating/deleting arbitrary
      system directories) without forcing every deployment to pre-register its
      NFS research roots.
    """
    # Accept Windows-style UNC paths from Windows clients and convert them.
    output_directory = _convert_windows_unc_path(output_directory)
    candidate = Path(output_directory)
    if not candidate.is_absolute():
        raise HTTPException(status_code=400, detail="output_directory must be an absolute path")
    resolved = candidate.resolve()

    bases = _allowed_output_bases()
    if bases:
        if not any(_is_within(resolved, b) for b in bases):
            raise HTTPException(
                status_code=400,
                detail="output_directory is not within an allowed base directory",
            )
        return resolved

    # No allow-list configured — apply a system-path safety net.
    if resolved == Path(resolved.anchor):
        raise HTTPException(status_code=400, detail="output_directory cannot be the filesystem root")
    s = str(resolved)
    if any(s == root or s.startswith(root + "/") for root in _FORBIDDEN_OUTPUT_ROOTS):
        raise HTTPException(
            status_code=400,
            detail="output_directory points to a protected system location",
        )
    return resolved


def _is_deletable_output_dir(path: Path) -> bool:
    """Whether `path` may be rmtree'd during purge — mirrors submit-time policy."""
    safe_roots = [_results_dir().resolve()] + _allowed_output_bases()
    if any(_is_within(path, root) for root in safe_roots):
        return True
    if _allowed_output_bases():
        # Strict mode: only managed results dir or allow-listed bases.
        return False
    # Lenient mode: permit any non-system absolute path (dirs we accepted at submit).
    if path == Path(path.anchor):
        return False
    s = str(path)
    return not any(s == root or s.startswith(root + "/") for root in _FORBIDDEN_OUTPUT_ROOTS)


def _job_result_dir(job_id: int) -> Path:
    return _results_dir() / str(job_id)


def _load_catalog() -> list:
    """Load model catalog from catalog.json. Returns [] on any error."""
    catalog_path = _models_dir() / "catalog.json"
    if not catalog_path.exists():
        log.warning(f"Model catalog not found at {catalog_path}")
        return []
    try:
        return json.loads(catalog_path.read_text(encoding="utf-8"))
    except Exception as e:
        log.error(f"Failed to read catalog.json: {e}")
        return []


def _catalog_model(model_id: str) -> Optional[dict]:
    """Return a single model entry by id, or None."""
    return next((m for m in _load_catalog() if m["id"] == model_id), None)


def _slurm_state(slurm_job_id: int) -> Optional[str]:
    """
    Query SLURM for the state of a job.
    Returns the raw SLURM state string ('PENDING', 'RUNNING', 'COMPLETED',
    'FAILED', 'CANCELLED', etc.) or None if the job is no longer in the queue
    (finished and purged from squeue history).
    Returns 'UNAVAILABLE' if sbatch/squeue is not installed (local dev).
    """
    try:
        result = subprocess.run(
            ["squeue", "-j", str(slurm_job_id), "-h", "-o", "%T"],
            capture_output=True,
            text=True,
            timeout=8,
        )
        state = result.stdout.strip()
        return state if state else None
    except FileNotFoundError:
        return "UNAVAILABLE"
    except subprocess.TimeoutExpired:
        log.warning(f"squeue timed out for job {slurm_job_id}")
        return None
    except Exception as e:
        log.warning(f"squeue error for job {slurm_job_id}: {e}")
        return None


def _slurm_states_batch(slurm_job_ids: List[int]) -> tuple[dict, bool]:
    """
    Query SLURM for many jobs in a single squeue call.

    Returns (states, available) where:
      - states maps slurm_job_id -> raw state string for jobs still in the queue.
        IDs absent from the result are finished/purged (treat as None).
      - available is False when squeue could not be run (not installed, timeout,
        error). In that case callers must NOT infer completion from a missing id.
    """
    if not slurm_job_ids:
        return {}, True
    try:
        result = subprocess.run(
            ["squeue", "-j", ",".join(str(i) for i in slurm_job_ids),
             "-h", "-o", "%i %T"],
            capture_output=True,
            text=True,
            timeout=10,
        )
    except FileNotFoundError:
        return {}, False
    except subprocess.TimeoutExpired:
        log.warning("squeue batch query timed out")
        return {}, False
    except Exception as e:
        log.warning(f"squeue batch error: {e}")
        return {}, False

    states: dict = {}
    for line in result.stdout.strip().splitlines():
        parts = line.split()
        if len(parts) >= 2:
            try:
                states[int(parts[0])] = parts[1]
            except ValueError:
                pass
    return states, True


# Sentinel: tells _sync_job_status to fetch the SLURM state itself (single-job
# path). Distinct from None, which is a valid state meaning "not in the queue".
_FETCH_STATE = object()


def _read_progress(job_id: int) -> tuple[int, Optional[str]]:
    """
    Read progress.json written by the model script.
    Returns (pct: int, message: str | None).
    Expected format: {"pct": 38, "message": "Processing tiles..."}
    """
    progress_file = _job_result_dir(job_id) / "progress.json"
    try:
        data = json.loads(progress_file.read_text())
        pct = int(data.get("pct", 0))
        pct = max(0, min(100, pct))          # clamp to [0, 100]
        return pct, data.get("message")
    except Exception:
        return 0, None


def _try_resubmit_batch(job: AnalysisJob, db: Session, reason: str) -> bool:
    """
    Attempt to auto-resubmit a batch job that ended before completion (e.g. TIMEOUT).

    Increments retry_count in batch_context.json, calls sbatch, and updates the
    DB record in-place.  Returns True if the job was successfully resubmitted so
    that the caller can return early without marking it failed.
    """
    context_file = _job_result_dir(job.id) / "batch_context.json"
    if not context_file.exists():
        log.warning(f"Cannot auto-resubmit job {job.id}: batch_context.json missing")
        return False

    try:
        ctx = json.loads(context_file.read_text(encoding="utf-8"))
        retry_count = ctx.get("retry_count", 0)
        max_retries = ctx.get("max_retries", 3)

        if retry_count >= max_retries:
            log.info(f"Job {job.id}: max retries ({max_retries}) reached after {reason}")
            return False

        ctx["retry_count"] = retry_count + 1
        context_file.write_text(json.dumps(ctx), encoding="utf-8")

        model_script = _models_dir() / job.model_id / "run_batch.sh"
        if not model_script.exists():
            log.error(f"Cannot resubmit job {job.id}: {model_script} not found")
            return False

        log_file = _job_result_dir(job.id) / "slurm_%j.out"
        sbatch_cmd = [
            "sbatch", "--parsable",
            f"--job-name=pathodb_batch_{job.model_id}_{job.id}",
            f"--output={log_file}",
            "--export=NONE",
            str(model_script),
            str(context_file),
        ]

        result = subprocess.run(sbatch_cmd, capture_output=True, text=True, timeout=15)
        if result.returncode != 0:
            log.error(
                f"sbatch resubmit failed for job {job.id}: {result.stderr.strip()}"
            )
            return False

        new_slurm_id = int(result.stdout.strip().split(";")[0])
        job.slurm_job_id  = new_slurm_id
        job.status        = "running"
        job.error_message = (
            f"Auto-resubmitted after {reason} "
            f"(attempt {retry_count + 1}/{max_retries}, SLURM {new_slurm_id})"
        )
        job.updated_at = datetime.now(timezone.utc)
        db.commit()
        db.refresh(job)

        log.info(
            f"Auto-resubmitted job {job.id} after {reason}: "
            f"new SLURM {new_slurm_id} (retry {retry_count + 1}/{max_retries})"
        )
        return True

    except FileNotFoundError:
        log.warning("sbatch not found — cannot auto-resubmit (dev mode)")
        return False
    except Exception as e:
        log.error(f"Failed to auto-resubmit job {job.id}: {e}")
        return False


def _sync_job_status(job: AnalysisJob, db: Session, slurm_state=_FETCH_STATE) -> AnalysisJob:
    """
    Sync a job's status from SLURM and the progress file.
    Mutates and commits the DB record if anything changed.

    slurm_state may be supplied by a caller that already queried SLURM in bulk
    (see list_jobs). When left as the _FETCH_STATE sentinel, this function issues
    its own per-job squeue call (single-job polling path).
    """
    if job.status in ("done", "failed", "cancelled"):
        return job                           # terminal states — nothing to update

    changed = False

    # ── Progress from sidecar file ────────────────────────────────────────────
    if job.status == "running":
        pct, _ = _read_progress(job.id)
        if pct != job.progress:
            job.progress = pct
            changed = True

    # ── SLURM state ───────────────────────────────────────────────────────────
    if job.slurm_job_id:
        if slurm_state is _FETCH_STATE:
            slurm_state = _slurm_state(job.slurm_job_id)

        if slurm_state == "UNAVAILABLE":
            # Running locally without SLURM — leave status as-is
            pass

        elif slurm_state == "RUNNING":
            if job.status != "running":
                job.status   = "running"
                changed = True

        elif slurm_state in ("COMPLETED", None):
            result_file = _job_result_dir(job.id) / "result.json"
            is_batch = bool(job.params_json.get("is_batch"))
            file_ready = False
            result_error = None

            if is_batch:
                if result_file.exists():
                    try:
                        res_data = json.loads(result_file.read_text(encoding="utf-8"))
                        job_status_field = res_data.get("job_status")
                        if job_status_field == "complete":
                            file_ready = True
                        elif job_status_field == "failed":
                            result_error = res_data.get("error", "Batch job reported failure.")
                        elif slurm_state is None:
                            # Job vanished from SLURM but result is still "running" —
                            # most likely a timeout that was purged before we polled.
                            if _try_resubmit_batch(job, db, "TIMEOUT"):
                                return job
                            result_error = "Job ended before completion (possible timeout)."
                    except Exception:
                        result_error = "Failed to parse result.json."
                elif slurm_state is None:
                    # No result file at all and job gone — treat as lost
                    result_error = "Job is no longer tracked by SLURM and produced no result."
            else:
                file_ready = result_file.exists()

            if file_ready:
                job.status      = "done"
                job.progress    = 100
                job.result_path = str(_job_result_dir(job.id))
                changed = True
            elif result_error:
                job.status        = "failed"
                job.error_message = result_error
                changed = True
            elif slurm_state == "COMPLETED":
                job.status        = "failed"
                job.error_message = "SLURM job completed but no valid result was produced."
                changed = True
            elif slurm_state is None:
                job.status        = "failed"
                job.error_message = "Job is no longer tracked by SLURM and no valid result was produced."
                changed = True

        elif slurm_state in ("TIMEOUT", "NODE_FAIL"):
            # For batch jobs try to resume; for single-slide jobs, mark failed.
            if bool(job.params_json.get("is_batch")) and _try_resubmit_batch(job, db, slurm_state):
                return job
            job.status        = "failed"
            job.error_message = f"SLURM job ended with state: {slurm_state}"
            changed = True

        elif slurm_state in ("FAILED", "OUT_OF_MEMORY"):
            job.status        = "failed"
            job.error_message = f"SLURM job ended with state: {slurm_state}"
            changed = True

        elif slurm_state in ("CANCELLED", "REVOKED"):
            job.status = "cancelled"
            changed = True

        # PENDING — no change needed (still queued)

    if changed:
        job.updated_at = datetime.now(timezone.utc)
        db.commit()
        db.refresh(job)

    return job


def _get_job_or_404(job_id: int, db: Session, user: User) -> AnalysisJob:
    job = db.get(AnalysisJob, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Analysis job not found")
    # Researchers can only see their own jobs; admins see all
    if user.role != "admin" and job.submitted_by != user.id:
        raise HTTPException(status_code=403, detail="Not your job")
    return job


# ─── Endpoints ────────────────────────────────────────────────────────────────

@router.get("/jobs/{job_id}/tiles/{file_key}")
def get_overlay_tile(
    job_id:   int,
    file_key: str,
    level:    int,
    x:        int,
    y:        int,
    token:    str          = Query(...),
    scan_id:  Optional[int] = Query(None, description="For batch results: scan_id to look up"),
    db:       Session      = Depends(get_db),
    payload:  dict         = Depends(_auth_token),
):
    """
    Serve a 256×256 PNG tile of an OME-TIFF segmentation overlay.

    Memory guarantees
    -----------------
      • read_region is never called with dimensions > MAX_READ_DIM.
        If the requested zoom would need a larger read, the tile is cropped
        from a pre-built, downsampled in-memory image instead.
      • Concurrent read_region calls are bounded by MAX_CONCURRENT_READS.
      • TiffSlide handles are pooled (max _SLIDE_POOL_MAX); never leaked.
      • Encoded tiles and the downsampled image are LRU-cached.
      • result.json is cached per job.
    """
    user_id = int(payload.get("sub"))
    user    = db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=401, detail="User not found")

    job = _get_job_or_404(job_id, db, user)
    if job.status != "done":
        raise HTTPException(status_code=409, detail=f"Job is not done yet (status: {job.status})")

    # Tile cache hit
    cache_key = _otile_key(job_id, file_key, level, x, y)
    cached    = _otile_get(cache_key)
    if cached:
        return Response(content=cached, media_type="image/png",
                        headers={"Cache-Control": "public, max-age=3600", "X-Cache": "HIT"})

    # Resolve TIFF path — supports both single-slide and batch result structures
    result_data = _get_result_data(job_id)
    if scan_id is not None and "scans" in result_data:
        scan_entry = next((s for s in result_data["scans"] if s.get("scan_id") == scan_id), None)
        tiff_path = scan_entry.get("files", {}).get(file_key) if scan_entry else None
    else:
        tiff_path = result_data.get("files", {}).get(file_key)
    if not tiff_path or not os.path.exists(tiff_path):
        raise HTTPException(status_code=404, detail="Overlay TIFF not found on disk")
 
    try:
        slide, slide_lock = _get_pooled_slide(tiff_path)
    except Exception as e:
        log.error(f"[overlay_tile] Failed to open {tiff_path}: {e}")
        raise HTTPException(status_code=500, detail=f"Cannot open overlay TIFF: {e}")
 
    tile_size = 256
    try:
        w, h          = slide.dimensions
        max_osd_level = math.ceil(math.log2(max(w, h)))
        scale         = 2 ** (max_osd_level - level)
 
        x0 = int(x * tile_size * scale)
        y0 = int(y * tile_size * scale)
 
        # Out of bounds → transparent tile (do not cache to keep tile cache tight)
        if x0 >= w or y0 >= h:
            img = Image.new("RGBA", (tile_size, tile_size), (0, 0, 0, 0))
            buf = io.BytesIO()
            img.save(buf, format="PNG", compress_level=1)
            img.close()
            return Response(content=buf.getvalue(), media_type="image/png")
 
        best_level = slide.get_best_level_for_downsample(scale)
        best_ds    = slide.level_downsamples[best_level]
        read_w     = max(1, math.ceil(tile_size * scale / best_ds))
        read_h     = max(1, math.ceil(tile_size * scale / best_ds))
 
        # ── DEFENSIVE BRANCH ──────────────────────────────────────────────────
        # If the read would exceed our safety cap, serve from the downsampled
        # cache.  This is the case that was OOM-killing the API on non- or
        # under-pyramidal overlay TIFFs.
        if read_w > MAX_READ_DIM or read_h > MAX_READ_DIM:
            log.debug(
                f"[overlay_tile] level={level} → read {read_w}x{read_h} > "
                f"{MAX_READ_DIM}; serving from downsampled cache."
            )
            downsampled = _get_downsampled(tiff_path, slide, slide_lock)
            dw, dh = downsampled.size
 
            # Map tile bounds from full-res to downsampled coords
            sx = dw / w
            sy = dh / h
            cx0 = int(x0 * sx)
            cy0 = int(y0 * sy)
            cx1 = min(dw, max(cx0 + 1, int((x0 + tile_size * scale) * sx)))
            cy1 = min(dh, max(cy0 + 1, int((y0 + tile_size * scale) * sy)))
            region = downsampled.crop((cx0, cy0, cx1, cy1))
 
        else:
            # Safe path: read from the TIFF directly, under semaphore + slide lock.
            with _read_semaphore:
                with slide_lock:
                    region = slide.read_region((x0, y0), best_level, (read_w, read_h))
 
        region = region.convert("RGBA")
        if region.size != (tile_size, tile_size):
            region = region.resize((tile_size, tile_size), Image.NEAREST)
 
        buf = io.BytesIO()
        # compress_level=1 is much faster and uses less CPU/memory than the
        # default 6; for tiles served at low cache-hit rate this matters.
        region.save(buf, format="PNG", compress_level=1)
        tile_bytes = buf.getvalue()
        region.close()
        del region
 
    except Exception as e:
        log.error(f"[overlay_tile] Failed job={job_id} level={level} x={x} y={y}: {e}")
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))
 
    _otile_set(cache_key, tile_bytes)
    return Response(content=tile_bytes, media_type="image/png",
                    headers={"Cache-Control": "public, max-age=3600", "X-Cache": "MISS"})


@router.post("/jobs/{job_id}/cache/invalidate", status_code=204)
def invalidate_overlay_cache(
    job_id: int,
    db:     Session = Depends(get_db),
    user:   User    = Depends(get_current_active_user),
):
    """Flush server-side caches for a specific job (admin only)."""
    if user.role != "admin":
        raise HTTPException(status_code=403, detail="Admin only")
 
    with _result_cache_lock:
        _result_cache.pop(job_id, None)
 
    with _overlay_tile_lock:
        stale = [k for k in list(_overlay_tile_cache) if k.startswith(f"{job_id}/")]
        for k in stale:
            _overlay_tile_cache.pop(k, None)
 
    log.info(f"[cache] Invalidated {len(stale)} tiles + result for job {job_id}")


@router.delete("/jobs/{job_id}", status_code=204)
def cancel_or_delete_job(
    job_id: int,
    purge:  bool    = Query(False, description="If true, delete the job from DB and remove all files"),
    db:     Session = Depends(get_db),
    user:   User    = Depends(get_current_active_user),
):
    """
    Cancel a queued or running job via scancel.
    If purge=True, also delete the database record and delete the result directory on disk.
    """
    job = _get_job_or_404(job_id, db, user)

    # Always attempt to scancel if the job is active
    if job.status not in ("done", "failed", "cancelled") and job.slurm_job_id:
        try:
            subprocess.run(
                ["scancel", str(job.slurm_job_id)],
                capture_output=True,
                timeout=8,
            )
        except FileNotFoundError:
            pass        # scancel not available locally — proceed anyway
        except Exception as e:
            log.warning(f"scancel error for job {job_id}: {e}")

    # If the user just wants to cancel, update status and return
    if not purge:
        if job.status not in ("done", "failed", "cancelled"):
            job.status     = "cancelled"
            job.updated_at = datetime.now(timezone.utc)
            db.commit()
        return None

    # If purge=True, we destroy the data completely
    if purge:
        result_dir = _job_result_dir(job_id)
        
        # Check if it's a batch job and has a custom output dir
        context_file = result_dir / "batch_context.json"
        if context_file.exists():
            try:
                ctx = json.loads(context_file.read_text())
                raw_out = ctx.get("output_dir", "")
                custom_out_dir = Path(raw_out).resolve() if raw_out else None
                # Never rmtree an arbitrary path read from the context file.
                if custom_out_dir is not None and _is_deletable_output_dir(custom_out_dir):
                    if custom_out_dir.exists() and custom_out_dir.is_dir():
                        shutil.rmtree(custom_out_dir)
                        log.info(f"Deleted custom batch output at {custom_out_dir}")
                elif custom_out_dir is not None:
                    log.warning(
                        f"Refusing to delete out-of-policy output dir for job "
                        f"{job_id}: {custom_out_dir}"
                    )
            except Exception as e:
                log.error(f"Failed to read context or delete custom output for job {job_id}: {e}")

        # Delete standard tracking files
        if result_dir.exists() and result_dir.is_dir():
            try:
                shutil.rmtree(result_dir)
                log.info(f"Deleted files for job {job_id} at {result_dir}")
            except Exception as e:
                log.error(f"Failed to delete directory {result_dir} for job {job_id}: {e}")
                raise HTTPException(status_code=500, detail="Failed to delete files on disk")

        db.delete(job)
        db.commit()
    
    return None

@router.get("/models")
def list_models(
    _: User = Depends(get_current_active_user),
):
    """
    Return the full model catalog. The catalog is read from
    {models_dir}/catalog.json on every request so changes take effect
    without restarting the API.
    """
    catalog = _load_catalog()
    return {"models": catalog, "count": len(catalog)}


@router.post("/jobs", response_model=AnalysisJobResponse, status_code=201)
def submit_job(
    req:  AnalysisRunRequest,
    scan_id: int = Query(..., description="ID of the scan to analyse"),
    db:   Session = Depends(get_db),
    user: User    = Depends(get_current_active_user),
):
    """
    Submit a new inference job for a scan.
    Validates the scan exists, looks up the model in the catalog, creates a
    DB record, then calls sbatch and stores the returned SLURM job ID.
    """
    # ── Validate scan ─────────────────────────────────────────────────────────
    scan = db.get(Scan, scan_id)
    if not scan:
        raise HTTPException(status_code=404, detail="Scan not found")
    if not scan.file_path:
        raise HTTPException(status_code=422, detail="Scan has no file path")

    # ── Validate model ────────────────────────────────────────────────────────
    model = _catalog_model(req.model_id)
    if not model:
        raise HTTPException(
            status_code=422,
            detail=f"Model '{req.model_id}' not found in catalog",
        )

    # ── Validate scope / ROI ──────────────────────────────────────────────────
    valid_scopes = {"whole_slide", "visible_region", "roi"}
    if req.scope not in valid_scopes:
        raise HTTPException(
            status_code=422,
            detail=f"scope must be one of: {sorted(valid_scopes)}",
        )
    if req.scope == "roi" and not req.roi_json:
        raise HTTPException(
            status_code=422,
            detail="roi_json is required when scope='roi'",
        )

    # ── Create DB record (queued) ─────────────────────────────────────────────
    job = AnalysisJob(
        scan_id      = scan_id,
        model_id     = req.model_id,
        status       = "queued",
        scope        = req.scope,
        params_json  = req.params,
        roi_json     = req.roi_json,
        submitted_by = user.id,
    )
    db.add(job)
    db.commit()
    db.refresh(job)

    # ── Prepare result directory ──────────────────────────────────────────────
    result_dir = _job_result_dir(job.id)
    result_dir.mkdir(parents=True, exist_ok=True)

    # ── Build sbatch command ──────────────────────────────────────────────────
    model_script = _models_dir() / req.model_id / "run.sh"
    if not model_script.exists():
        job.status        = "failed"
        job.error_message = f"Model script not found: {model_script}"
        job.updated_at    = datetime.now(timezone.utc)
        db.commit()
        raise HTTPException(
            status_code=500,
            detail=f"Model script missing: {model_script}",
        )

    # 1. NEW: Extract the ROI dict and save it as a separate file
    roi_file_path = None
    if req.roi_json:
        roi_file = result_dir / "roi.json"
        roi_file.write_text(json.dumps(req.roi_json), encoding="utf-8")
        roi_file_path = str(roi_file)

    # 2. Write the context file (now referencing the path, not the dict)
    context_file = result_dir / "job_context.json"
    context_data = {
        "job_id": job.id,
        "scan_id": scan_id,
        "scan_path": scan.file_path,
        "result_dir": str(result_dir),
        "scope": req.scope,
        "params": req.params,
        "roi": roi_file_path 

    }
    context_file.write_text(json.dumps(context_data), encoding="utf-8")

    # 3. Submit the job (Isolated Conda + Pass the file path)
    log_file = result_dir / "slurm_%j.out"
    sbatch_cmd = [
        "sbatch",
        "--parsable",
        f"--job-name=pathodb_{req.model_id}_{job.id}",
        f"--output={log_file}",
        "--export=NONE",       # Keep environment clean
        str(model_script),
        str(context_file)      # Passed as $1 to run.sh
    ]

    # ── Submit ────────────────────────────────────────────────────────────────
    try:
        result = subprocess.run(
            sbatch_cmd,
            capture_output=True,
            text=True,
            timeout=15)

        if result.returncode != 0:
            err = result.stderr.strip() or "sbatch returned non-zero exit code"
            log.error(f"sbatch failed for job {job.id}: {err}")
            job.status        = "failed"
            job.error_message = f"sbatch error: {err}"
            job.updated_at    = datetime.now(timezone.utc)
            db.commit()
            raise HTTPException(status_code=500, detail=f"sbatch failed: {err}")

        # --parsable output: "12345" or "12345;cluster_name"
        slurm_id_str  = result.stdout.strip().split(";")[0]
        job.slurm_job_id = int(slurm_id_str)
        job.updated_at   = datetime.now(timezone.utc)
        db.commit()
        db.refresh(job)
        log.info(f"Submitted SLURM job {job.slurm_job_id} for analysis job {job.id}")

    except FileNotFoundError:
        # sbatch not installed — running locally / in Docker
        log.warning(f"sbatch not found — analysis job {job.id} left as 'queued' (dev mode)")

    except subprocess.TimeoutExpired:
        job.status        = "failed"
        job.error_message = "sbatch timed out"
        job.updated_at    = datetime.now(timezone.utc)
        db.commit()
        raise HTTPException(status_code=500, detail="sbatch timed out")

    db.refresh(job)
    return job


@router.get("/jobs", response_model=List[AnalysisJobResponse])
def list_jobs(
    scan_id: Optional[int] = Query(None, description="Filter jobs by scan ID"),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_active_user),
):
    """
    Return analysis jobs, most recent first. 
    If scan_id is provided, filters by that WSI. Otherwise, returns all jobs.
    Researchers see only their own jobs; admins see all.
    """
    q = db.query(AnalysisJob)
    
    if scan_id is not None:
        q = q.filter(AnalysisJob.scan_id == scan_id)
        
    if user.role != "admin":
        q = q.filter(AnalysisJob.submitted_by == user.id)
        
    jobs = q.order_by(AnalysisJob.created_at.desc()).all()

    # Sync status for any non-terminal jobs. SLURM is queried ONCE for all jobs
    # rather than spawning a squeue subprocess per job.
    non_terminal = [j for j in jobs if j.status not in ("done", "failed", "cancelled")]
    slurm_ids    = [j.slurm_job_id for j in non_terminal if j.slurm_job_id]
    states, available = _slurm_states_batch(slurm_ids)

    for job in non_terminal:
        if job.slurm_job_id and available:
            # None here means "not in the queue" → finished/purged.
            _sync_job_status(job, db, slurm_state=states.get(job.slurm_job_id))
        else:
            # No SLURM id (dev mode) or squeue unavailable → don't infer
            # completion; only refresh the progress sidecar.
            _sync_job_status(job, db, slurm_state="UNAVAILABLE")

    return jobs


@router.get("/jobs/{job_id}", response_model=AnalysisJobResponse)
def get_job(
    job_id: int,
    db:     Session = Depends(get_db),
    user:   User    = Depends(get_current_active_user),
):
    """
    Return a single analysis job, syncing its status from SLURM first.
    This is the primary polling endpoint for the frontend.
    """
    job = _get_job_or_404(job_id, db, user)
    job = _sync_job_status(job, db)
    return job


@router.get("/jobs/{job_id}/result")
def get_job_result(
    job_id: int,
    db:     Session = Depends(get_db),
    user:   User    = Depends(get_current_active_user),
):
    """
    Serve the JSON result produced by the model.
    Allows fetching while 'running' for live batch tracking.
    """
    job = _get_job_or_404(job_id, db, user)

    # 1. ALLOW 'running' state
    if job.status not in ("done", "running"):
        raise HTTPException(
            status_code=409,
            detail=f"Job is not active yet (status: {job.status})",
        )

    result_file = _job_result_dir(job_id) / "result.json"
    if not result_file.exists():
        # 2. If it's running but hasn't written the file yet, return an empty scans list
        if job.status == "running":
            return JSONResponse(content={"scans": []})
            
        raise HTTPException(
            status_code=404,
            detail="Result file not found on disk",
        )

    try:
        data = json.loads(result_file.read_text(encoding="utf-8"))
    except Exception as e:
        log.error(f"Failed to read result.json for job {job_id}: {e}")
        raise HTTPException(status_code=500, detail="Failed to read result file")

    return JSONResponse(content=data)

@router.get("/jobs/{job_id}/overlay")
def get_job_overlay(
    job_id:  int,
    file:    str          = Query(..., description="file_key in result.json"),
    scan_id: Optional[int] = Query(None, description="For batch results: scan_id to look up"),
    db:      Session      = Depends(get_db),
    user:    User         = Depends(get_current_active_user),
):
    """
    Serve a GeoJSON overlay file produced by the model.
    Reads the file path from result.json and streams the content.
    The browser cannot access NFS paths directly — this endpoint proxies it.
    Supports both single-slide (top-level files{}) and batch (scans[].files{}) structures.
    """
    job = _get_job_or_404(job_id, db, user)

    if job.status != "done":
        raise HTTPException(
            status_code=409,
            detail=f"Job is not done yet (status: {job.status})",
        )

    result_file = _job_result_dir(job_id) / "result.json"
    if not result_file.exists():
        raise HTTPException(status_code=404, detail="result.json not found")

    try:
        result_data = json.loads(result_file.read_text(encoding="utf-8"))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to read result.json: {e}")

    # Resolve files dict — batch results use scans[].files, single-slide uses top-level files
    if scan_id is not None and "scans" in result_data:
        scan_entry = next((s for s in result_data["scans"] if s.get("scan_id") == scan_id), None)
        files = scan_entry.get("files", {}) if scan_entry else {}
    else:
        files = result_data.get("files", {})

    geojson_path = files.get(file)

    if not geojson_path:
        raise HTTPException(
            status_code=404,
            detail=f"No entry for '{file}' in result.json. Available: {list(files.keys())}",
        )

    geojson_file = Path(geojson_path)
    if not geojson_file.exists():
        raise HTTPException(
            status_code=404,
            detail=f"GeoJSON file not found on disk: {geojson_path}",
        )

    try:
        data = json.loads(geojson_file.read_text(encoding="utf-8"))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to read GeoJSON: {e}")

    return JSONResponse(content=data)




@router.get("/jobs/{job_id}/download")
def download_job_file(
    job_id: int,
    file_key: str = Query("download_file", description="Key in the result.json files dict"),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_active_user),
):
    """
    Serve a downloadable file produced by the model inference.
    """
    job = _get_job_or_404(job_id, db, user)

    if job.status != "done":
        raise HTTPException(
            status_code=409,
            detail=f"Job is not done yet (status: {job.status})",
        )

    result_file = _job_result_dir(job_id) / "result.json"
    if not result_file.exists():
        raise HTTPException(status_code=404, detail="result.json not found")

    try:
        result_data = json.loads(result_file.read_text(encoding="utf-8"))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to read result.json: {e}")

    files = result_data.get("files", {})
    file_path = files.get(file_key)

    if not file_path or not os.path.exists(file_path):
        raise HTTPException(
            status_code=404,
            detail=f"Downloadable file '{file_key}' not found on disk.",
        )

    filename = os.path.basename(file_path)
    return FileResponse(
        path=file_path, 
        filename=filename, 
        media_type="application/octet-stream"
    )


class BatchAnalysisRequest(BaseModel):
    model_id: str
    output_directory: Optional[str] = None
    scan_ids: List[int]
    params: dict = {}

@router.post("/batch", response_model=AnalysisJobResponse, status_code=201)
def submit_batch_job(
    req: BatchAnalysisRequest,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_active_user),
):
    if not req.scan_ids:
        raise HTTPException(status_code=422, detail="No valid scan IDs provided.")
        
    model = _catalog_model(req.model_id)
    if not model:
        raise HTTPException(status_code=422, detail=f"Model '{req.model_id}' not found.")

    # 1. SECURITY VALIDATION: Ensure user has permission to ingest into this project
    project_id = req.params.get("project_id")
    if project_id:
        from ..models import Project, ProjectShare # Ensure imported
        project = db.get(Project, int(project_id))
        
        if not project:
            raise HTTPException(status_code=404, detail="Target project not found.")
            
        # User must be the owner, an admin, or have 'edit' access via a share
        if project.owner_id != user.id and user.role != "admin":
            share = db.query(ProjectShare).filter_by(
                project_id=project.id, 
                shared_with_user_id=user.id, 
                access_level="edit"
            ).first()
            if not share:
                raise HTTPException(status_code=403, detail="Not authorized to auto-ingest into this project.")

    # 2. CONTEXT & DIRECTORY ROUTING
    req.params["is_batch"] = True

    # Treat empty string "" (from UI) and None exactly the same
    is_auto_ingest = not bool(req.output_directory)

    validated_out_base = None
    if not is_auto_ingest:
        # Authorize the user-supplied output directory before creating any job.
        validated_out_base = _validate_output_directory(req.output_directory)
        req.params["output_directory"] = str(validated_out_base)
    else:
        req.params["auto_ingest"] = True

    job = AnalysisJob(
        scan_id=req.scan_ids[0],
        model_id=req.model_id,
        status="queued",
        scope="whole_slide", 
        params_json=req.params,
        submitted_by=user.id,
    )
    db.add(job)
    db.commit()
    db.refresh(job)

    # API Tracking Directory (Metadata)
    result_dir = _job_result_dir(job.id)
    result_dir.mkdir(parents=True, exist_ok=True)

    if not is_auto_ingest:
        custom_out_dir = validated_out_base / f"batch_job_{job.id}"
        try:
            custom_out_dir.mkdir(parents=True, exist_ok=True)
        except Exception as e:
            job.status = "failed"
            job.error_message = f"Failed to create output directory: {e}"
            db.commit()
            raise HTTPException(status_code=500, detail=f"Invalid output directory: {e}")
    else:
        # Keep everything in the internal tracking directory for UI jobs
        custom_out_dir = result_dir

    model_script = _models_dir() / req.model_id / "run_batch.sh"
    if not model_script.exists():
        job.status = "failed"
        job.error_message = f"Model script not found: {model_script}"
        db.commit()
        raise HTTPException(status_code=500, detail="Batch script missing")

    scans = db.query(Scan).filter(Scan.id.in_(req.scan_ids)).all()
    target_files = [{"scan_id": s.id, "file_path": s.file_path} for s in scans]

    # 3. WRITE THE CONTEXT FILE (Watcher needs this to map classes & get project_id!)
    context_file = result_dir / "batch_context.json"
    context_data = {
        "job_id": job.id,
        "result_dir": str(result_dir),
        "output_dir": str(custom_out_dir),
        "params": req.params,
        "targets": target_files,
        "db_host": socket.gethostname(),
        "retry_count": 0,
        "max_retries": 3,
    }
    context_file.write_text(json.dumps(context_data), encoding="utf-8")

    # 4. SUBMIT GPU MODEL INFERENCE JOB
    log_file = result_dir / "slurm_%j.out"
    sbatch_cmd_gpu = [
        "sbatch", "--parsable",
        f"--job-name=pathodb_batch_{req.model_id}_{job.id}",
        f"--output={log_file}", "--export=NONE",
        str(model_script), 
        str(context_file)
    ]

    try:
        # Launch GPU script
        result = subprocess.run(sbatch_cmd_gpu, capture_output=True, text=True, timeout=15)
        if result.returncode != 0:
            raise Exception(result.stderr.strip() or "sbatch returned non-zero exit code")

        job.slurm_job_id = int(result.stdout.strip().split(";")[0])
        
        # 5. CONDITIONALLY SUBMIT CPU WATCHER JOB
        if is_auto_ingest:
            # Note: Adjust this path depending on exactly where you saved run_watcher.sh!
            watcher_sh = Path(__file__).resolve().parents[1] / "workers" / "run_watcher.sh"
            watcher_log = result_dir / "watcher_%j.out"
            
            # Watcher takes 2 arguments: The Directory to watch, and the Context file (for class mappings)
            sbatch_cmd_cpu = [
                "sbatch", "--parsable",
                f"--job-name=pathodb_watcher_{job.id}",
                f"--output={watcher_log}",
                str(watcher_sh),
                str(custom_out_dir),  
                str(context_file)     
            ]
            subprocess.run(sbatch_cmd_cpu, capture_output=True, text=True, timeout=15)
            log.info(f"Auto-ingest requested. Submitted CPU Watcher job for analysis job {job.id}")

        job.updated_at = datetime.now(timezone.utc)
        db.commit()

    except FileNotFoundError:
        log.warning(f"sbatch not found — dev mode for job {job.id}")
    except Exception as e:
        job.status = "failed"
        job.error_message = str(e)
        job.updated_at = datetime.now(timezone.utc)
        db.commit()
        raise HTTPException(status_code=500, detail=str(e))

    db.refresh(job)
    return job

@router.get("/jobs/{job_id}/live-state")
def get_job_live_state(
    job_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_active_user),
):
    """Lightweight endpoint for frontend polling of active SLURM jobs."""
    job = _get_job_or_404(job_id, db, user)
    
    progress_file = _job_result_dir(job_id) / "progress.json"
    
    # Default state if worker hasn't created the file yet
    if not progress_file.exists():
        return {"pct": job.progress, "message": "Queued on cluster...", "slides": {}}
        
    try:
        data = json.loads(progress_file.read_text(encoding="utf-8"))
        return data
    except json.JSONDecodeError:
        # Fallback in case of an extreme race condition, prevents 500 errors
        return {"pct": job.progress, "message": "Updating...", "slides": {}}