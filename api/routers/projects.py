"""
PathoDB API — Projects Router  (v2 — corrected)
Fixes vs v1:
  - /from_file uses fastapi.Form() not Query params (multipart/form-data)
  - User import de-aliased to avoid circular shadowing
  - _resolve_cohort_scans wrapped in try/except for safety
"""
import csv
import io
import json
import math
import os
from datetime import datetime, timezone
from typing import List, Optional, Literal, Union

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session
from sqlalchemy import func

from ..database import get_db
from ..models import (
    User, Project, ProjectScan, ProjectShare, Annotation,
    Scan, Block, Probe, Submission, Cohort, Stain, Patient,
    PROJECT_TYPE_TMA,
)
from ..auth import get_current_active_user

router = APIRouter(prefix="/projects", tags=["projects"])


# ─── Schemas ──────────────────────────────────────────────────────────────────

class ClassDef(BaseModel):
    id:    str
    name:  str
    color: str = "#6ee7b7"

class ProjectCreate(BaseModel):
    name:         str
    description:  Optional[str] = None
    project_type: Literal["cell_detection", "region_annotation"]
    classes:      List[ClassDef] = []
    # Added "custom_list" to the source types
    source_type:  Literal["cohort", "file_import", "custom_list"]
    cohort_id:    Optional[int] = None
    # Add a direct list of scan IDs
    scan_ids:     Optional[List[int]] = None

class ProjectUpdate(BaseModel):
    name:        Optional[str] = None
    description: Optional[str] = None
    classes:     Optional[List[ClassDef]] = None

class ShareCreate(BaseModel):
    username_or_email: str
    access_level:      Literal["read", "edit"] = "read"

class ShareUpdate(BaseModel):
    access_level: Literal["read", "edit"]

class AnnotationCreate(BaseModel):
    class_id:        Optional[str] = None
    class_name:      Optional[str] = None
    annotation_type: str
    geometry:        dict
    notes:           Optional[str] = None

class AnnotationUpdate(BaseModel):
    class_id:   Optional[str] = None
    class_name: Optional[str] = None
    geometry:   Optional[dict] = None
    notes:      Optional[str] = None

class BulkAnnotationItem(AnnotationCreate):
    # Stable identifier sent back by the client. Integers reference an existing
    # DB row (update in place, preserving provenance); anything else (temp ids,
    # null) is treated as a new annotation.
    id: Optional[Union[int, str]] = None

class BulkAnnotationUpsert(BaseModel):
    annotations: List[BulkAnnotationItem]


# ─── Geometry helpers ─────────────────────────────────────────────────────────

def _bbox(ann_type: str, g: dict):
    try:
        if ann_type == "point":
            return g["x"], g["y"], 0.0, 0.0
        if ann_type == "rectangle":
            return g["x"], g["y"], g["width"], g["height"]
        if ann_type == "ellipse":
            return g["cx"]-g["rx"], g["cy"]-g["ry"], g["rx"]*2, g["ry"]*2
        if ann_type in ("polygon", "brush"):
            pts = g.get("points", [])
            if not pts:
                return 0.0, 0.0, 0.0, 0.0
                
            # FIX: Handle both 1D (no holes) and 2D (with holes) point arrays.
            # If it's a 2D array, the exterior ring is always at index 0.
            exterior = pts[0] if isinstance(pts[0], list) else pts
            
            if not exterior:
                 return 0.0, 0.0, 0.0, 0.0

            xs, ys = [p["x"] for p in exterior], [p["y"] for p in exterior]
            return min(xs), min(ys), max(xs)-min(xs), max(ys)-min(ys)
    except (KeyError, TypeError):
        pass
    return 0.0, 0.0, 0.0, 0.0


def _area(ann_type: str, g: dict) -> Optional[float]:
    try:
        if ann_type == "point":     return None
        if ann_type == "rectangle": return abs(g["width"] * g["height"])
        if ann_type == "ellipse":   return math.pi * g["rx"] * g["ry"]
        if ann_type in ("polygon", "brush"):
            pts = g.get("points", [])
            if not pts:
                return None

            # Helper function to calculate area of a single ring using the Shoelace formula
            def ring_area(ring):
                n = len(ring)
                if n < 3: return 0.0
                a = sum(ring[i]["x"] * ring[(i+1)%n]["y"] - ring[(i+1)%n]["x"] * ring[i]["y"] for i in range(n))
                return abs(a) / 2.0

            # If it's a 1D array (no holes)
            if not isinstance(pts[0], list):
                if len(pts) < 3: return None
                return ring_area(pts)
            
            # If it's a 2D array (has holes)
            exterior_area = ring_area(pts[0])
            holes_area = sum(ring_area(hole) for hole in pts[1:])
            
            # The true area is the exterior minus the holes
            return exterior_area - holes_area
            
    except (KeyError, TypeError):
        pass
    return None


