// frontend/src/pages/ProjectDetail/AnnotationLayer.jsx
//
// Round 2 — complete rewrite on top of Round 1.
//
// SELECT / MOVE TOOL
//   • Click annotation body         → select it (no toggle for already-selected)
//   • Click empty canvas            → deselect
//   • Drag body (threshold 5 px)    → translate all geometry in image space
//   • readOnly: click still selects, drag is blocked
//
// POLYGON / BRUSH vertex editing (select mode)  [Round 1, kept + unified into activeDrag]
//   • Drag vertex handle            → reposition vertex
//   • Click edge mid-point handle   → insert vertex then drag it
//   • Alt + click vertex            → delete vertex (min 3)
//
// RECTANGLE resize handles (8: TL T TR R BR B BL L)
//   • Drag handle                   → resize
//   • Shift held                    → constrain to square
//
// ELLIPSE resize handles (4 cardinal: N S E W)
//   • Drag handle                   → resize rx / ry
//   • Shift held                    → constrain to circle
//
// POINT   — move via general body-drag; create via click in point mode
//
// POLYGON drawing [Round 1, kept]
//   • Click to add vertex           | Double-click / click first vertex → commit
//   • Backspace                     → remove last in-progress vertex
//   • Hold & drag on fresh polygon  → freehand mode
//   • Esc (ProjectDetail)           → cancel (reset activeTool → 'select')
//
// BRUSH   [Round 1, kept]
//   • Paint / erase (Alt)           | Alt+wheel → radius | F → fill holes
//   • Expand existing brush/polygon annotation

import { useState, useEffect, useRef } from 'react'
import { imageToElement, elementToImage } from '../../hooks/useOSDViewer'
import { strokeToPolygon }               from '../../lib/BrushEngine'
import {
  union, difference, constrainToBounds, fillHoles, simplify, roundCoordinates,
} from '../../lib/PolygonOps'
import BrushLimits from './BrushLimits'

// ─── Visual constants ─────────────────────────────────────────────────────────
const VERTEX_R        = 5    // in-progress polygon vertex radius
const FIRST_VERTEX_R  = 7    // in-progress polygon first-vertex radius
const CLOSE_THRESH    = 14   // px — close-on-first-vertex snap distance
const MIN_DRAG        = 4    // px — minimum drag to register rect/ellipse creation

// ─── Polygon-tool constants ───────────────────────────────────────────────────
const FREEHAND_THRESH = 8    // px moved while held → activate freehand mode
const FREEHAND_GAP    = 4    // minimum element-px between consecutive freehand vertices

// ─── Select-mode constants ────────────────────────────────────────────────────
const MOVE_THRESH     = 5    // px — drag threshold before body-move activates
const VTX_HIT_R       = 12   // px — vertex handle hit radius
const MIDPT_HIT_R     = 10   // px — edge mid-point handle hit radius
const HDL_HIT_R       = 10   // px — rect / ellipse resize-handle hit radius
const VTX_R_VIS       = 6    // visual radius of vertex handles
const MIDPT_R_VIS     = 4    // visual radius of edge mid-point handles
const RECT_HDL_HALF   = 5    // half-size of rect resize handle squares (10×10 px)
const ELLIPSE_HDL_R   = 6    // visual radius of ellipse handles

// ─── Cursor maps ──────────────────────────────────────────────────────────────
const RECT_CURSOR = {
  TL: 'nwse-resize', T:  'ns-resize',   TR: 'nesw-resize',
  R:  'ew-resize',   BR: 'nwse-resize', B:  'ns-resize',
  BL: 'nesw-resize', L:  'ew-resize',
}
const ELLIPSE_CURSOR = { N: 'ns-resize', S: 'ns-resize', E: 'ew-resize', W: 'ew-resize' }


// ═══════════════════════════════════════════════════════════════════════════════
// PURE HELPERS  (no hooks, no side effects)
// ═══════════════════════════════════════════════════════════════════════════════

function toSVGPath(pts, closed) {
  if (!pts.length) return ''
  return pts.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')
    + (closed ? ' Z' : '')
}

function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y) }

function polygonContains(pts, img) {
  let inside = false, n = pts.length
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const pi = pts[i], pj = pts[j]
    if ((pi.y > img.y) !== (pj.y > img.y) &&
        img.x < (pj.x - pi.x) * (img.y - pi.y) / (pj.y - pi.y) + pi.x)
      inside = !inside
  }
  return inside
}

/** True if element-space point `el` is inside the annotation body. */
function hitTestBody(viewer, ann, el) {
  if (!viewer?.viewport) return false
  const g = ann.geometry
  try {
    switch (ann.annotation_type) {
      case 'point': {
        const e = imageToElement(viewer, g.x, g.y)
        return e ? dist(el, e) <= 14 : false
      }
      case 'rectangle': {
        const img = elementToImage(viewer, el.x, el.y); if (!img) return false
        return img.x >= g.x && img.x <= g.x + g.width &&
               img.y >= g.y && img.y <= g.y + g.height
      }
      case 'ellipse': {
        const img = elementToImage(viewer, el.x, el.y); if (!img) return false
        const dx = (img.x - g.cx) / Math.max(1, g.rx)
        const dy = (img.y - g.cy) / Math.max(1, g.ry)
        return dx * dx + dy * dy <= 1
      }
      case 'polygon': case 'brush': {
        const img = elementToImage(viewer, el.x, el.y)
        return img ? polygonContains(g.points || [], img) : false
      }
      default: return false
    }
  } catch { return false }
}

/** Translate geometry by (dx, dy) in image space. */
function translateGeometry(type, geom, dx, dy) {
  switch (type) {
    case 'point':
      return { x: geom.x + dx, y: geom.y + dy }
    case 'rectangle':
      return { ...geom, x: geom.x + dx, y: geom.y + dy }
    case 'ellipse':
      return { ...geom, cx: geom.cx + dx, cy: geom.cy + dy }
    case 'polygon': case 'brush':
      return { points: (geom.points || []).map(p => ({ x: p.x + dx, y: p.y + dy })) }
    default: return geom
  }
}

/** Eight resize-handle image-space positions for a rectangle. */
function rectHandlePositions(g) {
  const { x, y, width: w, height: h } = g
  return [
    { id: 'TL', ix: x,       iy: y       },
    { id: 'T',  ix: x + w/2, iy: y       },
    { id: 'TR', ix: x + w,   iy: y       },
    { id: 'R',  ix: x + w,   iy: y + h/2 },
    { id: 'BR', ix: x + w,   iy: y + h   },
    { id: 'B',  ix: x + w/2, iy: y + h   },
    { id: 'BL', ix: x,       iy: y + h   },
    { id: 'L',  ix: x,       iy: y + h/2 },
  ]
}

