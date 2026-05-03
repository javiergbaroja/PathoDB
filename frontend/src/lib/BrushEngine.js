/**
 * BrushEngine.js
 * Converts a freehand brush stroke (array of {x,y} image-space points)
 * into a closed polygon outline using the offset-curve method.
 * No external geometry libraries required.
 */

/** Generate N points around a circle */
function circlePolygon(cx, cy, r, n = 32) {
  const pts = []
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n
    pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) })
  }
  return pts
}

/** Normalize a 2D vector */
function normalize(v) {
  const len = Math.hypot(v.x, v.y)
  if (len < 1e-10) return { x: 1, y: 0 }
  return { x: v.x / len, y: v.y / len }
}

/** Perpendicular (left normal) of a direction vector */
function leftNormal(dir) {
  return { x: -dir.y, y: dir.x }
}

/** Arc points from angle a0 to a1 (ccw) around center, radius r */
function arcPoints(cx, cy, r, a0, a1, segments = 8) {
  let diff = a1 - a0
  // Normalize diff to [0, 2π)
  while (diff < 0) diff += 2 * Math.PI
  const pts = []
  for (let i = 0; i <= segments; i++) {
    const a = a0 + (diff * i) / segments
    pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) })
  }
  return pts
}

/** Remove points closer than minDist to each other */
function deduplicate(points, minDist = 0.5) {
  if (points.length === 0) return []
  const result = [points[0]]
  for (let i = 1; i < points.length; i++) {
    const prev = result[result.length - 1]
    if (Math.hypot(points[i].x - prev.x, points[i].y - prev.y) >= minDist) {
      result.push(points[i])
    }
  }
  return result
}

/** Douglas-Peucker line simplification */
function douglasPeucker(pts, epsilon) {
  if (pts.length < 3) return pts
  let maxDist = 0
  let maxIdx = 0
  const first = pts[0]
  const last  = pts[pts.length - 1]
  const dx = last.x - first.x
  const dy = last.y - first.y
  const len = Math.hypot(dx, dy) || 1

  for (let i = 1; i < pts.length - 1; i++) {
    // Distance from point i to line(first, last)
    const dist = Math.abs(dy * pts[i].x - dx * pts[i].y + last.x * first.y - last.y * first.x) / len
    if (dist > maxDist) { maxDist = dist; maxIdx = i }
  }

  if (maxDist > epsilon) {
    const left  = douglasPeucker(pts.slice(0, maxIdx + 1), epsilon)
    const right = douglasPeucker(pts.slice(maxIdx), epsilon)
    return [...left.slice(0, -1), ...right]
  }
  return [first, last]
}

/**
 * Convert a brush stroke to a closed polygon.
 * @param {Array<{x,y}>} points  - stroke centre points in image coordinates
 * @param {number}       radius  - brush radius in image pixels
 * @param {number}       arcSegs - arc approximation segments at caps/joins
 * @returns {Array<{x,y}>} closed polygon (image coordinates)
 */
export function strokeToPolygon(points, radius, arcSegs = 8) {
  const pts = deduplicate(points, radius * 0.05)
  if (pts.length === 0) return []
  if (pts.length === 1) return circlePolygon(pts[0].x, pts[0].y, radius, arcSegs * 4)

  // Compute per-vertex averaged normal
  const normals = pts.map((p, i) => {
    let dir
    if (i === 0) {
      dir = normalize({ x: pts[1].x - pts[0].x, y: pts[1].y - pts[0].y })
    } else if (i === pts.length - 1) {
      dir = normalize({ x: pts[i].x - pts[i - 1].x, y: pts[i].y - pts[i - 1].y })
    } else {
      const d1 = normalize({ x: pts[i].x - pts[i-1].x, y: pts[i].y - pts[i-1].y })
      const d2 = normalize({ x: pts[i+1].x - pts[i].x, y: pts[i+1].y - pts[i].y })
      const avg = normalize({ x: d1.x + d2.x, y: d1.y + d2.y })
      // Miter: scale by 1/cos(halfAngle) capped at 4× to prevent spikes
      const cosHalf = d1.x * avg.x + d1.y * avg.y
      const scale = Math.min(4, cosHalf > 1e-6 ? 1 / cosHalf : 1)
      return { x: leftNormal(avg).x * scale, y: leftNormal(avg).y * scale }
    }
    return leftNormal(dir)
  })

  // Left side (forward, offset by +normal)
  const left = pts.map((p, i) => ({
    x: p.x + normals[i].x * radius,
    y: p.y + normals[i].y * radius,
  }))

  // Right side (forward, offset by -normal)
  const right = pts.map((p, i) => ({
    x: p.x - normals[i].x * radius,
    y: p.y - normals[i].y * radius,
  }))

  // End cap: semicircle from right[last] to left[last]
  const endPt  = pts[pts.length - 1]
  const endDir = normalize({ x: pts[pts.length-1].x - pts[pts.length-2].x, y: pts[pts.length-1].y - pts[pts.length-2].y })
  const endA0  = Math.atan2(-normals[pts.length-1].y * radius - 0, -normals[pts.length-1].x * radius - 0)
  const endStartAngle = Math.atan2(right[right.length-1].y - endPt.y, right[right.length-1].x - endPt.x)
  const endEndAngle   = Math.atan2(left[left.length-1].y  - endPt.y, left[left.length-1].x  - endPt.x)
  const endCap = arcPoints(endPt.x, endPt.y, radius, endStartAngle, endEndAngle, arcSegs)

  // Start cap: semicircle from left[0] back to right[0]
  const startPt         = pts[0]
  const startStartAngle = Math.atan2(left[0].y  - startPt.y, left[0].x  - startPt.x)
  const startEndAngle   = Math.atan2(right[0].y - startPt.y, right[0].x - startPt.x)
  const startCap        = arcPoints(startPt.x, startPt.y, radius, startStartAngle, startEndAngle, arcSegs)

  const polygon = [...left, ...endCap, ...right.slice().reverse(), ...startCap]

  // Simplify
  const simplified = douglasPeucker(polygon, radius * 0.05)
  return simplified
}

/**
 * Compute the union bbox of a list of polygons (for viewport culling).
 */
export function polygonBounds(pts) {
  if (!pts || pts.length === 0) return null
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const p of pts) {
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
    if (p.x > maxX) maxX = p.x
    if (p.y > maxY) maxY = p.y
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

/**
 * Point-in-polygon test (ray casting).
 */
export function pointInPolygon(px, py, pts) {
  let inside = false
  const n = pts.length
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = pts[i].x, yi = pts[i].y
    const xj = pts[j].x, yj = pts[j].y
    if (((yi > py) !== (yj > py)) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
      inside = !inside
    }
  }
  return inside
}