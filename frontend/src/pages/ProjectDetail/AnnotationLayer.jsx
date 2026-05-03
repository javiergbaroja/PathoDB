// frontend/src/pages/ProjectDetail/AnnotationLayer.jsx
// Unified SVG overlay for all annotation tools and rendering of saved annotations.
// Sits above the OSD canvas, below UI chrome.

import { useState, useEffect, useRef, useCallback } from 'react'
import { imageToElement, elementToImage } from '../../hooks/useOSDViewer'
import { strokeToPolygon } from '../../lib/BrushEngine'

// ─── Visual constants ─────────────────────────────────────────────────────────
const VERTEX_R       = 5
const FIRST_VERTEX_R = 7
const CLOSE_THRESH   = 14    // px to snap-close a polygon
const MIN_DRAG       = 4     // px before a click becomes a drag
const BRUSH_SEGMENTS = 12    // arc segments in brush cap

function toSVGPath(pts, closed) {
  if (!pts.length) return ''
  return pts.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')
    + (closed ? ' Z' : '')
}

function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y) }

// ─── Project vertex coords for a saved annotation ─────────────────────────────
function projectAnnotation(viewer, ann) {
  if (!viewer?.viewport) return null
  const g = ann.geometry
  switch (ann.annotation_type) {
    case 'point': {
      const e = imageToElement(viewer, g.x, g.y)
      return e ? { type: 'point', e } : null
    }
    case 'rectangle': {
      const corners = [
        { x: g.x,          y: g.y },
        { x: g.x + g.width, y: g.y },
        { x: g.x + g.width, y: g.y + g.height },
        { x: g.x,          y: g.y + g.height },
      ]
      const proj = corners.map(p => imageToElement(viewer, p.x, p.y)).filter(Boolean)
      return proj.length === 4 ? { type: 'polygon', pts: proj } : null
    }
    case 'ellipse': {
      const N = 48
      const pts = []
      for (let i = 0; i < N; i++) {
        const a = (2 * Math.PI * i) / N
        const ix = g.cx + g.rx * Math.cos(a)
        const iy = g.cy + g.ry * Math.sin(a)
        const e = imageToElement(viewer, ix, iy)
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
}

// ─── Individual annotation shape ──────────────────────────────────────────────
function AnnotationShape({ viewer, ann, color, selected, onClick, tick }) {
  const proj = projectAnnotation(viewer, ann)
  if (!proj) return null

  const alpha = selected ? 0.55 : 0.35
  const strokeW = selected ? 2 : 1.5
  const strokeColor = selected ? '#fff' : color
  const fillColor = color

  if (proj.type === 'point') {
    const { x, y } = proj.e
    return (
      <g onClick={() => onClick(ann)} style={{ cursor: 'pointer' }}>
        <circle cx={x} cy={y} r={selected ? 9 : 7}
          fill={fillColor} fillOpacity={alpha + 0.2}
          stroke={strokeColor} strokeWidth={strokeW} />
        <circle cx={x} cy={y} r={3} fill={strokeColor} />
      </g>
    )
  }

  return (
    <g onClick={() => onClick(ann)} style={{ cursor: 'pointer' }}>
      <path d={toSVGPath(proj.pts, true)}
        fill={fillColor} fillOpacity={alpha}
        stroke={strokeColor} strokeWidth={strokeW}
        strokeLinejoin="round" />
      {selected && proj.pts.map((p, i) => (
        <circle key={i} cx={p.x} cy={p.y} r={4}
          fill={strokeColor} stroke="rgba(0,0,0,0.5)" strokeWidth={1} />
      ))}
    </g>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────
export default function AnnotationLayer({
  viewer,
  activeTool,       // 'polygon'|'rectangle'|'ellipse'|'point'|'brush'|null
  activeClass,      // { id, name, color }
  brushRadius,      // image pixels
  annotations,      // saved annotations for current slide
  selectedAnnId,
  onAnnotationClick,
  onAnnotationCreated,  // (annotationCreate) => void
  readOnly,
  tick,             // bumped by OSD viewport events
}) {
  const svgRef = useRef(null)

  // In-progress drawing state
  const [polyPts, setPolyPts]     = useState([])  // polygon vertices (image coords)
  const [mouse, setMouse]         = useState(null) // element coords
  const [dragStart, setDragStart] = useState(null) // for rect/ellipse
  const [dragEnd, setDragEnd]     = useState(null)
  const [brushPts, setBrushPts]   = useState([])   // brush stroke (image coords)
  const [brushDown, setBrushDown] = useState(false)

  const polyRef  = useRef([])
  useEffect(() => { polyRef.current = polyPts }, [polyPts])

  // Reset in-progress shapes when tool changes
  useEffect(() => {
    setPolyPts([]); setMouse(null); setDragStart(null); setDragEnd(null)
    setBrushPts([]); setBrushDown(false)
  }, [activeTool])

  // Disable OSD pan while a tool is active
  useEffect(() => {
    if (!viewer?.setMouseNavEnabled) return
    viewer.setMouseNavEnabled(!activeTool)
    return () => { viewer?.setMouseNavEnabled(true) }
  }, [activeTool, viewer])

  // ── Coordinate helpers ──────────────────────────────────────────────────────
  function getElCoords(e) {
    const rect = svgRef.current.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  // ── Project current drawing state to element coords ─────────────────────────
  const projPolyPts = polyPts.map(p => imageToElement(viewer, p.x, p.y)).filter(Boolean)
  const projBrush   = brushPts.map(p => imageToElement(viewer, p.x, p.y)).filter(Boolean)

  // Rect/ellipse drag corners in element space
  let dragProj = null
  if (dragStart && dragEnd) {
    dragProj = {
      ds: imageToElement(viewer, dragStart.x, dragStart.y),
      de: imageToElement(viewer, dragEnd.x,   dragEnd.y),
    }
  }

  // ── Emit created annotation ─────────────────────────────────────────────────
  function emit(ann) {
    if (!onAnnotationCreated || readOnly) return
    onAnnotationCreated({ ...ann, class_id: activeClass?.id, class_name: activeClass?.name })
  }

  // ── Polygon handlers ────────────────────────────────────────────────────────
  function handlePolyClick(e) {
    if (e.detail >= 2) return  // double-click handled separately
    const el  = getElCoords(e)
    const img = elementToImage(viewer, el.x, el.y)
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

  function handlePolyDblClick(e) {
    e.stopPropagation()
    const cur = polyRef.current
    if (cur.length >= 3) emit({ annotation_type: 'polygon', geometry: { points: cur } })
    setPolyPts([]); setMouse(null)
  }

  // ── Rect / Ellipse handlers ─────────────────────────────────────────────────
  function handleDragStart(e) {
    const el  = getElCoords(e)
    const img = elementToImage(viewer, el.x, el.y)
    if (!img) return
    setDragStart(img); setDragEnd(img)
  }

  function handleDragMove(e) {
    if (!dragStart) return
    const el  = getElCoords(e)
    const img = elementToImage(viewer, el.x, el.y)
    if (img) setDragEnd(img)
  }

  function handleDragEnd(e) {
    if (!dragStart || !dragEnd) return
    const dx = Math.abs(dragEnd.x - dragStart.x)
    const dy = Math.abs(dragEnd.y - dragStart.y)
    if (dx < MIN_DRAG && dy < MIN_DRAG) { setDragStart(null); setDragEnd(null); return }

    if (activeTool === 'rectangle') {
      const x = Math.min(dragStart.x, dragEnd.x)
      const y = Math.min(dragStart.y, dragEnd.y)
      emit({ annotation_type: 'rectangle', geometry: { x, y, width: Math.abs(dx), height: Math.abs(dy) } })
    } else if (activeTool === 'ellipse') {
      emit({ annotation_type: 'ellipse', geometry: {
        cx: (dragStart.x + dragEnd.x) / 2,
        cy: (dragStart.y + dragEnd.y) / 2,
        rx: Math.abs(dragEnd.x - dragStart.x) / 2,
        ry: Math.abs(dragEnd.y - dragStart.y) / 2,
      }})
    }
    setDragStart(null); setDragEnd(null)
  }

  // ── Point handler ────────────────────────────────────────────────────────────
  function handlePointClick(e) {
    const el  = getElCoords(e)
    const img = elementToImage(viewer, el.x, el.y)
    if (!img) return
    emit({ annotation_type: 'point', geometry: { x: img.x, y: img.y } })
  }

  // ── Brush handlers ───────────────────────────────────────────────────────────
  function handleBrushDown(e) {
    setBrushDown(true)
    const el  = getElCoords(e)
    const img = elementToImage(viewer, el.x, el.y)
    if (img) setBrushPts([img])
  }

  function handleBrushMove(e) {
    if (!brushDown) return
    const el  = getElCoords(e)
    const img = elementToImage(viewer, el.x, el.y)
    if (!img) return
    setBrushPts(prev => {
      const last = prev[prev.length - 1]
      if (last && dist(last, img) < brushRadius * 0.15) return prev
      return [...prev, img]
    })
  }

  function handleBrushUp() {
    if (!brushDown || brushPts.length === 0) return
    setBrushDown(false)
    const poly = strokeToPolygon(brushPts, brushRadius, BRUSH_SEGMENTS)
    if (poly.length >= 3) {
      emit({ annotation_type: 'brush', geometry: { points: poly } })
    }
    setBrushPts([])
  }

  // ── Unified pointer router ───────────────────────────────────────────────────
  function onMouseDown(e) {
    if (!activeTool || readOnly) return
    e.stopPropagation()
    if (activeTool === 'rectangle' || activeTool === 'ellipse') handleDragStart(e)
    if (activeTool === 'brush') handleBrushDown(e)
  }

  function onMouseMove(e) {
    setMouse(getElCoords(e))
    if (!activeTool || readOnly) return
    if (activeTool === 'rectangle' || activeTool === 'ellipse') handleDragMove(e)
    if (activeTool === 'brush') handleBrushMove(e)
  }

  function onMouseUp(e) {
    if (!activeTool || readOnly) return
    if (activeTool === 'rectangle' || activeTool === 'ellipse') handleDragEnd(e)
    if (activeTool === 'brush') handleBrushUp()
  }

  function onClick(e) {
    if (!activeTool || readOnly) return
    if (activeTool === 'polygon') handlePolyClick(e)
    if (activeTool === 'point')   handlePointClick(e)
  }

  function onDblClick(e) {
    if (!activeTool || readOnly) return
    if (activeTool === 'polygon') handlePolyDblClick(e)
  }

  // ── Cursor style ─────────────────────────────────────────────────────────────
  const cursorMap = {
    polygon: projPolyPts.length >= 3 && mouse && dist(mouse, projPolyPts[0]) <= CLOSE_THRESH ? 'cell' : 'crosshair',
    rectangle: 'crosshair', ellipse: 'crosshair',
    point: 'cell', brush: 'none',
  }
  const cursor = activeTool ? (cursorMap[activeTool] || 'crosshair') : 'default'

  // ── Brush preview circle ──────────────────────────────────────────────────────
  let brushCircle = null
  if (activeTool === 'brush' && mouse && viewer?.viewport) {
    // Convert brushRadius (image px) to element px
    const origin = imageToElement(viewer, 0, 0)
    const offset = imageToElement(viewer, brushRadius, 0)
    const elR = origin && offset ? Math.abs(offset.x - origin.x) : 20
    brushCircle = <circle cx={mouse.x} cy={mouse.y} r={elR}
      fill="rgba(255,215,0,0.12)" stroke="#ffd700" strokeWidth={1.5}
      style={{ pointerEvents: 'none' }} />
  }

  // ── Brush in-progress polygon ─────────────────────────────────────────────────
  let brushPreview = null
  if (brushDown && brushPts.length > 1) {
    const poly = strokeToPolygon(brushPts, brushRadius, BRUSH_SEGMENTS)
    const projPoly = poly.map(p => imageToElement(viewer, p.x, p.y)).filter(Boolean)
    if (projPoly.length > 2) {
      brushPreview = (
        <path d={toSVGPath(projPoly, true)}
          fill="rgba(255,215,0,0.25)" stroke="#ffd700" strokeWidth={1.5}
          style={{ pointerEvents: 'none' }} />
      )
    }
  }

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
      onMouseLeave={() => { setMouse(null); if (brushDown) handleBrushUp() }}
      onClick={onClick}
      onDoubleClick={onDblClick}
    >
      {/* ── Saved annotations ──────────────────────────────────────────────── */}
      {annotations.map(ann => {
        const cls = ann.class_id
        const color = activeClass?.id === cls ? activeClass.color : (ann._color || '#6ee7b7')
        return (
          <AnnotationShape key={ann.id} viewer={viewer} ann={ann}
            color={ann._color || '#6ee7b7'}
            selected={ann.id === selectedAnnId}
            onClick={onAnnotationClick} tick={tick} />
        )
      })}

      {/* ── Polygon in progress ──────────────────────────────────────────────── */}
      {activeTool === 'polygon' && projPolyPts.length > 0 && (
        <g>
          {projPolyPts.length >= 3 && (
            <path d={toSVGPath(projPolyPts, true)}
              fill={activeClass?.color || 'rgba(110,231,183,0.25)'}
              fillOpacity={0.25} stroke="none" />
          )}
          <path d={toSVGPath(projPolyPts, false)}
            fill="none" stroke={activeClass?.color || '#6ee7b7'} strokeWidth={1.5}
            strokeLinejoin="round" />
          {mouse && (
            <>
              <line
                x1={projPolyPts[projPolyPts.length-1].x} y1={projPolyPts[projPolyPts.length-1].y}
                x2={mouse.x} y2={mouse.y}
                stroke={activeClass?.color || '#6ee7b7'} strokeWidth={1.5}
                strokeDasharray="6 3" opacity={0.85} />
              {projPolyPts.length >= 2 && (
                <line x1={mouse.x} y1={mouse.y}
                  x2={projPolyPts[0].x} y2={projPolyPts[0].y}
                  stroke={activeClass?.color || '#6ee7b7'} strokeWidth={1}
                  strokeDasharray="2 6" opacity={0.35} />
              )}
            </>
          )}
          {projPolyPts.map((p, i) => (
            <circle key={i} cx={p.x} cy={p.y}
              r={i === 0 ? FIRST_VERTEX_R : VERTEX_R}
              fill={i === 0 ? '#ff7c00' : (activeClass?.color || '#6ee7b7')}
              stroke="white" strokeWidth={1.5} />
          ))}
        </g>
      )}

      {/* ── Rectangle drag ───────────────────────────────────────────────────── */}
      {activeTool === 'rectangle' && dragProj && (() => {
        const x = Math.min(dragProj.ds.x, dragProj.de.x)
        const y = Math.min(dragProj.ds.y, dragProj.de.y)
        const w = Math.abs(dragProj.de.x - dragProj.ds.x)
        const h = Math.abs(dragProj.de.y - dragProj.ds.y)
        return (
          <rect x={x} y={y} width={w} height={h}
            fill={activeClass?.color || '#6ee7b7'} fillOpacity={0.2}
            stroke={activeClass?.color || '#6ee7b7'} strokeWidth={1.5}
            strokeDasharray="6 3" />
        )
      })()}

      {/* ── Ellipse drag ─────────────────────────────────────────────────────── */}
      {activeTool === 'ellipse' && dragProj && (() => {
        const cx = (dragProj.ds.x + dragProj.de.x) / 2
        const cy = (dragProj.ds.y + dragProj.de.y) / 2
        const rx = Math.abs(dragProj.de.x - dragProj.ds.x) / 2
        const ry = Math.abs(dragProj.de.y - dragProj.ds.y) / 2
        return (
          <ellipse cx={cx} cy={cy} rx={rx} ry={ry}
            fill={activeClass?.color || '#6ee7b7'} fillOpacity={0.2}
            stroke={activeClass?.color || '#6ee7b7'} strokeWidth={1.5}
            strokeDasharray="6 3" />
        )
      })()}

      {/* ── Brush preview ────────────────────────────────────────────────────── */}
      {brushPreview}
      {brushCircle}

      {/* ── Point crosshair ──────────────────────────────────────────────────── */}
      {activeTool === 'point' && mouse && (
        <g style={{ pointerEvents: 'none' }}>
          <circle cx={mouse.x} cy={mouse.y} r={8}
            fill={activeClass?.color || '#6ee7b7'} fillOpacity={0.3}
            stroke={activeClass?.color || '#6ee7b7'} strokeWidth={1.5} />
          <circle cx={mouse.x} cy={mouse.y} r={2} fill={activeClass?.color || '#6ee7b7'} />
        </g>
      )}
    </svg>
  )
}