# ─── Access control ───────────────────────────────────────────────────────────

def _check_access(project: Project, user: User, require_edit: bool = False):
    if project.owner_id == user.id:
        return
    share = next((s for s in project.shares if s.shared_with_user_id == user.id), None)
    if not share:
        raise HTTPException(403, "Access denied")
    if require_edit and share.access_level != "edit":
        raise HTTPException(403, "Edit access required")


def _ensure_scan_in_project(project_id: int, scan_id: int, db: Session):
    """Guard against writing annotations for a scan that is not in the project."""
    in_project = db.query(ProjectScan.id).filter(
        ProjectScan.project_id == project_id,
        ProjectScan.scan_id == scan_id,
    ).first()
    if not in_project:
        raise HTTPException(404, "Scan is not part of this project")


def _serialize(project: Project, user_id: int, db: Session) -> dict:
    scan_count = db.query(func.count(ProjectScan.id)).filter(
        ProjectScan.project_id == project.id).scalar() or 0
    ann_count = db.query(func.count(Annotation.id)).filter(
        Annotation.project_id == project.id).scalar() or 0
    annotated = db.query(func.count(func.distinct(Annotation.scan_id))).filter(
        Annotation.project_id == project.id).scalar() or 0
    first_ps = db.query(ProjectScan).filter(
        ProjectScan.project_id == project.id
    ).order_by(ProjectScan.sort_order).first()

    access = "owner" if project.owner_id == user_id else next(
        (s.access_level for s in project.shares if s.shared_with_user_id == user_id), "read")

    return {
        "id":               project.id,
        "name":             project.name,
        "description":      project.description,
        "project_type":     project.project_type,
        "classes":          project.classes,
        "source_type":      project.source_type,
        "cohort_id":        project.cohort_id,
        "owner_id":         project.owner_id,
        "owner_username":   project.owner.username if project.owner else None,
        "created_at":       project.created_at.isoformat() if project.created_at else None,
        "updated_at":       project.updated_at.isoformat() if project.updated_at else None,
        "scan_count":       scan_count,
        "annotation_count": ann_count,
        "annotated_scans":  annotated,
        "first_scan_id":    first_ps.scan_id if first_ps else None,
        "access":           access,
        "shares": [
            {"user_id": s.shared_with_user_id,
             "username": s.shared_with_user.username,
             "access_level": s.access_level}
            for s in project.shares
        ],
    }


# ─── Scan resolution ──────────────────────────────────────────────────────────

def _resolve_cohort_scans(cohort_id: int, db: Session) -> List[int]:
    from ..schemas import CohortFilter
    from .cohorts import _apply_filters, _resolve_b_number_exact
    
    cohort = db.get(Cohort, cohort_id)
    if not cohort:
        return []
        
    try:
        f = CohortFilter(**cohort.filter_json)
        valid_block_ids = set()

        # 1. Gather all valid Block IDs (Handles both List-mode and Filter-mode)
        if getattr(f, 'is_list_query', False) and getattr(f, 'ids', None):
            ids = list(set(i.strip() for i in f.ids if i.strip()))
            for id_str in ids:
                if f.id_type == "patient_code":
                    patient = db.query(Patient).filter(Patient.patient_code == id_str).first()
                    if not patient: continue
                    for sub in patient.submissions:
                        for probe in sub.probes:
                            for block in probe.blocks:
                                valid_block_ids.add(block.id)
                else: # b_number
                    matched = _resolve_b_number_exact(id_str, db)
                    if not matched: continue
                    
                    if f.b_scope == "all":
                        seen_patient_ids = set()
                        for patient, _ in matched:
                            if patient.id not in seen_patient_ids:
                                seen_patient_ids.add(patient.id)
                                for sub in patient.submissions:
                                    for probe in sub.probes:
                                        for block in probe.blocks:
                                            valid_block_ids.add(block.id)
                    else:
                        for _, sub in matched:
                            for probe in sub.probes:
                                for block in probe.blocks:
                                    valid_block_ids.add(block.id)
        else:
            # Filter-mode: Use with_entities to fetch ONLY the Block.id integer!
            # This completely avoids loading full ORM objects into RAM.
            q = _apply_filters(db, f)
            block_ids = q.with_entities(Block.id).all()
            valid_block_ids = {row[0] for row in block_ids}

        if not valid_block_ids:
            return []

        # 2. Bulk query all Scan IDs for these blocks
        scan_query = db.query(Scan.id).filter(Scan.block_id.in_(valid_block_ids))
        
        # 3. Re-apply scan-specific filters if they exist in the cohort
        if f.stain_names or f.stain_categories:
            scan_query = scan_query.join(Stain, Scan.stain_id == Stain.id)
            if f.stain_names:
                scan_query = scan_query.filter(Stain.stain_name.in_(f.stain_names))
            if f.stain_categories:
                scan_query = scan_query.filter(Stain.stain_category.in_(f.stain_categories))
        if getattr(f, 'file_formats', None):
            scan_query = scan_query.filter(Scan.file_format.in_([x.upper() for x in f.file_formats]))
        if getattr(f, 'magnification_min', None):
            scan_query = scan_query.filter(Scan.magnification >= f.magnification_min)
        if getattr(f, 'magnification_max', None):
            scan_query = scan_query.filter(Scan.magnification <= f.magnification_max)
            
        return list(set(row[0] for row in scan_query.all()))

    except Exception as e:
        import logging
        logging.error(f"Failed to resolve cohort scans: {e}")
        return []
    

