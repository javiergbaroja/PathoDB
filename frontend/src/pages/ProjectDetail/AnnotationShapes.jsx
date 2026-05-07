import { imageToElement } from '../../hooks/useOSDViewer'
import {
  toSVGPath,
  projectPoints,
  rectHandlePositions,
  ellipseHandlePositions,
  RECT_HDL_HALF,
  ELLIPSE_HDL_R,
  MIDPT_R_VIS,
  VTX_R_VIS
} from '../../lib/annotationMath'

export function AnnotationShape({ viewer, ann, selected, fillAnnotations = true }) {
  if (!viewer?.viewport) return null
  const color   = ann._color || '#6ee7b7'
  const fillOp  = fillAnnotations ? (selected ? 0.50 : 0.28) : 0
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
        const pts = projectPoints(g.points, viewer)
        if (!pts.length) return null
        // UPDATED: fillRule="evenodd" allows holes to punch through visually
        return <path d={toSVGPath(pts, true)} fillRule="evenodd"
          fill={color} fillOpacity={fillOp} stroke={strokeC}
          strokeWidth={sw} strokeLinejoin="round" />
      }
      default: return null
    }
  } catch { return null }
}

export function LiveAnnotation({ viewer, type, geometry: g, color }) {
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
        const pts = projectPoints(g.points, viewer)
        if (!pts.length) return null
        return <path d={toSVGPath(pts, true)} fillRule="evenodd" fill={fill} stroke="white"
          strokeWidth={sw} strokeLinejoin="round" />
      }
      default: return null
    }
  } catch { return null }
}

export function RectHandleOverlay({ viewer, g, color }) {
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

export function EllipseHandleOverlay({ viewer, g, color }) {
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

export function PolygonHandleOverlay({ viewer, pts, color }) {
  if (!viewer?.viewport || !pts.length) return null
  // Only draw overlay handles on the exterior ring for now
  const exterior = Array.isArray(pts[0]) ? pts[0] : pts
  const proj = exterior.map(p => imageToElement(viewer, p.x, p.y)).filter(Boolean)
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