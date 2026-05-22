// CanvasAnnotationOverlay
//
// Draws every UNSELECTED annotation onto an HTML5 canvas synchronised with the
// OpenSeadragon viewport. The SVG AnnotationLayer continues to handle the
// selected annotation, edit handles, and live tool feedback — keeping React's
// reconciliation cost flat regardless of annotation count.
//
// Design notes (alignment with industry-standard WSI viewers):
//  - Single canvas overlay, no per-annotation React component.
//  - R-tree (rbush) query in image space → only the visible subset is drawn.
//  - Image→element affine transform is computed ONCE per frame, then applied
//    inline as `x * sx + ox`. This avoids per-vertex `OpenSeadragon.Point`
//    allocations and the two-step matrix multiply OSD performs internally.
//  - Redraws are coalesced through requestAnimationFrame so OSD's animation /
//    zoom / pan events (which can fire many times per frame) collapse to a
//    single paint.
//  - The component subscribes to OSD events directly via refs; React state
//    plays no part in the draw loop, so a noisy parent re-render is cheap.
import { useEffect, useRef } from 'react'

const DEFAULT_COLOR = '#6ee7b7'

function drawPath(ctx, points, sx, sy, ox, oy) {
  if (!points.length) return
  ctx.moveTo(points[0].x * sx + ox, points[0].y * sy + oy)
  for (let i = 1; i < points.length; i++) {
    ctx.lineTo(points[i].x * sx + ox, points[i].y * sy + oy)
  }
  ctx.closePath()
}

function drawAnnotation(ctx, ann, sx, sy, ox, oy, selected, fillEnabled) {
  const g = ann.geometry
  if (!g) return

  const color  = ann._color || DEFAULT_COLOR
  const stroke = selected ? '#ffffff' : color
  const sw     = selected ? 2 : 1.5
  const fillOp = fillEnabled ? (selected ? 0.50 : 0.28) : 0

  switch (ann.annotation_type) {
    case 'point': {
      const px = g.x * sx + ox
      const py = g.y * sy + oy
      const r  = selected ? 9 : 7
      ctx.globalAlpha = fillEnabled ? (selected ? 0.70 : 0.48) : 0
      ctx.fillStyle   = color
      ctx.beginPath(); ctx.arc(px, py, r, 0, 2 * Math.PI); ctx.fill()
      ctx.globalAlpha = 1
      ctx.strokeStyle = stroke; ctx.lineWidth = sw
      ctx.beginPath(); ctx.arc(px, py, r, 0, 2 * Math.PI); ctx.stroke()
      ctx.fillStyle = stroke
      ctx.beginPath(); ctx.arc(px, py, 3, 0, 2 * Math.PI); ctx.fill()
      return
    }
    case 'rectangle': {
      const x = g.x * sx + ox
      const y = g.y * sy + oy
      const w = g.width  * sx
      const h = g.height * sy
      if (fillOp > 0) {
        ctx.globalAlpha = fillOp
        ctx.fillStyle   = color
        ctx.fillRect(x, y, w, h)
        ctx.globalAlpha = 1
      }
      ctx.strokeStyle = stroke; ctx.lineWidth = sw
      ctx.strokeRect(x, y, w, h)
      return
    }
    case 'ellipse': {
      const cx = g.cx * sx + ox
      const cy = g.cy * sy + oy
      const rx = g.rx * sx
      const ry = g.ry * sy
      if (rx <= 0 || ry <= 0) return
      ctx.beginPath()
      ctx.ellipse(cx, cy, rx, ry, 0, 0, 2 * Math.PI)
      if (fillOp > 0) {
        ctx.globalAlpha = fillOp
        ctx.fillStyle   = color
        ctx.fill()
        ctx.globalAlpha = 1
      }
      ctx.strokeStyle = stroke; ctx.lineWidth = sw
      ctx.stroke()
      return
    }
    case 'polygon':
    case 'brush': {
      const pts = g.points
      if (!pts || !pts.length) return
      ctx.beginPath()
      if (Array.isArray(pts[0])) {
        for (const ring of pts) drawPath(ctx, ring, sx, sy, ox, oy)
      } else {
        drawPath(ctx, pts, sx, sy, ox, oy)
      }
      if (fillOp > 0) {
        ctx.globalAlpha = fillOp
        ctx.fillStyle   = color
        ctx.fill('evenodd')
        ctx.globalAlpha = 1
      }
      ctx.strokeStyle = stroke; ctx.lineWidth = sw
      ctx.lineJoin    = 'round'
      ctx.stroke()
      return
    }
    default:
      return
  }
}

