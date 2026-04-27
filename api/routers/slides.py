"""
PathoDB API — Slides Router
Serves DZI tile streams, thumbnails, slide metadata, and related scan lists
for the OpenSeadragon-based slide viewer.
"""
import io
import math
import logging
import re
from functools import lru_cache
from pathlib import Path

import openslide
from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import Scan, Block, Probe, Submission, Patient, Report, Stain
from ..auth import get_current_active_user, decode_token
from ..config import get_settings

log      = logging.getLogger("pathodb_slides")
settings = get_settings()

router = APIRouter(prefix="/slides", tags=["slides"])

TILE_SIZE    = 254
TILE_OVERLAP = 1
JPEG_QUALITY = 85

# ─── Tiny in-process tile cache ───────────────────────────────────────────────
_cache: dict = {}
_MAX_CACHE   = 512

def _cache_key(scan_id, level, col, row):
    return f"{scan_id}/{level}/{col}/{row}"

def _cache_get(key):
    return _cache.get(key)

def _cache_set(key, value):
    if len(_cache) >= _MAX_CACHE:
        try:
            _cache.pop(next(iter(_cache)))
        except StopIteration:
            pass
    _cache[key] = value


# ─── Helpers ──────────────────────────────────────────────────────────────────

def _auth_token(token: str = Query(...), db: Session = Depends(get_db)):
    """Validate the ?token= query parameter used by OSD tile URLs."""
    payload = decode_token(token)
    return payload


def _get_scan_or_404(scan_id: int, db: Session) -> Scan:
    scan = db.get(Scan, scan_id)
    if not scan:
        raise HTTPException(status_code=404, detail="Scan not found")
    return scan


def _open_slide(file_path: str) -> openslide.OpenSlide:
    try:
        return openslide.open_slide(file_path)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Cannot open slide: {e}")
    
def _get_dimensions(slide: openslide.OpenSlide):
    props = dict(slide.properties)
    if "openslide.bounds-width" in props:
        w = int(props["openslide.bounds-width"])
        h = int(props["openslide.bounds-height"])
    else:
        w, h = slide.dimensions
    return w, h


# ─── Slide info ───────────────────────────────────────────────────────────────

@router.get("/{scan_id}/info")
def get_slide_info(
    scan_id: int,
    token:   str     = Query(...),
    db:      Session = Depends(get_db),
    _payload          = Depends(_auth_token),
):
    scan  = _get_scan_or_404(scan_id, db)
    block = db.get(Block, scan.block_id)
    probe = db.get(Probe, block.probe_id) if block else None
    sub   = db.get(Submission, probe.submission_id) if probe else None
    patient = db.get(Patient, sub.patient_id) if sub else None

    reports = {}
    if sub:
        for r in db.query(Report).filter(Report.submission_id == sub.id).all():
            reports[r.report_type] = r.report_text

    # Slide technical metadata
    slide = _open_slide(scan.file_path)
    try:
        w, h = _get_dimensions(slide)
        props = dict(slide.properties)
        mpp_x_raw = props.get("openslide.mpp-x")
        obj_power = props.get("openslide.objective-power")
        if mpp_x_raw:
            try:
                mpp_val = float(mpp_x_raw)
                if mpp_val < 0.18:
                    obj_power = "80"
                if mpp_val < 0.35:
                    obj_power = "40"
                elif mpp_val < 0.75:
                    obj_power = "20"
                elif mpp_val < 1.5:
                    obj_power = "10"
                else:
                    obj_power = "5"
            except ValueError:
                pass
            
        tech  = {
            "width":           w,
            "height":          h,
            "level_count":     slide.level_count,
            "mpp_x":           props.get("openslide.mpp-x"),
            "mpp_y":           props.get("openslide.mpp-y"),
            "objective_power": obj_power,
            "vendor":          props.get("openslide.vendor"),
            "bounds_x":        int(props.get("openslide.bounds-x", 0) or 0),
            "bounds_y":        int(props.get("openslide.bounds-y", 0) or 0),
        }
    finally:
        slide.close()

    return {
        # Technical
        "scan_id":         scan_id,
        "file_format":     scan.file_format,
        "stain_name":      scan.stain.stain_name     if scan.stain else None,
        "stain_category":  scan.stain.stain_category if scan.stain else None,
        **tech,

        # Clinical — block
        "block_label":     block.block_label  if block else None,
        "block_info":      block.block_info   if block else None,
        "tissue_count":    block.tissue_count if block else None,

        # Clinical — probe
        "lis_probe_id":        probe.lis_probe_id        if probe else None,
        "snomed_topo_code":    probe.snomed_topo_code    if probe else None,
        "topo_description":    probe.topo_description    if probe else None,
        "location_additional": probe.location_additional if probe else None,
        "submission_type":     probe.submission_type     if probe else None,

        # Clinical — submission
        "lis_submission_id": sub.lis_submission_id if sub else None,
        "report_date":       str(sub.report_date)  if sub and sub.report_date else None,
        "malignancy_flag":   sub.malignancy_flag   if sub else None,

        # Clinical — patient
        "patient_code":  patient.patient_code  if patient else None,
        "patient_sex":   patient.sex           if patient else None,
        "date_of_birth": str(patient.date_of_birth) if patient and patient.date_of_birth else None,

        # Reports
        "report_macro":       reports.get("macro"),
        "report_microscopy":  reports.get("microscopy"),
    }


