// frontend/src/pages/ProjectDetail/AnnotationLayer.jsx
//
// Full re-implementation of the brush tool to match QuPath's BrushToolEventHandler.
//
// Key behavioural changes vs previous version:
//  • Brush ROI is built INCREMENTALLY each drag event (union / subtract) rather
//    than collecting raw points and converting only at mouseUp.
//  • Alt key (or PointerEvent eraser button) → subtract mode.
//  • BrushLimits overlay: two concentric SVG rings that track the cursor.
//  • Alt + wheel → adjust brush radius (clamped 10–500 image-px).
//  • 'F' key while drawing → fill holes in current brush ROI.
//  • Pen / pointer pressure scales brush radius when > 0.
//  • Annotating an existing ROI: the annotation is removed from the live list
//    during the stroke and re-committed on mouseUp (matching QuPath's
//    removeObjectWithoutUpdate pattern).
//
// Coordinate helpers are imported from useOSDViewer (unchanged).
// Geometry helpers are imported from PolygonOps (new file).

import { useState, useEffect, useRef } from 'react'
import { imageToElement, elementToImage } from '../../hooks/useOSDViewer'
import { strokeToPolygon }               from '../../lib/BrushEngine'
import {
  union, difference, constrainToBounds,
  fillHoles, simplify, roundCoordinates,
} from '../../lib/PolygonOps'
import BrushLimits from './BrushLimits'

// ─── visual constants ─────────────────────────────────────────────────────────
const VERTEX_R       = 5
const FIRST_VERTEX_R = 7
const CLOSE_THRESH   = 14
const MIN_DRAG       = 4
const BRUSH_SEGMENTS = 12

// ─── brush geometry ───────────────────────────────────────────────────────────

/** Circle polygon centred at (cx, cy) with radius r. */
function circlePoly(cx, cy, r, n = 32) {
  const pts = []
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n
    pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) })
  }
  return pts
}

/**
 * Buffered segment between (x1,y1) and (x2,y2) — the "capsule" QuPath draws
 * with its JTS geometry.buffer(diameter/2) call.
 */
function capsulePoly(x1, y1, x2, y2, r) {
  return strokeToPolygon([{ x: x1, y: y1 }, { x: x2, y: y2 }], r, 12)
}

// ─── SVG path helper ──────────────────────────────────────────────────────────
function toSVGPath(pts, closed) {
  if (!pts.length) return ''
  return pts.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')
    + (closed ? ' Z' : '')
}

function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y) }

// ─── project stored annotation into element-space for rendering ───────────────
function projectAnnotation(viewer, ann) {
  if (!viewer?.viewport) return null
  const g = ann.geometry
  try {
    switch (ann.annotation_type) {
      case 'point': {
        const e = imageToElement(viewer, g.x, g.y)
        return e ? { type: 'point', e } : null
      }
      case 'rectangle': {
        const corners = [
          { x: g.x,           y: g.y },
          { x: g.x + g.width, y: g.y },
          { x: g.x + g.width, y: g.y + g.height },
          { x: g.x,           y: g.y + g.height },
        ]
        const proj = corners.map(p => imageToElement(viewer, p.x, p.y)).filter(Boolean)
        return proj.length === 4 ? { type: 'polygon', pts: proj } : null
      }
      case 'ellipse': {
        const N = 48
        const pts = []
        for (let i = 0; i < N; i++) {
          const a  = (2 * Math.PI * i) / N
          const e  = imageToElement(viewer, g.cx + g.rx * Math.cos(a), g.cy + g.ry * Math.sin(a))
          if (e) pts.push(e)
        }
        return pts.length > 3 ? { type: 'polygon', pts } : null
      }
      case 'polygon':
      case 'brush': {
        const pts = (g.points || []).map(p => imageToElement(viewer, p.x, p.y)).filter(Boolean)
        return pts.length > 1 ? { type: 'polygon', pts } : null
      }
      default: return null
    }
  } catch { return null }
}

