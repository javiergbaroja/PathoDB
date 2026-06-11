// frontend/src/lib/overlayRenderer.js
import { api } from '../api'

// ─────────────────────────────────────────────────────────────────────────────
// Module-level state
//
// activeOverlays  : jobId  → [ cleanup descriptor ]
// loadingJobs     : Set of jobIds currently being fetched
//                   Prevents double-loads from rapid toggle clicks.
// ─────────────────────────────────────────────────────────────────────────────
const activeOverlays = new Map()
const loadingJobs    = new Set()
const viewerGeneration = new WeakMap()

// SVG circles are acceptable for sparse point overlays, but if a vector result
// contains more Point features than this we switch to the canvas path instead
// to avoid creating thousands of DOM nodes.
const SVG_POINT_THRESHOLD = 500

// ─────────────────────────────────────────────────────────────────────────────
// fetchAndRenderOverlay
// ─────────────────────────────────────────────────────────────────────────────
export async function fetchAndRenderOverlay(viewer, jobId, overlayDef, token, slideInfo, scanId = null) {
  const { file_key: fileKey, legend = {}, type } = overlayDef

  // ── Deduplication guard ────────────────────────────────────────────────────
  // Prevent a second call while an async fetch is still in-flight for the same
  // job. Without this, rapid toggle clicks accumulate duplicate data in memory.
  if (loadingJobs.has(jobId)) return
  loadingJobs.add(jobId)

  if (!activeOverlays.has(jobId)) activeOverlays.set(jobId, [])
  const jobRefs = activeOverlays.get(jobId)

  // Build scan_id query suffix for batch result lookups (empty for single-slide jobs)
  const scanParam = scanId != null ? `&scan_id=${scanId}` : ''

  try {
    // ─────────────────────────────────────────────────────────────────────────
    // 1. RASTER TILE SERVER  (OME-TIFF pyramidal overlay)
    // ─────────────────────────────────────────────────────────────────────────
    if (type === 'tiled_image') {
      const maskWidth  = overlayDef.mask_width  || parseFloat(slideInfo?.width  || 100000)
      const maskHeight = overlayDef.mask_height || parseFloat(slideInfo?.height || 100000)
      const maxLevel   = Math.ceil(Math.log2(Math.max(maskWidth, maskHeight)))
      const myGen = (viewerGeneration.get(viewer) ?? 0)

      viewer.addTiledImage({
        tileSource: {
          width: maskWidth, height: maskHeight,
          tileSize: 256, minLevel: 0, maxLevel,
          getTileUrl: (level, x, y) =>
            `/api/analysis/jobs/${jobId}/tiles/${fileKey}?level=${level}&x=${x}&y=${y}&token=${token}${scanParam}`,
        },
        opacity: 0.7, x: 0, y: 0, width: 1.0,
        success: e => {
          // If the viewer was reset since we started loading, discard this item
          if ((viewerGeneration.get(viewer) ?? 0) !== myGen) {
            try { viewer.world.removeItem(e.item) } catch (_) {}
            return
          }
          jobRefs.push({ tiledImage: e.item })
        },
      })
      return
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 2. STATIC IMAGE  (legacy single-image overlay)
    // ─────────────────────────────────────────────────────────────────────────
    if (type === 'image') {
      viewer.addTiledImage({
        tileSource: { type: 'image', url: `/api/analysis/jobs/${jobId}/overlay?file=${fileKey}${scanParam}` },
        opacity: 0.65, x: 0, y: 0, width: 1,
        success: e => {
          // If the viewer was reset since we started loading, discard this item
          if ((viewerGeneration.get(viewer) ?? 0) !== myGen) {
            try { viewer.world.removeItem(e.item) } catch (_) {}
            return
          }
          jobRefs.push({ tiledImage: e.item })
        },
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
    //
    // Memory strategy:
    //   - The raw geojson object (50–200 MB) is explicitly nulled the moment
    //     we finish building the compact Float32Arrays so the GC can reclaim
    //     it before the draw-loop closures are even registered.
    //   - colorGroups Float32Arrays are the only long-lived allocation per job.
    //   - The canvas 2d context is cached once; getContext() is never called in
    //     the hot draw path.
    //   - The image→element affine transform is computed once per draw() call
    //     using plain arithmetic instead of allocating an OSD Point per cell.
    //     At 600k cells × 60fps that saves ~36M object allocations/sec and the
    //     associated GC pressure that was the primary trigger for OOM crashes.
    // ─────────────────────────────────────────────────────────────────────────
    if (type === 'points') {
      const slW = slideInfo?.width
      const slH = slideInfo?.height
      if (!slW || !slH) return

      // Fetch the full GeoJSON once (may be large — 50–200 MB for a whole slide)
      let geojson
      try {
        geojson = await api.getAnalysisOverlay(jobId, fileKey, scanId)
      } catch (e) {
        console.error(`[overlayRenderer] Failed to fetch point cloud for job ${jobId}:`, e)
        return
      }
      if (!geojson?.features?.length) return

      // ── Pre-process: group normalised [x,y] pairs by colour ────────────────
      // Normalised coords are in [0,1] × [0, slH/slW], matching OSD viewport space.
      // Grouping by colour lets us issue one beginPath / fill per class, which is
      // significantly faster than switching fillStyle per cell.
      const colorGroups = {}   // hex → Float32Array (compact, cache-friendly)
      const colorTmp    = {}   // hex → plain array during build phase

      geojson.features.forEach(f => {
        if (f.geometry?.type !== 'Point') return
        const [px, py] = f.geometry.coordinates
        const name     = f.properties?.classification?.name || 'other'
        const color    = legend[name] || '#94a3b8'
        if (!colorTmp[color]) colorTmp[color] = []
        colorTmp[color].push(px / slW, py / slW)
      })

      // Convert to Float32Arrays for tighter memory and faster iteration, then
      // immediately drop the temporary plain arrays.
      for (const [color, arr] of Object.entries(colorTmp)) {
        colorGroups[color] = new Float32Array(arr)
      }

      // ── CRITICAL: release the raw JSON and temporary plain arrays ───────────
      // geojson (50–200 MB of parsed JS objects) and colorTmp are no longer
      // needed. Explicitly nulling them lets V8 reclaim this memory before we
      // register the draw-loop event handlers below, which is crucial on
      // memory-constrained devices and large slides.
      geojson = null

      // ── Canvas setup ─────────────────────────────────────────────────────────
      const container = viewer.element
      const canvas    = document.createElement('canvas')
      canvas.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none;z-index:1;'

      // Cache the 2d context once — calling getContext() on every draw() call
      // is unnecessary overhead in the hot path.
      const ctx = canvas.getContext('2d', { willReadFrequently: false })

      function resize() {
        canvas.width  = container.clientWidth
        canvas.height = container.clientHeight
      }

      // ── Draw function — called on every OSD viewport-update event ──────────
      //
      // Affine transform (avoids per-point OSD Point allocations):
      //   Our Float32Arrays store viewport-space coords (image pixels / slW).
      //   OSD's viewport bounds are in the same space.
      //   Mapping to canvas pixels is a simple scale + offset:
      //
      //     canvasX = (nx - bounds.x) * scale      where scale = canvas.width / bounds.width
      //     canvasY = (ny - bounds.y) * scale
      //
      //   This replaces `vp.imageToViewerElementCoordinates(new OSD.Point(...))`
      //   which was allocating and discarding one Point object per cell per frame.
      //   For 600k cells at 60fps that is ~36M short-lived allocations/sec.
      function draw() {
        const vp = viewer.viewport
        const b  = vp.getBounds(true)

        ctx.clearRect(0, 0, canvas.width, canvas.height)

        // Pre-compute the affine constants once per frame
        const scale  = canvas.width / b.width
        const offX   = -b.x * scale
        const offY   = -b.y * scale

        const bx0 = b.x
        const by0 = b.y
        const bx1 = b.x + b.width
        const by1 = b.y + b.height

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

            // Viewport culling — skip anything outside the current view
            if (nx < bx0 || nx > bx1 || ny < by0 || ny > by1) continue

            // Inline affine — no per-point object allocation
            const cx = nx * scale + offX
            const cy = ny * scale + offY

            ctx.moveTo(cx + radius, cy)
            ctx.arc(cx, cy, radius, 0, Math.PI * 2)
          }

          ctx.fill()
        }
      }

      resize()
      container.appendChild(canvas)

      // Draw immediately so the overlay appears without requiring a pan/zoom.
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
    //
    // Memory strategy:
    //   - geojson is nulled immediately after the SVG is constructed.
    //   - Point features are safe as SVG circles only when sparse (< threshold).
    //     If the result contains more points than SVG_POINT_THRESHOLD, they are
    //     routed to a lightweight canvas overlay instead to avoid DOM bloat.
    // ─────────────────────────────────────────────────────────────────────────
    try {
      let geojson = await api.getAnalysisOverlay(jobId, fileKey, scanId)
      const slW   = slideInfo?.width
      const slH   = slideInfo?.height

      if (!slW || !slH || !viewer || !geojson?.features?.length) return

      // ── Count point features up-front ─────────────────────────────────────
      // If a result unexpectedly contains a large number of Points, fall back
      // to a canvas overlay rather than creating thousands of SVG <circle> nodes.
      const pointFeatures = geojson.features.filter(
        f => f.geometry?.type === 'Point' || f.geometry?.type === 'MultiPoint'
      )
      const totalPoints = pointFeatures.reduce((acc, f) => {
        return acc + (f.geometry.type === 'MultiPoint' ? f.geometry.coordinates.length : 1)
      }, 0)

      if (totalPoints > SVG_POINT_THRESHOLD) {
        // Recycle into the canvas point-cloud path
        console.warn(
          `[overlayRenderer] Vector overlay for job ${jobId} contains ${totalPoints} points ` +
          `(> ${SVG_POINT_THRESHOLD}). Routing to canvas renderer to avoid DOM pressure.`
        )
        await fetchAndRenderOverlay(
          viewer, jobId,
          { ...overlayDef, type: 'points' },
          token, slideInfo, scanId
        )
        geojson = null
        return
      }

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

        // Points (sparse only — guarded by SVG_POINT_THRESHOLD above)
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

      // ── CRITICAL: release the GeoJSON object ─────────────────────────────
      // The SVG has been fully built from it; holding a reference is wasteful.
      geojson = null

      viewer.addOverlay(svg, new window.OpenSeadragon.Rect(0, 0, 1, aspect))
      jobRefs.push({ svg, viewer })
    } catch (e) {
      console.error(`[overlayRenderer] Vector overlay fetch failed for job ${jobId}:`, e)
    }
  } finally {
    // Always release the loading lock, even if an error occurred.
    loadingJobs.delete(jobId)
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
  // Also clear any stale loading lock for this job (e.g. if cleared mid-fetch)
  loadingJobs.delete(jobId)
}

// ─────────────────────────────────────────────────────────────────────────────
// clearAllOverlays — call this when the OSD viewer instance is destroyed
//
// The module-level Map previously held strong references to canvas elements,
// Float32Arrays, and event handler closures indefinitely across slide navigation.
// Calling this in the SlideViewer useEffect cleanup ensures all overlay memory
// is released when the viewer unmounts.
// ─────────────────────────────────────────────────────────────────────────────
export function clearAllOverlays(viewer) {
  for (const jobId of [...activeOverlays.keys()]) {
    clearOverlay(viewer, jobId)
  }
  // Invalidate any in-flight addTiledImage success callbacks for this viewer
  viewerGeneration.set(viewer, (viewerGeneration.get(viewer) ?? 0) + 1)
}