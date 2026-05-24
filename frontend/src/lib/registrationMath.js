// frontend/src/lib/registrationMath.js
//
// 2D similarity-transform algebra for slide registration. Mirrors the backend
// estimator in api/lib/registration.py so manual landmark alignment can be
// computed client-side (no round-trip) and applied to the OpenSeadragon sync.
//
// A transform maps MOVING-slide image pixels -> FIXED-slide image pixels:
//   xf = s*(cosθ*xm - sinθ*ym) + tx
//   yf = s*(sinθ*xm + cosθ*ym) + ty

export function applyTransform(t, x, y) {
  const c = Math.cos(t.rotation)
  const s = Math.sin(t.rotation)
  return {
    x: t.scale * (c * x - s * y) + t.tx,
    y: t.scale * (s * x + c * y) + t.ty,
  }
}

export function invertTransform(t) {
  if (!t.scale) throw new Error('non-invertible transform (zero scale)')
  const invScale = 1.0 / t.scale
  const invRot = -t.rotation
  const c = Math.cos(invRot)
  const s = Math.sin(invRot)
  return {
    scale: invScale,
    rotation: invRot,
    tx: -invScale * (c * t.tx - s * t.ty),
    ty: -invScale * (s * t.tx + c * t.ty),
  }
}

// Closed-form least-squares similarity (Umeyama). `src`/`dst` are arrays of
// {x,y}; src are moving-slide points, dst the matching fixed-slide points.
export function estimateSimilarity(src, dst) {
  const n = src.length
  if (n < 2 || dst.length !== n) {
    throw new Error('need at least 2 matching point pairs')
  }
  let msx = 0, msy = 0, mdx = 0, mdy = 0
  for (let i = 0; i < n; i++) {
    msx += src[i].x; msy += src[i].y
    mdx += dst[i].x; mdy += dst[i].y
  }
  msx /= n; msy /= n; mdx /= n; mdy /= n

  let dot = 0, cross = 0, varr = 0
  for (let i = 0; i < n; i++) {
    const ax = src[i].x - msx, ay = src[i].y - msy
    const bx = dst[i].x - mdx, by = dst[i].y - mdy
    dot += ax * bx + ay * by
    cross += ax * by - ay * bx
    varr += ax * ax + ay * ay
  }
  if (varr === 0) throw new Error('degenerate source points (all coincident)')

  const rotation = Math.atan2(cross, dot)
  const scale = Math.hypot(dot, cross) / varr
  if (scale === 0) throw new Error('degenerate point configuration (zero scale)')

  const c = Math.cos(rotation)
  const s = Math.sin(rotation)
  return {
    scale,
    rotation,
    tx: mdx - scale * (c * msx - s * msy),
    ty: mdy - scale * (s * msx + c * msy),
  }
}

// RMS fixed-space residual (px) of the fit — used to warn on poor landmarks.
export function rmsResidual(t, src, dst) {
  if (!src.length) return 0
  let total = 0
  for (let i = 0; i < src.length; i++) {
    const p = applyTransform(t, src[i].x, src[i].y)
    total += (p.x - dst[i].x) ** 2 + (p.y - dst[i].y) ** 2
  }
  return Math.sqrt(total / src.length)
}
