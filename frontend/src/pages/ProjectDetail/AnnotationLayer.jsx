// frontend/src/pages/ProjectDetail/AnnotationLayer.jsx
//
// BUG 3 FIX: accepts `osdRef` (a React ref object) instead of `viewer` (a value).
// Reading osdRef.current on every render guarantees we always have the live
// OSD instance, even though the ref assignment happens asynchronously after
// the DZI fetch completes.
//
// All other coordinate helpers and drawing logic are unchanged from v1.

import { useState, useEffect, useRef } from 'react'
import { imageToElement, elementToImage } from '../../hooks/useOSDViewer'
import { strokeToPolygon } from '../../lib/BrushEngine'

// ─── Visual constants ─────────────────────────────────────────────────────────
const VERTEX_R       = 5
const FIRST_VERTEX_R = 7
const CLOSE_THRESH   = 14
const MIN_DRAG       = 4
const BRUSH_SEGMENTS = 12

function toSVGPath(pts, closed) {
  if (!pts.length) return ''
  return pts.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')
    + (closed ? ' Z' : '')
}

function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y) }

// ─── Project a saved annotation into element-space coordinates ────────────────
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

// ─── Single saved annotation shape ───────────────────────────────────────────
function AnnotationShape({ viewer, ann, selected, onClick }) {
  const proj = projectAnnotation(viewer, ann)
  if (!proj) return null

  const color    = ann._color || '#6ee7b7'
  const alpha    = selected ? 0.55 : 0.35
  const strokeW  = selected ? 2 : 1.5
  const strokeC  = selected ? '#fff' : color

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

// ─── Main component ───────────────────────────────────────────────────────────
export default function AnnotationLayer({
  osdRef,           // ← ref object (not the viewer value)
  activeTool,
  activeClass,
  brushRadius,
  annotations,
  selectedAnnId,
  onAnnotationClick,
  onAnnotationCreated,
  readOnly,
  tick,             // bumped by OSD viewport events — causes SVG to re-render & reproject
}) {
  const svgRef = useRef(null)

  // In-progress drawing state
  const [polyPts,    setPolyPts]    = useState([])   // polygon vertices (image coords)
  const [mouse,      setMouse]      = useState(null)  // element coords
  const [dragStart,  setDragStart]  = useState(null)
  const [dragEnd,    setDragEnd]    = useState(null)
  const [brushPts,   setBrushPts]   = useState([])
  const [brushDown,  setBrushDown]  = useState(false)

  const polyRef = useRef([])
  useEffect(() => { polyRef.current = polyPts }, [polyPts])

  // Reset in-progress drawing when tool changes
  useEffect(() => {
    setPolyPts([]); setMouse(null)
    setDragStart(null); setDragEnd(null)
    setBrushPts([]); setBrushDown(false)
  }, [activeTool])

  // Disable OSD pan while a tool is armed
  useEffect(() => {
    const v = osdRef.current
    if (!v?.setMouseNavEnabled) return
    v.setMouseNavEnabled(!activeTool)
    return () => { osdRef.current?.setMouseNavEnabled(true) }
  }, [activeTool, osdRef])

  // ── Helpers ───────────────────────────────────────────────────────────────────
  function getEl(e) {
    const r = svgRef.current.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  // Read osdRef.current at call time — always the live instance
  function toImg(el) { return elementToImage(osdRef.current, el.x, el.y) }

  // ── Projected in-progress drawing ─────────────────────────────────────────────
  const viewer = osdRef.current   // snapshot for this render cycle
  const projPolyPts = polyPts.map(p => imageToElement(viewer, p.x, p.y)).filter(Boolean)
  const projBrush   = brushPts.map(p => imageToElement(viewer, p.x, p.y)).filter(Boolean)

  let dragProj = null
  if (dragStart && dragEnd) {
    const ds = imageToElement(viewer, dragStart.x, dragStart.y)
    const de = imageToElement(viewer, dragEnd.x, dragEnd.y)
    if (ds && de) dragProj = { ds, de }
  }

  // ── Emit ──────────────────────────────────────────────────────────────────────
  function emit(ann) {
    if (!onAnnotationCreated || readOnly) return
    onAnnotationCreated({ ...ann, class_id: activeClass?.id, class_name: activeClass?.name })
  }

  // ── Polygon ───────────────────────────────────────────────────────────────────
  function handlePolyClick(e) {
    if (e.detail >= 2) return
    const el  = getEl(e)
    const img = toImg(el)
    if (!img) return

    const cur = polyRef.current
    if (projPolyPts.length >= 3 && dist(el, projPolyPts[0]) <= CLOSE_THRESH) {
      emit({ annotation_type: 'polygon', geometry: { points: cur } })
      setPolyPts([]); setMouse(null); return
    }
    const next = [...cur, img]
    polyRef.current = next
    setPolyPts(next)
  }

  function handlePolyDbl(e) {
    e.stopPropagation()
    const cur = polyRef.current
    if (cur.length >= 3) emit({ annotation_type: 'polygon', geometry: { points: cur } })
    setPolyPts([]); setMouse(null)
  }

  // ── Rectangle / Ellipse ───────────────────────────────────────────────────────
  function onDragStart(e) {
    const img = toImg(getEl(e))
    if (!img) return
    setDragStart(img); setDragEnd(img)
  }

  function onDragMove(e) {
    if (!dragStart) return
    const img = toImg(getEl(e))
    if (img) setDragEnd(img)
  }

  function onDragEnd() {
    if (!dragStart || !dragEnd) return
    const dx = Math.abs(dragEnd.x - dragStart.x)
    const dy = Math.abs(dragEnd.y - dragStart.y)
    if (dx < MIN_DRAG && dy < MIN_DRAG) { setDragStart(null); setDragEnd(null); return }

    if (activeTool === 'rectangle') {
      emit({ annotation_type: 'rectangle', geometry: {
        x: Math.min(dragStart.x, dragEnd.x),
        y: Math.min(dragStart.y, dragEnd.y),
        width: dx, height: dy,
      }})
    } else if (activeTool === 'ellipse') {
      emit({ annotation_type: 'ellipse', geometry: {
        cx: (dragStart.x + dragEnd.x) / 2,
        cy: (dragStart.y + dragEnd.y) / 2,
        rx: dx / 2, ry: dy / 2,
      }})
    }
    setDragStart(null); setDragEnd(null)
  }

  // ── Point ──────────────────────────────────────────────────────────────────────
  function handlePointClick(e) {
    const img = toImg(getEl(e))
    if (!img) return
    emit({ annotation_type: 'point', geometry: { x: img.x, y: img.y } })
  }

  // ── Brush ──────────────────────────────────────────────────────────────────────
  function onBrushDown(e) {
    setBrushDown(true)
    const img = toImg(getEl(e))
    if (img) setBrushPts([img])
  }

  function onBrushMove(e) {
    if (!brushDown) return
    const img = toImg(getEl(e))
    if (!img) return
    setBrushPts(prev => {
      const last = prev[prev.length - 1]
      if (last && dist(last, img) < brushRadius * 0.15) return prev
      return [...prev, img]
    })
  }

  function onBrushUp() {
    if (!brushDown || brushPts.length === 0) return
    setBrushDown(false)
    const poly = strokeToPolygon(brushPts, brushRadius, BRUSH_SEGMENTS)
    if (poly.length >= 3) emit({ annotation_type: 'brush', geometry: { points: poly } })
    setBrushPts([])
  }

  // ── Unified pointer router ────────────────────────────────────────────────────
  function onMouseDown(e) {
    if (!activeTool || readOnly) return
    e.stopPropagation()
    if (activeTool === 'rectangle' || activeTool === 'ellipse') onDragStart(e)
    if (activeTool === 'brush') onBrushDown(e)
  }

  function onMouseMove(e) {
    setMouse(getEl(e))
    if (!activeTool || readOnly) return
    if (activeTool === 'rectangle' || activeTool === 'ellipse') onDragMove(e)
    if (activeTool === 'brush') onBrushMove(e)
  }

  function onMouseUp(e) {
    if (!activeTool || readOnly) return
    if (activeTool === 'rectangle' || activeTool === 'ellipse') onDragEnd(e)
    if (activeTool === 'brush') onBrushUp()
  }

  function onClick(e) {
    if (!activeTool || readOnly) return
    if (activeTool === 'polygon') handlePolyClick(e)
    if (activeTool === 'point')   handlePointClick(e)
  }

  function onDblClick(e) {
    if (!activeTool || readOnly) return
    if (activeTool === 'polygon') handlePolyDbl(e)
  }

  // ── Cursor ────────────────────────────────────────────────────────────────────
  const cursorMap = {
    polygon:   projPolyPts.length >= 3 && mouse && dist(mouse, projPolyPts[0]) <= CLOSE_THRESH
               ? 'cell' : 'crosshair',
    rectangle: 'crosshair',
    ellipse:   'crosshair',
    point:     'cell',
    brush:     'none',
  }
  const cursor = activeTool ? (cursorMap[activeTool] || 'crosshair') : 'default'

  // ── Brush preview circle ───────────────────────────────────────────────────────
  let brushCircle = null
  if (activeTool === 'brush' && mouse && viewer?.viewport) {
    const origin = imageToElement(viewer, 0, 0)
    const offset = imageToElement(viewer, brushRadius, 0)
    const elR = origin && offset ? Math.abs(offset.x - origin.x) : 20
    brushCircle = (
      <circle cx={mouse.x} cy={mouse.y} r={elR}
        fill="rgba(255,215,0,0.12)" stroke="#ffd700" strokeWidth={1.5}
        style={{ pointerEvents: 'none' }} />
    )
  }

  // Brush in-progress polygon preview
  let brushPreview = null
  if (brushDown && brushPts.length > 1) {
    const poly     = strokeToPolygon(brushPts, brushRadius, BRUSH_SEGMENTS)
    const projPoly = poly.map(p => imageToElement(viewer, p.x, p.y)).filter(Boolean)
    if (projPoly.length > 2) {
      brushPreview = (
        <path d={toSVGPath(projPoly, true)}
          fill="rgba(255,215,0,0.25)" stroke="#ffd700" strokeWidth={1.5}
          style={{ pointerEvents: 'none' }} />
      )
    }
  }

  const toolColor = activeClass?.color || '#6ee7b7'

  return (
    <svg
      ref={svgRef}
      style={{
        position: 'absolute', inset: 0, width: '100%', height: '100%',
        pointerEvents: activeTool ? 'all' : 'none',
        cursor, zIndex: 50,
      }}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onMouseLeave={() => { setMouse(null); if (brushDown) onBrushUp() }}
      onClick={onClick}
      onDoubleClick={onDblClick}
    >
      {/* ── Saved annotations (re-renders on every tick so they track pan/zoom) ── */}
      {annotations.map(ann => (
        <AnnotationShape
          key={ann.id}
          viewer={viewer}
          ann={ann}
          selected={ann.id === selectedAnnId}
          onClick={onAnnotationClick}
        />
      ))}

      {/* ── Polygon in progress ────────────────────────────────────────────── */}
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

      {/* ── Rectangle drag ─────────────────────────────────────────────────── */}
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

      {/* ── Ellipse drag ───────────────────────────────────────────────────── */}
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

      {/* ── Brush stroke + circle ──────────────────────────────────────────── */}
      {brushPreview}
      {brushCircle}

      {/* ── Point crosshair ────────────────────────────────────────────────── */}
      {activeTool === 'point' && mouse && (
        <g style={{ pointerEvents: 'none' }}>
          <circle cx={mouse.x} cy={mouse.y} r={8}
            fill={toolColor} fillOpacity={0.3}
            stroke={toolColor} strokeWidth={1.5} />
          <circle cx={mouse.x} cy={mouse.y} r={2} fill={toolColor} />
        </g>
      )}
    </svg>
  )
}