def _resolve_file_import(lines: List[str], db: Session) -> List[int]:
    clean_lines = [line.strip() for line in lines if line.strip()]
    if not clean_lines:
        return []

    path_to_id = {}
    chunk_size = 2000
    
    # 1. Bulk Exact Match (Instantly resolves UI-generated cohorts in milliseconds)
    for i in range(0, len(clean_lines), chunk_size):
        chunk = clean_lines[i:i + chunk_size]
        # Query up to 2,000 paths at once
        scans = db.query(Scan.id, Scan.file_path).filter(Scan.file_path.in_(chunk)).all()
        for sid, fpath in scans:
            path_to_id[fpath] = sid

    # 2. Fallback for manual .txt uploads with missing paths
    # Because the UI sends exact file_paths, 'missing_lines' will be EMPTY for cohort creations
    # and this slow loop will be completely skipped!
    missing_lines = [line for line in clean_lines if line not in path_to_id]
    if missing_lines:
        for line in missing_lines:
            base = os.path.basename(line)
            scan = db.query(Scan.id).filter(Scan.file_path.ilike(f"%{base}%")).first()
            if scan:
                path_to_id[line] = scan[0]

    # 3. Reconstruct the ordered list of IDs, dropping duplicates
    final_ids = []
    seen = set()
    for line in clean_lines:
        sid = path_to_id.get(line)
        if sid and sid not in seen:
            seen.add(sid)
            final_ids.append(sid)
            
    return final_ids


# ─── Project CRUD ─────────────────────────────────────────────────────────────

@router.get("")
def list_projects(db: Session = Depends(get_db), user: User = Depends(get_current_active_user)):
    # TMAs are also stored in the projects table but are a distinct sub-type with
    # their own /tmas API and page; they must not appear in the annotation
    # project list. (See PROJECT_TYPES / docs/GLOSSARY.md.)
    owned = db.query(Project).filter(
        Project.owner_id == user.id,
        Project.project_type != PROJECT_TYPE_TMA,
    ).all()
    shared_ids = [r[0] for r in db.query(ProjectShare.project_id).filter(
        ProjectShare.shared_with_user_id == user.id).all()]
    shared = db.query(Project).filter(
        Project.id.in_(shared_ids),
        Project.owner_id != user.id,
        Project.project_type != PROJECT_TYPE_TMA,
    ).all() if shared_ids else []
    return [_serialize(p, user.id, db) for p in owned + shared]


@router.post("", status_code=201)
def create_project(req: ProjectCreate, db: Session = Depends(get_db),
                   user: User = Depends(get_current_active_user)):
    
    proj = Project(owner_id=user.id, name=req.name, description=req.description,
                   project_type=req.project_type, classes=[c.model_dump() for c in req.classes],
                   source_type=req.source_type, cohort_id=req.cohort_id)
    db.add(proj)
    db.flush()

    final_scan_ids = []
    if req.source_type == "cohort" and req.cohort_id:
        final_scan_ids = _resolve_cohort_scans(req.cohort_id, db)
    elif req.source_type == "custom_list" and req.scan_ids:
        # We already have the exact IDs from the frontend SlideTargetManager!
        final_scan_ids = req.scan_ids

    if final_scan_ids:
        # Ultra-fast raw SQL bulk insert. Bypasses ORM memory bloat entirely!
        mappings = [{"project_id": proj.id, "scan_id": sid, "sort_order": i} 
                    for i, sid in enumerate(final_scan_ids)]
        db.bulk_insert_mappings(ProjectScan, mappings)

    db.commit()
    db.refresh(proj)
    return _serialize(proj, user.id, db)


