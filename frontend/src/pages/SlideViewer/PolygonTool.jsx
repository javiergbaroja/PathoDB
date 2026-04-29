import { useState, useEffect, useRef } from 'react'

// ── Visual constants — chosen for contrast against H&E pink/purple ─────────────
const FILL_COLOR      = 'rgba(255, 210, 0, 0.15)'
const STROKE_COLOR    = '#ffd700'
const VERTEX_COLOR    = '#ffd700'
const FIRST_VERTEX_COLOR = '#ff7c00'  // orange ⟹ "click here to close"
const VERTEX_R        = 5
const FIRST_VERTEX_R  = 7
const CLOSE_THRESHOLD = 14  // px — click within this of first vertex to close polygon


// ── Coordinate helpers ─────────────────────────────────────────────────────────

function imageToElement(viewer, ix, iy) {
  if (!viewer?.viewport) return null
  try {
    const vp = viewer.viewport.imageToViewportCoordinates(
      new window.OpenSeadragon.Point(ix, iy)
    )
    const el = viewer.viewport.viewportToViewerElementCoordinates(vp)
    return { x: el.x, y: el.y }
  } catch { return null }
}

function elementToImage(viewer, ex, ey) {
  if (!viewer?.viewport) return null
  try {
    const vp = viewer.viewport.viewerElementToViewportCoordinates(
      new window.OpenSeadragon.Point(ex, ey)
    )
    const img = viewer.viewport.viewportToImageCoordinates(vp)
    return { x: img.x, y: img.y }
  } catch { return null }
}