/** Compute new rectangle geometry from a handle drag. */
function applyRectHandle(orig, handleId, img, shiftKey = false) {
  const MIN = 4
  const origR = orig.x + orig.width, origB = orig.y + orig.height
  const movesL = handleId === 'TL' || handleId === 'L'  || handleId === 'BL'
  const movesR = handleId === 'TR' || handleId === 'R'  || handleId === 'BR'
  const movesT = handleId === 'TL' || handleId === 'T'  || handleId === 'TR'
  const movesB = handleId === 'BL' || handleId === 'B'  || handleId === 'BR'
  let L = movesL ? img.x : orig.x,  R = movesR ? img.x : origR
  let T = movesT ? img.y : orig.y,  B = movesB ? img.y : origB
  // Enforce minimum size (don't allow flipping)
  if (R - L < MIN) { if (movesL) L = R - MIN; else R = L + MIN }
  if (B - T < MIN) { if (movesT) T = B - MIN; else B = T + MIN }
  if (shiftKey) {
    const w = R - L, h = B - T, s = Math.max(w, h)
    if (w < s) { if (movesL) L = R - s; else R = L + s }
    if (h < s) { if (movesT) T = B - s; else B = T + s }
  }
  return { x: L, y: T, width: R - L, height: B - T }
}

/** Four cardinal resize-handle image-space positions for an ellipse. */
function ellipseHandlePositions(g) {
  return [
    { id: 'N', ix: g.cx,        iy: g.cy - g.ry },
    { id: 'S', ix: g.cx,        iy: g.cy + g.ry },
    { id: 'E', ix: g.cx + g.rx, iy: g.cy        },
    { id: 'W', ix: g.cx - g.rx, iy: g.cy        },
  ]
}

/** Compute new ellipse geometry from a handle drag. */
function applyEllipseHandle(orig, handleId, img, shiftKey = false) {
  const MIN = 4
  let { cx, cy, rx, ry } = orig
  switch (handleId) {
    case 'N': ry = Math.max(MIN, cy - img.y); break
    case 'S': ry = Math.max(MIN, img.y - cy); break
    case 'E': rx = Math.max(MIN, img.x - cx); break
    case 'W': rx = Math.max(MIN, cx - img.x); break
  }
  if (shiftKey) { const r = Math.max(rx, ry); rx = r; ry = r }
  return { cx, cy, rx, ry }
}

/** Hit-test el against rect resize handles. Returns {id} or null. */
function hitRectHandle(viewer, g, el) {
  if (!viewer?.viewport || !g) return null
  for (const h of rectHandlePositions(g)) {
    const e = imageToElement(viewer, h.ix, h.iy)
    if (e && dist(el, e) <= HDL_HIT_R) return { id: h.id }
  }
  return null
}

/** Hit-test el against ellipse resize handles. Returns {id} or null. */
function hitEllipseHandle(viewer, g, el) {
  if (!viewer?.viewport || !g) return null
  for (const h of ellipseHandlePositions(g)) {
    const e = imageToElement(viewer, h.ix, h.iy)
    if (e && dist(el, e) <= HDL_HIT_R) return { id: h.id }
  }
  return null
}

/**
 * Hit-test el against polygon/brush vertex and edge mid-point handles.
 * Vertices take priority. Returns {type:'vertex'|'midpoint', idx} or null.
 */
function hitVertexHandle(viewer, ann, el) {
  if (!viewer?.viewport || !ann) return null
  const pts = ann.geometry?.points || []
  for (let i = 0; i < pts.length; i++) {
    const e = imageToElement(viewer, pts[i].x, pts[i].y)
    if (e && dist(el, e) <= VTX_HIT_R) return { type: 'vertex', idx: i }
  }
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length
    const e = imageToElement(viewer,
      (pts[i].x + pts[j].x) / 2,
      (pts[i].y + pts[j].y) / 2)
    if (e && dist(el, e) <= MIDPT_HIT_R) return { type: 'midpoint', idx: i }
  }
  return null
}

// ─── Brush geometry helpers ───────────────────────────────────────────────────
function circlePoly(cx, cy, r, n = 32) {
  return Array.from({ length: n }, (_, i) => {
    const a = (2 * Math.PI * i) / n
    return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) }
  })
}
function capsulePoly(x1, y1, x2, y2, r) {
  return strokeToPolygon([{ x: x1, y: y1 }, { x: x2, y: y2 }], r, 12)
}


// ═══════════════════════════════════════════════════════════════════════════════
// SVG SUB-COMPONENTS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Renders one stored annotation.
 * No onClick — all canvas-level interaction is handled by the SVG overlay.
 */
function AnnotationShape({ viewer, ann, selected }) {
  if (!viewer?.viewport) return null
  const color   = ann._color || '#6ee7b7'
  const fillOp  = selected ? 0.50 : 0.28
  const sw      = selected ? 2 : 1.5
  const strokeC = selected ? '#fff' : color
  const g = ann.geometry
  try {
    switch (ann.annotation_type) {
      case 'point': {
        const e = imageToElement(viewer, g.x, g.y); if (!e) return null
        return (
          <g>
            <circle cx={e.x} cy={e.y} r={selected ? 9 : 7}
              fill={color} fillOpacity={fillOp + 0.2} stroke={strokeC} strokeWidth={sw} />
            <circle cx={e.x} cy={e.y} r={3} fill={strokeC} />
          </g>
        )
      }
      case 'rectangle': {
        const cs = [
          imageToElement(viewer, g.x,           g.y),
          imageToElement(viewer, g.x + g.width,  g.y),
          imageToElement(viewer, g.x + g.width,  g.y + g.height),
          imageToElement(viewer, g.x,            g.y + g.height),
        ].filter(Boolean)
        if (cs.length < 4) return null
        return <path d={toSVGPath(cs, true)}
          fill={color} fillOpacity={fillOp} stroke={strokeC} strokeWidth={sw} />
      }
      case 'ellipse': {
        const pts = []
        for (let i = 0; i < 48; i++) {
          const a = (2 * Math.PI * i) / 48
          const e = imageToElement(viewer, g.cx + g.rx * Math.cos(a), g.cy + g.ry * Math.sin(a))
          if (e) pts.push(e)
        }
        if (pts.length < 3) return null
        return <path d={toSVGPath(pts, true)}
          fill={color} fillOpacity={fillOp} stroke={strokeC} strokeWidth={sw} />
      }
      case 'polygon': case 'brush': {
        const pts = (g.points || []).map(p => imageToElement(viewer, p.x, p.y)).filter(Boolean)
        if (pts.length < 2) return null
        return <path d={toSVGPath(pts, true)}
          fill={color} fillOpacity={fillOp} stroke={strokeC}
          strokeWidth={sw} strokeLinejoin="round" />
      }
      default: return null
    }
  } catch { return null }
}

/**
 * Ghost annotation rendered with higher opacity while being dragged/edited.
 * `type` and `geometry` describe the live (in-flight) shape.
 */