@router.post("/from_file", status_code=201)
async def create_project_from_file(
    name:         str           = Form(...),
    project_type: str           = Form(...),
    classes:      str           = Form("[]"),
    description:  Optional[str] = Form(None),
    file:         UploadFile    = File(...),
    db:           Session       = Depends(get_db),
    user:         User          = Depends(get_current_active_user),
):
    if project_type not in ("cell_detection", "region_annotation"):
        raise HTTPException(422, "Invalid project_type")

    content = await file.read()
    lines   = content.decode("utf-8", errors="ignore").splitlines()
    try:
        classes_list = json.loads(classes)
    except Exception:
        classes_list = []

    proj = Project(owner_id=user.id, name=name, description=description,
                   project_type=project_type, classes=classes_list,
                   source_type="file_import", cohort_id=None)
    db.add(proj); db.flush()

    scan_ids = _resolve_file_import(lines, db)
    
    project_scans = [
        ProjectScan(project_id=proj.id, scan_id=sid, sort_order=i)
        for i, sid in enumerate(scan_ids)
    ]
    if project_scans:
        db.bulk_save_objects(project_scans)

    db.commit(); db.refresh(proj)
    result = _serialize(proj, user.id, db)
    result["unmatched_count"] = len([l for l in lines if l.strip()]) - len(scan_ids)
    return result


@router.get("/{project_id}")
def get_project(project_id: int, db: Session = Depends(get_db),
                user: User = Depends(get_current_active_user)):
    proj = db.get(Project, project_id)
    if not proj: raise HTTPException(404, "Project not found")
    _check_access(proj, user)
    return _serialize(proj, user.id, db)


@router.patch("/{project_id}")
def update_project(project_id: int, req: ProjectUpdate,
                   db: Session = Depends(get_db), user: User = Depends(get_current_active_user)):
    proj = db.get(Project, project_id)
    if not proj: raise HTTPException(404, "Project not found")
    _check_access(proj, user, require_edit=True)

    if req.name        is not None: proj.name        = req.name
    if req.description is not None: proj.description = req.description
    if req.classes     is not None: proj.classes     = [c.model_dump() for c in req.classes]
    proj.updated_at = datetime.now(timezone.utc)
    db.commit(); db.refresh(proj)
    return _serialize(proj, user.id, db)


@router.delete("/{project_id}", status_code=204)
def delete_project(project_id: int, db: Session = Depends(get_db),
                   user: User = Depends(get_current_active_user)):
    proj = db.get(Project, project_id)
    if not proj: raise HTTPException(404, "Project not found")
    if proj.owner_id != user.id: raise HTTPException(403, "Only the owner can delete")
    db.delete(proj); db.commit()


@router.post("/{project_id}/sync")
def sync_project_scans(project_id: int, db: Session = Depends(get_db),
                       user: User = Depends(get_current_active_user)):
    proj = db.get(Project, project_id)
    if not proj: raise HTTPException(404, "Project not found")
    _check_access(proj, user, require_edit=True)

    if proj.source_type != "cohort" or not proj.cohort_id:
        return {"message": "Sync only applicable to cohort-based projects", "added": 0}

    existing = {ps.scan_id for ps in proj.scans}
    new_ids  = _resolve_cohort_scans(proj.cohort_id, db)
    cur_max  = max((ps.sort_order for ps in proj.scans), default=-1)
    added    = 0

    for sid in new_ids:
        if sid not in existing:
            cur_max += 1
            db.add(ProjectScan(project_id=proj.id, scan_id=sid, sort_order=cur_max))
            added += 1

    proj.updated_at = datetime.now(timezone.utc)
    db.commit()
    return {"message": "Sync complete", "added": added}


# ─── Scans list ───────────────────────────────────────────────────────────────