// ─── single saved annotation shape ───────────────────────────────────────────
function AnnotationShape({ viewer, ann, selected, onClick }) {
  const proj = projectAnnotation(viewer, ann)
  if (!proj) return null
  const color   = ann._color || '#6ee7b7'
  const alpha   = selected ? 0.55 : 0.35
  const strokeW = selected ? 2 : 1.5
  const strokeC = selected ? '#fff' : color
  if (proj.type === 'point') {
    const { x, y } = proj.e
    return (
      <g onClick={() => onClick(ann)} style={{ cursor: 'pointer' }}>
        <circle cx={x} cy={y} r={selected ? 9 : 7}
          fill={color} fillOpacity={alpha + 0.2}
          stroke={strokeC} strokeWidth={strokeW} />
        <circle cx={x} cy={y} r={3} fill={strokeC} />
      </g>
    )
  }
  return (
    <g onClick={() => onClick(ann)} style={{ cursor: 'pointer' }}>
      <path d={toSVGPath(proj.pts, true)}
        fill={color} fillOpacity={alpha}
        stroke={strokeC} strokeWidth={strokeW} strokeLinejoin="round" />
      {selected && proj.pts.map((p, i) => (
        <circle key={i} cx={p.x} cy={p.y} r={4}
          fill={strokeC} stroke="rgba(0,0,0,0.5)" strokeWidth={1} />
      ))}
    </g>
  )
}

