import { imageToElement, elementToImage } from '../hooks/useOSDViewer'
import { strokeToPolygon } from './BrushEngine'

export const VERTEX_R       = 5
export const FIRST_VERTEX_R = 7
export const CLOSE_THRESH   = 14
export const MIN_DRAG       = 4
export const FREEHAND_THRESH = 8
export const FREEHAND_GAP   = 4
export const MOVE_THRESH    = 5
export const VTX_HIT_R      = 12
export const MIDPT_HIT_R    = 10
export const HDL_HIT_R      = 10
export const VTX_R_VIS      = 6
export const MIDPT_R_VIS    = 4
export const RECT_HDL_HALF  = 5
export const ELLIPSE_HDL_R  = 6

export const RECT_CURSOR = {
  TL: 'nwse-resize', T:  'ns-resize',   TR: 'nesw-resize',
  R:  'ew-resize',   BR: 'nwse-resize', B:  'ns-resize',
  BL: 'nesw-resize', L:  'ew-resize',
}
export const ELLIPSE_CURSOR = { N: 'ns-resize', S: 'ns-resize', E: 'ew-resize', W: 'ew-resize' }

// ─── NEW: Safely map points to screen space, supporting true holes (nested arrays)
export function projectPoints(points, viewer) {
  if (!points || !points.length) return []
  // If it's an array of arrays (Polygon with holes)
  if (Array.isArray(points[0])) {
    return points.map(ring => ring.map(p => imageToElement(viewer, p.x, p.y)).filter(Boolean))
  }
  // Single ring
  return points.map(p => imageToElement(viewer, p.x, p.y)).filter(Boolean)
}

// ─── UPDATED: Generates SVG path string handling both single rings and multi-rings
export function toSVGPath(pts, closed) {
  if (!pts || !pts.length) return ''
  if (Array.isArray(pts[0])) {
    return pts.map(ring => {
      if (!ring.length) return ''
      return ring.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ') + (closed ? ' Z' : '')
    }).join(' ')
  }
  return pts.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ') + (closed ? ' Z' : '')
}

export function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y) }

export function polygonContains(pts, img) {
  // If points is an array of arrays (holes), test the exterior ring (index 0)
  const ring = Array.isArray(pts[0]) ? pts[0] : pts
  let inside = false, n = ring.length
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const pi = ring[i], pj = ring[j]
    if ((pi.y > img.y) !== (pj.y > img.y) &&
        img.x < (pj.x - pi.x) * (img.y - pi.y) / (pj.y - pi.y) + pi.x)
      inside = !inside
  }
  return inside
}

export function hitTestBody(viewer, ann, el) {
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

export function hitVertexHandle(viewer, ann, el) {
  if (!viewer?.viewport || !ann) return null
  const rawPts = ann.geometry?.points || []
  const pts = Array.isArray(rawPts[0]) ? rawPts[0] : rawPts // Only allow editing exterior ring handles for now
  
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

export function hitRectHandle(viewer, g, el) {
  if (!viewer?.viewport || !g) return null
  for (const h of rectHandlePositions(g)) {
    const e = imageToElement(viewer, h.ix, h.iy)
    if (e && dist(el, e) <= HDL_HIT_R) return { id: h.id }
  }
  return null
}

export function hitEllipseHandle(viewer, g, el) {
  if (!viewer?.viewport || !g) return null
  for (const h of ellipseHandlePositions(g)) {
    const e = imageToElement(viewer, h.ix, h.iy)
    if (e && dist(el, e) <= HDL_HIT_R) return { id: h.id }
  }
  return null
}

export function translateGeometry(type, geom, dx, dy) {
  switch (type) {
    case 'point':
      return { x: geom.x + dx, y: geom.y + dy }
    case 'rectangle':
      return { ...geom, x: geom.x + dx, y: geom.y + dy }
    case 'ellipse':
      return { ...geom, cx: geom.cx + dx, cy: geom.cy + dy }
    case 'polygon': case 'brush': {
      const shift = p => ({ x: p.x + dx, y: p.y + dy })
      const pts = geom.points || []
      return { points: Array.isArray(pts[0]) ? pts.map(ring => ring.map(shift)) : pts.map(shift) }
    }
    default: return geom
  }
}

export function rectHandlePositions(g) {
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

export function applyRectHandle(orig, handleId, img, shiftKey = false) {
  const MIN = 4
  const origR = orig.x + orig.width, origB = orig.y + orig.height
  const movesL = handleId === 'TL' || handleId === 'L'  || handleId === 'BL'
  const movesR = handleId === 'TR' || handleId === 'R'  || handleId === 'BR'
  const movesT = handleId === 'TL' || handleId === 'T'  || handleId === 'TR'
  const movesB = handleId === 'BL' || handleId === 'B'  || handleId === 'BR'
  let L = movesL ? img.x : orig.x,  R = movesR ? img.x : origR
  let T = movesT ? img.y : orig.y,  B = movesB ? img.y : origB
  
  if (R - L < MIN) { if (movesL) L = R - MIN; else R = L + MIN }
  if (B - T < MIN) { if (movesT) T = B - MIN; else B = T + MIN }
  if (shiftKey) {
    const w = R - L, h = B - T, s = Math.max(w, h)
    if (w < s) { if (movesL) L = R - s; else R = L + s }
    if (h < s) { if (movesT) T = B - s; else B = T + s }
  }
  return { x: L, y: T, width: R - L, height: B - T }
}

export function ellipseHandlePositions(g) {
  return [
    { id: 'N', ix: g.cx,        iy: g.cy - g.ry },
    { id: 'S', ix: g.cx,        iy: g.cy + g.ry },
    { id: 'E', ix: g.cx + g.rx, iy: g.cy        },
    { id: 'W', ix: g.cx - g.rx, iy: g.cy        },
  ]
}

export function applyEllipseHandle(orig, handleId, img, shiftKey = false) {
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

export function circlePoly(cx, cy, r, n = 32) {
  return Array.from({ length: n }, (_, i) => {
    const a = (2 * Math.PI * i) / n
    return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) }
  })
}

export function capsulePoly(x1, y1, x2, y2, r) {
  return strokeToPolygon([{ x: x1, y: y1 }, { x: x2, y: y2 }], r, 12)
}


export function getAnnotationBBox(ann) {
  // If the backend already calculated it, use it
  if (ann.bbox) return ann.bbox; 
  
  const g = ann.geometry;
  if (!g) return { x: 0, y: 0, w: 0, h: 0 };

  if (ann.annotation_type === 'point') return { x: g.x, y: g.y, w: 0, h: 0 };
  if (ann.annotation_type === 'rectangle') return { x: g.x, y: g.y, w: g.width, h: g.height };
  if (ann.annotation_type === 'ellipse') return { x: g.cx - g.rx, y: g.cy - g.ry, w: g.rx * 2, h: g.ry * 2 };
  
  if (ann.annotation_type === 'polygon' || ann.annotation_type === 'brush') {
    const pts = Array.isArray(g.points[0]) ? g.points[0] : g.points;
    if (!pts || pts.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
    
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of pts) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }
  return { x: 0, y: 0, w: 0, h: 0 };
}