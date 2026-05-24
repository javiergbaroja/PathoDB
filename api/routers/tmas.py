# api/routers/tmas.py
import csv
import codecs
from datetime import datetime, timezone
from fastapi import APIRouter, Depends, UploadFile, File, Form, HTTPException, status
from pydantic import BaseModel as PydanticModel
from sqlalchemy.orm import Session
from sqlalchemy import func
from typing import List, Optional
import re
import io

from ..database import get_db
from ..auth import get_current_user
from ..models import Project, TMACore, Block, Scan, ProjectScan, Stain, User, Probe, Submission

router = APIRouter(prefix="/tmas", tags=["TMAs"])


# ── Access control ─────────────────────────────────────────────────────────────

def _get_owned_tma(tma_id: int, db: Session, user: User) -> Project:
    """Fetch a TMA the current user owns, or raise 404.

    TMAs are owner-scoped (see list/patch/delete), so returning 404 for
    non-owned TMAs avoids leaking the existence of other users' data.
    """
    tma = db.query(Project).filter(
        Project.id == tma_id,
        Project.owner_id == user.id,
        Project.project_type == 'tma',
    ).first()
    if not tma:
        raise HTTPException(status_code=404, detail="TMA not found")
    return tma


# ── Serialization helper ───────────────────────────────────────────────────────

def _serialize_tma(tma: Project, db: Session) -> dict:
    scan_count = db.query(func.count(ProjectScan.id)).filter(
        ProjectScan.project_id == tma.id
    ).scalar() or 0

    core_count = db.query(func.count(TMACore.id)).filter(
        TMACore.project_id == tma.id
    ).scalar() or 0

    matched_count = db.query(func.count(TMACore.id)).filter(
        TMACore.project_id == tma.id,
        TMACore.donor_block_id.isnot(None)
    ).scalar() or 0

    first_ps = db.query(ProjectScan).filter(
        ProjectScan.project_id == tma.id
    ).order_by(ProjectScan.sort_order).first()

    return {
        "id":                   tma.id,
        "name":                 tma.name,
        "description":          tma.description,
        "project_type":         tma.project_type,
        "owner_id":             tma.owner_id,
        "created_at":           tma.created_at.isoformat() if tma.created_at else None,
        "updated_at":           tma.updated_at.isoformat() if tma.updated_at else None,
        "scan_count":           scan_count,
        "core_count":           core_count,
        "matched_core_count":   matched_count,
        "unmatched_core_count": core_count - matched_count,
        "first_scan_id":        first_ps.scan_id if first_ps else None,
    }


# ── Pydantic schema ────────────────────────────────────────────────────────────

class TMAPatchRequest(PydanticModel):
    name:        Optional[str] = None
    description: Optional[str] = None


# ── Endpoints ──────────────────────────────────────────────────────────────────