# ─── DZI descriptor ───────────────────────────────────────────────────────────

@router.get("/{scan_id}/dzi")
def get_dzi(
    scan_id: int,
    token:   str     = Query(...),
    db:      Session = Depends(get_db),
    _payload          = Depends(_auth_token),
):
    scan  = _get_scan_or_404(scan_id, db)
    slide = _open_slide(scan.file_path)
    try:
        w, h = _get_dimensions(slide)
        
    finally:
        slide.close()

    xml = f"""<?xml version="1.0" encoding="UTF-8"?>
<Image xmlns="http://schemas.microsoft.com/deepzoom/2008"
  Format="jpeg"
  Overlap="{TILE_OVERLAP}"
  TileSize="{TILE_SIZE}">
  <Size Width="{w}" Height="{h}"/>
</Image>"""
    return Response(content=xml, media_type="application/xml")


# ─── Tile endpoint ────────────────────────────────────────────────────────────

@router.get("/{scan_id}/dzi_files/{level}/{tile_name}")
def get_tile(
    scan_id:   int,
    level:     int,
    tile_name: str,
    token:     str     = Query(...),
    db:        Session = Depends(get_db),
    _payload            = Depends(_auth_token),
):
    try:
        name_part = tile_name.replace(".jpeg", "").replace(".jpg", "")
        col, row  = map(int, name_part.split('_'))
    except Exception:
        raise HTTPException(status_code=400, detail=f"Invalid tile name: {tile_name}")

    key    = _cache_key(scan_id, level, col, row)
    cached = _cache_get(key)
    if cached:
        return Response(content=cached, media_type="image/jpeg",
                        headers={"Cache-Control": "public, max-age=3600", "X-Cache": "HIT"})

    scan  = _get_scan_or_404(scan_id, db)
    slide = _open_slide(scan.file_path)

    try:
        w, h = _get_dimensions(slide)
        props = dict(slide.properties)
        
        bounds_x = int(props.get("openslide.bounds-x", 0) or 0)
        bounds_y = int(props.get("openslide.bounds-y", 0) or 0)
        max_level = math.ceil(math.log2(max(w, h)))

        if level > max_level:
            raise HTTPException(status_code=404, detail="Level out of range")

        scale   = 2 ** (max_level - level)
        level_w = max(1, math.ceil(w / scale))
        level_h = max(1, math.ceil(h / scale))

        tx = col * TILE_SIZE - (TILE_OVERLAP if col > 0 else 0)
        ty = row * TILE_SIZE - (TILE_OVERLAP if row > 0 else 0)

        if tx >= level_w or ty >= level_h:
            raise HTTPException(status_code=404, detail="Tile out of bounds")

        tw = min(TILE_SIZE + (TILE_OVERLAP if col > 0 else 0) + TILE_OVERLAP, level_w - tx)
        th = min(TILE_SIZE + (TILE_OVERLAP if row > 0 else 0) + TILE_OVERLAP, level_h - ty)

        best_level = slide.get_best_level_for_downsample(scale)
        best_ds    = slide.level_downsamples[best_level]

        # 2. Add the bounds offsets to the calculated absolute coordinates
        x0     = int(tx * scale) + bounds_x
        y0     = int(ty * scale) + bounds_y
        
        read_w = max(1, math.ceil(tw * scale / best_ds))
        read_h = max(1, math.ceil(th * scale / best_ds))

        # 3. read_region now fetches from the correct physical location
        region = slide.read_region((x0, y0), best_level, (read_w, read_h))
        region = region.convert("RGB")

        if region.size != (tw, th):
            from PIL import Image
            region = region.resize((tw, th), Image.LANCZOS)

        buf = io.BytesIO()
        region.save(buf, format="JPEG", quality=JPEG_QUALITY)
        tile_bytes = buf.getvalue()
    finally:
        slide.close()

    _cache_set(key, tile_bytes)
    return Response(content=tile_bytes, media_type="image/jpeg",
                    headers={"Cache-Control": "public, max-age=3600", "X-Cache": "MISS"})


