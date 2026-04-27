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

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from fastapi.responses import JSONResponse
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

# ─── Helpers ──────────────────────────────────────────────────────────────────

def _results_dir() -> Path:
    """Return the base results directory, creating it if needed."""
    d = Path(settings.analysis_results_dir)
    d.mkdir(parents=True, exist_ok=True)
    return d


def _models_dir() -> Path:
    return Path(settings.models_dir)


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


def _sync_job_status(job: AnalysisJob, db: Session) -> AnalysisJob:
    """
    Sync a job's status from SLURM and the progress file.
    Mutates and commits the DB record if anything changed.
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
        slurm_state = _slurm_state(job.slurm_job_id)

        if slurm_state == "UNAVAILABLE":
            # Running locally without SLURM — leave status as-is
            pass

        elif slurm_state == "RUNNING":
            if job.status != "running":
                job.status   = "running"
                changed = True

        elif slurm_state in ("COMPLETED", None):
            # COMPLETED or purged from squeue — check if result file exists
            result_file = _job_result_dir(job.id) / "result.json"
            if result_file.exists():
                job.status      = "done"
                job.progress    = 100
                job.result_path = str(_job_result_dir(job.id))
                changed = True
            elif slurm_state == "COMPLETED":
                # SLURM says done but no result — mark failed
                job.status        = "failed"
                job.error_message = "SLURM job completed but no result.json was produced."
                changed = True
            # else: None (purged) and no result yet — still running, wait

        elif slurm_state in ("FAILED", "TIMEOUT", "NODE_FAIL", "OUT_OF_MEMORY"):
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
    job_id: int, 
    file_key: str, 
    level: int, 
    x: int, 
    y: int,
    token: str = Query(...),                   # 1. Accept token from the URL
    db: Session = Depends(get_db),
    payload: dict = Depends(_auth_token),      # 2. Verify it just like slides.py does!
):
    """
    Streams a single 256x256 PNG tile from the OME-TIFF mask to OpenSeadragon.
    """
    # 3. Build the User object from the verified token payload
    user_id = int(payload.get("sub"))
    user = db.get(User, user_id)
    if not user:
        raise HTTPException(status_code=401, detail="User not found")

    # 4. Securely fetch the job (this requires the user object we just built)
    job = _get_job_or_404(job_id, db, user)

    if job.status != "done":
        raise HTTPException(status_code=409, detail=f"Job is not done yet (status: {job.status})")

    result_file = _job_result_dir(job_id) / "result.json"
    if not result_file.exists():
        raise HTTPException(status_code=404, detail="result.json not found")

    try:
        result_data = json.loads(result_file.read_text(encoding="utf-8"))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to read result.json: {e}")

    # 5. Get the TIFF path from the manifest
    tiff_path = result_data.get("files", {}).get(file_key)
    
    if not tiff_path or not os.path.exists(tiff_path):
        raise HTTPException(status_code=404, detail="Overlay TIFF not found on disk")

    try:
        slide = tiffslide.TiffSlide(tiff_path)
        w, h = slide.dimensions
        
        max_osd_level = math.ceil(math.log2(max(w, h)))
        
        # 1. Calculate the exact scale OSD is requesting (even if it's < 1 for high zoom)
        scale = 2 ** (max_osd_level - level)
        
        tile_size = 256
        
        # Calculate the absolute Level 0 coordinates for this tile
        tx = x * tile_size
        ty = y * tile_size
        x0 = int(tx * scale)
        y0 = int(ty * scale)

        # Prevent reading outside the image bounds
        if x0 >= w or y0 >= h:
            # Return an empty, fully transparent PNG
            img = Image.new('RGBA', (256, 256), (0,0,0,0))
            buf = io.BytesIO()
            img.save(buf, format="PNG")
            return Response(content=buf.getvalue(), media_type="image/png")

        # 2. Find the closest available level in the TIFF
        best_level = slide.get_best_level_for_downsample(scale)
        best_ds    = slide.level_downsamples[best_level]

        # 3. CRITICAL FIX: Calculate exactly how many pixels to read from that level
        read_w = max(1, math.ceil(tile_size * scale / best_ds))
        read_h = max(1, math.ceil(tile_size * scale / best_ds))

        # Read the region and ensure it has an Alpha channel for transparency
        region = slide.read_region((x0, y0), best_level, (read_w, read_h))
        region = region.convert("RGBA")

        # 4. Resize the fetched region to perfectly fit OSD's 256x256 expectation
        if region.size != (tile_size, tile_size):
            # MUST use NEAREST to prevent blending colors/transparency at the edges
            region = region.resize((tile_size, tile_size), Image.NEAREST)

        buf = io.BytesIO()
        region.save(buf, format="PNG")
        
        return Response(content=buf.getvalue(), media_type="image/png")

    except Exception as e:
        traceback.print_exc()  
        raise HTTPException(status_code=500, detail=str(e))
    

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
    # 1. Delete physical files
    result_dir = _job_result_dir(job_id)
    if result_dir.exists() and result_dir.is_dir():
        try:
            shutil.rmtree(result_dir)
            log.info(f"Deleted files for job {job_id} at {result_dir}")
        except Exception as e:
            log.error(f"Failed to delete directory {result_dir} for job {job_id}: {e}")
            raise HTTPException(status_code=500, detail="Failed to delete files on disk")

    # 2. Delete database record
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

    log_file = result_dir / "slurm_%j.out"
    
    # 1. Copy the current environment so sbatch has standard paths
    # 1. Write everything into a clean JSON file
    context_file = result_dir / "job_context.json"
    context_data = {
        "job_id": job.id,
        "scan_id": scan_id,
        "scan_path": scan.file_path,
        "result_dir": str(result_dir),
        "scope": req.scope,
        "params": req.params,
        "roi": req.roi_json
    }
    context_file.write_text(json.dumps(context_data), encoding="utf-8")

    # 2. Submit the job (Isolated Conda + Pass the file path)
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
    scan_id: int    = Query(..., description="Filter jobs by scan ID"),
    db:      Session = Depends(get_db),
    user:    User    = Depends(get_current_active_user),
):
    """
    Return all analysis jobs for a given scan, most recent first.
    Researchers see only their own jobs; admins see all.
    Status is synced from SLURM on each call for non-terminal jobs.
    """
    q = db.query(AnalysisJob).filter(AnalysisJob.scan_id == scan_id)
    if user.role != "admin":
        q = q.filter(AnalysisJob.submitted_by == user.id)
    jobs = q.order_by(AnalysisJob.created_at.desc()).all()

    # Sync status for any non-terminal jobs
    for job in jobs:
        if job.status not in ("done", "failed", "cancelled"):
            _sync_job_status(job, db)

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


@router.delete("/jobs/{job_id}", status_code=204)
def cancel_job(
    job_id: int,
    db:     Session = Depends(get_db),
    user:   User    = Depends(get_current_active_user),
):
    """
    Cancel a queued or running job via scancel.
    Has no effect on already-terminal jobs.
    """
    job = _get_job_or_404(job_id, db, user)

    if job.status in ("done", "failed", "cancelled"):
        return None     # already terminal — 204 with no body

    if job.slurm_job_id:
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

    job.status     = "cancelled"
    job.updated_at = datetime.now(timezone.utc)
    db.commit()
    return None


@router.get("/jobs/{job_id}/result")
def get_job_result(
    job_id: int,
    db:     Session = Depends(get_db),
    user:   User    = Depends(get_current_active_user),
):
    """
    Serve the JSON result produced by the model.
    The model writes result.json to {analysis_results_dir}/{job_id}/result.json.
    Returns 404 if the job is not yet done or the file doesn't exist.
    """
    job = _get_job_or_404(job_id, db, user)

    if job.status != "done":
        raise HTTPException(
            status_code=409,
            detail=f"Job is not done yet (status: {job.status})",
        )

    result_file = _job_result_dir(job_id) / "result.json"
    if not result_file.exists():
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
    job_id: int,
    file:   str     = Query(..., description="'metastasis' or 'ln'"),
    db:     Session = Depends(get_db),
    user:   User    = Depends(get_current_active_user),
):
    """
    Serve a GeoJSON overlay file produced by the model.
    Reads the file path from result.json and streams the content.
    The browser cannot access NFS paths directly — this endpoint proxies it.
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
    key   = file
    geojson_path = files.get(key)

    if not geojson_path:
        raise HTTPException(
            status_code=404,
            detail=f"No entry for '{key}' in result.json. Available: {list(files.keys())}",
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