@router.get("/{project_id}/scans")
def list_project_scans(project_id: int, db: Session = Depends(get_db),
                       user: User = Depends(get_current_active_user)):
    proj = db.get(Project, project_id)
    if not proj: raise HTTPException(404, "Project not found")
    _check_access(proj, user)

    ann_counts = dict(
        db.query(Annotation.scan_id, func.count(Annotation.id))
        .filter(Annotation.project_id == project_id)
        .group_by(Annotation.scan_id).all()
    )

    # Single query with outer joins instead of per-scan db.get() lookups.
    # Block/Probe/Submission are outer-joined because TMA scans have no block.
    rows = (
        db.query(ProjectScan, Scan, Stain, Block, Probe, Submission)
        .join(Scan, ProjectScan.scan_id == Scan.id)
        .outerjoin(Stain, Scan.stain_id == Stain.id)
        .outerjoin(Block, Scan.block_id == Block.id)
        .outerjoin(Probe, Block.probe_id == Probe.id)
        .outerjoin(Submission, Probe.submission_id == Submission.id)
        .filter(ProjectScan.project_id == project_id)
        .order_by(ProjectScan.sort_order)
        .all()
    )

    result = []
    for ps, sc, stain, block, probe, sub in rows:
        result.append({
            "project_scan_id":   ps.id,
            "scan_id":           sc.id,
            "sort_order":        ps.sort_order,
            "file_path":         sc.file_path,
            "file_format":       sc.file_format,
            "magnification":     float(sc.magnification) if sc.magnification else None,
            "stain_name":        stain.stain_name     if stain else None,
            "stain_category":    stain.stain_category if stain else None,
            "block_label":       block.block_label       if block else None,
            "lis_probe_id":      probe.lis_probe_id      if probe else None,
            "topo_description":  probe.topo_description  if probe else None,
            "lis_submission_id": sub.lis_submission_id   if sub   else None,
            "annotation_count":  ann_counts.get(sc.id, 0),
        })
    return result


# ─── Shares ───────────────────────────────────────────────────────────────────

@router.post("/{project_id}/shares", status_code=201)
def share_project(project_id: int, req: ShareCreate,
                  db: Session = Depends(get_db), user: User = Depends(get_current_active_user)):
    proj = db.get(Project, project_id)
    if not proj: raise HTTPException(404, "Project not found")
    if proj.owner_id != user.id: raise HTTPException(403, "Only the owner can share")

    target = db.query(User).filter(
        (User.username == req.username_or_email) | (User.email == req.username_or_email)
    ).first()
    if not target: raise HTTPException(404, "User not found")
    if target.id == user.id: raise HTTPException(422, "Cannot share with yourself")

    existing = db.query(ProjectShare).filter_by(
        project_id=project_id, shared_with_user_id=target.id).first()
    if existing:
        existing.access_level = req.access_level
    else:
        db.add(ProjectShare(project_id=project_id, shared_with_user_id=target.id,
                            access_level=req.access_level, shared_by=user.id))
    db.commit()
    return {"message": f"Shared with {target.username}", "access_level": req.access_level}


@router.patch("/{project_id}/shares/{target_user_id}")
def update_share(project_id: int, target_user_id: int, req: ShareUpdate,
                 db: Session = Depends(get_db), user: User = Depends(get_current_active_user)):
    proj = db.get(Project, project_id)
    if not proj or proj.owner_id != user.id: raise HTTPException(403, "Forbidden")
    share = db.query(ProjectShare).filter_by(
        project_id=project_id, shared_with_user_id=target_user_id).first()
    if not share: raise HTTPException(404, "Share not found")
    share.access_level = req.access_level
    db.commit()
    return {"message": "Updated"}


@router.delete("/{project_id}/shares/{target_user_id}", status_code=204)
def revoke_share(project_id: int, target_user_id: int,
                 db: Session = Depends(get_db), user: User = Depends(get_current_active_user)):
    proj = db.get(Project, project_id)
    if not proj or proj.owner_id != user.id: raise HTTPException(403, "Forbidden")
    share = db.query(ProjectShare).filter_by(
        project_id=project_id, shared_with_user_id=target_user_id).first()
    if share:
        db.delete(share); db.commit()


# ─── Annotations ──────────────────────────────────────────────────────────────

def _ann_dict(a: Annotation) -> dict:
    return {
        "id":              a.id,
        "project_id":      a.project_id,
        "scan_id":         a.scan_id,
        "class_id":        a.class_id,
        "class_name":      a.class_name,
        "annotation_type": a.annotation_type,
        "geometry":        a.geometry,
        "bbox":            {"x": float(a.bbox_x), "y": float(a.bbox_y),
                            "w": float(a.bbox_w), "h": float(a.bbox_h)},
        "area_px":         float(a.area_px) if a.area_px is not None else None,
        "notes":           a.notes,
        "created_by":      a.created_by,
        "created_at":      a.created_at.isoformat() if a.created_at else None,
        "updated_at":      a.updated_at.isoformat() if a.updated_at else None,
    }


