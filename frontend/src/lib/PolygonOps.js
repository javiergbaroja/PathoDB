/**
 * PolygonOps.js
 *
 * Polygon boolean operations for the brush tool, matching QuPath's JTS usage.
 *
 * Depends on: npm install polygon-clipping
 *
 * Internal format throughout:  {x, y}[]  (outer ring, image-pixel coords).
 *
 * polygon-clipping format:
 *   MultiPolygon  = Polygon[]
 *   Polygon       = Ring[]           (first ring = outer, rest = holes)
 *   Ring          = [number,number][]
 */
import polygonClipping from 'polygon-clipping'

// ─── format helpers ───────────────────────────────────────────────────────────

/** {x,y}[] → polygon-clipping Ring (closed) */
function toRing(pts) {
  if (!pts.length) return []
  const ring = pts.map(p => [p.x, p.y])
  // polygon-clipping requires closed rings
  const first = ring[0], last = ring[ring.length - 1]
  if (first[0] !== last[0] || first[1] !== last[1]) ring.push([...first])
  return ring
}

/** polygon-clipping MultiPolygon → {x,y}[] (largest outer ring wins) */
function fromMultiPolygon(mp) {
  if (!mp || !mp.length) return []
  // pick the polygon with the largest outer ring (by area approximation)
  let best = []
  let bestArea = -1
  for (const poly of mp) {
    if (!poly.length) continue
    const ring = poly[0]
    if (!ring.length) continue
    let area = 0
    for (let i = 0; i < ring.length - 1; i++) {
      area += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1]
    }
    area = Math.abs(area) / 2
    if (area > bestArea) { bestArea = area; best = ring }
  }
  // drop closing duplicate
  const out = best.map(([x, y]) => ({ x, y }))
  if (out.length > 1) {
    const f = out[0], l = out[out.length - 1]
    if (Math.abs(f.x - l.x) < 1e-6 && Math.abs(f.y - l.y) < 1e-6) out.pop()
  }
  return out
}

// ─── public API ───────────────────────────────────────────────────────────────

/**
 * Union of two polygons.
 * Returns the merged outer ring, discarding holes.
 */
export function union(ptsA, ptsB) {
  if (!ptsA.length) return ptsB
  if (!ptsB.length) return ptsA
  try {
    const result = polygonClipping.union([toRing(ptsA)], [toRing(ptsB)])
    return fromMultiPolygon(result)
  } catch (e) {
    console.warn('[PolygonOps] union failed, returning ptsA', e)
    return ptsA
  }
}

/**
 * Difference: ptsA minus ptsB.
 * Equivalent to QuPath's shapeCurrent.difference(shapeDrawn).
 */
export function difference(ptsA, ptsB) {
  if (!ptsA.length) return []
  if (!ptsB.length) return ptsA
  try {
    const result = polygonClipping.difference([toRing(ptsA)], [toRing(ptsB)])
    if (!result.length) return []
    return fromMultiPolygon(result)
  } catch (e) {
    console.warn('[PolygonOps] difference failed, returning ptsA', e)
    return ptsA
  }
}

/**
 * Clip polygon to image bounds [0, 0, w, h].
 * Equivalent to GeometryTools.constrainToBounds.
 */
export function constrainToBounds(pts, w, h) {
  if (!pts.length) return []
  const bbox = [
    [0, 0], [w, 0], [w, h], [0, h], [0, 0],
  ]
  try {
    const result = polygonClipping.intersection([toRing(pts)], [bbox])
    return fromMultiPolygon(result)
  } catch (e) {
    return pts
  }
}

/**
 * Fill holes: discard all interior rings, returning only the outer boundary.
 * In the {x,y}[] format we don't track holes, so this just ensures the winding
 * is consistent (counter-clockwise = outer ring in polygon-clipping).
 */
export function fillHoles(pts) {
  if (pts.length < 3) return pts
  // Re-route through polygon-clipping union of self to normalise winding
  try {
    const result = polygonClipping.union([toRing(pts)])
    // Take only the first (outer) ring of the first polygon
    if (!result.length || !result[0].length) return pts
    return result[0][0].map(([x, y]) => ({ x, y })).slice(0, -1) // drop closer
  } catch {
    return pts
  }
}

/**
 * Visvalingam-Whyatt simplification (port of JTS VWSimplifier).
 * tolerance is the minimum effective area.
 */
export function simplify(pts, tolerance = 0.1) {
  if (pts.length < 4) return pts
  // Build a heap of triangle areas and iteratively remove the smallest
  let working = [...pts]
  const area = (a, b, c) =>
    Math.abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y)) / 2

  let changed = true
  while (changed) {
    changed = false
    for (let i = 1; i < working.length - 1; i++) {
      if (area(working[i - 1], working[i], working[i + 1]) < tolerance) {
        working.splice(i, 1)
        changed = true
        break
      }
    }
  }
  return working
}

/**
 * Round all coordinates to integers (matching QuPath's GeometryTools.roundCoordinates).
 */
export function roundCoordinates(pts) {
  return pts.map(p => ({ x: Math.round(p.x), y: Math.round(p.y) }))
}