# ─── Thumbnail ────────────────────────────────────────────────────────────────

@router.get("/{scan_id}/thumbnail")
def get_thumbnail(
    scan_id: int,
    width:   int = Query(512, ge=64, le=1024),
    token:   str = Query(...),
    db:      Session = Depends(get_db),
    _payload          = Depends(_auth_token),
):
    scan  = _get_scan_or_404(scan_id, db)
    slide = _open_slide(scan.file_path)
    try:
        w, h   = _get_dimensions(slide)
        aspect = h / w
        thumb  = slide.get_thumbnail((width, int(width * aspect)))
        thumb  = thumb.convert("RGB")
        buf    = io.BytesIO()
        thumb.save(buf, format="JPEG", quality=85)
    finally:
        slide.close()

    return Response(content=buf.getvalue(), media_type="image/jpeg",
                    headers={"Cache-Control": "public, max-age=86400"})


# ─── Related scans ────────────────────────────────────────────────────────────

@router.get("/{scan_id}/related")
def get_related_scans(
    scan_id: int,
    token:   str     = Query(...),
    db:      Session = Depends(get_db),
    _payload          = Depends(_auth_token),
):
    scan  = _get_scan_or_404(scan_id, db)
    block = db.get(Block, scan.block_id)
    if not block: return []

    probe = db.get(Probe, block.probe_id)
    sub   = db.get(Submission, probe.submission_id)

    probes    = db.query(Probe).filter(Probe.submission_id == sub.id).all()
    probe_ids = [p.id for p in probes]
    blocks    = db.query(Block).filter(Block.probe_id.in_(probe_ids)).all()
    block_map = {b.id: b for b in blocks}
    probe_map = {p.id: p for p in probes}
    scans     = db.query(Scan).filter(Scan.block_id.in_(block_map.keys())).all()

    results = []
    for s in scans:
        b = block_map[s.block_id]
        p = probe_map[b.probe_id]

        lis_sub   = sub.lis_submission_id or ""
        lis_probe = p.lis_probe_id or ""
        b_label   = b.block_label or "A"

        # Smart era-aware label
        if "/" in lis_probe:
            parts = lis_probe.split('/')
            try:
                display_label = f"{parts[0]}_{int(parts[1])}-{b_label}"
            except ValueError:
                display_label = f"{lis_probe}-{b_label}"
        elif lis_probe.upper().startswith("B20") or lis_probe.upper().startswith("B19"):
            display_label = f"{lis_probe}_{b_label}"
        else:
            display_label = f"{lis_sub}_{lis_probe}-{b_label}"

        results.append({
            "scan_id":          s.id,
            "block_id":         b.id,
            "block_label":      b_label,
            "probe_id":         p.id,
            "lis_probe_id":     p.lis_probe_id or "",
            "topo_description": p.topo_description or "Unknown Site",
            "stain_name":       s.stain.stain_name     if s.stain else "Unmatched",
            "stain_category":   s.stain.stain_category if s.stain else "other",
            "magnification":    float(s.magnification) if s.magnification else None,
            "file_format":      s.file_format,
            "display_label":    display_label,
            "is_current_block": s.block_id == scan.block_id,
            "is_current_scan":  s.id == scan.id,
        })

    return results