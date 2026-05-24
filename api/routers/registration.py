"""
PathoDB API — Slide Registration Router

Co-registers two slides for synchronized navigation in the compare viewer.

A registration is a 2D similarity transform (scale, rotation, translation)
mapping *moving*-slide full-resolution pixels onto *fixed*-slide pixels.

Endpoints
---------
GET    /registration?fixed_scan_id=&moving_scan_id=  — fetch saved transform (either order)
POST   /registration                                 — save/replace a transform (manual or accepted auto)
POST   /registration/auto                            — compute a transform via feature matching (optional, OpenCV)
DELETE /registration?fixed_scan_id=&moving_scan_id=  — remove a saved transform
"""
import logging
from datetime import datetime, timezone
from typing import List, Optional, Tuple

import openslide
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import or_, and_
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import Scan, SlideRegistration, User
from ..auth import get_current_active_user
from ..lib.registration import (
    SimilarityTransform,
    RegistrationError,
    auto_register_similarity,
)

log = logging.getLogger("pathodb_registration")
router = APIRouter(prefix="/registration", tags=["registration"])

# Long-edge size of the thumbnails used for automatic feature matching.
AUTO_THUMB_MAX = 1024


# ─── Schemas ──────────────────────────────────────────────────────────────────

class TransformOut(BaseModel):
    scale: float
    rotation: float          # radians, moving -> fixed
    rotation_deg: float
    tx: float
    ty: float


class RegistrationLookup(BaseModel):
    found: bool
    fixed_scan_id: Optional[int] = None
    moving_scan_id: Optional[int] = None
    method: Optional[str] = None
    transform: Optional[TransformOut] = None


class AutoRegisterRequest(BaseModel):
    fixed_scan_id: int
    moving_scan_id: int


class SaveRegistrationRequest(BaseModel):
    fixed_scan_id: int
    moving_scan_id: int
    scale: float
    rotation: float
    tx: float
    ty: float
    method: str = "manual"


# ─── Helpers ────────────────────────────────────────────────────────────────

def _transform_out(t: SimilarityTransform) -> TransformOut:
    d = t.to_dict()
    return TransformOut(**{k: d[k] for k in ("scale", "rotation", "rotation_deg", "tx", "ty")})


def _get_scan(scan_id: int, db: Session) -> Scan:
    scan = db.get(Scan, scan_id)
    if not scan:
        raise HTTPException(404, f"Scan {scan_id} not found")
    if not scan.file_path:
        raise HTTPException(422, f"Scan {scan_id} has no file path")
    return scan


def _thumbnail_gray_and_downsample(file_path: str):
    """Return (grayscale numpy array, downsample = full_width / thumb_width)."""
    import numpy as np  # lazy: only needed for the auto path
    try:
        slide = openslide.open_slide(file_path)
    except Exception as e:
        raise HTTPException(500, f"Cannot open slide: {e}")
    try:
        full_w = slide.dimensions[0]
        thumb = slide.get_thumbnail((AUTO_THUMB_MAX, AUTO_THUMB_MAX)).convert("L")
    finally:
        slide.close()
    arr = np.asarray(thumb)
    downsample = full_w / float(thumb.width) if thumb.width else 1.0
    return arr, downsample


# ─── Endpoints ────────────────────────────────────────────────────────────────

@router.get("", response_model=RegistrationLookup)
def get_registration(
    fixed_scan_id: int = Query(...),
    moving_scan_id: int = Query(...),
    db: Session = Depends(get_db),
    _: User = Depends(get_current_active_user),
):
    """Return the saved transform for this pair, in the requested orientation.

    If the pair was saved in the opposite order, the stored transform is
    inverted so the caller always gets moving->fixed for *their* fixed/moving.
    """
    row = db.query(SlideRegistration).filter(
        SlideRegistration.fixed_scan_id == fixed_scan_id,
        SlideRegistration.moving_scan_id == moving_scan_id,
    ).first()
    if row:
        t = SimilarityTransform(row.scale, row.rotation, row.tx, row.ty)
        return RegistrationLookup(
            found=True, fixed_scan_id=fixed_scan_id, moving_scan_id=moving_scan_id,
            method=row.method, transform=_transform_out(t),
        )

    # Try the reverse orientation and invert.
    rev = db.query(SlideRegistration).filter(
        SlideRegistration.fixed_scan_id == moving_scan_id,
        SlideRegistration.moving_scan_id == fixed_scan_id,
    ).first()
    if rev:
        inv = SimilarityTransform(rev.scale, rev.rotation, rev.tx, rev.ty).inverse()
        return RegistrationLookup(
            found=True, fixed_scan_id=fixed_scan_id, moving_scan_id=moving_scan_id,
            method=rev.method, transform=_transform_out(inv),
        )

    return RegistrationLookup(found=False)


