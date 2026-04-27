"""
PathoDB API — Scans Router
Search, register, and manage scans.
"""
from decimal import Decimal
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session, joinedload
from sqlalchemy import and_

from ..database import get_db
from ..models import Scan, Block, Probe, Submission, Patient, Stain, User
from ..schemas import ScanResponse, ScanSummary, ScanRegisterRequest
from ..auth import get_current_active_user, require_admin, get_user_or_scanner

router = APIRouter(tags=["scans"])


def _scan_to_response(sc: Scan) -> ScanResponse:
    block = sc.block
    probe = block.probe if block else None
    sub   = probe.submission if probe else None
    pat   = sub.patient if sub else None
    return ScanResponse(
        id=sc.id,
        stain_id=sc.stain_id,
        stain_name=sc.stain.stain_name if sc.stain else None,
        stain_category=sc.stain.stain_category if sc.stain else None,
        file_path=sc.file_path,
        file_format=sc.file_format,
        magnification=sc.magnification,
        created_at=sc.created_at,
        block_id=sc.block_id,
        block_label=block.block_label if block else None,
        probe_id=probe.id if probe else None,
        lis_probe_id=probe.lis_probe_id if probe else None,
        submission_id=sub.id if sub else None,
        lis_submission_id=sub.lis_submission_id if sub else None,
        patient_id=pat.id if pat else None,
        patient_code=pat.patient_code if pat else None,
    )


@router.get("/scans", response_model=list[ScanResponse])
def search_scans(
    stain_name: str | None       = Query(None),
    stain_category: str | None   = Query(None),
    file_format: str | None      = Query(None),
    magnification: Decimal | None = Query(None),
    submission_id: int | None    = Query(None),
    probe_id: int | None         = Query(None),
    block_id: int | None         = Query(None),
    page: int                    = Query(1, ge=1),
    page_size: int               = Query(50, ge=1, le=200),
    db: Session                  = Depends(get_db),
    _: User                      = Depends(get_current_active_user),
):
    q = (
        db.query(Scan)
        .join(Scan.stain)
        .join(Scan.block)
        .join(Block.probe)
        .join(Probe.submission)
        .join(Submission.patient)
        .options(
            joinedload(Scan.stain),
            joinedload(Scan.block).joinedload(Block.probe)
                .joinedload(Probe.submission).joinedload(Submission.patient)
        )
    )
    if stain_name:
        q = q.filter(Stain.stain_name.ilike(f"%{stain_name}%"))
    if stain_category:
        q = q.filter(Stain.stain_category == stain_category)
    if file_format:
        q = q.filter(Scan.file_format == file_format.upper())
    if magnification:
        q = q.filter(Scan.magnification == magnification)
    if block_id:
        q = q.filter(Scan.block_id == block_id)
    if probe_id:
        q = q.filter(Block.probe_id == probe_id)
    if submission_id:
        q = q.filter(Probe.submission_id == submission_id)

    scans = q.order_by(Scan.created_at.desc()).offset((page - 1) * page_size).limit(page_size).all()
    return [_scan_to_response(sc) for sc in scans]


@router.get("/scans/{scan_id}", response_model=ScanResponse)
def get_scan(
    scan_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(get_current_active_user),
):
    sc = (
        db.query(Scan)
        .options(
            joinedload(Scan.stain),
            joinedload(Scan.block).joinedload(Block.probe)
                .joinedload(Probe.submission).joinedload(Submission.patient)
        )
        .filter(Scan.id == scan_id)
        .first()
    )
    if not sc:
        raise HTTPException(status_code=404, detail="Scan not found")
    return _scan_to_response(sc)


@router.get("/blocks/{block_id}/scans", response_model=list[ScanSummary])
def get_scans_for_block(
    block_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(get_current_active_user),
):
    """
    Returns all scans for a specific block with stain info.
    This is the primary duplicate-check endpoint — call before requesting new sectioning.
    """
    block = db.get(Block, block_id)
    if not block:
        raise HTTPException(status_code=404, detail="Block not found")

    scans = (
        db.query(Scan)
        .options(joinedload(Scan.stain))
        .filter(Scan.block_id == block_id)
        .all()
    )
    return [
        ScanSummary(
            id=sc.id,
            stain_id=sc.stain_id,
            stain_name=sc.stain.stain_name if sc.stain else None,
            stain_category=sc.stain.stain_category if sc.stain else None,
            file_path=sc.file_path,
            file_format=sc.file_format,
            magnification=sc.magnification,
            created_at=sc.created_at,
        )
        for sc in scans
    ]


@router.post("/scans", response_model=ScanResponse, status_code=201)
def register_scan(
    req: ScanRegisterRequest,
    db: Session = Depends(get_db),
    current_user: User | None = Depends(get_user_or_scanner),
):
    """
    Register a new scan. Accepts JWT (researcher) or X-API-Key (scanner script).
    Resolves block via lis_submission_id → lis_probe_id → block_label.
    Resolves stain by name (creates with needs_review=TRUE if unknown).
    """
    # Resolve submission
    sub = db.query(Submission).filter(
        Submission.lis_submission_id == req.lis_submission_id
    ).first()
    if not sub:
        raise HTTPException(status_code=404, detail=f"Submission '{req.lis_submission_id}' not found")

    # Resolve probe
    probe = db.query(Probe).filter(
        and_(Probe.submission_id == sub.id, Probe.lis_probe_id == req.lis_probe_id)
    ).first()
    if not probe:
        raise HTTPException(status_code=404, detail=f"Probe '{req.lis_probe_id}' not found in submission '{req.lis_submission_id}'")

    # Resolve block
    block = db.query(Block).filter(
        and_(Block.probe_id == probe.id, Block.block_label == req.block_label)
    ).first()
    if not block:
        raise HTTPException(status_code=404, detail=f"Block '{req.block_label}' not found in probe '{req.lis_probe_id}'")

    # Resolve or create stain
    stain = db.query(Stain).filter(Stain.stain_name == req.stain_name).first()
    if not stain:
        # Try alias match
        from sqlalchemy import func
        stain = db.query(Stain).filter(
            Stain.aliases.any(req.stain_name)
        ).first()
    if not stain:
        stain = Stain(stain_name=req.stain_name, stain_category="other", needs_review=True)
        db.add(stain)
        db.flush()

    # Check for duplicate file path
    if db.query(Scan).filter(Scan.file_path == req.file_path).first():
        raise HTTPException(status_code=409, detail="A scan with this file path already exists")

    scan = Scan(
        block_id=block.id,
        stain_id=stain.id,
        file_path=req.file_path,
        file_format=req.file_format.upper() if req.file_format else None,
        magnification=req.magnification,
        registered_by=current_user.id if current_user else None,
    )
    db.add(scan)
    db.commit()
    db.refresh(scan)

    # Reload with relationships for response
    sc = (
        db.query(Scan)
        .options(
            joinedload(Scan.stain),
            joinedload(Scan.block).joinedload(Block.probe)
                .joinedload(Probe.submission).joinedload(Submission.patient)
        )
        .filter(Scan.id == scan.id)
        .first()
    )
    return _scan_to_response(sc)


@router.delete("/scans/{scan_id}", status_code=204)
def delete_scan(
    scan_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(require_admin),
):
    """Soft-delete: removes the database record. Does NOT delete the file on disk."""
    sc = db.get(Scan, scan_id)
    if not sc:
        raise HTTPException(status_code=404, detail="Scan not found")
    db.delete(sc)
    db.commit()
