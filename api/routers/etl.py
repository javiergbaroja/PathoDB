"""
PathoDB API — ETL Router
=========================
Admin-only endpoints for triggering and monitoring data-import jobs.
Each job runs as a SLURM batch job on the HPC cluster.

Scans import has three modes (see submit_etl_job's `mode` param):
  - sync:    crawl a folder, match files to blocks, insert new scans.
  - preview: dry run — checks every existing scan's file_path against disk,
             deletes nothing. Reports missing scans split into "clean" (no
             other references — safe to delete) and "blocked" (referenced
             by a project, annotation, or analysis run — itemized for review).
  - commit:  applies a deletion plan built from a preview's results. Clean
             IDs get a final re-check before deleting; force IDs are deleted
             along with their dependent annotations/project links/analysis
             runs, per explicit admin selection.

Endpoints
---------
POST   /etl/jobs           — Upload CSV / specify folder / preview / commit
GET    /etl/jobs           — List all ETL jobs (newest first)
GET    /etl/jobs/{id}      — Single job detail with synced progress
DELETE /etl/jobs/{id}      — Cancel or purge a job
"""

import json
import logging
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from ..auth import require_admin
from ..config import get_settings
from ..database import get_db
from ..models import EtlJob, User

log = logging.getLogger("pathodb_etl_router")
settings = get_settings()

router = APIRouter(prefix="/etl", tags=["etl"])

# ── Paths ─────────────────────────────────────────────────────────────────────

VALID_JOB_TYPES = {"submissions", "blocks", "scans"}
ALLOWED_EXTENSIONS = {".csv", ".xlsx", ".xls", ".tsv"}
BROWSABLE_ROOT = Path("/storage/research")
SCAN_EXTENSIONS = {".svs", ".ndpi", ".mrxs"}  # no .tif/.tiff


def _etl_data_dir() -> Path:
    """Root directory for ETL job data (uploads, results, progress files)."""
    base = Path(settings.data_dir) / "etl_jobs" if hasattr(settings, "data_dir") else (
        Path(__file__).resolve().parents[2] / "data" / "etl_jobs"
    )
    base.mkdir(parents=True, exist_ok=True)
    return base


def _job_dir(job_id: int) -> Path:
    d = _etl_data_dir() / str(job_id)
    d.mkdir(parents=True, exist_ok=True)
    return d


def _etl_script() -> Path:
    return Path(__file__).resolve().parents[2] / "etl" / "run_etl.sh"


