// frontend/src/lib/overlayRenderer.js
import { api } from '../api'

// Module-level cache: jobId → array of cleanup descriptors
const activeOverlays = new Map()

export async function fetchAndRenderOverlay(viewer, jobId, overlayDef, token, slideInfo) {
  const { file_key: fileKey, legend = {}, type } = overlayDef

  if (!activeOverlays.has(jobId)) activeOverlays.set(jobId, [])
  const jobRefs = activeOverlays.get(jobId)

  // ─────────────────────────────────────────────────────────────────────────
  // 1. RASTER TILE SERVER  (OME-TIFF pyramidal overlay)
  // ─────────────────────────────────────────────────────────────────────────
  if (type === 'tiled_image') {
    const maskWidth  = overlayDef.mask_width  || parseFloat(slideInfo?.width  || 100000)
    const maskHeight = overlayDef.mask_height || parseFloat(slideInfo?.height || 100000)
    const maxLevel   = Math.ceil(Math.log2(Math.max(maskWidth, maskHeight)))

    viewer.addTiledImage({
      tileSource: {
        width: maskWidth, height: maskHeight,
        tileSize: 256, minLevel: 0, maxLevel,
        getTileUrl: (level, x, y) =>
          `/api/analysis/jobs/${jobId}/tiles/${fileKey}?level=${level}&x=${x}&y=${y}&token=${token}`,
      },
      opacity: 0.7, x: 0, y: 0, width: 1.0,
      success: e => jobRefs.push({ tiledImage: e.item }),
    })
    return
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 2. STATIC IMAGE  (legacy single-image overlay)
  // ─────────────────────────────────────────────────────────────────────────
  if (type === 'image') {
    viewer.addTiledImage({
      tileSource: { type: 'image', url: `/api/analysis/jobs/${jobId}/overlay?file=${fileKey}` },
      opacity: 0.65, x: 0, y: 0, width: 1,
      success: e => jobRefs.push({ tiledImage: e.item }),
    })
    return
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 3. POINT CLOUD  (canvas-based, viewport-culled — for cell detection models)
  //
  // Why canvas instead of SVG:
  //   HoVer-NeXt produces 100k–600k points per whole-slide image.
  //   SVG would create that many DOM nodes and freeze the browser.
  //   Canvas renders in a single composited layer; we only draw the subset
  //   of points inside the current viewport (culling), and rescale on zoom.
  // ─────────────────────────────────────────────────────────────────────────
  if (type === 'points') {
    const slW = slideInfo?.width
    const slH = slideInfo?.height
    if (!slW || !slH) return

    // Fetch the full GeoJSON once (may be large — 50–200 MB for a whole slide)
    let geojson
    try {
      geojson = await api.getAnalysisOverlay(jobId, fileKey)
    } catch (e) {
      console.error(`[overlayRenderer] Failed to fetch point cloud for job ${jobId}:`, e)
      return
    }
    if (!geojson?.features?.length) return

    // ── Pre-process: group normalised [x,y] pairs by colour ──────────────────
    // Normalised coords are in [0,1] × [0, slH/slW], matching OSD viewport space.
    // Grouping by colour lets us issue one beginPath / fill per class, which is
    // significantly faster than switching fillStyle per cell.
    const colorGroups = {}   // hex → Float32Array-friendly flat array [x0,y0, x1,y1, ...]
    const colorTmp    = {}   // hex → plain array during build phase

    geojson.features.forEach(f => {
      if (f.geometry?.type !== 'Point') return
      const [px, py] = f.geometry.coordinates
      const name     = f.properties?.classification?.name || 'other'
      const color    = legend[name] || '#94a3b8'
      if (!colorTmp[color]) colorTmp[color] = []
      colorTmp[color].push(px / slW, py / slW)
    })

    // Convert to Float32Arrays for tighter memory and faster iteration
    for (const [color, arr] of Object.entries(colorTmp)) {
      colorGroups[color] = new Float32Array(arr)
    }

    // ── Canvas setup ─────────────────────────────────────────────────────────
    const container = viewer.element
    const canvas    = document.createElement('canvas')
    canvas.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none;z-index:1;'

    function resize() {
      canvas.width  = container.clientWidth
      canvas.height = container.clientHeight
    }

    // ── Draw function — called on every OSD viewport-update event ────────────
    function draw() {
      const ctx  = canvas.getContext('2d')
      const vp   = viewer.viewport

      // Viewport bounds in normalised [0,1] image space
      const b    = vp.getBounds(true)
      const bx0  = b.x
      const by0  = b.y
      const bx1  = b.x + b.width
      const by1  = b.y + b.height

      ctx.clearRect(0, 0, canvas.width, canvas.height)

      // Zoom-adaptive radius:
      //   - At whole-slide zoom (<0.5): 1.5 px  — just dots, no overlap
      //   - At tissue zoom (1–5×):      3–5 px  — clear circles
      //   - Deep zoom (>20×):           cap at 7 px so they don't blob together
      const zoom   = vp.getZoom(true)
      const radius = Math.max(1.5, Math.min(7, zoom * 1.2))

      for (const [color, pts] of Object.entries(colorGroups)) {
        ctx.fillStyle = color
        ctx.beginPath()

        for (let i = 0; i < pts.length; i += 2) {
          const nx = pts[i]
          const ny = pts[i + 1]

          // Viewport culling — skip anything outside the current view + small margin
          if (nx < bx0 || nx > bx1 || ny < by0 || ny > by1) continue

          // OSD converts normalised image coords → viewer-element pixel coordinates
          const vPt = vp.imageToViewerElementCoordinates(
            new window.OpenSeadragon.Point(nx * slW, ny * slW)
          )
          ctx.moveTo(vPt.x + radius, vPt.y)
          ctx.arc(vPt.x, vPt.y, radius, 0, Math.PI * 2)
        }

        ctx.fill()
      }
    }

    resize()
    container.appendChild(canvas)

    // Draw immediately so the overlay appears without requiring a pan/zoom
    // OSD fires update-viewport after open, but we call draw() once eagerly
    // to cover the case where the viewer is already settled.
    draw()

    const onUpdate = () => draw()
    const onResize = () => { resize(); draw() }

    viewer.addHandler('update-viewport', onUpdate)
    viewer.addHandler('resize',          onResize)

    jobRefs.push({ canvas, container, viewer, onUpdate, onResize })
    return
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 4. VECTOR  (GeoJSON polygons / mixed geometry — MetAssist, etc.)
  // ─────────────────────────────────────────────────────────────────────────
  try {
    const geojson = await api.getAnalysisOverlay(jobId, fileKey)
    const slW     = slideInfo?.width
    const slH     = slideInfo?.height

    if (!slW || !slH || !viewer || !geojson?.features?.length) return

    const aspect = slH / slW
    const NS     = 'http://www.w3.org/2000/svg'

    const svg = document.createElementNS(NS, 'svg')
    svg.setAttribute('viewBox', `0 0 1 ${aspect}`)
    svg.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;'

    geojson.features.forEach(feature => {
      const geom  = feature.geometry
      const name  = feature.properties?.classification?.name || feature.properties?.name || 'other'
      const color = legend[name] || '#94a3b8'

      // Polygons
      const polygons = geom.type === 'Polygon'      ? [geom.coordinates]
                     : geom.type === 'MultiPolygon' ? geom.coordinates
                     : []
      polygons.forEach(poly => {
        let d = ''
        poly.forEach(ring => {
          ring.forEach(([x, y], i) => {
            d += i === 0 ? `M ${x / slW},${y / slW} ` : `L ${x / slW},${y / slW} `
          })
          d += 'Z '
        })
        const path = document.createElementNS(NS, 'path')
        path.setAttribute('d', d.trim())
        path.setAttribute('fill', color)
        path.setAttribute('fill-opacity', '0.4')
        path.setAttribute('stroke', color)
        path.setAttribute('stroke-width', '0.0005')
        path.setAttribute('vector-effect', 'non-scaling-stroke')
        path.setAttribute('fill-rule', 'evenodd')
        svg.appendChild(path)
      })

      // Points (sparse — SVG circles are fine for non-cell-detection models)
      const points = geom.type === 'Point'      ? [geom.coordinates]
                   : geom.type === 'MultiPoint' ? geom.coordinates
                   : []
      points.forEach(([x, y]) => {
        const circle = document.createElementNS(NS, 'circle')
        circle.setAttribute('cx', x / slW)
        circle.setAttribute('cy', y / slW)
        circle.setAttribute('r', '0.0008')
        circle.setAttribute('fill', color)
        circle.setAttribute('fill-opacity', '0.9')
        circle.setAttribute('stroke', 'rgba(0,0,0,0.5)')
        circle.setAttribute('stroke-width', '0.0002')
        svg.appendChild(circle)
      })
    })

    viewer.addOverlay(svg, new window.OpenSeadragon.Rect(0, 0, 1, aspect))
    jobRefs.push({ svg, viewer })
  } catch (e) {
    console.error(`[overlayRenderer] Vector overlay fetch failed for job ${jobId}:`, e)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// clearOverlay — removes all rendered artefacts for a given job
// ─────────────────────────────────────────────────────────────────────────────
export function clearOverlay(viewer, jobId) {
  if (!activeOverlays.has(jobId)) return

  activeOverlays.get(jobId).forEach(item => {
    // Canvas point-cloud overlay
    if (item.canvas) {
      try {
        item.viewer.removeHandler('update-viewport', item.onUpdate)
        item.viewer.removeHandler('resize',          item.onResize)
        item.container.removeChild(item.canvas)
      } catch (e) {
        console.warn('[overlayRenderer] canvas cleanup error:', e)
      }
    }

    // SVG vector overlay
    if (item.svg) {
      try { viewer.removeOverlay(item.svg) } catch (e) {
        console.warn('[overlayRenderer] svg cleanup error:', e)
      }
    }

    // Raster tiled image overlay
    if (item.tiledImage) {
      try { viewer.world.removeItem(item.tiledImage) } catch (e) {
        console.warn('[overlayRenderer] tiledImage cleanup error:', e)
      }
    }
  })

  activeOverlays.delete(jobId)
}