export default function CanvasAnnotationOverlay({
  viewer, annotations, selectedAnnIds, hiddenIds,
  rtreeRef, fillAnnotations = true, showAnnotations = true,
  drawSelected = false,
}) {
  const canvasRef = useRef(null)
  const rafRef    = useRef(null)
  const dprRef    = useRef(1)

  // Mirror reactive props into refs so the draw loop reads the latest values
  // without re-subscribing OSD handlers on each render.
  const annsRef     = useRef(annotations)
  const selRef      = useRef(selectedAnnIds)
  const hidRef      = useRef(hiddenIds)
  const fillRef     = useRef(fillAnnotations)
  const showRef     = useRef(showAnnotations)
  const drawSelRef  = useRef(drawSelected)

  const schedule = () => {
    if (rafRef.current != null) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null
      draw()
    })
  }

  useEffect(() => { annsRef.current    = annotations;    schedule() }, [annotations])
  useEffect(() => { selRef.current     = selectedAnnIds; schedule() }, [selectedAnnIds])
  useEffect(() => { hidRef.current     = hiddenIds;      schedule() }, [hiddenIds])
  useEffect(() => { fillRef.current    = fillAnnotations; schedule() }, [fillAnnotations])
  useEffect(() => { showRef.current    = showAnnotations; schedule() }, [showAnnotations])
  useEffect(() => { drawSelRef.current = drawSelected;   schedule() }, [drawSelected])

  function resize() {
    const canvas = canvasRef.current
    if (!canvas) return
    const host = canvas.parentElement
    if (!host) return
    const rect = host.getBoundingClientRect()
    if (!rect.width || !rect.height) return
    const dpr = window.devicePixelRatio || 1
    dprRef.current = dpr
    canvas.width  = Math.round(rect.width  * dpr)
    canvas.height = Math.round(rect.height * dpr)
    canvas.style.width  = `${rect.width}px`
    canvas.style.height = `${rect.height}px`
  }

  function draw() {
    const canvas = canvasRef.current
    if (!canvas) return
    if (!viewer?.viewport) return
    if (canvas.width === 0 || canvas.height === 0) return

    const ctx = canvas.getContext('2d')
    const dpr = dprRef.current
    const wCss = canvas.width  / dpr
    const hCss = canvas.height / dpr

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, wCss, hCss)

    if (!showRef.current) return

    // Compute image→element affine once per frame.
    // Two reference points are enough: top-left and bottom-right of the canvas.
    let tlImg, brImg
    try {
      const tlVp = viewer.viewport.viewerElementToViewportCoordinates(
        new window.OpenSeadragon.Point(0, 0))
      const brVp = viewer.viewport.viewerElementToViewportCoordinates(
        new window.OpenSeadragon.Point(wCss, hCss))
      tlImg = viewer.viewport.viewportToImageCoordinates(tlVp)
      brImg = viewer.viewport.viewportToImageCoordinates(brVp)
    } catch { return }

    const dx = brImg.x - tlImg.x
    const dy = brImg.y - tlImg.y
    if (dx === 0 || dy === 0) return
    const sx = wCss / dx
    const sy = hCss / dy
    const ox = -tlImg.x * sx
    const oy = -tlImg.y * sy

    // R-tree query for visible candidates (image-space bbox + 10% buffer).
    const padW = Math.abs(dx) * 0.1
    const padH = Math.abs(dy) * 0.1
    const tree = rtreeRef?.current
    let candidates
    if (tree) {
      candidates = tree.search({
        minX: Math.min(tlImg.x, brImg.x) - padW,
        minY: Math.min(tlImg.y, brImg.y) - padH,
        maxX: Math.max(tlImg.x, brImg.x) + padW,
        maxY: Math.max(tlImg.y, brImg.y) + padH,
      })
    } else {
      candidates = annsRef.current.map(a => ({ ann: a }))
    }

    const hidden     = hidRef.current
    const selected   = selRef.current
    const fillOn     = fillRef.current
    const drawSel    = drawSelRef.current
    const selectedList = []

    ctx.lineCap = 'butt'

    for (let i = 0; i < candidates.length; i++) {
      const ann = candidates[i].ann
      if (!ann) continue
      if (hidden && hidden.has(ann.id)) continue
      const isSel = selected && selected.has(ann.id)
      if (isSel && !drawSel) continue
      if (isSel) {
        // Defer selected so they paint on top of the unselected layer.
        selectedList.push(ann)
        continue
      }
      drawAnnotation(ctx, ann, sx, sy, ox, oy, false, fillOn)
    }

    for (let i = 0; i < selectedList.length; i++) {
      drawAnnotation(ctx, selectedList[i], sx, sy, ox, oy, true, fillOn)
    }
  }

  // Subscribe to OSD events for redraws.
  useEffect(() => {
    if (!viewer) return
    const handler = () => schedule()
    const onResize = () => { resize(); schedule() }
    viewer.addHandler('animation', handler)
    viewer.addHandler('zoom',      handler)
    viewer.addHandler('pan',       handler)
    viewer.addHandler('resize',    onResize)
    viewer.addHandler('open',      onResize)
    resize()
    schedule()
    return () => {
      viewer.removeHandler('animation', handler)
      viewer.removeHandler('zoom',      handler)
      viewer.removeHandler('pan',       handler)
      viewer.removeHandler('resize',    onResize)
      viewer.removeHandler('open',      onResize)
    }
  }, [viewer])

  // Also watch container size via ResizeObserver — OSD's resize event doesn't
  // fire when only the surrounding layout changes (e.g. a sidebar collapses).
  useEffect(() => {
    const canvas = canvasRef.current
    const host   = canvas?.parentElement
    if (!host || typeof ResizeObserver === 'undefined') return
    const obs = new ResizeObserver(() => { resize(); schedule() })
    obs.observe(host)
    return () => obs.disconnect()
  }, [])

  useEffect(() => () => {
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
  }, [])

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: 'absolute', inset: 0, width: '100%', height: '100%',
        pointerEvents: 'none', zIndex: 49,
      }}
    />
  )
}
