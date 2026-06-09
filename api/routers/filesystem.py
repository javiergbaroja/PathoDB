"""
Filesystem browsing endpoint — lets the web UI navigate server-side
directories so users can pick an output folder for batch analysis.
"""
import logging
from pathlib import Path
from typing import List, Optional

from fastapi import APIRouter, HTTPException, Query, Depends
from pydantic import BaseModel

from ..auth import get_current_active_user
from ..models import User

log = logging.getLogger(__name__)

router = APIRouter(prefix="/filesystem", tags=["filesystem"])

BROWSABLE_ROOT = Path("/storage/research")

_HIDDEN_PREFIXES = (".", "__")


class DirectoryEntry(BaseModel):
    name: str
    path: str


class BrowseResponse(BaseModel):
    current: str
    parent: Optional[str] = None
    directories: List[DirectoryEntry]


class MkdirRequest(BaseModel):
    path: str


class MkdirResponse(BaseModel):
    path: str


def _resolve_and_guard(raw_path: str) -> Path:
    """Resolve a path and ensure it lives under BROWSABLE_ROOT."""
    candidate = Path(raw_path).resolve()
    try:
        candidate.relative_to(BROWSABLE_ROOT.resolve())
    except ValueError:
        raise HTTPException(status_code=403, detail="Path is outside the allowed storage area.")
    return candidate


@router.get("/browse", response_model=BrowseResponse)
def browse_directory(
    path: str = Query(default="/storage/research", description="Absolute directory path to list"),
    user: User = Depends(get_current_active_user),
):
    resolved = _resolve_and_guard(path)

    if not resolved.exists():
        raise HTTPException(status_code=404, detail="Directory not found.")
    if not resolved.is_dir():
        raise HTTPException(status_code=400, detail="Path is not a directory.")

    try:
        entries = sorted(resolved.iterdir(), key=lambda p: p.name.lower())
    except PermissionError:
        raise HTTPException(status_code=403, detail="Permission denied reading this directory.")

    dirs = []
    for entry in entries:
        if entry.name.startswith(_HIDDEN_PREFIXES):
            continue
        try:
            if entry.is_dir():
                dirs.append(DirectoryEntry(name=entry.name, path=str(entry)))
        except (PermissionError, OSError):
            continue

    parent = str(resolved.parent) if resolved != BROWSABLE_ROOT.resolve() else None

    return BrowseResponse(current=str(resolved), parent=parent, directories=dirs)


@router.post("/mkdir", response_model=MkdirResponse, status_code=201)
def create_directory(
    req: MkdirRequest,
    user: User = Depends(get_current_active_user),
):
    resolved = _resolve_and_guard(req.path)

    if resolved.exists():
        raise HTTPException(status_code=409, detail="Directory already exists.")

    try:
        resolved.mkdir(parents=True, exist_ok=False)
    except PermissionError:
        raise HTTPException(status_code=403, detail="Permission denied creating this directory.")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to create directory: {e}")

    return MkdirResponse(path=str(resolved))