def _read_progress(job_id: int) -> dict:
    """Read the progress.json sidecar written by the ETL worker."""
    progress_file = _job_dir(job_id) / "progress.json"
    if progress_file.exists():
        try:
            return json.loads(progress_file.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            pass
    return {}


def _sync_etl_job(job: EtlJob, db: Session) -> EtlJob:
    """
    Sync job status from SLURM + progress sidecar.
    Same pattern as analysis router's _sync_job_status.
    """
    if job.status in ("done", "failed", "cancelled"):
        return job

    changed = False

    # ── Read progress sidecar ─────────────────────────────────────────────
    prog = _read_progress(job.id)
    if prog:
        new_pct = prog.get("percent", job.progress)
        if new_pct != job.progress:
            job.progress = new_pct
            changed = True

        # Worker writes status = "done" or "failed" when finished
        worker_status = prog.get("status")
        if worker_status in ("done", "failed"):
            job.status = worker_status
            job.summary_json = prog.get("stats")
            if worker_status == "failed":
                job.error_message = prog.get("error", "ETL worker reported failure")
            changed = True

    # ── Check SLURM state ─────────────────────────────────────────────────
    if job.slurm_job_id and job.status not in ("done", "failed", "cancelled"):
        try:
            result = subprocess.run(
                ["squeue", "-j", str(job.slurm_job_id), "-h", "-o", "%T"],
                capture_output=True, text=True, timeout=8,
            )
            state = result.stdout.strip().upper()

            if not state:
                # Job no longer in queue — check if progress says done
                if not prog.get("status"):
                    # SLURM finished but no progress file → likely failed
                    job.status = "failed"
                    job.error_message = job.error_message or "SLURM job completed without writing results"
                    changed = True
            elif state in ("RUNNING", "COMPLETING"):
                if job.status != "running":
                    job.status = "running"
                    changed = True
            elif state in ("PENDING", "CONFIGURING"):
                pass  # still queued
            elif state in ("FAILED", "NODE_FAIL", "TIMEOUT", "OUT_OF_MEMORY"):
                job.status = "failed"
                job.error_message = f"SLURM state: {state}"
                changed = True
            elif state in ("CANCELLED", "PREEMPTED"):
                job.status = "cancelled"
                changed = True

        except (FileNotFoundError, subprocess.TimeoutExpired):
            pass  # squeue unavailable — dev mode

    if changed:
        job.updated_at = datetime.now(timezone.utc)
        db.commit()
        db.refresh(job)

    return job


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.post("/jobs", status_code=201)
def submit_etl_job(
    job_type:        str            = Form(..., description="submissions | blocks | scans"),
    mode:            str            = Form("sync", description="For job_type='scans': 'sync' (crawl a folder) | 'preview' (dry-run check, no deletes) | 'commit' (apply a reviewed deletion plan)"),
    file:            UploadFile     = File(None, description="CSV/Excel file (required for submissions/blocks)"),
    scan_folder:     Optional[str]  = Form(None, description="HPC folder path (required for scans + mode=sync)"),
    delete_scan_ids: Optional[str]  = Form(None, description="JSON array of scan IDs with no other references — commit mode only"),
    force_scan_ids:  Optional[str]  = Form(None, description="JSON array of scan IDs to cascade-delete (annotations, project links, analysis runs) — commit mode only"),
    db:              Session        = Depends(get_db),
    user:            User           = Depends(require_admin),
):
    """Submit a new ETL import job."""

    # ── Validate job type ─────────────────────────────────────────────────
    if job_type not in VALID_JOB_TYPES:
        raise HTTPException(
            status_code=422,
            detail=f"job_type must be one of: {sorted(VALID_JOB_TYPES)}",
        )

    # ── Validate inputs per job type ──────────────────────────────────────
    source_path = ""
    config = {}

    if job_type in ("submissions", "blocks"):
        if not file or not file.filename:
            raise HTTPException(status_code=422, detail=f"A CSV or Excel file is required for '{job_type}' import")

        ext = Path(file.filename).suffix.lower()
        if ext not in ALLOWED_EXTENSIONS:
            raise HTTPException(
                status_code=422,
                detail=f"Unsupported file type '{ext}'. Accepted: {sorted(ALLOWED_EXTENSIONS)}",
            )

    elif job_type == "scans":
        if mode not in ("sync", "preview", "commit"):
            raise HTTPException(status_code=422, detail="mode must be 'sync', 'preview', or 'commit'")

        config["mode"] = mode

        if mode == "preview":
            # No folder needed — checks every existing scan's file_path against
            # disk and reports what's missing, split into "clean" (safe to
            # delete) vs "blocked" (referenced by a project, annotation, or
            # analysis run). Deletes nothing.
            source_path = "(preview: checking existing scans against disk)"

        elif mode == "commit":
            try:
                delete_ids = json.loads(delete_scan_ids) if delete_scan_ids else []
                force_ids = json.loads(force_scan_ids) if force_scan_ids else []
            except (json.JSONDecodeError, TypeError):
                raise HTTPException(status_code=422, detail="delete_scan_ids / force_scan_ids must be JSON arrays of integers")

            if not isinstance(delete_ids, list) or not isinstance(force_ids, list):
                raise HTTPException(status_code=422, detail="delete_scan_ids / force_scan_ids must be JSON arrays")

            try:
                delete_ids = [int(x) for x in delete_ids]
                force_ids = [int(x) for x in force_ids]
            except (ValueError, TypeError):
                raise HTTPException(status_code=422, detail="delete_scan_ids / force_scan_ids must contain integer scan IDs")

            if not delete_ids and not force_ids:
                raise HTTPException(status_code=422, detail="Nothing to commit — provide at least one scan id")

            config["delete_scan_ids"] = delete_ids
            config["force_scan_ids"] = force_ids
            source_path = f"(commit: {len(delete_ids)} clean delete + {len(force_ids)} forced cascade)"

        else:
            if not scan_folder:
                raise HTTPException(status_code=422, detail="scan_folder is required for 'scans' import in sync mode")

            # Validate the folder path
            folder = Path(scan_folder).resolve()
            try:
                folder.relative_to(BROWSABLE_ROOT.resolve())
            except ValueError:
                raise HTTPException(status_code=403, detail="Folder path is outside the allowed storage area")

            if not folder.exists() or not folder.is_dir():
                raise HTTPException(status_code=404, detail="Specified folder does not exist")

            source_path = str(folder)

    # ── Create DB record ──────────────────────────────────────────────────
    job = EtlJob(
        job_type=job_type,
        status="queued",
        source_path=source_path or "pending_upload",
        config_json=config,
        submitted_by=user.id,
    )
    db.add(job)
    db.commit()
    db.refresh(job)

    # ── Save uploaded file ────────────────────────────────────────────────
    job_dir = _job_dir(job.id)

    if job_type in ("submissions", "blocks"):
        save_name = f"{job_type}{Path(file.filename).suffix.lower()}"
        save_path = job_dir / save_name

        try:
            with open(save_path, "wb") as f:
                shutil.copyfileobj(file.file, f)
        except Exception as e:
            db.delete(job)
            db.commit()
            raise HTTPException(status_code=500, detail=f"Failed to save uploaded file: {e}")

        source_path = str(save_path)
        job.source_path = source_path
        db.commit()

    # ── Write context file ────────────────────────────────────────────────
    context_file = job_dir / "etl_context.json"
    import socket
    context_data = {
        "job_id": job.id,
        "job_type": job_type,
        "source_path": source_path,
        "result_dir": str(job_dir),
        "db_host": socket.gethostname(),
        "config": config,
    }
    context_file.write_text(json.dumps(context_data), encoding="utf-8")

    # ── Submit SLURM job ──────────────────────────────────────────────────
    etl_script = _etl_script()
    if not etl_script.exists():
        job.status = "failed"
        job.error_message = f"ETL script not found: {etl_script}"
        job.updated_at = datetime.now(timezone.utc)
        db.commit()
        raise HTTPException(status_code=500, detail=f"ETL script missing: {etl_script}")

    log_file = job_dir / "slurm_%j.out"

    # Scans sync (folder crawl) benefits from more CPUs for parallel filename
    # parsing; preview/commit are I/O-bound (filesystem stat calls) or simple
    # DB operations, and don't need extra cores.
    cpus = "8" if (job_type == "scans" and config.get("mode") == "sync") else "2"

    sbatch_cmd = [
        "sbatch", "--parsable",
        f"--job-name=pathodb_etl_{job_type}_{job.id}",
        f"--output={log_file}",
        f"--cpus-per-task={cpus}",
        "--export=NONE",
        str(etl_script),
        str(context_file),
    ]

    try:
        result = subprocess.run(
            sbatch_cmd, capture_output=True, text=True, timeout=15,
        )
        if result.returncode != 0:
            err = result.stderr.strip() or "sbatch returned non-zero exit code"
            log.error(f"sbatch failed for ETL job {job.id}: {err}")
            job.status = "failed"
            job.error_message = f"sbatch error: {err}"
            job.updated_at = datetime.now(timezone.utc)
            db.commit()
            raise HTTPException(status_code=500, detail=f"sbatch failed: {err}")

        slurm_id = int(result.stdout.strip().split(";")[0])
        job.slurm_job_id = slurm_id
        job.updated_at = datetime.now(timezone.utc)
        db.commit()
        db.refresh(job)
        log.info(f"Submitted SLURM ETL job {slurm_id} for ETL job {job.id} ({job_type})")

    except FileNotFoundError:
        log.warning(f"sbatch not found — ETL job {job.id} left as 'queued' (dev mode)")

    except subprocess.TimeoutExpired:
        job.status = "failed"
        job.error_message = "sbatch timed out"
        job.updated_at = datetime.now(timezone.utc)
        db.commit()
        raise HTTPException(status_code=500, detail="sbatch timed out")

    db.refresh(job)
    return _job_to_dict(job)


@router.get("/jobs")
def list_etl_jobs(
    job_type: Optional[str] = Query(None, description="Filter by job type"),
    limit:    int           = Query(50, ge=1, le=200),
    db:       Session       = Depends(get_db),
    _:        User          = Depends(require_admin),
):
    """List all ETL jobs, newest first. Syncs non-terminal jobs."""
    q = db.query(EtlJob)
    if job_type:
        q = q.filter(EtlJob.job_type == job_type)
    jobs = q.order_by(EtlJob.created_at.desc()).limit(limit).all()

    # Sync non-terminal jobs
    for job in jobs:
        if job.status not in ("done", "failed", "cancelled"):
            _sync_etl_job(job, db)

    return [_job_to_dict(j) for j in jobs]


@router.get("/jobs/{job_id}")
def get_etl_job(
    job_id: int,
    db:     Session = Depends(get_db),
    _:      User    = Depends(require_admin),
):
    """Get a single ETL job with synced status."""
    job = db.get(EtlJob, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="ETL job not found")

    job = _sync_etl_job(job, db)

    # Include detailed progress from sidecar
    response = _job_to_dict(job)
    prog = _read_progress(job_id)
    if prog:
        response["progress_detail"] = {
            "phase":     prog.get("phase", ""),
            "processed": prog.get("processed", 0),
            "total":     prog.get("total", 0),
        }

    return response


@router.delete("/jobs/{job_id}", status_code=204)
def cancel_etl_job(
    job_id: int,
    purge:  bool    = Query(False, description="Also delete files and DB record"),
    db:     Session = Depends(get_db),
    _:      User    = Depends(require_admin),
):
    """Cancel a queued/running ETL job. With purge=True, also deletes files + record."""
    job = db.get(EtlJob, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="ETL job not found")

    # Try to cancel SLURM job
    if job.status not in ("done", "failed", "cancelled") and job.slurm_job_id:
        try:
            subprocess.run(
                ["scancel", str(job.slurm_job_id)],
                capture_output=True, timeout=8,
            )
        except (FileNotFoundError, subprocess.TimeoutExpired):
            pass

    if not purge:
        if job.status not in ("done", "failed", "cancelled"):
            job.status = "cancelled"
            job.updated_at = datetime.now(timezone.utc)
            db.commit()
        return None

    # Purge — delete files and DB record
    job_dir = _job_dir(job.id)
    if job_dir.exists():
        try:
            shutil.rmtree(job_dir)
        except Exception as e:
            log.error(f"Failed to delete ETL job dir {job_dir}: {e}")

    db.delete(job)
    db.commit()
    return None


# ── Helpers ───────────────────────────────────────────────────────────────────

def _job_to_dict(job: EtlJob) -> dict:
    return {
        "id":            job.id,
        "job_type":      job.job_type,
        "status":        job.status,
        "slurm_job_id":  job.slurm_job_id,
        "source_path":   job.source_path,
        "config_json":   job.config_json or {},
        "progress":      job.progress,
        "summary_json":  job.summary_json,
        "error_message": job.error_message,
        "submitted_by":  job.submitted_by,
        "created_at":    job.created_at.isoformat() if job.created_at else None,
        "updated_at":    job.updated_at.isoformat() if job.updated_at else None,
    }

@router.get("/jobs/{job_id}/report")
def download_etl_report(
    job_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(require_admin),
):
    """Download the detailed per-file CSV report for a scans sync job."""
    job = db.get(EtlJob, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="ETL job not found")

    report_name = (job.summary_json or {}).get("report_csv")
    if not report_name:
        raise HTTPException(status_code=404, detail="No report file available for this job")

    report_path = _job_dir(job.id) / report_name
    if not report_path.exists():
        raise HTTPException(status_code=404, detail="Report file no longer exists on disk")

    return FileResponse(
        path=str(report_path),
        filename=f"etl_job_{job_id}_report.csv",
        media_type="text/csv",
    )