function LiveAnnotation({ viewer, type, geometry: g, color }) {
  if (!viewer?.viewport || !g) return null
  const fill = `${color}55`, sw = 1.5
  try {
    switch (type) {
      case 'point': {
        const e = imageToElement(viewer, g.x, g.y); if (!e) return null
        return (
          <g>
            <circle cx={e.x} cy={e.y} r={9} fill={color} fillOpacity={0.5}
              stroke="white" strokeWidth={sw} />
            <circle cx={e.x} cy={e.y} r={3} fill="white" />
          </g>
        )
      }
      case 'rectangle': {
        const cs = [
          imageToElement(viewer, g.x,           g.y),
          imageToElement(viewer, g.x + g.width,  g.y),
          imageToElement(viewer, g.x + g.width,  g.y + g.height),
          imageToElement(viewer, g.x,            g.y + g.height),
        ].filter(Boolean)
        if (cs.length < 4) return null
        return <path d={toSVGPath(cs, true)} fill={fill} stroke="white" strokeWidth={sw} />
      }
      case 'ellipse': {
        const pts = []
        for (let i = 0; i < 48; i++) {
          const a = (2 * Math.PI * i) / 48
          const e = imageToElement(viewer, g.cx + g.rx * Math.cos(a), g.cy + g.ry * Math.sin(a))
          if (e) pts.push(e)
        }
        if (pts.length < 3) return null
        return <path d={toSVGPath(pts, true)} fill={fill} stroke="white" strokeWidth={sw} />
      }
      case 'polygon': case 'brush': {
        const pts = (g.points || []).map(p => imageToElement(viewer, p.x, p.y)).filter(Boolean)
        if (pts.length < 2) return null
        return <path d={toSVGPath(pts, true)} fill={fill} stroke="white"
          strokeWidth={sw} strokeLinejoin="round" />
      }
      default: return null
    }
  } catch { return null }
}

/** Dashed bounding-box outline + 8 square resize handles for a selected rectangle. */
function RectHandleOverlay({ viewer, g, color }) {
  if (!viewer?.viewport || !g) return null
  const corners = [
    imageToElement(viewer, g.x,           g.y),
    imageToElement(viewer, g.x + g.width,  g.y),
    imageToElement(viewer, g.x + g.width,  g.y + g.height),
    imageToElement(viewer, g.x,            g.y + g.height),
  ].filter(Boolean)
  const handles = rectHandlePositions(g)
    .map(h => ({ ...h, e: imageToElement(viewer, h.ix, h.iy) }))
    .filter(h => h.e)
  return (
    <g style={{ pointerEvents: 'none' }}>
      {corners.length === 4 && (
        <path d={toSVGPath(corners, true)} fill="none"
          stroke={color} strokeWidth={1} strokeDasharray="5 3" opacity={0.65} />
      )}
      {handles.map(h => (
        <rect key={h.id}
          x={h.e.x - RECT_HDL_HALF} y={h.e.y - RECT_HDL_HALF}
          width={RECT_HDL_HALF * 2}  height={RECT_HDL_HALF * 2}
          fill="white" fillOpacity={0.92} stroke={color} strokeWidth={1.5} />
      ))}
    </g>
  )
}

/** Dashed ellipse outline + 4 circular resize handles for a selected ellipse. */
function EllipseHandleOverlay({ viewer, g, color }) {
  if (!viewer?.viewport || !g) return null
  const outline = Array.from({ length: 36 }, (_, i) => {
    const a = (2 * Math.PI * i) / 36
    return imageToElement(viewer, g.cx + g.rx * Math.cos(a), g.cy + g.ry * Math.sin(a))
  }).filter(Boolean)
  const handles = ellipseHandlePositions(g)
    .map(h => ({ ...h, e: imageToElement(viewer, h.ix, h.iy) }))
    .filter(h => h.e)
  return (
    <g style={{ pointerEvents: 'none' }}>
      {outline.length > 3 && (
        <path d={toSVGPath(outline, true)} fill="none"
          stroke={color} strokeWidth={1} strokeDasharray="5 3" opacity={0.65} />
      )}
      {handles.map(h => (
        <circle key={h.id} cx={h.e.x} cy={h.e.y} r={ELLIPSE_HDL_R}
          fill="white" fillOpacity={0.92} stroke={color} strokeWidth={1.5} />
      ))}
    </g>
  )
}

/**
 * Dashed polygon outline + vertex handles + edge mid-point handles.
 * Used for selected polygon/brush in select mode.
 * `pts` is the current (possibly live) point array in image space.
 */
function PolygonHandleOverlay({ viewer, pts, color }) {
  if (!viewer?.viewport || !pts.length) return null
  const proj = pts.map(p => imageToElement(viewer, p.x, p.y)).filter(Boolean)
  if (proj.length < 2) return null
  return (
    <g style={{ pointerEvents: 'none' }}>
      <path d={toSVGPath(proj, true)} fill={color} fillOpacity={0.07}
        stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeDasharray="5 3" />
      {proj.map((p, i) => {
        const nx = proj[(i + 1) % proj.length]
        return (
          <circle key={`m${i}`}
            cx={(p.x + nx.x) / 2} cy={(p.y + nx.y) / 2}
            r={MIDPT_R_VIS}
            fill="white" fillOpacity={0.8} stroke={color} strokeWidth={1} />
        )
      })}
      {proj.map((p, i) => (
        <circle key={`v${i}`} cx={p.x} cy={p.y} r={VTX_R_VIS}
          fill={color} fillOpacity={0.92} stroke="white" strokeWidth={1.5} />
      ))}
    </g>
  )
}


// ═══════════════════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * activeDrag shape (stored in both ref + state for fresh reads + re-renders):
 * null
 * | { kind:'pendingMove',   annId, startEl, startImg, origGeometry, annotationType }
 * | { kind:'move',          annId, startEl, startImg, origGeometry, annotationType }
 * | { kind:'vtxEdit',       annId, pts:[{x,y}], idx }
 * | { kind:'rectHandle',    annId, handleId, origGeometry, shiftKey }
 * | { kind:'ellipseHandle', annId, handleId, origGeometry, shiftKey }
 */

