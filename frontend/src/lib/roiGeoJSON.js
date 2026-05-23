// Shared GeoJSON helpers for packaging user-drawn ROIs into the payload the
// analysis backend expects (QuPath-style `classification.name: 'user_roi'`).
// Both viewer model panels build the same Feature/FeatureCollection shape.

// Round a ring's points to integer image pixels and close it (first point repeated).
function closedIntRing(ring) {
  const pts = ring.map(p => [Math.round(p.x), Math.round(p.y)])
  pts.push([Math.round(ring[0].x), Math.round(ring[0].y)])
  return pts
}

export function roiFeature(ring, name) {
  return {
    type: 'Feature',
    properties: { name, classification: { name: 'user_roi' } },
    geometry: { type: 'Polygon', coordinates: [closedIntRing(ring)] },
  }
}

export function roiFeatureCollection(features) {
  return { type: 'FeatureCollection', features }
}