// ─── main component ───────────────────────────────────────────────────────────
export default function AnnotationLayer({
  osdRef,
  activeTool,
  activeClass,
  brushRadius,
  setBrushRadius,       // ← NEW: required so Alt+scroll can update the parent
  annotations,
  selectedAnnId,
  onAnnotationClick,
  onAnnotationCreated,
  readOnly,
  tick,
}) {
  const svgRef = useRef(null)

  // ── in-progress polygon (non-brush tools) ─────────────────────────────────
  const [polyPts,    setPolyPts]    = useState([])
  const [mouse,      setMouse]      = useState(null)   // element-space {x,y}
  const [dragStart,  setDragStart]  = useState(null)
  const [dragEnd,    setDragEnd]    = useState(null)
  const [isSpacePan, setIsSpacePan] = useState(false)
  const [isMiddlePan, setIsMiddlePan] = useState(false)

  const isSpacePanRef = useRef(false)
  const isMiddlePanRef = useRef(false)
  const navOverride = isSpacePan || isMiddlePan

  const polyRef = useRef([])
  useEffect(() => { polyRef.current = polyPts }, [polyPts])

  // ── brush state ───────────────────────────────────────────────────────────
  //
  // brushROI    — the polygon being built this stroke, in image-pixel coords.
  // brushROIRef — ref always in sync (read inside async pointer events).
  // lastBrushPt — previous image-space point (for capsule geometry).
  // editingAnn  — annotation that was "removed without update" at mouseDown
  //               so we can union with it; null when creating fresh.
  // subtractMode — true when Alt is held or eraser stylus is active.
  // brushDown   — whether primary button is pressed.
  const [brushROI,     setBrushROI]     = useState(null)   // {x,y}[] | null
  const [brushLimitsV, setBrushLimitsV] = useState(false)  // BrushLimits visible
  const brushROIRef   = useRef(null)
  const lastBrushPt   = useRef(null)
  const editingAnn    = useRef(null)
  const subtractMode  = useRef(false)
  const brushDown     = useRef(false)
  const pressureRef   = useRef(1.0)   // pen pressure (1.0 if no pen)

  useEffect(() => { brushROIRef.current = brushROI }, [brushROI])

  // reset when tool changes
  useEffect(() => {
    if (activeTool !== 'brush') {
      setBrushROI(null)
      brushROIRef.current = null
      lastBrushPt.current = null
      editingAnn.current  = null
      brushDown.current   = false
      setBrushLimitsV(false)
    }
    setPolyPts([])
    setMouse(null)
    setDragStart(null)
    setDragEnd(null)
    setIsSpacePan(false)
    setIsMiddlePan(false)
    isSpacePanRef.current = false
    isMiddlePanRef.current = false
  }, [activeTool])

  // disable OSD pan while a tool is armed
  useEffect(() => {
    const v = osdRef.current
    if (!v?.setMouseNavEnabled) return
    v.setMouseNavEnabled(readOnly || !activeTool || navOverride)
    return () => { osdRef.current?.setMouseNavEnabled(true) }
  }, [activeTool, navOverride, osdRef, readOnly])

  // Allow temporary navigation while drawing (spacebar)
  useEffect(() => {
    if (!activeTool || readOnly) return
    const isTyping = () => ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)
    const onDown = (ev) => {
      if (ev.code !== 'Space' || isTyping()) return
      ev.preventDefault()
      isSpacePanRef.current = true
      setIsSpacePan(true)
    }
    const onUp = (ev) => {
      if (ev.code !== 'Space') return
      isSpacePanRef.current = false
      setIsSpacePan(false)
    }
    const onBlur = () => {
      isSpacePanRef.current = false
      setIsSpacePan(false)
    }
    window.addEventListener('keydown', onDown)
    window.addEventListener('keyup', onUp)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onDown)
      window.removeEventListener('keyup', onUp)
      window.removeEventListener('blur', onBlur)
    }
  }, [activeTool, readOnly])

  // Track middle mouse navigation
  useEffect(() => {
    if (!activeTool) return
    const onUp = (ev) => {
      if (ev.button !== 1) return
      isMiddlePanRef.current = false
      setIsMiddlePan(false)
    }
    window.addEventListener('mouseup', onUp)
    return () => window.removeEventListener('mouseup', onUp)
  }, [activeTool])

  // ── helpers ───────────────────────────────────────────────────────────────

  // ── helpers ───────────────────────────────────────────────────────────────

  function getEl(e) {
    const r = svgRef.current.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  function toImg(el) { return elementToImage(osdRef.current, el.x, el.y) }

  /** Effective brush radius in image pixels, accounting for pen pressure. */
  function effectiveBrushRadius() {
    return brushRadius * pressureRef.current
  }

  /**
   * Compute brush radius in viewer-element pixels so BrushLimits can render.
   */
  function viewRadius() {
    const viewer = osdRef.current
    if (!viewer?.viewport) return 20
    const origin = imageToElement(viewer, 0, 0)
    const offset = imageToElement(viewer, effectiveBrushRadius(), 0)
    if (!origin || !offset) return 20
    return Math.max(1, Math.abs(offset.x - origin.x))
  }

  /** Build the brush geometry for a single point or a capsule between two points. */
  function makeBrushGeom(imgPt) {
    const r    = effectiveBrushRadius()
    const last = lastBrushPt.current
    if (!last || (Math.abs(last.x - imgPt.x) < 0.5 && Math.abs(last.y - imgPt.y) < 0.5)) {
      return circlePoly(imgPt.x, imgPt.y, r)
    }
    return capsulePoly(last.x, last.y, imgPt.x, imgPt.y, r)
  }

  /** Apply brush geom to the current ROI (union or subtract). */
  function applyBrush(brushGeom, currentROI, viewer) {
    const { width, height } = viewer
      ? { width: viewer.source?.width || 1e6, height: viewer.source?.height || 1e6 }
      : { width: 1e6, height: 1e6 }

    let next
    if (subtractMode.current) {
      next = difference(currentROI, brushGeom)
    } else {
      next = union(currentROI, brushGeom)
    }
    // pixel snapping
    next = roundCoordinates(next)
    // light simplification (VW tolerance 0.1 px, matching QuPath)
    if (next.length > 8) next = simplify(next, 0.1)
    // constrain to image bounds
    if (viewer) {
      const info = osdRef.current?.source
      if (info?.width && info?.height) {
        next = constrainToBounds(next, info.width, info.height)
      }
    }
    return next
  }

  /** Look for an existing editable brush/polygon annotation under the cursor. */
  function findEditableAnnotationUnder(imgPt) {
    for (const ann of [...annotations].reverse()) {
      if (ann.annotation_type !== 'brush' && ann.annotation_type !== 'polygon') continue
      const pts = ann.geometry?.points || []
      if (!pts.length) continue
      // simple bounding-box pre-filter
      const xs = pts.map(p => p.x), ys = pts.map(p => p.y)
      const minX = Math.min(...xs), maxX = Math.max(...xs)
      const minY = Math.min(...ys), maxY = Math.max(...ys)
      if (imgPt.x < minX || imgPt.x > maxX || imgPt.y < minY || imgPt.y > maxY) continue
      // point-in-polygon test
      let inside = false
      const n = pts.length
      for (let i = 0, j = n - 1; i < n; j = i++) {
        if ((pts[i].y > imgPt.y) !== (pts[j].y > imgPt.y) &&
            imgPt.x < (pts[j].x - pts[i].x) * (imgPt.y - pts[i].y) / (pts[j].y - pts[i].y) + pts[i].x) {
          inside = !inside
        }
      }
      if (inside) return ann
    }
    return null
  }

  }

  /** Look for an existing editable brush/polygon annotation under the cursor. */
  function findEditableAnnotationUnder(imgPt) {
    for (const ann of [...annotations].reverse()) {
      if (ann.annotation_type !== 'brush' && ann.annotation_type !== 'polygon') continue
      const pts = ann.geometry?.points || []
      if (!pts.length) continue
      // simple bounding-box pre-filter
      const xs = pts.map(p => p.x), ys = pts.map(p => p.y)
      const minX = Math.min(...xs), maxX = Math.max(...xs)
      const minY = Math.min(...ys), maxY = Math.max(...ys)
      if (imgPt.x < minX || imgPt.x > maxX || imgPt.y < minY || imgPt.y > maxY) continue
      // point-in-polygon test
      let inside = false
      const n = pts.length
      for (let i = 0, j = n - 1; i < n; j = i++) {
        if ((pts[i].y > imgPt.y) !== (pts[j].y > imgPt.y) &&
            imgPt.x < (pts[j].x - pts[i].x) * (imgPt.y - pts[i].y) / (pts[j].y - pts[i].y) + pts[i].x) {
          inside = !inside
        }
      }
      if (inside) return ann
    }
    return null
  }

  // ── emit helpers ──────────────────────────────────────────────────────────
  function emit(ann) {
    if (!onAnnotationCreated || readOnly) return
    onAnnotationCreated({ ...ann, class_id: activeClass?.id, class_name: activeClass?.name })
  }

  // ─────────────────────────────────────────────────────────────────────────
  // BRUSH HANDLERS
  // These mirror BrushToolEventHandler.mousePressed / mouseDragged / mouseReleased
  // ─────────────────────────────────────────────────────────────────────────

  function onBrushDown(e) {
    if (readOnly) return
    brushDown.current   = true
    subtractMode.current = e.altKey || (e.pointerType === 'pen' && (e.buttons & 32)) // eraser button

    // pen pressure
    pressureRef.current = (e.pressure && e.pressure > 0) ? e.pressure : 1.0

    const el  = getEl(e)
    const img = toImg(el)
    if (!img) return

    // Determine if we should edit an existing annotation or create new.
    // Matches QuPath: create new if no valid current object OR brush-create-new-objects
    // pref is on and cursor is outside the current ROI (and not subtracting).
    let existingAnn = null
    if (!subtractMode.current) {
      existingAnn = findEditableAnnotationUnder(img)
    }

    let startROI = []
    if (existingAnn) {
      startROI = existingAnn.geometry?.points || []
      editingAnn.current = existingAnn   // hold ref so we can replace it on mouseUp
    } else {
      editingAnn.current = null
    }

    // First brush geometry: circle at click point
    const brushGeom = circlePoly(img.x, img.y, effectiveBrushRadius())
    let nextROI = applyBrush(brushGeom, startROI, osdRef.current)

    lastBrushPt.current = img
    setBrushROI(nextROI)
    brushROIRef.current = nextROI
  }

  function onBrushDrag(e) {
    if (!brushDown.current || readOnly) return

    // update pen pressure
    pressureRef.current = (e.pressure && e.pressure > 0) ? e.pressure : pressureRef.current

    const el  = getEl(e)
    const img = toImg(el)
    if (!img) return

    const brushGeom = makeBrushGeom(img)
    const nextROI   = applyBrush(brushGeom, brushROIRef.current || [], osdRef.current)

    lastBrushPt.current = img
    setBrushROI(nextROI)
    brushROIRef.current = nextROI
  }

  function onBrushUp() {
    if (!brushDown.current || readOnly) return
    brushDown.current = false

    const finalROI = brushROIRef.current || []
    if (finalROI.length < 3) {
      // too small — discard
      setBrushROI(null); brushROIRef.current = null
      lastBrushPt.current = null; editingAnn.current = null
      return
    }

    if (editingAnn.current) {
      // Replace the existing annotation in-place via a synthetic update:
      // emit as a "create" that the parent's handleAnnotationCreated will
      // assign a new temp-id; the old annotation will be removed because
      // the parent calls triggerSave with the full list.
      // A cleaner approach would be a dedicated onAnnotationUpdated callback;
      // for now we piggyback on the existing protocol:
      emit({
        annotation_type: 'brush',
        geometry: { points: finalROI },
        _replaceId: editingAnn.current.id,  // signal to parent to drop the old one
      })
    } else {
      emit({ annotation_type: 'brush', geometry: { points: finalROI } })
    }

    setBrushROI(null); brushROIRef.current = null
    lastBrushPt.current = null; editingAnn.current = null
    subtractMode.current = false
  }

  // ─────────────────────────────────────────────────────────────────────────
  // POLYGON HANDLERS (unchanged logic)
  // ─────────────────────────────────────────────────────────────────────────

  function handlePolyClick(e) {
    if (e.detail >= 2) return
    const el  = getEl(e)
    const img = toImg(el)
    if (!img) return
    const cur = polyRef.current
    if (polyPts.length >= 3 && dist(el, (cur.map(p => imageToElement(osdRef.current, p.x, p.y)).filter(Boolean))[0] || { x: 0, y: 0 }) <= CLOSE_THRESH) {
      emit({ annotation_type: 'polygon', geometry: { points: cur } })
      setPolyPts([]); setMouse(null); return
    }
    const next = [...cur, img]
    polyRef.current = next; setPolyPts(next)
  }

  function handlePolyDbl(e) {
    e.stopPropagation()
    const cur = polyRef.current
    if (cur.length >= 3) emit({ annotation_type: 'polygon', geometry: { points: cur } })
    setPolyPts([]); setMouse(null)
  }

  // ─────────────────────────────────────────────────────────────────────────
  // DRAG-SHAPE HANDLERS (rectangle / ellipse)
  // ─────────────────────────────────────────────────────────────────────────

  function onDragStart(e) {
    const img = toImg(getEl(e)); if (!img) return
    setDragStart(img); setDragEnd(img)
  }
  function onDragMove(e) {
    if (!dragStart) return
    const img = toImg(getEl(e)); if (img) setDragEnd(img)
  }
  function onDragEnd() {
    if (!dragStart || !dragEnd) return
    const dx = Math.abs(dragEnd.x - dragStart.x)
    const dy = Math.abs(dragEnd.y - dragStart.y)
    if (dx < MIN_DRAG && dy < MIN_DRAG) { setDragStart(null); setDragEnd(null); return }
    if (activeTool === 'rectangle') {
      emit({ annotation_type: 'rectangle', geometry: {
        x: Math.min(dragStart.x, dragEnd.x), y: Math.min(dragStart.y, dragEnd.y),
        width: dx, height: dy,
      }})
    } else if (activeTool === 'ellipse') {
      emit({ annotation_type: 'ellipse', geometry: {
        cx: (dragStart.x + dragEnd.x) / 2, cy: (dragStart.y + dragEnd.y) / 2,
        rx: dx / 2, ry: dy / 2,
      }})
    }
    setDragStart(null); setDragEnd(null)
  }

  function handlePointClick(e) {
    const img = toImg(getEl(e)); if (!img) return
    emit({ annotation_type: 'point', geometry: { x: img.x, y: img.y } })
  }

  // ─────────────────────────────────────────────────────────────────────────
  // UNIFIED POINTER ROUTER
  // ─────────────────────────────────────────────────────────────────────────

  function onPointerDown(e) {
    if (!activeTool || readOnly) return
    if (e.button === 1) {
      isMiddlePanRef.current = true
      setIsMiddlePan(true)
      osdRef.current?.setMouseNavEnabled(true)
      return
    }
    if (isSpacePanRef.current || isMiddlePanRef.current || e.button !== 0) return
    if (!activeTool || readOnly || e.button !== 0) return
    svgRef.current.setPointerCapture(e.pointerId)
    e.stopPropagation()
    if (activeTool === 'brush')                              onBrushDown(e)
    if (activeTool === 'rectangle' || activeTool === 'ellipse') onDragStart(e)
  }

  function onPointerMove(e) {
    if (isSpacePanRef.current || isMiddlePanRef.current) return
    const el = getEl(e)
    setMouse(el)
    // update BrushLimits visibility
    if (activeTool === 'brush') setBrushLimitsV(true)
    if (!activeTool || readOnly) return
    if (activeTool === 'brush')                              onBrushDrag(e)
    if (activeTool === 'rectangle' || activeTool === 'ellipse') onDragMove(e)
  }

  function onPointerUp(e) {
    if (!activeTool || readOnly || e.button !== 0) return
    if (!activeTool || readOnly) return
    if (activeTool === 'brush')                              onBrushUp()
    if (activeTool === 'rectangle' || activeTool === 'ellipse') onDragEnd()
    if (svgRef.current.hasPointerCapture?.(e.pointerId))
      svgRef.current.releasePointerCapture(e.pointerId)
  }

  function onPointerLeave() {
    setMouse(null)
    setBrushLimitsV(false)
    if (brushDown.current) onBrushUp() // safety commit if pointer leaves while down
  }

  function onClick(e) {
    if (isSpacePanRef.current || isMiddlePanRef.current) return
    if (!activeTool || readOnly) return
    if (activeTool === 'polygon') handlePolyClick(e)
    if (activeTool === 'point')   handlePointClick(e)
  }

  function onDblClick(e) {
    if (isSpacePanRef.current || isMiddlePanRef.current) return
    if (!activeTool || readOnly) return
    if (activeTool === 'polygon') handlePolyDbl(e)
  }

  // ─────────────────────────────────────────────────────────────────────────
  // ALT + SCROLL → adjust brush diameter (QuPath: Alt+ScrollEvent)
  // ─────────────────────────────────────────────────────────────────────────
  function onWheel(e) {
    if (!e.altKey || activeTool !== 'brush') return
    e.preventDefault()
    e.stopPropagation()
    // deltaY < 0 = scroll up = increase radius
    const delta = e.deltaY < 0 ? 5 : -5
    setBrushRadius(r => Math.max(10, Math.min(500, Math.round(r + delta))))
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 'F' KEY → fill holes in current brush ROI (QuPath: KeyCode.F while drawing)
  // ─────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (activeTool !== 'brush') return
    function handler(ev) {
      if (ev.key !== 'f' && ev.key !== 'F') return
      if (!brushROIRef.current) return
      const filled = fillHoles(brushROIRef.current)
      setBrushROI(filled)
      brushROIRef.current = filled
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [activeTool])

  // ─────────────────────────────────────────────────────────────────────────
  // PROJECTED COORDINATES (re-runs every tick so SVG tracks pan/zoom)
  // ─────────────────────────────────────────────────────────────────────────
  const viewer     = osdRef.current
  const projPolyPts = polyPts.map(p => imageToElement(viewer, p.x, p.y)).filter(Boolean)

  let dragProj = null
  if (dragStart && dragEnd) {
    const ds = imageToElement(viewer, dragStart.x, dragStart.y)
    const de = imageToElement(viewer, dragEnd.x, dragEnd.y)
    if (ds && de) dragProj = { ds, de }
  }

  // project brushROI for live preview
  const projBrushROI = brushROI
    ? brushROI.map(p => imageToElement(viewer, p.x, p.y)).filter(Boolean)
    : null

  // ─────────────────────────────────────────────────────────────────────────
  // CURSOR
  // ─────────────────────────────────────────────────────────────────────────
  const nearFirst = activeTool === 'polygon' && projPolyPts.length >= 3 && mouse &&
    dist(mouse, projPolyPts[0] || { x: -999, y: -999 }) <= CLOSE_THRESH
  const cursorMap = {
    polygon:   nearFirst ? 'cell' : 'crosshair',
    rectangle: 'crosshair',
    ellipse:   'crosshair',
    point:     'cell',
    brush:     'none',   // BrushLimits replaces the native cursor
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 'F' KEY → fill holes in current brush ROI (QuPath: KeyCode.F while drawing)
  // ─────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (activeTool !== 'brush') return
    function handler(ev) {
      if (ev.key !== 'f' && ev.key !== 'F') return
      if (!brushROIRef.current) return
      const filled = fillHoles(brushROIRef.current)
      setBrushROI(filled)
      brushROIRef.current = filled
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [activeTool])

  // ─────────────────────────────────────────────────────────────────────────
  // PROJECTED COORDINATES (re-runs every tick so SVG tracks pan/zoom)
  // ─────────────────────────────────────────────────────────────────────────
  const viewer     = osdRef.current
  const projPolyPts = polyPts.map(p => imageToElement(viewer, p.x, p.y)).filter(Boolean)

  let dragProj = null
  if (dragStart && dragEnd) {
    const ds = imageToElement(viewer, dragStart.x, dragStart.y)
    const de = imageToElement(viewer, dragEnd.x, dragEnd.y)
    if (ds && de) dragProj = { ds, de }
  }

  // project brushROI for live preview
  const projBrushROI = brushROI
    ? brushROI.map(p => imageToElement(viewer, p.x, p.y)).filter(Boolean)
    : null

  // ─────────────────────────────────────────────────────────────────────────
  // CURSOR
  // ─────────────────────────────────────────────────────────────────────────
  const nearFirst = activeTool === 'polygon' && projPolyPts.length >= 3 && mouse &&
    dist(mouse, projPolyPts[0] || { x: -999, y: -999 }) <= CLOSE_THRESH
  const cursorMap = {
    polygon:   nearFirst ? 'cell' : 'crosshair',
    rectangle: 'crosshair',
    ellipse:   'crosshair',
    point:     'cell',
    brush:     'none',   // BrushLimits replaces the native cursor
  }
  const cursor = activeTool ? (navOverride ? 'grab' : (cursorMap[activeTool] || 'crosshair')) : 'default'

  const toolColor = activeClass?.color || '#6ee7b7'

  // ─────────────────────────────────────────────────────────────────────────
  // BRUSH LIMITS position in view space
  // ─────────────────────────────────────────────────────────────────────────
  const brushLimitsPos = mouse && activeTool === 'brush'
    ? { cx: mouse.x, cy: mouse.y, r: viewRadius() }
    : null

  // ─────────────────────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────────────────────
  return (
    <svg
      ref={svgRef}
      style={{
        position: 'absolute', inset: 0, width: '100%', height: '100%',
        pointerEvents: activeTool ? 'all' : 'none',
        cursor, zIndex: 50,
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={onPointerLeave}
      onClick={onClick}
      onDoubleClick={onDblClick}
      onWheel={onWheel}
    >
      {/* ── Saved annotations ─────────────────────────────────────────── */}
      {annotations
        // hide the annotation currently being re-edited by the brush
        .filter(a => !(editingAnn.current && a.id === editingAnn.current.id))
        .map(ann => (
          <AnnotationShape
            key={ann.id}
            viewer={viewer}
            ann={ann}
            selected={ann.id === selectedAnnId}
            onClick={onAnnotationClick}
          />
        ))
      }

      {/* ── Brush ROI in progress ───────────────────────────────────── */}
      {projBrushROI && projBrushROI.length > 2 && (
        <path
          d={toSVGPath(projBrushROI, true)}
          fill={subtractMode.current ? 'rgba(230,0,46,0.15)' : (toolColor + '33')}
          stroke={subtractMode.current ? 'rgba(230,0,46,0.8)' : toolColor}
          strokeWidth={1.5}
          strokeLinejoin="round"
          style={{ pointerEvents: 'none' }}
        />
      )}

      {/* ── Polygon in progress ─────────────────────────────────────── */}
      {activeTool === 'polygon' && projPolyPts.length > 0 && (
        <g>
          {projPolyPts.length >= 3 && (
            <path d={toSVGPath(projPolyPts, true)}
              fill={toolColor} fillOpacity={0.25} stroke="none" />
          )}
          <path d={toSVGPath(projPolyPts, false)}
            fill="none" stroke={toolColor} strokeWidth={1.5} strokeLinejoin="round" />
          {mouse && (
            <>
              <line
                x1={projPolyPts[projPolyPts.length - 1].x}
                y1={projPolyPts[projPolyPts.length - 1].y}
                x2={mouse.x} y2={mouse.y}
                stroke={toolColor} strokeWidth={1.5} strokeDasharray="6 3" opacity={0.85} />
              {projPolyPts.length >= 2 && (
                <line x1={mouse.x} y1={mouse.y}
                  x2={projPolyPts[0].x} y2={projPolyPts[0].y}
                  stroke={toolColor} strokeWidth={1} strokeDasharray="2 6" opacity={0.35} />
              )}
            </>
          )}
          {projPolyPts.map((p, i) => (
            <circle key={i} cx={p.x} cy={p.y}
              r={i === 0 ? FIRST_VERTEX_R : VERTEX_R}
              fill={i === 0 ? '#ff7c00' : toolColor}
              stroke="white" strokeWidth={1.5} />
          ))}
        </g>
      )}

      {/* ── Rectangle drag ──────────────────────────────────────────── */}
      {activeTool === 'rectangle' && dragProj && (() => {
        const x = Math.min(dragProj.ds.x, dragProj.de.x)
        const y = Math.min(dragProj.ds.y, dragProj.de.y)
        const w = Math.abs(dragProj.de.x - dragProj.ds.x)
        const h = Math.abs(dragProj.de.y - dragProj.ds.y)
        return (
          <rect x={x} y={y} width={w} height={h}
            fill={toolColor} fillOpacity={0.2}
            stroke={toolColor} strokeWidth={1.5} strokeDasharray="6 3" />
        )
      })()}

      {/* ── Ellipse drag ────────────────────────────────────────────── */}
      {activeTool === 'ellipse' && dragProj && (() => {
        const cx = (dragProj.ds.x + dragProj.de.x) / 2
        const cy = (dragProj.ds.y + dragProj.de.y) / 2
        const rx = Math.abs(dragProj.de.x - dragProj.ds.x) / 2
        const ry = Math.abs(dragProj.de.y - dragProj.ds.y) / 2
        return (
          <ellipse cx={cx} cy={cy} rx={rx} ry={ry}
            fill={toolColor} fillOpacity={0.2}
            stroke={toolColor} strokeWidth={1.5} strokeDasharray="6 3" />
        )
      })()}

      {/* ── Point crosshair ─────────────────────────────────────────── */}
      {activeTool === 'point' && mouse && (
        <g style={{ pointerEvents: 'none' }}>
          <circle cx={mouse.x} cy={mouse.y} r={8}
            fill={toolColor} fillOpacity={0.3}
            stroke={toolColor} strokeWidth={1.5} />
          <circle cx={mouse.x} cy={mouse.y} r={2} fill={toolColor} />
        </g>
      )}

      {/* ── BrushLimits (dual-ring cursor overlay) ───────────────────── */}
      {brushLimitsPos && (
        <BrushLimits
          cx={brushLimitsPos.cx}
          cy={brushLimitsPos.cy}
          radius={brushLimitsPos.r}
          subtract={subtractMode.current}
          visible={brushLimitsV}
        />
      )}
    </svg>
  )
}