@router.get("/{project_id}/scans/{scan_id}/annotations")
def list_annotations(project_id: int, scan_id: int,
                     db: Session = Depends(get_db), user: User = Depends(get_current_active_user)):
    proj = db.get(Project, project_id)
    if not proj: raise HTTPException(404, "Project not found")
    _check_access(proj, user)
    anns = db.query(Annotation).filter(
        Annotation.project_id == project_id, Annotation.scan_id == scan_id
    ).order_by(Annotation.created_at).all()
    return [_ann_dict(a) for a in anns]


@router.post("/{project_id}/scans/{scan_id}/annotations", status_code=201)
def create_annotation(project_id: int, scan_id: int, req: AnnotationCreate,
                      db: Session = Depends(get_db), user: User = Depends(get_current_active_user)):
    proj = db.get(Project, project_id)
    if not proj: raise HTTPException(404, "Project not found")
    _check_access(proj, user, require_edit=True)
    _ensure_scan_in_project(project_id, scan_id, db)
    bx, by, bw, bh = _bbox(req.annotation_type, req.geometry)
    ann = Annotation(project_id=project_id, scan_id=scan_id, created_by=user.id,
                     class_id=req.class_id, class_name=req.class_name,
                     annotation_type=req.annotation_type, geometry=req.geometry,
                     bbox_x=bx, bbox_y=by, bbox_w=bw, bbox_h=bh,
                     area_px=_area(req.annotation_type, req.geometry), notes=req.notes)
    db.add(ann); db.commit(); db.refresh(ann)
    return _ann_dict(ann)


@router.patch("/{project_id}/scans/{scan_id}/annotations/{ann_id}")
def update_annotation(project_id: int, scan_id: int, ann_id: int, req: AnnotationUpdate,
                      db: Session = Depends(get_db), user: User = Depends(get_current_active_user)):
    proj = db.get(Project, project_id)
    if not proj: raise HTTPException(404, "Project not found")
    _check_access(proj, user, require_edit=True)
    ann = db.get(Annotation, ann_id)
    if not ann or ann.project_id != project_id or ann.scan_id != scan_id:
        raise HTTPException(404, "Annotation not found")

    if req.class_id   is not None: ann.class_id   = req.class_id
    if req.class_name is not None: ann.class_name = req.class_name
    if req.notes      is not None: ann.notes      = req.notes
    if req.geometry   is not None:
        ann.geometry = req.geometry
        bx, by, bw, bh = _bbox(ann.annotation_type, req.geometry)
        ann.bbox_x, ann.bbox_y, ann.bbox_w, ann.bbox_h = bx, by, bw, bh
        ann.area_px = _area(ann.annotation_type, req.geometry)

    ann.updated_at = datetime.now(timezone.utc)
    db.commit(); db.refresh(ann)
    return _ann_dict(ann)


@router.delete("/{project_id}/scans/{scan_id}/annotations/{ann_id}", status_code=204)
def delete_annotation(project_id: int, scan_id: int, ann_id: int,
                      db: Session = Depends(get_db), user: User = Depends(get_current_active_user)):
    proj = db.get(Project, project_id)
    if not proj: raise HTTPException(404, "Project not found")
    _check_access(proj, user, require_edit=True)
    ann = db.get(Annotation, ann_id)
    if not ann or ann.project_id != project_id: raise HTTPException(404, "Annotation not found")
    db.delete(ann); db.commit()