export default function AnnotationLayer({
  osdRef,
  activeTool,
  activeClass,
  brushRadius,
  setBrushRadius,
  annotations,
  selectedAnnId,
  onAnnotationClick,
  onAnnotationCreated,
  onAnnotationUpdated,
  readOnly,
  tick,   // incremented by OSD pan/zoom → triggers re-projection
}) {
  const svgRef = useRef(null)

  // ── In-progress polygon ───────────────────────────────────────────────────
  const [polyPts,   setPolyPts]   = useState([])
  const [mouse,     setMouse]     = useState(null)   // element-space {x,y}
  const [dragStart, setDragStart] = useState(null)   // rect/ellipse creation
  const [dragEnd,   setDragEnd]   = useState(null)
  // Ref always tracks latest polyPts without stale closures
  const polyRef          = useRef([])
  useEffect(() => { polyRef.current = polyPts }, [polyPts])
  // Freehand tracking refs
  const polyDownRef      = useRef(false)
  const polyPressElRef   = useRef(null)
  const polyFreehandRef  = useRef(false)

  // ── Space / middle-mouse pan ──────────────────────────────────────────────
  const [isSpacePan,  setIsSpacePan]  = useState(false)
  const [isMiddlePan, setIsMiddlePan] = useState(false)
  const isSpacePanRef  = useRef(false)
  const isMiddlePanRef = useRef(false)
  const navOverride = isSpacePan || isMiddlePan

  // ── Unified drag state ────────────────────────────────────────────────────
  const [activeDrag, setActiveDrag] = useState(null)
  const activeDragRef = useRef(null)
  function setDragState(val) { activeDragRef.current = val; setActiveDrag(val) }

  // Swallows the `click` event that fires after onPointerUp resolves a drag
  const suppressClickRef  = useRef(false)
  // Marks that empty-space was pressed; deselect on pointerUp
  const pendingDeselectRef = useRef(false)

  // ── Brush state ───────────────────────────────────────────────────────────
  const [brushROI,     setBrushROI]     = useState(null)
  const [brushLimitsV, setBrushLimitsV] = useState(false)
  const brushROIRef   = useRef(null)
  const lastBrushPt   = useRef(null)
  const editingAnn    = useRef(null)    // existing annotation being expanded
  const subtractMode  = useRef(false)
  const brushDown     = useRef(false)
  const pressureRef   = useRef(1.0)
  useEffect(() => { brushROIRef.current = brushROI }, [brushROI])


  // ═══════════════════════════════════════════════════════════════════════════
  // EFFECTS
  // ═══════════════════════════════════════════════════════════════════════════

  // Reset all drawing state on tool change
  useEffect(() => {
    if (activeTool !== 'brush') {
      setBrushROI(null); brushROIRef.current = null
      lastBrushPt.current = null; editingAnn.current = null
      brushDown.current = false; setBrushLimitsV(false)
    }
    setPolyPts([]); polyRef.current = []
    setMouse(null); setDragStart(null); setDragEnd(null)
    setIsSpacePan(false); setIsMiddlePan(false)
    isSpacePanRef.current = false; isMiddlePanRef.current = false
    polyDownRef.current = false; polyPressElRef.current = null; polyFreehandRef.current = false
    if (activeDragRef.current) setDragState(null)
    suppressClickRef.current = false
    pendingDeselectRef.current = false
  }, [activeTool]) // eslint-disable-line

  // Cancel drag if ProjectDetail changes selection externally (e.g. ClassPanel)
  useEffect(() => {
    if (activeDragRef.current) setDragState(null)
  }, [selectedAnnId]) // eslint-disable-line

  // Disable OSD pan while a tool is active; re-enable for nav override
  useEffect(() => {
    const v = osdRef.current
    if (!v?.setMouseNavEnabled) return
    v.setMouseNavEnabled(readOnly || !activeTool || navOverride)
    return () => { osdRef.current?.setMouseNavEnabled(true) }
  }, [activeTool, navOverride, osdRef, readOnly])

  // Spacebar → temporary OSD pan while drawing
  useEffect(() => {
    if (!activeTool || readOnly) return
    const notInput = () => !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)
    const dn = ev => { if (ev.code !== 'Space' || !notInput()) return; ev.preventDefault(); isSpacePanRef.current = true;  setIsSpacePan(true) }
    const up = ev => { if (ev.code !== 'Space') return;                                             isSpacePanRef.current = false; setIsSpacePan(false) }
    const bl = ()  => { isSpacePanRef.current = false; setIsSpacePan(false) }
    window.addEventListener('keydown', dn); window.addEventListener('keyup', up); window.addEventListener('blur', bl)
    return () => { window.removeEventListener('keydown', dn); window.removeEventListener('keyup', up); window.removeEventListener('blur', bl) }
  }, [activeTool, readOnly])

  // Middle-mouse → temporary OSD pan
  useEffect(() => {
    if (!activeTool) return
    const up = ev => { if (ev.button !== 1) return; isMiddlePanRef.current = false; setIsMiddlePan(false) }
    window.addEventListener('mouseup', up)
    return () => window.removeEventListener('mouseup', up)
  }, [activeTool])

  // Backspace → remove last in-progress polygon vertex
  useEffect(() => {
    if (activeTool !== 'polygon') return
    const h = ev => {
      if (ev.key !== 'Backspace') return
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return
      ev.preventDefault()
      const cur = polyRef.current; if (!cur.length) return
      const next = cur.slice(0, -1); polyRef.current = next; setPolyPts(next)
    }
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [activeTool])

  // F key → fill holes in active brush ROI
  useEffect(() => {
    if (activeTool !== 'brush') return
    const h = ev => {
      if (ev.key !== 'f' && ev.key !== 'F') return
      if (!brushROIRef.current) return
      const filled = fillHoles(brushROIRef.current)
      setBrushROI(filled); brushROIRef.current = filled
    }
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [activeTool])


  // ═══════════════════════════════════════════════════════════════════════════
  // EVENT HELPERS
  // ═══════════════════════════════════════════════════════════════════════════

  function getEl(e) {
    const r = svgRef.current.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }
  function toImg(el) { return elementToImage(osdRef.current, el.x, el.y) }

  function effectiveBrushR() { return brushRadius * pressureRef.current }
  function viewRadius() {
    const v = osdRef.current; if (!v?.viewport) return 20
    const o = imageToElement(v, 0, 0), f = imageToElement(v, effectiveBrushR(), 0)
    return (o && f) ? Math.max(1, Math.abs(f.x - o.x)) : 20
  }

  /** Emit a new annotation (blocked when readOnly). */
  function emit(ann) {
    if (!onAnnotationCreated || readOnly) return
    onAnnotationCreated({ ...ann, class_id: activeClass?.id, class_name: activeClass?.name })
  }


  // ═══════════════════════════════════════════════════════════════════════════
  // BRUSH HANDLERS
  // ═══════════════════════════════════════════════════════════════════════════

  function makeBrushGeom(img) {
    const r = effectiveBrushR(), last = lastBrushPt.current
    if (!last || (Math.abs(last.x - img.x) < 0.5 && Math.abs(last.y - img.y) < 0.5))
      return circlePoly(img.x, img.y, r)
    return capsulePoly(last.x, last.y, img.x, img.y, r)
  }

  function applyBrush(geom, current) {
    let next = subtractMode.current ? difference(current, geom) : union(current, geom)
    next = roundCoordinates(next)
    if (next.length > 8) next = simplify(next, 0.1)
    const info = osdRef.current?.source
    if (info?.width && info?.height) next = constrainToBounds(next, info.width, info.height)
    return next
  }

  function findEditableAnnUnder(img) {
    for (const ann of [...annotations].reverse()) {
      if (ann.annotation_type !== 'brush' && ann.annotation_type !== 'polygon') continue
      const pts = ann.geometry?.points || []; if (!pts.length) continue
      const xs = pts.map(p => p.x), ys = pts.map(p => p.y)
      if (img.x < Math.min(...xs) || img.x > Math.max(...xs) ||
          img.y < Math.min(...ys) || img.y > Math.max(...ys)) continue
      if (polygonContains(pts, img)) return ann
    }
    return null
  }

  function onBrushDown(e) {
    if (readOnly) return
    brushDown.current = true
    subtractMode.current = e.altKey || (e.pointerType === 'pen' && (e.buttons & 32))
    pressureRef.current  = (e.pressure && e.pressure > 0) ? e.pressure : 1.0
    const img = toImg(getEl(e)); if (!img) return
    const existing = subtractMode.current ? null : findEditableAnnUnder(img)
    const startROI = existing ? (existing.geometry?.points || []) : []
    editingAnn.current = existing || null
    const next = applyBrush(circlePoly(img.x, img.y, effectiveBrushR()), startROI)
    lastBrushPt.current = img; setBrushROI(next); brushROIRef.current = next
  }

  function onBrushDrag(e) {
    if (!brushDown.current || readOnly) return
    pressureRef.current = (e.pressure && e.pressure > 0) ? e.pressure : pressureRef.current
    const img = toImg(getEl(e)); if (!img) return
    const next = applyBrush(makeBrushGeom(img), brushROIRef.current || [])
    lastBrushPt.current = img; setBrushROI(next); brushROIRef.current = next
  }

  function onBrushUp() {
    if (!brushDown.current || readOnly) return
    brushDown.current = false
    const final = brushROIRef.current || []
    if (final.length >= 3) {
      emit(editingAnn.current
        ? { annotation_type: 'brush', geometry: { points: final }, _replaceId: editingAnn.current.id }
        : { annotation_type: 'brush', geometry: { points: final } })
    }
    setBrushROI(null); brushROIRef.current = null
    lastBrushPt.current = null; editingAnn.current = null; subtractMode.current = false
  }


  // ═══════════════════════════════════════════════════════════════════════════
  // POLYGON HANDLERS
  // ═══════════════════════════════════════════════════════════════════════════

  /** Click mode — adds a vertex or closes the polygon. */
  function handlePolyClick(e) {
    if (e.detail >= 2) return               // handled by handlePolyDbl
    if (polyFreehandRef.current) return      // freehand committed in onPolyUp
    const el = getEl(e), img = toImg(el); if (!img) return
    const cur = polyRef.current             // always fresh (no stale state)
    // Close polygon if click is near the first vertex and ≥3 pts exist
    if (cur.length >= 3) {
      const firstEl = imageToElement(osdRef.current, cur[0].x, cur[0].y)
      if (firstEl && dist(el, firstEl) <= CLOSE_THRESH) {
        emit({ annotation_type: 'polygon', geometry: { points: cur } })
        setPolyPts([]); polyRef.current = []; setMouse(null); return
      }
    }
    const next = [...cur, img]; polyRef.current = next; setPolyPts(next)
  }

  /** Double-click — commits the polygon. */
  function handlePolyDbl(e) {
    e.stopPropagation()
    const cur = polyRef.current
    if (cur.length >= 3) emit({ annotation_type: 'polygon', geometry: { points: cur } })
    setPolyPts([]); polyRef.current = []; setMouse(null)
    polyFreehandRef.current = false; polyDownRef.current = false; polyPressElRef.current = null
  }

  function onPolyDown(e) {
    polyDownRef.current = true; polyPressElRef.current = getEl(e); polyFreehandRef.current = false
  }

  /**
   * Freehand: triggered when the user drags on a FRESH (0-vertex) polygon.
   * Mirrors QuPath's `isFreehandPolyROI` check: only activates on a brand-new polygon.
   */
  function onPolyFreehandDrag(e) {
    if (!polyDownRef.current) return
    const el = getEl(e), pressEl = polyPressElRef.current; if (!pressEl) return
    if (!polyFreehandRef.current) {
      if (polyRef.current.length > 0) return    // click-mode polygon in progress — don't switch
      if (Math.hypot(el.x - pressEl.x, el.y - pressEl.y) < FREEHAND_THRESH) return
      polyFreehandRef.current = true
      const si = toImg(pressEl)
      if (si) { const init = [si]; polyRef.current = init; setPolyPts(init) }
    }
    const img = toImg(el); if (!img) return
    const cur = polyRef.current
    if (cur.length > 0) {
      const lastEl = imageToElement(osdRef.current, cur[cur.length - 1].x, cur[cur.length - 1].y)
      if (lastEl && dist(el, lastEl) < FREEHAND_GAP) return
    }
    const next = [...cur, img]; polyRef.current = next; setPolyPts(next)
  }

  function onPolyUp() {
    if (polyFreehandRef.current) {
      const cur = polyRef.current
      if (cur.length >= 3) emit({ annotation_type: 'polygon', geometry: { points: cur } })
      setPolyPts([]); polyRef.current = []; setMouse(null)
    }
    polyDownRef.current = false; polyPressElRef.current = null; polyFreehandRef.current = false
  }


  // ═══════════════════════════════════════════════════════════════════════════
  // RECT / ELLIPSE CREATION HANDLERS
  // ═══════════════════════════════════════════════════════════════════════════

  function onShapeDragStart(e) {
    const img = toImg(getEl(e)); if (!img) return
    setDragStart(img); setDragEnd(img)
  }
  function onShapeDragMove(e) {
    if (!dragStart) return
    const img = toImg(getEl(e)); if (img) setDragEnd(img)
  }
  function onShapeDragEnd() {
    if (!dragStart || !dragEnd) return
    const dx = Math.abs(dragEnd.x - dragStart.x), dy = Math.abs(dragEnd.y - dragStart.y)
    if (dx < MIN_DRAG && dy < MIN_DRAG) { setDragStart(null); setDragEnd(null); return }
    if (activeTool === 'rectangle')
      emit({ annotation_type: 'rectangle', geometry: {
        x: Math.min(dragStart.x, dragEnd.x), y: Math.min(dragStart.y, dragEnd.y),
        width: dx, height: dy } })
    else if (activeTool === 'ellipse')
      emit({ annotation_type: 'ellipse', geometry: {
        cx: (dragStart.x + dragEnd.x) / 2, cy: (dragStart.y + dragEnd.y) / 2,
        rx: dx / 2, ry: dy / 2 } })
    setDragStart(null); setDragEnd(null)
  }

  function handlePointClick(e) {
    const img = toImg(getEl(e)); if (!img) return
    emit({ annotation_type: 'point', geometry: { x: img.x, y: img.y } })
  }


  // ═══════════════════════════════════════════════════════════════════════════
  // UNIFIED POINTER ROUTER
  // ═══════════════════════════════════════════════════════════════════════════

  function onPointerDown(e) {
    if (e.button === 1) {
      isMiddlePanRef.current = true; setIsMiddlePan(true)
      osdRef.current?.setMouseNavEnabled(true); return
    }
    if (isSpacePanRef.current || isMiddlePanRef.current || e.button !== 0) return
    if (!activeTool || readOnly && activeTool !== 'select') return
    svgRef.current.setPointerCapture(e.pointerId)
    e.stopPropagation()

    const el = getEl(e)
    const v  = osdRef.current

    // ────────────────────────────────────────────────────────────────────────
    if (activeTool === 'select') {

      const selAnn = selectedAnnId ? annotations.find(a => a.id === selectedAnnId) : null

      // 1 ── Vertex / mid-point handles (polygon / brush)
      if (!readOnly && selAnn &&
          (selAnn.annotation_type === 'polygon' || selAnn.annotation_type === 'brush')) {
        const pts = selAnn.geometry?.points || []
        const hit = hitVertexHandle(v, selAnn, el)
        if (hit) {
          if (hit.type === 'vertex' && e.altKey) {
            // Alt+click → remove vertex (min 3)
            if (pts.length > 3)
              onAnnotationUpdated?.(selAnn.id, { points: pts.filter((_, i) => i !== hit.idx) })
            suppressClickRef.current = true; return
          }
          if (hit.type === 'midpoint') {
            // Insert vertex at mid-point, immediately start dragging it
            const a = hit.idx, b = (hit.idx + 1) % pts.length
            const ins = { x: (pts[a].x + pts[b].x) / 2, y: (pts[a].y + pts[b].y) / 2 }
            const newPts = [...pts.slice(0, a + 1), ins, ...pts.slice(a + 1)]
            setDragState({ kind: 'vtxEdit', annId: selAnn.id, pts: newPts, idx: a + 1 })
            suppressClickRef.current = true; return
          }
          if (hit.type === 'vertex') {
            setDragState({ kind: 'vtxEdit', annId: selAnn.id, pts: [...pts], idx: hit.idx })
            suppressClickRef.current = true; return
          }
        }
      }

      // 2 ── Rectangle resize handles
      if (!readOnly && selAnn && selAnn.annotation_type === 'rectangle') {
        const hit = hitRectHandle(v, selAnn.geometry, el)
        if (hit) {
          setDragState({ kind: 'rectHandle', annId: selAnn.id, handleId: hit.id,
            origGeometry: selAnn.geometry, shiftKey: e.shiftKey })
          suppressClickRef.current = true; return
        }
      }

      // 3 ── Ellipse resize handles
      if (!readOnly && selAnn && selAnn.annotation_type === 'ellipse') {
        const hit = hitEllipseHandle(v, selAnn.geometry, el)
        if (hit) {
          setDragState({ kind: 'ellipseHandle', annId: selAnn.id, handleId: hit.id,
            origGeometry: selAnn.geometry, shiftKey: e.shiftKey })
          suppressClickRef.current = true; return
        }
      }

      // 4 ── Annotation body hit-test (topmost first)
      const img = toImg(el)
      for (let i = annotations.length - 1; i >= 0; i--) {
        const ann = annotations[i]
        if (hitTestBody(v, ann, el)) {
          setDragState({
            kind: 'pendingMove',
            annId: ann.id,
            startEl: el,
            startImg: readOnly ? null : img,  // null = selection only, no move
            origGeometry: ann.geometry,
            annotationType: ann.annotation_type,
          })
          return
        }
      }

      // 5 ── Empty space
      pendingDeselectRef.current = true
      return
    }

    // ── Non-select tools ─────────────────────────────────────────────────────
    if (activeTool === 'brush')                                onBrushDown(e)
    if (activeTool === 'rectangle' || activeTool === 'ellipse') onShapeDragStart(e)
    if (activeTool === 'polygon')                              onPolyDown(e)
  }

  // ─────────────────────────────────────────────────────────────────────────
  function onPointerMove(e) {
    if (isSpacePanRef.current || isMiddlePanRef.current) return
    const el = getEl(e)
    setMouse(el)
    if (activeTool === 'brush') setBrushLimitsV(true)
    if (!activeTool) return

    const drag = activeDragRef.current

    if (drag) {
      // pendingMove → move when threshold crossed
      if (drag.kind === 'pendingMove' && drag.startImg) {
        if (dist(el, drag.startEl) > MOVE_THRESH) {
          setDragState({ ...drag, kind: 'move' })
          // Optimistically select the annotation if not already
          if (drag.annId !== selectedAnnId) {
            const ann = annotations.find(a => a.id === drag.annId)
            if (ann) onAnnotationClick?.(ann)
          }
        }
        return
      }
      // vtxEdit → update live vertex position
      if (drag.kind === 'vtxEdit') {
        const img = toImg(el); if (!img) return
        setDragState({ ...drag, pts: drag.pts.map((p, i) => i === drag.idx ? img : p) })
        return
      }
      // rectHandle / ellipseHandle → only shiftKey needs tracking; live geom computed in render
      if (drag.kind === 'rectHandle' || drag.kind === 'ellipseHandle') {
        if (e.shiftKey !== drag.shiftKey) setDragState({ ...drag, shiftKey: e.shiftKey })
        return
      }
      // 'move': setMouse above already triggers re-render → live geom computed in render
      return
    }

    if (readOnly) return
    if (activeTool === 'brush')                                onBrushDrag(e)
    if (activeTool === 'rectangle' || activeTool === 'ellipse') onShapeDragMove(e)
    if (activeTool === 'polygon')                              onPolyFreehandDrag(e)
  }

  // ─────────────────────────────────────────────────────────────────────────
  function onPointerUp(e) {
    if (!activeTool || e.button !== 0) return

    const drag = activeDragRef.current

    // ── SELECT TOOL: resolve drag ──────────────────────────────────────────
    if (activeTool === 'select' && drag) {
      const v = osdRef.current

      if (drag.kind === 'pendingMove') {
        // Pure click — select if different, keep if same (avoid toggle)
        if (drag.annId !== selectedAnnId) {
          const ann = annotations.find(a => a.id === drag.annId)
          if (ann) onAnnotationClick?.(ann)
        }
        setDragState(null); suppressClickRef.current = true
        pendingDeselectRef.current = false
        svgRef.current?.releasePointerCapture?.(e.pointerId)
        return
      }

      if (drag.kind === 'move') {
        const curImg = mouse ? elementToImage(v, mouse.x, mouse.y) : null
        if (curImg && drag.startImg && !readOnly) {
          const dx = curImg.x - drag.startImg.x, dy = curImg.y - drag.startImg.y
          if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5)
            onAnnotationUpdated?.(drag.annId,
              translateGeometry(drag.annotationType, drag.origGeometry, dx, dy))
        }
        setDragState(null); suppressClickRef.current = true
        svgRef.current?.releasePointerCapture?.(e.pointerId)
        return
      }

      if (drag.kind === 'vtxEdit') {
        if (!readOnly) onAnnotationUpdated?.(drag.annId, { points: drag.pts })
        setDragState(null); suppressClickRef.current = true
        svgRef.current?.releasePointerCapture?.(e.pointerId)
        return
      }

      if (drag.kind === 'rectHandle') {
        const curImg = mouse ? elementToImage(v, mouse.x, mouse.y) : null
        if (curImg && !readOnly)
          onAnnotationUpdated?.(drag.annId,
            applyRectHandle(drag.origGeometry, drag.handleId, curImg, drag.shiftKey))
        setDragState(null); suppressClickRef.current = true
        svgRef.current?.releasePointerCapture?.(e.pointerId)
        return
      }

      if (drag.kind === 'ellipseHandle') {
        const curImg = mouse ? elementToImage(v, mouse.x, mouse.y) : null
        if (curImg && !readOnly)
          onAnnotationUpdated?.(drag.annId,
            applyEllipseHandle(drag.origGeometry, drag.handleId, curImg, drag.shiftKey))
        setDragState(null); suppressClickRef.current = true
        svgRef.current?.releasePointerCapture?.(e.pointerId)
        return
      }
    }

    // ── SELECT TOOL: resolve empty-space deselect ─────────────────────────
    if (activeTool === 'select' && pendingDeselectRef.current) {
      pendingDeselectRef.current = false
      if (selectedAnnId) onAnnotationClick?.(null)
      suppressClickRef.current = true
      svgRef.current?.releasePointerCapture?.(e.pointerId)
      return
    }

    // ── Other tools ───────────────────────────────────────────────────────
    if (readOnly) return
    if (activeTool === 'brush')                                onBrushUp()
    if (activeTool === 'rectangle' || activeTool === 'ellipse') onShapeDragEnd()
    if (activeTool === 'polygon')                              onPolyUp()
    svgRef.current?.releasePointerCapture?.(e.pointerId)
  }

  // ─────────────────────────────────────────────────────────────────────────
  function onPointerLeave() {
    setMouse(null); setBrushLimitsV(false)
    if (brushDown.current) onBrushUp()
    // Pointer capture keeps pointerUp firing even after leave — drags are safe.
  }

  function onPointerCancel() {
    setDragState(null)
    brushDown.current = false; setBrushROI(null); brushROIRef.current = null
    lastBrushPt.current = null; editingAnn.current = null
    polyDownRef.current = false; polyFreehandRef.current = false
    setPolyPts([]); polyRef.current = []; setDragStart(null); setDragEnd(null)
    pendingDeselectRef.current = false; suppressClickRef.current = false
  }

  function onClick(e) {
    if (isSpacePanRef.current || isMiddlePanRef.current) return
    if (suppressClickRef.current) { suppressClickRef.current = false; return }
    if (!activeTool || readOnly) return
    if (activeTool === 'select') return    // all handled in onPointerUp
    if (activeTool === 'polygon') handlePolyClick(e)
    if (activeTool === 'point')   handlePointClick(e)
  }

  function onDblClick(e) {
    if (isSpacePanRef.current || isMiddlePanRef.current) return
    if (!activeTool || readOnly) return
    if (activeTool === 'polygon') handlePolyDbl(e)
  }

  function onWheel(e) {
    if (!e.altKey || activeTool !== 'brush') return
    e.preventDefault(); e.stopPropagation()
    setBrushRadius(r => Math.max(10, Math.min(500, Math.round(r + (e.deltaY < 0 ? 5 : -5)))))
  }


  // ═══════════════════════════════════════════════════════════════════════════
  // RENDER PREP  (everything derived in the render phase so OSD tick re-projects)
  // ═══════════════════════════════════════════════════════════════════════════

  const viewer = osdRef.current

  // Current mouse in image space (for live drag geometry)
  const curImg = mouse ? elementToImage(viewer, mouse.x, mouse.y) : null

  // The annotation being dragged (look up by ID each render)
  const dragAnn = activeDrag?.annId
    ? annotations.find(a => a.id === activeDrag.annId) ?? null : null

  // The currently selected annotation (only meaningful in select mode)
  const selAnn = (activeTool === 'select' && selectedAnnId)
    ? annotations.find(a => a.id === selectedAnnId) ?? null : null

  // Annotation IDs to omit from the normal shape list (currently dragged / brush-edited)
  const hiddenIds = new Set()
  if (activeDrag) {
    const k = activeDrag.kind
    if (k === 'move' || k === 'vtxEdit' || k === 'rectHandle' || k === 'ellipseHandle')
      hiddenIds.add(activeDrag.annId)
  }
  if (editingAnn.current) hiddenIds.add(editingAnn.current.id)

  // ── Live geometry for move / handle drags ─────────────────────────────────
  let liveGeom = null, liveType = null, liveColor = '#6ee7b7'
  if (activeDrag && curImg) {
    if (activeDrag.kind === 'move' && activeDrag.startImg) {
      const dx = curImg.x - activeDrag.startImg.x, dy = curImg.y - activeDrag.startImg.y
      liveGeom  = translateGeometry(activeDrag.annotationType, activeDrag.origGeometry, dx, dy)
      liveType  = activeDrag.annotationType
      liveColor = dragAnn?._color || '#6ee7b7'
    } else if (activeDrag.kind === 'rectHandle') {
      liveGeom  = applyRectHandle(activeDrag.origGeometry, activeDrag.handleId, curImg, activeDrag.shiftKey)
      liveType  = 'rectangle'
      liveColor = dragAnn?._color || '#6ee7b7'
    } else if (activeDrag.kind === 'ellipseHandle') {
      liveGeom  = applyEllipseHandle(activeDrag.origGeometry, activeDrag.handleId, curImg, activeDrag.shiftKey)
      liveType  = 'ellipse'
      liveColor = dragAnn?._color || '#6ee7b7'
    }
  }
  // Live vertex positions during vtxEdit
  const liveVtxPts = activeDrag?.kind === 'vtxEdit' ? activeDrag.pts : null

  // Geometry to pass to handle overlays (live during handle drags, stored otherwise)
  const overlayGeom = (liveGeom && (activeDrag?.kind === 'rectHandle' || activeDrag?.kind === 'ellipseHandle'))
    ? liveGeom : selAnn?.geometry
  const overlayVtxPts = liveVtxPts
    ?? ((selAnn?.annotation_type === 'polygon' || selAnn?.annotation_type === 'brush')
      ? (selAnn.geometry?.points ?? []) : null)

  // Show handles only in select mode, for selected annotation, not while body-moving
  const showHandles = activeTool === 'select' && selAnn && !readOnly
    && activeDrag?.kind !== 'move'

  // ── In-progress polygon projected to element space ────────────────────────
  const projPolyPts = polyPts.map(p => imageToElement(viewer, p.x, p.y)).filter(Boolean)
  const nearFirst   = activeTool === 'polygon' && projPolyPts.length >= 3 && mouse
    && dist(mouse, projPolyPts[0] ?? { x: -999, y: -999 }) <= CLOSE_THRESH

  // ── Rect/ellipse creation drag projected ─────────────────────────────────
  let dragProj = null
  if (dragStart && dragEnd) {
    const ds = imageToElement(viewer, dragStart.x, dragStart.y)
    const de = imageToElement(viewer, dragEnd.x,   dragEnd.y)
    if (ds && de) dragProj = { ds, de }
  }

  // ── Brush preview projected ───────────────────────────────────────────────
  const projBrushROI = brushROI
    ? brushROI.map(p => imageToElement(viewer, p.x, p.y)).filter(Boolean) : null

  // ── Dynamic cursor ────────────────────────────────────────────────────────
  const dynamicCursor = (() => {
    if (!activeTool)    return 'default'
    if (navOverride)    return 'grab'
    if (activeTool === 'brush')     return 'none'
    if (activeTool === 'point')     return 'cell'
    if (activeTool === 'polygon')   return nearFirst ? 'cell' : 'crosshair'
    if (activeTool === 'rectangle' || activeTool === 'ellipse') return 'crosshair'

    if (activeTool === 'select') {
      const drag = activeDragRef.current
      if (drag) {
        if (drag.kind === 'move' || drag.kind === 'pendingMove' || drag.kind === 'vtxEdit')
          return 'move'
        if (drag.kind === 'rectHandle')    return RECT_CURSOR[drag.handleId]    || 'move'
        if (drag.kind === 'ellipseHandle') return ELLIPSE_CURSOR[drag.handleId] || 'move'
      }
      if (!mouse) return 'default'
      // Hover: handles of selected annotation
      if (selAnn && !readOnly) {
        if (selAnn.annotation_type === 'polygon' || selAnn.annotation_type === 'brush') {
          const h = hitVertexHandle(viewer, selAnn, mouse)
          if (h) return h.type === 'vertex' ? 'move' : 'cell'
        }
        if (selAnn.annotation_type === 'rectangle') {
          const h = hitRectHandle(viewer, selAnn.geometry, mouse)
          if (h) return RECT_CURSOR[h.id] || 'move'
        }
        if (selAnn.annotation_type === 'ellipse') {
          const h = hitEllipseHandle(viewer, selAnn.geometry, mouse)
          if (h) return ELLIPSE_CURSOR[h.id] || 'move'
        }
      }
      // Hover: annotation bodies
      for (let i = annotations.length - 1; i >= 0; i--) {
        if (hitTestBody(viewer, annotations[i], mouse))
          return annotations[i].id === selectedAnnId
            ? (readOnly ? 'pointer' : 'move')
            : 'pointer'
      }
      return 'default'
    }
    return 'crosshair'
  })()

  const toolColor = activeClass?.color || '#6ee7b7'
  const brushLimitsPos = (mouse && activeTool === 'brush')
    ? { cx: mouse.x, cy: mouse.y, r: viewRadius() } : null


  // ═══════════════════════════════════════════════════════════════════════════
  // RENDER
  // ═══════════════════════════════════════════════════════════════════════════
  return (
    <svg
      ref={svgRef}
      style={{
        position: 'absolute', inset: 0, width: '100%', height: '100%',
        pointerEvents: activeTool ? 'all' : 'none',
        cursor: dynamicCursor, zIndex: 50,
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={onPointerLeave}
      onPointerCancel={onPointerCancel}
      onClick={onClick}
      onDoubleClick={onDblClick}
      onWheel={onWheel}
    >

      {/* ── 1. Saved annotation shapes (hidden while actively dragged) ─────── */}
      {annotations
        .filter(a => !hiddenIds.has(a.id))
        .map(ann => (
          <AnnotationShape
            key={ann.id}
            viewer={viewer}
            ann={ann}
            selected={ann.id === selectedAnnId}
          />
        ))}

      {/* ── 2. Ghost shape during body-move drag ─────────────────────────── */}
      {liveGeom && liveType && (
        <LiveAnnotation viewer={viewer} type={liveType} geometry={liveGeom} color={liveColor} />
      )}

      {/* ── 3. Ghost shape during vtxEdit (handle overlay shows handles) ──── */}
      {liveVtxPts && dragAnn && (
        <LiveAnnotation
          viewer={viewer}
          type={dragAnn.annotation_type}
          geometry={{ points: liveVtxPts }}
          color={dragAnn._color || '#6ee7b7'}
        />
      )}

      {/* ── 4. Handle overlays for the selected annotation (select mode) ───── */}
      {showHandles && (
        <>
          {(selAnn.annotation_type === 'polygon' || selAnn.annotation_type === 'brush') &&
           overlayVtxPts && (
            <PolygonHandleOverlay
              viewer={viewer}
              pts={overlayVtxPts}
              color={selAnn._color || '#6ee7b7'}
            />
          )}
          {selAnn.annotation_type === 'rectangle' && overlayGeom && (
            <RectHandleOverlay
              viewer={viewer}
              g={overlayGeom}
              color={selAnn._color || '#6ee7b7'}
            />
          )}
          {selAnn.annotation_type === 'ellipse' && overlayGeom && (
            <EllipseHandleOverlay
              viewer={viewer}
              g={overlayGeom}
              color={selAnn._color || '#6ee7b7'}
            />
          )}
        </>
      )}

      {/* ── 5. Brush ROI in progress ──────────────────────────────────────── */}
      {projBrushROI && projBrushROI.length > 2 && (
        <path
          d={toSVGPath(projBrushROI, true)}
          fill={subtractMode.current ? 'rgba(230,0,46,0.15)' : toolColor + '33'}
          stroke={subtractMode.current ? 'rgba(230,0,46,0.8)' : toolColor}
          strokeWidth={1.5} strokeLinejoin="round"
          style={{ pointerEvents: 'none' }}
        />
      )}

      {/* ── 6. Polygon in progress ────────────────────────────────────────── */}
      {activeTool === 'polygon' && projPolyPts.length > 0 && (
        <g>
          {projPolyPts.length >= 3 && (
            <path d={toSVGPath(projPolyPts, true)}
              fill={toolColor} fillOpacity={0.25} stroke="none" />
          )}
          <path d={toSVGPath(projPolyPts, false)}
            fill="none" stroke={toolColor} strokeWidth={1.5} strokeLinejoin="round" />

          {/* Live edge to cursor */}
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

          {/* Vertex dots */}
          {projPolyPts.map((p, i) => (
            <circle key={i} cx={p.x} cy={p.y}
              r={i === 0 ? FIRST_VERTEX_R : VERTEX_R}
              fill={i === 0 ? '#ff7c00' : toolColor}
              stroke="white" strokeWidth={1.5} />
          ))}

          {/* Freehand mode label */}
          {polyFreehandRef.current && projPolyPts.length > 2 && (
            <text
              x={projPolyPts[projPolyPts.length - 1].x + 10}
              y={projPolyPts[projPolyPts.length - 1].y - 10}
              fill={toolColor} fontSize={10} fontFamily="monospace"
              style={{ pointerEvents: 'none', userSelect: 'none' }}>
              freehand
            </text>
          )}
        </g>
      )}

      {/* ── 7. Rectangle creation drag ────────────────────────────────────── */}
      {activeTool === 'rectangle' && dragProj && (() => {
        const x = Math.min(dragProj.ds.x, dragProj.de.x)
        const y = Math.min(dragProj.ds.y, dragProj.de.y)
        const w = Math.abs(dragProj.de.x - dragProj.ds.x)
        const h = Math.abs(dragProj.de.y - dragProj.ds.y)
        return <rect x={x} y={y} width={w} height={h}
          fill={toolColor} fillOpacity={0.2} stroke={toolColor}
          strokeWidth={1.5} strokeDasharray="6 3" />
      })()}

      {/* ── 8. Ellipse creation drag ──────────────────────────────────────── */}
      {activeTool === 'ellipse' && dragProj && (() => {
        const cx = (dragProj.ds.x + dragProj.de.x) / 2
        const cy = (dragProj.ds.y + dragProj.de.y) / 2
        const rx = Math.abs(dragProj.de.x - dragProj.ds.x) / 2
        const ry = Math.abs(dragProj.de.y - dragProj.ds.y) / 2
        return <ellipse cx={cx} cy={cy} rx={rx} ry={ry}
          fill={toolColor} fillOpacity={0.2} stroke={toolColor}
          strokeWidth={1.5} strokeDasharray="6 3" />
      })()}

      {/* ── 9. Point crosshair ────────────────────────────────────────────── */}
      {activeTool === 'point' && mouse && (
        <g style={{ pointerEvents: 'none' }}>
          <circle cx={mouse.x} cy={mouse.y} r={8}
            fill={toolColor} fillOpacity={0.3} stroke={toolColor} strokeWidth={1.5} />
          <circle cx={mouse.x} cy={mouse.y} r={2} fill={toolColor} />
        </g>
      )}

      {/* ── 10. BrushLimits dual-ring cursor ─────────────────────────────── */}
      {brushLimitsPos && (
        <BrushLimits
          cx={brushLimitsPos.cx} cy={brushLimitsPos.cy}
          radius={brushLimitsPos.r}
          subtract={subtractMode.current}
          visible={brushLimitsV}
        />
      )}
    </svg>
  )
}