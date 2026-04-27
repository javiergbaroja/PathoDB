"""
PathoDB API — Stains Router
Controlled vocabulary management.
"""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from sqlalchemy import func

from ..database import get_db
from ..models import Stain, Scan, User
from ..schemas import StainResponse, StainCreate, StainResolveRequest
from ..auth import get_current_active_user, require_admin

router = APIRouter(prefix="/stains", tags=["stains"])


@router.get("")
def list_stains(
    needs_review: bool | None = None,
    category: str | None = None,
    db: Session = Depends(get_db),
    _: User = Depends(get_current_active_user),
):
    # Subquery: count scans per stain
    scan_count_sq = (
        db.query(Scan.stain_id, func.count(Scan.id).label("scan_count"))
        .group_by(Scan.stain_id)
        .subquery()
    )

    q = (
        db.query(Stain, func.coalesce(scan_count_sq.c.scan_count, 0).label("scan_count"))
        .outerjoin(scan_count_sq, Stain.id == scan_count_sq.c.stain_id)
    )

    if needs_review is not None:
        q = q.filter(Stain.needs_review == needs_review)
    if category:
        q = q.filter(Stain.stain_category == category)

    rows = q.order_by(Stain.stain_name).all()

    return [
        {
            "id":             stain.id,
            "stain_name":     stain.stain_name,
            "stain_category": stain.stain_category,
            "aliases":        stain.aliases,
            "needs_review":   stain.needs_review,
            "created_at":     stain.created_at,
            "scan_count":     scan_count,
        }
        for stain, scan_count in rows
    ]


@router.get("/{stain_id}", response_model=StainResponse)
def get_stain(
    stain_id: int,
    db: Session = Depends(get_db),
    _: User = Depends(get_current_active_user),
):
    stain = db.get(Stain, stain_id)
    if not stain:
        raise HTTPException(status_code=404, detail="Stain not found")
    return stain


@router.post("/resolve", response_model=StainResponse)
def resolve_stain(
    req: StainResolveRequest,
    db: Session = Depends(get_db),
    _: User = Depends(get_current_active_user),
):
    """
    Find the canonical stain record for a free-text stain name.
    Matches on stain_name first, then aliases.
    """
    stain = db.query(Stain).filter(Stain.stain_name == req.name).first()
    if stain:
        return stain
    stain = db.query(Stain).filter(Stain.aliases.any(req.name)).first()
    if stain:
        return stain
    raise HTTPException(
        status_code=404,
        detail=f"Stain '{req.name}' not found. Use POST /stains to create it."
    )


@router.post("", response_model=StainResponse, status_code=201)
def create_stain(
    req: StainCreate,
    db: Session = Depends(get_db),
    _: User = Depends(require_admin),
):
    if db.query(Stain).filter(Stain.stain_name == req.stain_name).first():
        raise HTTPException(status_code=409, detail="Stain name already exists")
    stain = Stain(
        stain_name=req.stain_name,
        stain_category=req.stain_category,
        aliases=req.aliases,
        needs_review=False,
    )
    db.add(stain)
    db.commit()
    db.refresh(stain)
    return stain


@router.patch("/{stain_id}", response_model=StainResponse)
def update_stain(
    stain_id: int,
    req: StainCreate,
    db: Session = Depends(get_db),
    _: User = Depends(require_admin),
):
    stain = db.get(Stain, stain_id)
    if not stain:
        raise HTTPException(status_code=404, detail="Stain not found")
    stain.stain_name     = req.stain_name
    stain.stain_category = req.stain_category
    stain.aliases        = req.aliases
    stain.needs_review   = False
    db.commit()
    db.refresh(stain)
    return stain