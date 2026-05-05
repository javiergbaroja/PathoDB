/**
 * frontend/src/lib/geometryUtils.js
 *
 * Polygon boolean operations and annotation hit-testing.
 * Requires: npm install @turf/turf
 *
 * Note: We use @turf/turf rather than jsts for cleaner ESM imports.
 * If strict QuPath/JTS parity is needed, swap to jsts:
 *   import * as jsts from 'jsts'
 *   new jsts.io.GeoJSONReader() / new jsts.io.GeoJSONWriter()
 */
import * as turf from '@turf/turf'
import { imageToElement } from '../hooks/useOSDViewer'
import { pointInPolygon } from './BrushEngine'

// ── Coordinate format helpers ─────────────────────────────────────────────────
//  Our format  : [{x, y}, ...]           (open polygon, first ≠ last)
//  GeoJSON ring: [[x, y], ..., [x0, y0]] (closed ring, first = last)

const pointsToRing = (pts) => [
  ...pts.map(p => [p.x, p.y]),
  [pts[0].x, pts[0].y],
]

const ringToPoints = (ring) =>
  ring.slice(0, -1).map(([x, y]) => ({ x, y }))

function toTurfPolygon(points) {
  if (!points || points.length < 3) return null
  try {
    return turf.polygon([pointsToRing(points)])
  } catch {
    return null
  }
}

// ── Extract a flat points array from any annotation type ──────────────────────

export function annotationToPoints(ann) {
  if (!ann) return []
  const g = ann.geometry
  switch (ann.annotation_type) {
    case 'polygon':
    case 'brush':
      return g.points || []

    case 'rectangle':
      return [
        { x: g.x,           y: g.y },
        { x: g.x + g.width, y: g.y },
        { x: g.x + g.width, y: g.y + g.height },
        { x: g.x,           y: g.y + g.height },
      ]

    case 'ellipse': {
      const N = 64
      return Array.from({ length: N }, (_, i) => {
        const a = (2 * Math.PI * i) / N
        return { x: g.cx + g.rx * Math.cos(a), y: g.cy + g.ry * Math.sin(a) }
      })
    }

    default:
      return []
  }
}

// ── Boolean operations ────────────────────────────────────────────────────────

/** Returns true if two polygons (as point arrays) intersect or touch. */
export function doPolygonsIntersect(pointsA, pointsB) {
  const a = toTurfPolygon(pointsA)
  const b = toTurfPolygon(pointsB)
  if (!a || !b) return false
  try {
    return turf.booleanIntersects(a, b)
  } catch {
    return false
  }
}

/**
 * Union two polygons (as point arrays).
 * Returns the merged point array, or null on failure.
 * If the result is a MultiPolygon, returns the largest ring.
 */
export function unionPolygons(pointsA, pointsB) {
  const a = toTurfPolygon(pointsA)
  const b = toTurfPolygon(pointsB)
  if (!a && !b) return null
  if (!a) return pointsB.length >= 3 ? pointsB : null
  if (!b) return pointsA.length >= 3 ? pointsA : null

  try {
    const result = turf.union(a, b)
    if (!result) return null
    const geom = result.geometry

    if (geom.type === 'Polygon') {
      return ringToPoints(geom.coordinates[0])
    }
    if (geom.type === 'MultiPolygon') {
      // Disconnected regions — take the exterior ring with the most vertices
      const rings = geom.coordinates.map(coords => ringToPoints(coords[0]))
      return rings.reduce((best, r) => r.length > best.length ? r : best)
    }
    return null
  } catch (e) {
    console.warn('[geometryUtils] unionPolygons failed:', e)
    return null
  }
}

// ── Hit testing ───────────────────────────────────────────────────────────────
// Coordinates are in OSD viewer-element space (pixels from top-left of viewer).

/**
 * Returns true if the element-space point (ex, ey) is inside the annotation.
 * Uses pointInPolygon (ray-casting) from BrushEngine for polygon types.
 */
export function hitTestAnnotation(viewer, ann, ex, ey) {
  if (!viewer?.viewport || !ann) return false
  const g = ann.geometry

  switch (ann.annotation_type) {
    case 'point': {
      const e = imageToElement(viewer, g.x, g.y)
      // Generous 14-px hit radius for points
      return e ? Math.hypot(ex - e.x, ey - e.y) <= 14 : false
    }

    case 'polygon':
    case 'brush': {
      const pts = (g.points || [])
        .map(p => imageToElement(viewer, p.x, p.y))
        .filter(Boolean)
      return pts.length >= 3 && pointInPolygon(ex, ey, pts)
    }

    case 'rectangle': {
      const corners = [
        { x: g.x,           y: g.y },
        { x: g.x + g.width, y: g.y },
        { x: g.x + g.width, y: g.y + g.height },
        { x: g.x,           y: g.y + g.height },
      ].map(p => imageToElement(viewer, p.x, p.y)).filter(Boolean)
      return corners.length === 4 && pointInPolygon(ex, ey, corners)
    }

    case 'ellipse': {
      // Approximate ellipse with 32-gon for hit testing
      const N = 32
      const pts = Array.from({ length: N }, (_, i) => {
        const a = (2 * Math.PI * i) / N
        return imageToElement(viewer, g.cx + g.rx * Math.cos(a), g.cy + g.ry * Math.sin(a))
      }).filter(Boolean)
      return pts.length >= 3 && pointInPolygon(ex, ey, pts)
    }

    default:
      return false
  }
}

/**
 * Returns the topmost annotation at element-space point (ex, ey),
 * or null if nothing was hit. Tests in reverse draw order (last = topmost).
 */
export function hitTestAnnotations(viewer, annotations, ex, ey) {
  for (let i = annotations.length - 1; i >= 0; i--) {
    if (hitTestAnnotation(viewer, annotations[i], ex, ey)) {
      return annotations[i]
    }
  }
  return null
}