# api/routers/tmas.py
import csv
import codecs
from fastapi import APIRouter, Depends, UploadFile, File, Form, HTTPException, status
from sqlalchemy.orm import Session
from sqlalchemy import func
from typing import List
import re
import io

from ..database import get_db
from ..auth import get_current_user
from ..models import Project, TMACore, Block, Scan, ProjectScan, Stain, User, Probe, Submission

router = APIRouter(prefix="/tmas", tags=["TMAs"])

@router.get("")
def list_tmas(db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    """Fetch all TMAs owned by or shared with the user."""
    # Leveraging existing project structure but filtering strictly for TMAs
    return db.query(Project).filter(
        Project.project_type == 'tma',
        Project.owner_id == current_user.id # Add sharing logic here later if needed
    ).order_by(Project.updated_at.desc()).all()

@router.post("", status_code=status.HTTP_201_CREATED)
def create_tma(
    name: str = Form(...),
    description: str = Form(""),
    is_public: bool = Form(False),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """Creates the TMA shell."""
    new_tma = Project(
        owner_id=current_user.id,
        name=name,
        description=description,
        project_type='tma',
        source_type='file_import' # Defaulting for schema compliance
    )
    db.add(new_tma)
    db.commit()
    db.refresh(new_tma)
    return new_tma

@router.get("/{tma_id}")
def get_tma(tma_id: int, db: Session = Depends(get_db), current_user: User = Depends(get_current_user)):
    tma = db.query(Project).filter(Project.id == tma_id, Project.project_type == 'tma').first()
    if not tma:
        raise HTTPException(status_code=404, detail="TMA not found")
    return tma


@router.post("/{tma_id}/batch-cores", status_code=status.HTTP_201_CREATED)
async def upload_tma_cores(
    tma_id: int,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """Parses WSI grid mapping from CSV."""
    tma = db.query(Project).filter(Project.id == tma_id, Project.project_type == 'tma').first()
    if not tma:
        raise HTTPException(status_code=404, detail="TMA not found")

    content = await file.read()
    try:
        text = content.decode('utf-8-sig')
    except UnicodeDecodeError:
        text = content.decode('latin-1')
        
    delimiter = ';' if ';' in text.split('\n')[0] else ','
    csvReader = csv.DictReader(io.StringIO(text), delimiter=delimiter)
    
    cores_to_insert = []
    
    for row in csvReader:
        # Clean headers
        clean_row = {str(k).strip().lower(): str(v).strip() for k, v in row.items() if k is not None}
        
        try:
            r_idx, c_idx = int(clean_row.get('row', -1)), int(clean_row.get('col', -1))
        except ValueError:
            continue
        if r_idx < 0 or c_idx < 0:
            continue

        identifier = clean_row.get('identifier') or clean_row.get('indentifier') or ''
        core_type = clean_row.get('core_type', 'tissue').lower()
        control_desc = clean_row.get('control_description') or clean_row.get('description') or ''
        donor_block_id = None
        
        
        if identifier:
            normalized_id = identifier.replace('-', '_')
            parts = [p for p in normalized_id.split('_') if p]
            
            if parts:
                sub_id_raw = parts[0]
                probe_str = None
                block_str = None
                
                # 1. Parse the strings
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
                        # Looks like a probe numeral, but could be a numeric block label
                        probe_str = remainder
                    else:
                        block_str = remainder

                # 2. Helper function to find the Probe mimicking ETL era-logic
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
                        # If cand is generic ('1' or 'II'), it MUST belong to the specific submission
                        if cand in ("1", p_str) and not cand.startswith('B'):
                            if not sub_db_ids:
                                continue
                            q = q.filter(Probe.submission_id.in_(sub_db_ids))
                        
                        probe = q.first()
                        if probe:
                            return probe
                    return None

                target_probe = find_probe(probe_str)
                actual_block_str = block_str
                
                # Edge Case: The user typed B15.12345_1. Our regex guessed '1' was the probe, 
                # but it was actually the block label for a single-probe era 2 case.
                if not target_probe and probe_str and not block_str:
                    target_probe = find_probe(None)
                    actual_block_str = probe_str

                # 3. Resolve the Block
                if target_probe:
                    blocks = db.query(Block).filter(Block.probe_id == target_probe.id).all()
                    
                    if blocks:
                        # Attempt explicit label match
                        if actual_block_str:
                            for b in blocks:
                                if b.block_label and b.block_label.upper() == actual_block_str.upper():
                                    donor_block_id = b.id
                                    break
                        
                        # THE FIX: Auto-resolve if exact match failed and exactly 1 block exists
                        if not donor_block_id and len(blocks) == 1:
                            donor_block_id = blocks[0].id
                            
                
        new_core = TMACore(
            project_id=tma_id,
            row_idx=r_idx,
            col_idx=c_idx,
            donor_block_id=donor_block_id,
            core_type=core_type,
            control_description=control_desc if core_type == 'control' else None
        )
        cores_to_insert.append(new_core)

    try:
        db.query(TMACore).filter(TMACore.project_id == tma_id).delete()
        db.bulk_save_objects(cores_to_insert)
        db.commit()
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=str(e))

    return {"message": f"Mapped {len(cores_to_insert)} cores."}



@router.post("/{tma_id}/batch-scans", status_code=status.HTTP_201_CREATED)
async def upload_tma_scans(
    tma_id: int,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user)
):
    """Registers absolute NFS paths as TMA scans."""
    tma = db.query(Project).filter(Project.id == tma_id, Project.project_type == 'tma').first()
    if not tma:
        raise HTTPException(status_code=404, detail="TMA not found")

    # Robust memory reading to avoid async stream exhaustion
    content = await file.read()
    try:
        text = content.decode('utf-8-sig')
    except UnicodeDecodeError:
        text = content.decode('latin-1')

    # Handle European Excel exports (semicolon vs comma)
    delimiter = ';' if ';' in text.split('\n')[0] else ','
    csvReader = csv.DictReader(io.StringIO(text), delimiter=delimiter)
    
    all_stains = db.query(Stain).all()
    processed_count = 0
    added_scans = 0
    
    for row in csvReader:
        # Case-insensitive, space-stripped headers
        clean_row = {str(k).strip().lower(): str(v).strip() for k, v in row.items() if k is not None}
        
        file_path = clean_row.get('file_path', '')
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
            existing_scan = Scan(stain_id=stain_id, file_path=file_path, block_id=None, registered_by=current_user.id)
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
    
    # Only fail the frontend if it literally couldn't find a single valid line
    if processed_count == 0:
        return {"message": "Registered 0 WSI scans."}
        
    return {"message": f"Processed {processed_count} valid scans (Added {added_scans} new)."}


@router.delete("/{tma_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_tma(
    tma_id: int, 
    db: Session = Depends(get_db), 
    current_user: User = Depends(get_current_user)
):
    # Only allow owners to delete
    tma = db.query(Project).filter(Project.id == tma_id, Project.owner_id == current_user.id).first()
    if not tma:
        raise HTTPException(status_code=404, detail="TMA not found or unauthorized")
        
    db.delete(tma)
    db.commit()
    return None