@router.get("")
def list_tmas(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    tmas = db.query(Project).filter(
        Project.project_type == 'tma',
        Project.owner_id == current_user.id
    ).order_by(Project.updated_at.desc()).all()
    return [_serialize_tma(t, db) for t in tmas]


@router.post("", status_code=status.HTTP_201_CREATED)
def create_tma(
    name:        str  = Form(...),
    description: str  = Form(""),
    db:          Session = Depends(get_db),
    current_user: User   = Depends(get_current_user)
):
    new_tma = Project(
        owner_id=current_user.id,
        name=name,
        description=description,
        project_type='tma',
        source_type='file_import'
    )
    db.add(new_tma)
    db.commit()
    db.refresh(new_tma)
    return _serialize_tma(new_tma, db)


@router.get("/{tma_id}")
def get_tma(tma_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    tma = _get_owned_tma(tma_id, db, current_user)
    return _serialize_tma(tma, db)


@router.patch("/{tma_id}")
def patch_tma(
    tma_id: int,
    req:    TMAPatchRequest,
    db:     Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    tma = db.query(Project).filter(
        Project.id == tma_id,
        Project.owner_id == current_user.id,
        Project.project_type == 'tma'
    ).first()
    if not tma:
        raise HTTPException(status_code=404, detail="TMA not found or unauthorized")
    if req.name is not None:
        tma.name = req.name
    if req.description is not None:
        tma.description = req.description
    tma.updated_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(tma)
    return _serialize_tma(tma, db)


@router.get("/{tma_id}/cores")
def get_tma_cores(tma_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    _get_owned_tma(tma_id, db, current_user)

    cores = db.query(TMACore).filter(TMACore.project_id == tma_id).all()
    result = []
    for core in cores:
        block_label    = None
        lis_probe_id   = None
        lis_submission_id = None
        patient_code   = None

        if core.donor_block_id:
            block = db.get(Block, core.donor_block_id)
            if block:
                block_label = block.block_label
                probe = db.get(Probe, block.probe_id) if block else None
                if probe:
                    lis_probe_id = probe.lis_probe_id
                    sub = db.get(Submission, probe.submission_id)
                    if sub:
                        lis_submission_id = sub.lis_submission_id
                        from ..models import Patient
                        patient = db.get(Patient, sub.patient_id)
                        if patient:
                            patient_code = patient.patient_code

        result.append({
            "id":                  core.id,
            "row_idx":             core.row_idx,
            "col_idx":             core.col_idx,
            "donor_block_id":      core.donor_block_id,
            "core_type":           core.core_type,
            "control_description": core.control_description,
            "block_label":         block_label,
            "lis_probe_id":        lis_probe_id,
            "lis_submission_id":   lis_submission_id,
            "patient_code":        patient_code,
        })
    return result


@router.post("/{tma_id}/batch-cores", status_code=status.HTTP_201_CREATED)
async def upload_tma_cores(
    tma_id: int,
    file:   UploadFile = File(...),
    db:     Session    = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    _get_owned_tma(tma_id, db, current_user)

    content = await file.read()
    try:
        text = content.decode('utf-8-sig')
    except UnicodeDecodeError:
        text = content.decode('latin-1')

    delimiter = ';' if ';' in text.split('\n')[0] else ','
    csvReader = csv.DictReader(io.StringIO(text), delimiter=delimiter)

    cores_to_insert = []

    for row in csvReader:
        clean_row = {str(k).strip().lower(): str(v).strip() for k, v in row.items() if k is not None}

        try:
            r_idx, c_idx = int(clean_row.get('row', -1)), int(clean_row.get('col', -1))
        except ValueError:
            continue
        if r_idx < 0 or c_idx < 0:
            continue

        identifier    = clean_row.get('identifier') or ''
        core_type     = clean_row.get('core_type', 'tissue').lower()
        control_desc  = clean_row.get('description') or ''
        donor_block_id = None

        if identifier:
            normalized_id = identifier.replace('-', '_')
            parts = [p for p in normalized_id.split('_') if p]

            if parts:
                sub_id_raw = parts[0]
                probe_str  = None
                block_str  = None

                if len(parts) >= 3:
                    probe_str = parts[1]
                    block_label = parts[2]
                elif len(parts) == 2:
                    remainder = parts[1]
                    m = re.match(r'^(\d+)([a-zA-Z]+)$', remainder)
                    if m:
                        probe_str = m.group(1)
                        block_str = m.group(2)
                    elif re.match(r'^(\d+|I{1,3}|IV|V|VI{0,3}|IX|X)$', remainder, re.IGNORECASE):
                        probe_str = remainder
                    else:
                        block_str = remainder

                def find_probe(p_str):
                    sub_id_alt = sub_id_raw.replace('B', 'B20') if len(sub_id_raw.split('.')[0]) == 3 else sub_id_raw
                    subs = db.query(Submission.id).filter(Submission.lis_submission_id.in_([sub_id_raw, sub_id_alt])).all()
                    sub_db_ids = [s[0] for s in subs]
                    candidates = []
                    if p_str:
                        candidates.append(p_str)
                        try:
                            candidates.append(f"{sub_id_raw}/{int(p_str):03d}")
                        except ValueError:
                            pass
                    else:
                        candidates.extend([sub_id_raw, f"{sub_id_raw}/001", "1"])
                    for cand in candidates:
                        q = db.query(Probe).filter(Probe.lis_probe_id == cand)
                        if cand in ("1", p_str) and not cand.startswith('B'):
                            if not sub_db_ids:
                                continue
                            q = q.filter(Probe.submission_id.in_(sub_db_ids))
                        probe = q.first()
                        if probe:
                            return probe
                    return None

                target_probe   = find_probe(probe_str)
                actual_block_str = block_str

                if not target_probe and probe_str and not block_str:
                    target_probe     = find_probe(None)
                    actual_block_str = probe_str

                if target_probe:
                    blocks = db.query(Block).filter(Block.probe_id == target_probe.id).all()
                    if blocks:
                        if actual_block_str:
                            for b in blocks:
                                if b.block_label and b.block_label.upper() == actual_block_str.upper():
                                    donor_block_id = b.id
                                    break
                        if not donor_block_id and len(blocks) == 1:
                            donor_block_id = blocks[0].id

        cores_to_insert.append(TMACore(
            project_id=tma_id,
            row_idx=r_idx,
            col_idx=c_idx,
            donor_block_id=donor_block_id,
            core_type=core_type,
            control_description=control_desc or None
        ))

    try:
        db.query(TMACore).filter(TMACore.project_id == tma_id).delete()
        db.bulk_save_objects(cores_to_insert)
        db.commit()
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))

    matched = sum(1 for c in cores_to_insert if c.donor_block_id is not None)
    return {
        "message": f"Mapped {len(cores_to_insert)} cores.",
        "total":   len(cores_to_insert),
        "matched": matched,
    }


@router.post("/{tma_id}/batch-scans", status_code=status.HTTP_201_CREATED)
async def upload_tma_scans(
    tma_id: int,
    file:   UploadFile = File(...),
    db:     Session    = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    _get_owned_tma(tma_id, db, current_user)

    content = await file.read()
    try:
        text = content.decode('utf-8-sig')
    except UnicodeDecodeError:
        text = content.decode('latin-1')

    delimiter = ';' if ';' in text.split('\n')[0] else ','
    csvReader = csv.DictReader(io.StringIO(text), delimiter=delimiter)

    all_stains      = db.query(Stain).all()
    processed_count = 0
    added_scans     = 0

    for row in csvReader:
        clean_row  = {str(k).strip().lower(): str(v).strip() for k, v in row.items() if k is not None}
        file_path  = clean_row.get('file_path', '')
        stain_name = clean_row.get('stain_name', '')
        if not file_path or not stain_name:
            continue

        processed_count += 1
        stain_id = None
        for s in all_stains:
            if s.stain_name.lower() == stain_name.lower():
                stain_id = s.id
                break
            if s.aliases and any(a.lower() == stain_name.lower() for a in s.aliases):
                stain_id = s.id
                break

        if not stain_id:
            raise HTTPException(status_code=400, detail=f"Stain '{stain_name}' not registered.")

        existing_scan = db.query(Scan).filter(Scan.file_path == file_path).first()
        if not existing_scan:
            existing_scan = Scan(
                stain_id=stain_id,
                file_path=file_path,
                block_id=None,
                registered_by=current_user.id
            )
            db.add(existing_scan)
            db.commit()
            db.refresh(existing_scan)

        if not db.query(ProjectScan).filter_by(project_id=tma_id, scan_id=existing_scan.id).first():
            new_link = ProjectScan(
                project_id=tma_id,
                scan_id=existing_scan.id,
                sort_order=db.query(func.max(ProjectScan.sort_order)).filter_by(project_id=tma_id).scalar() or 1
            )
            db.add(new_link)
            added_scans += 1

    db.commit()

    if processed_count == 0:
        return {"message": "Registered 0 WSI scans.", "total": 0, "added": 0}
    return {"message": f"Processed {processed_count} valid scans.", "total": processed_count, "added": added_scans}


@router.delete("/{tma_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_tma(
    tma_id: int,
    db:     Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    tma = db.query(Project).filter(
        Project.id == tma_id,
        Project.owner_id == current_user.id,
        Project.project_type == 'tma'
    ).first()
    if not tma:
        raise HTTPException(status_code=404, detail="TMA not found or unauthorized")

    # TMACore uses backref (no cascade) — must delete manually before project
    db.query(TMACore).filter(TMACore.project_id == tma_id).delete(synchronize_session=False)

    # ProjectScan and ProjectShare have cascade="all, delete-orphan" on Project model
    db.delete(tma)
    db.commit()
    return None