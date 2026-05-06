import polygonClipping from 'polygon-clipping'

// ─── format helpers ───────────────────────────────────────────────────────────

export function toPolygon(pts) {
  if (!pts || !pts.length) return [];
  // Single 1D array -> Polygon with no holes
  if (!Array.isArray(pts[0])) return [toRing(pts)];
  // 2D array -> Polygon with holes
  return pts.map(toRing);
}

function toRing(pts) {
  if (!pts.length) return []
  const ring = pts.map(p => [p.x, p.y])
  const first = ring[0], last = ring[ring.length - 1]
  if (first[0] !== last[0] || first[1] !== last[1]) ring.push([...first])
  return ring
}

function fromMultiPolygon(mp) {
  if (!mp || !mp.length) return []
  
  let bestPoly = []
  let bestArea = -1
  for (const poly of mp) {
    if (!poly.length || !poly[0].length) continue
    const exterior = poly[0]
    let area = 0
    for (let i = 0; i < exterior.length - 1; i++) {
      area += exterior[i][0] * exterior[i + 1][1] - exterior[i + 1][0] * exterior[i][1]
    }
    area = Math.abs(area) / 2
    if (area > bestArea) { bestArea = area; bestPoly = poly }
  }
  
  const result = bestPoly.map(ring => {
    const mapped = ring.map(([x,y]) => ({x, y}))
    if (mapped.length > 0) {
      const first = mapped[0], last = mapped[mapped.length - 1]
      if (first.x !== last.x || first.y !== last.y) {
        mapped.push({ x: first.x, y: first.y })
      }
    }
    return mapped
  })
  
  if (result.length === 1) return result[0]
  return result
}

// ─── public API ───────────────────────────────────────────────────────────────

export function union(ptsA, ptsB) {
  if (!ptsA.length) return ptsB
  if (!ptsB.length) return ptsA
  try {
    const result = polygonClipping.union([toPolygon(ptsA)], [toPolygon(ptsB)])
    return fromMultiPolygon(result)
  } catch (e) { return ptsA }
}

export function difference(ptsA, ptsB) {
  if (!ptsA.length) return []
  if (!ptsB.length) return ptsA
  try {
    const result = polygonClipping.difference([toPolygon(ptsA)], [toPolygon(ptsB)])
    if (!result.length) return []
    return fromMultiPolygon(result)
  } catch (e) { return ptsA }
}

export function constrainToBounds(pts, w, h) {
  if (!pts.length) return []
  const bbox = [[0, 0], [w, 0], [w, h], [0, h], [0, 0]]
  try {
    const result = polygonClipping.intersection([toPolygon(pts)], [bbox])
    return fromMultiPolygon(result)
  } catch (e) { return pts }
}

// Ensure the geometry does not contain self-intersections
export function validateTopology(pts) {
  if (!pts || !pts.length) return true;
  try {
    polygonClipping.union([toPolygon(pts)])
    return true;
  } catch(e) {
    return false;
  }
}

export function fillHoles(pts) {
  if (!pts.length) return pts;
  if (Array.isArray(pts[0])) return pts[0];
  return pts;
}

export function simplify(pts, tolerance = 0.1) {
  if (!pts.length) return pts;
  const is2D = Array.isArray(pts[0]);
  const rings = is2D ? pts : [pts];
  
  const simplified = rings.map(ring => {
    if (ring.length < 4) return ring;
    let working = [...ring]
    const area = (a, b, c) => Math.abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y)) / 2
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
    return working;
  });
  
  return is2D ? simplified : simplified[0];
}

export function roundCoordinates(pts) {
  if (!pts.length) return pts;
  if (Array.isArray(pts[0])) {
    return pts.map(ring => ring.map(p => ({ x: Math.round(p.x), y: Math.round(p.y) })))
  }
  return pts.map(p => ({ x: Math.round(p.x), y: Math.round(p.y) }))
}