@router.post("", response_model=RegistrationLookup, status_code=201)
def save_registration(
    req: SaveRegistrationRequest,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_active_user),
):
    if req.fixed_scan_id == req.moving_scan_id:
        raise HTTPException(422, "Cannot register a slide to itself")
    if req.method not in ("manual", "auto"):
        raise HTTPException(422, "method must be 'manual' or 'auto'")
    _get_scan(req.fixed_scan_id, db)
    _get_scan(req.moving_scan_id, db)

    row = db.query(SlideRegistration).filter(
        SlideRegistration.fixed_scan_id == req.fixed_scan_id,
        SlideRegistration.moving_scan_id == req.moving_scan_id,
    ).first()
    if row:
        row.scale, row.rotation, row.tx, row.ty = req.scale, req.rotation, req.tx, req.ty
        row.method = req.method
        row.updated_at = datetime.now(timezone.utc)
    else:
        row = SlideRegistration(
            fixed_scan_id=req.fixed_scan_id, moving_scan_id=req.moving_scan_id,
            scale=req.scale, rotation=req.rotation, tx=req.tx, ty=req.ty,
            method=req.method, created_by=user.id,
        )
        db.add(row)
    db.commit()

    t = SimilarityTransform(req.scale, req.rotation, req.tx, req.ty)
    return RegistrationLookup(
        found=True, fixed_scan_id=req.fixed_scan_id, moving_scan_id=req.moving_scan_id,
        method=req.method, transform=_transform_out(t),
    )


@router.post("/auto", response_model=RegistrationLookup)
def auto_register(
    req: AutoRegisterRequest,
    db: Session = Depends(get_db),
    _: User = Depends(get_current_active_user),
):
    """Estimate a transform automatically via ORB feature matching on thumbnails.

    Does NOT persist — the client previews the result and saves it explicitly.
    Returns 503 if OpenCV is not installed (manual landmark alignment still works).
    """
    if req.fixed_scan_id == req.moving_scan_id:
        raise HTTPException(422, "Cannot register a slide to itself")
    fixed = _get_scan(req.fixed_scan_id, db)
    moving = _get_scan(req.moving_scan_id, db)

    fixed_gray, fixed_ds = _thumbnail_gray_and_downsample(fixed.file_path)
    moving_gray, moving_ds = _thumbnail_gray_and_downsample(moving.file_path)

    try:
        transform = auto_register_similarity(fixed_gray, moving_gray, fixed_ds, moving_ds)
    except ImportError:
        raise HTTPException(
            status_code=503,
            detail="Automatic alignment requires OpenCV (opencv-python-headless). "
                   "Use manual landmark alignment instead.",
        )
    except RegistrationError as e:
        raise HTTPException(status_code=422, detail=f"Automatic alignment failed: {e}")

    return RegistrationLookup(
        found=True, fixed_scan_id=req.fixed_scan_id, moving_scan_id=req.moving_scan_id,
        method="auto", transform=_transform_out(transform),
    )


@router.delete("", status_code=204)
def delete_registration(
    fixed_scan_id: int = Query(...),
    moving_scan_id: int = Query(...),
    db: Session = Depends(get_db),
    _: User = Depends(get_current_active_user),
):
    rows = db.query(SlideRegistration).filter(
        or_(
            and_(SlideRegistration.fixed_scan_id == fixed_scan_id,
                 SlideRegistration.moving_scan_id == moving_scan_id),
            and_(SlideRegistration.fixed_scan_id == moving_scan_id,
                 SlideRegistration.moving_scan_id == fixed_scan_id),
        )
    ).all()
    for row in rows:
        db.delete(row)
    db.commit()
    return None