@router.put("/{project_id}/scans/{scan_id}/annotations")
def bulk_save_annotations(project_id: int, scan_id: int, req: BulkAnnotationUpsert,
                          db: Session = Depends(get_db), user: User = Depends(get_current_active_user)):
    """Reconcile the scan's annotations against the submitted set.

    Used by auto-save on slide navigation. Rows are matched by id so that
    unchanged/edited annotations keep their original author and created_at
    (provenance) instead of being wiped and re-created on every save. Rows
    absent from the payload are deleted; rows without a matching DB id are
    inserted as new.
    """
    proj = db.get(Project, project_id)
    if not proj: raise HTTPException(404, "Project not found")
    _check_access(proj, user, require_edit=True)
    _ensure_scan_in_project(project_id, scan_id, db)

    existing = {
        a.id: a for a in db.query(Annotation).filter(
            Annotation.project_id == project_id, Annotation.scan_id == scan_id
        ).all()
    }
    now = datetime.now(timezone.utc)
    seen_ids = set()

    for item in req.annotations:
        bx, by, bw, bh = _bbox(item.annotation_type, item.geometry)
        area = _area(item.annotation_type, item.geometry)

        current = existing.get(item.id) if isinstance(item.id, int) else None
        if current is not None:
            seen_ids.add(current.id)
            changed = (
                current.class_id        != item.class_id or
                current.class_name      != item.class_name or
                current.annotation_type != item.annotation_type or
                current.geometry        != item.geometry or
                current.notes           != item.notes
            )
            if changed:
                current.class_id        = item.class_id
                current.class_name      = item.class_name
                current.annotation_type = item.annotation_type
                current.geometry        = item.geometry
                current.bbox_x, current.bbox_y, current.bbox_w, current.bbox_h = bx, by, bw, bh
                current.area_px         = area
                current.notes           = item.notes
                current.updated_at      = now
        else:
            db.add(Annotation(
                project_id=project_id, scan_id=scan_id, created_by=user.id,
                class_id=item.class_id, class_name=item.class_name,
                annotation_type=item.annotation_type, geometry=item.geometry,
                bbox_x=bx, bbox_y=by, bbox_w=bw, bbox_h=bh,
                area_px=area, notes=item.notes,
            ))

    for ann_id, ann in existing.items():
        if ann_id not in seen_ids:
            db.delete(ann)

    db.commit()
    return {"saved": len(req.annotations)}


# ─── Progress ─────────────────────────────────────────────────────────────────

@router.get("/{project_id}/progress")
def get_progress(project_id: int, db: Session = Depends(get_db),
                 user: User = Depends(get_current_active_user)):
    proj = db.get(Project, project_id)
    if not proj: raise HTTPException(404, "Project not found")
    _check_access(proj, user)
    return {
        "total_scans": db.query(func.count(ProjectScan.id)).filter(
            ProjectScan.project_id == project_id).scalar() or 0,
        "annotated_scans": db.query(func.count(func.distinct(Annotation.scan_id))).filter(
            Annotation.project_id == project_id).scalar() or 0,
        "total_annotations": db.query(func.count(Annotation.id)).filter(
            Annotation.project_id == project_id).scalar() or 0,
        "by_class": dict(
            db.query(Annotation.class_name, func.count(Annotation.id))
            .filter(Annotation.project_id == project_id)
            .group_by(Annotation.class_name).all()
        ),
    }


# ─── Export ───────────────────────────────────────────────────────────────────

@router.get("/{project_id}/export")
def export_project(project_id: int, db: Session = Depends(get_db),
                   user: User = Depends(get_current_active_user)):
    proj = db.get(Project, project_id)
    if not proj: raise HTTPException(404, "Project not found")
    _check_access(proj, user)

    anns      = db.query(Annotation).filter(Annotation.project_id == project_id).all()
    fname     = proj.name.replace(" ", "_")

    if proj.project_type == "cell_detection":
        buf    = io.StringIO()
        writer = csv.writer(buf)
        writer.writerow(["inst_id", "scan_id", "x", "y", "class_id", "class_name"])
        for a in anns:
            g = a.geometry
            if a.annotation_type == "point":
                x, y = g.get("x", 0), g.get("y", 0)
            else:
                x = float(a.bbox_x) + float(a.bbox_w) / 2
                y = float(a.bbox_y) + float(a.bbox_h) / 2
            writer.writerow([a.id, a.scan_id, round(x, 2), round(y, 2),
                             a.class_id or "", a.class_name or ""])
        buf.seek(0)
        return StreamingResponse(buf, media_type="text/csv",
            headers={"Content-Disposition": f'attachment; filename="{fname}_annotations.csv"'})

    # GeoJSON
    features = []
    for a in anns:
        g = a.geometry
        geom = None
        try:
            if a.annotation_type == "point":
                geom = {"type": "Point", "coordinates": [g["x"], g["y"]]}
            elif a.annotation_type in ("polygon", "brush"):
                pts = g.get("points", [])
                if len(pts) >= 3:
                    coords = [[p["x"], p["y"]] for p in pts] + [[pts[0]["x"], pts[0]["y"]]]
                    geom = {"type": "Polygon", "coordinates": [coords]}
            elif a.annotation_type == "rectangle":
                x, y, w, h = g["x"], g["y"], g["width"], g["height"]
                geom = {"type": "Polygon", "coordinates": [[[x,y],[x+w,y],[x+w,y+h],[x,y+h],[x,y]]]}
            elif a.annotation_type == "ellipse":
                cx, cy, rx, ry = g["cx"], g["cy"], g["rx"], g["ry"]
                coords = [[cx + rx*math.cos(2*math.pi*i/64), cy + ry*math.sin(2*math.pi*i/64)]
                          for i in range(64)]
                coords.append(coords[0])
                geom = {"type": "Polygon", "coordinates": [coords]}
        except (KeyError, TypeError):
            continue
        if geom:
            features.append({
                "type": "Feature",
                "properties": {"id": a.id, "scan_id": a.scan_id,
                               "class_id": a.class_id, "class_name": a.class_name,
                               "annotation_type": a.annotation_type,
                               "classification": {"name": a.class_name or "unclassified"}},
                "geometry": geom,
            })

    payload = json.dumps({"type": "FeatureCollection", "features": features}, indent=2)
    return StreamingResponse(io.StringIO(payload), media_type="application/json",
        headers={"Content-Disposition": f'attachment; filename="{fname}_annotations.geojson"'})