function dist2d(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

function toSVGPath(pts, closed) {
  if (!pts.length) return ''
  return pts
    .map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`)
    .join(' ') + (closed ? ' Z' : '')
}


// ── Component ──────────────────────────────────────────────────────────────────

export default function PolygonTool({ viewer, isActive, polygons, setPolygons }) {
  // Vertices of the polygon being drawn, in image-pixel coordinates
  const [current, setCurrent] = useState([])
  // Mouse position in viewer-element space (for the live preview edge)
  const [mouse,   setMouse]   = useState(null)
  // Bumped on OSD pan/zoom to trigger re-projection of stored coordinates
  const [tick,    setTick]    = useState(0)

  // Ref kept in sync with `current` so double-click handler can read the
  // latest value without a stale closure (setCurrent is async).
  const currentRef = useRef([])
  useEffect(() => { currentRef.current = current }, [current])

  const svgRef = useRef(null)

  // ── Subscribe to OSD viewport events ────────────────────────────────────────
  useEffect(() => {
    if (!viewer) return
    const bump = () => setTick(n => n + 1)
    viewer.addHandler('animation', bump)
    viewer.addHandler('zoom',      bump)
    viewer.addHandler('pan',       bump)
    viewer.addHandler('resize',    bump)
    return () => {
      viewer.removeHandler('animation', bump)
      viewer.removeHandler('zoom',      bump)
      viewer.removeHandler('pan',       bump)
      viewer.removeHandler('resize',    bump)
    }
  }, [viewer])

  // ── Deactivation resets in-progress polygon ──────────────────────────────────
  useEffect(() => {
    if (!isActive) { setCurrent([]); setMouse(null) }
  }, [isActive])

  // ── Escape key: cancel current polygon (not finished ones) ──────────────────
  useEffect(() => {
    if (!isActive) return
    const handler = e => {
      if (e.key === 'Escape') { setCurrent([]); currentRef.current = [] }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [isActive])


  // ── Re-project all stored coordinates to viewer-element space ────────────────
  // Called on every render — tick changes force this to run after OSD moves.
  const projFinished = polygons.map(poly =>
    poly.map(pt => imageToElement(viewer, pt.x, pt.y)).filter(Boolean)
  )
  const projCurrent = current.map(pt =>
    imageToElement(viewer, pt.x, pt.y)
  ).filter(Boolean)


  // ── Event helpers ────────────────────────────────────────────────────────────

  function getElementCoords(e) {
    const rect = svgRef.current.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  function closePolygon(poly) {
    if (poly.length < 3) return
    setPolygons(prev => [...prev, poly])
    setCurrent([])
    currentRef.current = []
    setMouse(null)
  }


  // ── Pointer handlers ─────────────────────────────────────────────────────────

  function handleMouseMove(e) {
    if (!isActive) return
    setMouse(getElementCoords(e))
  }

  function handleMouseLeave() { setMouse(null) }

  function handleClick(e) {
    // Skip the second click that makes up a double-click — the dblclick
    // handler closes the polygon instead.
    if (!isActive || e.detail >= 2) return
    e.stopPropagation()

    const elPos  = getElementCoords(e)
    const imgPos = elementToImage(viewer, elPos.x, elPos.y)
    if (!imgPos) return

    // Click near the first vertex (≥3 vertices already) → close polygon
    if (projCurrent.length >= 3 && dist2d(elPos, projCurrent[0]) <= CLOSE_THRESHOLD) {
      closePolygon(currentRef.current)
      return
    }

    const newCurrent = [...currentRef.current, { x: imgPos.x, y: imgPos.y }]
    currentRef.current = newCurrent  // sync ref immediately (before React batch)
    setCurrent(newCurrent)
  }

  function handleDoubleClick(e) {
    // By the time dblclick fires, handleClick(detail=1) has already added one
    // vertex (the first click of the double-click). The second click was
    // suppressed by the detail≥2 guard. So currentRef.current is up-to-date.
    if (!isActive) return
    e.stopPropagation()
    closePolygon(currentRef.current)
  }


  // ── Derived display values ───────────────────────────────────────────────────
  const hasPreview = isActive && projCurrent.length > 0 && mouse
  const nearFirst  = hasPreview &&
    projCurrent.length >= 3 &&
    dist2d(mouse, projCurrent[0]) <= CLOSE_THRESHOLD


  // ── Render ───────────────────────────────────────────────────────────────────
  return (
    <svg
      ref={svgRef}
      style={{
        position: 'absolute', inset: 0,
        width: '100%', height: '100%',
        pointerEvents: isActive ? 'all' : 'none',
        cursor: isActive ? (nearFirst ? 'cell' : 'crosshair') : 'default',
        zIndex: 50,
      }}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
    >
      {/* ── Completed polygons ─────────────────────────────────────────────── */}
      {projFinished.map((poly, pi) =>
        poly.length >= 2 ? (
          <g key={pi}>
            <path
              d={toSVGPath(poly, true)}
              fill={FILL_COLOR}
              stroke={STROKE_COLOR}
              strokeWidth={1.5}
              strokeLinejoin="round"
            />
            {poly.map((pt, vi) => (
              <circle key={vi} cx={pt.x} cy={pt.y} r={3}
                fill={STROKE_COLOR} stroke="rgba(0,0,0,0.45)" strokeWidth={1} />
            ))}
          </g>
        ) : null
      )}

      {/* ── Polygon in progress ────────────────────────────────────────────── */}
      {projCurrent.length > 0 && (
        <g>
          {/* Filled area preview (once ≥3 vertices) */}
          {projCurrent.length >= 3 && (
            <path d={toSVGPath(projCurrent, true)} fill={FILL_COLOR} stroke="none" />
          )}

          {/* Drawn edges */}
          <path
            d={toSVGPath(projCurrent, false)}
            fill="none"
            stroke={STROKE_COLOR}
            strokeWidth={1.5}
            strokeLinejoin="round"
          />

          {/* Live edge from last vertex to cursor */}
          {hasPreview && (
            <line
              x1={projCurrent[projCurrent.length - 1].x}
              y1={projCurrent[projCurrent.length - 1].y}
              x2={mouse.x} y2={mouse.y}
              stroke={STROKE_COLOR} strokeWidth={1.5}
              strokeDasharray="6 3" opacity={0.85}
            />
          )}

          {/* Faint closing hint: cursor back to first vertex */}
          {hasPreview && projCurrent.length >= 2 && (
            <line
              x1={mouse.x} y1={mouse.y}
              x2={projCurrent[0].x} y2={projCurrent[0].y}
              stroke={STROKE_COLOR} strokeWidth={1}
              strokeDasharray="2 6" opacity={0.35}
            />
          )}

          {/* Vertices */}
          {projCurrent.map((pt, vi) => (
            <circle
              key={vi}
              cx={pt.x} cy={pt.y}
              r={vi === 0 ? FIRST_VERTEX_R : VERTEX_R}
              fill={vi === 0 ? FIRST_VERTEX_COLOR : VERTEX_COLOR}
              stroke="white" strokeWidth={1.5}
            />
          ))}
        </g>
      )}
    </svg>
  )
}