@router.post("/{project_id}/scans/{scan_id}/annotations/import", status_code=201)
async def import_annotations(
    project_id: int, scan_id: int,
    file: UploadFile = File(...),
    import_mode: str = Form("keep_all"),  # "keep_all" or "match_only"
    db: Session = Depends(get_db),
    user: User = Depends(get_current_active_user)
):
    proj = db.get(Project, project_id)
    if not proj: raise HTTPException(404, "Project not found")
    _check_access(proj, user, require_edit=True)
    _ensure_scan_in_project(project_id, scan_id, db)

    content = await file.read()
    try:
        data = json.loads(content)
    except json.JSONDecodeError:
        raise HTTPException(400, "Invalid JSON file")

    if data.get("type") != "FeatureCollection":
        raise HTTPException(400, "Must be a GeoJSON FeatureCollection")

    # Map project classes (case-insensitive for robust matching from other software)
    class_map = {c["name"].lower(): c for c in proj.classes}

    imported_count = 0
    features = data.get("features", [])

    for feat in features:
        geom = feat.get("geometry")
        if not geom: continue
        
        # Extract Class Name (handles QuPath, standard GeoJSON, and PathoDB exports)
        props = feat.get("properties", {})
        class_name = props.get("name")
        if not class_name and "classification" in props:
            class_name = props["classification"].get("name")
        if not class_name:
            class_name = props.get("class_name")
            
        class_id = None
        final_class_name = None
        
        if class_name:
            matched = class_map.get(class_name.lower())
            if matched:
                class_id = matched["id"]
                final_class_name = matched["name"]
            else:
                if import_mode == "match_only":
                    continue
                # keep_all -> Leave class_id empty, but preserve the string name as Unclassified
                final_class_name = class_name
        else:
            if import_mode == "match_only":
                continue

        # Geometry Translation
        g_type = geom.get("type")
        coords = geom.get("coordinates")
        if not coords: continue

        geoms_to_insert = []
        
        if g_type == "Point":
            geoms_to_insert.append(("point", {"x": coords[0], "y": coords[1]}))
        elif g_type == "Polygon":
            # standard polygons are list of rings: [ [ [x,y], ... ], [ [x,y], ... ] ]
            rings = [[{"x": p[0], "y": p[1]} for p in ring] for ring in coords]
            if len(rings) == 1:
                geoms_to_insert.append(("polygon", {"points": rings[0]}))
            else:
                geoms_to_insert.append(("polygon", {"points": rings}))
        elif g_type == "MultiPolygon":
            # multipolygons: [ [ [ [x,y] ] ] ] -> break into individual PathoDB Polygons
            for poly_coords in coords:
                rings = [[{"x": p[0], "y": p[1]} for p in ring] for ring in poly_coords]
                if len(rings) == 1:
                    geoms_to_insert.append(("polygon", {"points": rings[0]}))
                else:
                    geoms_to_insert.append(("polygon", {"points": rings}))
        else:
            continue # LineStrings etc. are skipped

        # Calculate bounding boxes and areas natively
        for ann_type, g_data in geoms_to_insert:
            bx, by, bw, bh = _bbox(ann_type, g_data)
            db.add(Annotation(
                project_id=project_id, scan_id=scan_id, created_by=user.id,
                class_id=class_id, class_name=final_class_name,
                annotation_type=ann_type, geometry=g_data,
                bbox_x=bx, bbox_y=by, bbox_w=bw, bbox_h=bh,
                area_px=_area(ann_type, g_data), notes=props.get("notes")
            ))
            imported_count += 1

    db.commit()
    return {"imported": imported_count}