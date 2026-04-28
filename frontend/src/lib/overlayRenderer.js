// frontend/src/lib/overlayRenderer.js
import { api } from '../api'

// Module-level cache to track rendered SVGs and TiledImages outside of React
const activeOverlays = new Map()

export async function fetchAndRenderOverlay(viewer, jobId, overlayDef, token, slideInfo) {
  const { file_key: fileKey, legend, type } = overlayDef

  // Initialize cache array for this job if it doesn't exist
  if (!activeOverlays.has(jobId)) {
    activeOverlays.set(jobId, [])
  }
  const jobRefs = activeOverlays.get(jobId)

  // ==========================================
  // 1. RASTER TILE SERVER HANDLING (OME-TIFF)
  // ==========================================
  if (type === 'tiled_image') {
    const maskWidth = overlayDef.mask_width || parseFloat(slideInfo?.width || 100000)
    const maskHeight = overlayDef.mask_height || parseFloat(slideInfo?.height || 100000)
    const maxLevel = Math.ceil(Math.log2(Math.max(maskWidth, maskHeight)))

    viewer.addTiledImage({
      tileSource: {
        width: maskWidth,
        height: maskHeight,
        tileSize: 256,
        minLevel: 0,
        maxLevel: maxLevel,
        getTileUrl: function(level, x, y) {
          return `/api/analysis/jobs/${jobId}/tiles/${fileKey}?level=${level}&x=${x}&y=${y}&token=${token}`
        }
      },
      opacity: 0.7,
      x: 0,
      y: 0,
      width: 1.0,
      success: function (event) {
        jobRefs.push({ tiledImage: event.item })
      }
    })
    return
  }

  if (type === 'image') {
    const imageUrl = `/api/analysis/jobs/${jobId}/overlay?file=${fileKey}`
    viewer.addTiledImage({
      tileSource: { type: 'image', url: imageUrl },
      opacity: 0.65,
      x: 0,
      y: 0,
      width: 1,
      success: function (event) {
        jobRefs.push({ tiledImage: event.item })
      }
    })
    return
  }

  // ==========================================
  // 2. VECTOR HANDLING (GeoJSON Polygons & Points)
  // ==========================================
  try {
    const geojson = await api.getAnalysisOverlay(jobId, fileKey)
    const slW     = slideInfo?.width
    const slH     = slideInfo?.height
    
    if (!slW || !slH || !viewer || !geojson?.features?.length) return

    const aspect  = slH / slW
    const NS      = 'http://www.w3.org/2000/svg'
    
    const svg = document.createElementNS(NS, 'svg')
    svg.setAttribute('viewBox', `0 0 1 ${aspect}`)
    svg.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;'

    geojson.features.forEach(feature => {
      const geom = feature.geometry
      const name = feature.properties?.classification?.name || feature.properties?.name || 'other'
      const color = legend[name] || '#94a3b8' 
      
      // Handle Polygons
      const polygons = geom.type === 'Polygon'      ? [geom.coordinates]
                     : geom.type === 'MultiPolygon' ? geom.coordinates
                     : []

      polygons.forEach(poly => {
        let pathData = ''
        poly.forEach(ring => {
          ring.forEach(([x, y], i) => {
            const localX = (x) / slW
            const localY = (y) / slW
            pathData += i === 0 ? `M ${localX},${localY} ` : `L ${localX},${localY} `
          })
          pathData += 'Z '
        })
        const path = document.createElementNS(NS, 'path')
        path.setAttribute('d', pathData.trim())
        path.setAttribute('fill', color)
        path.setAttribute('fill-opacity', '0.4')
        path.setAttribute('stroke', color)
        path.setAttribute('stroke-width', '0.0005')
        path.setAttribute('vector-effect', 'non-scaling-stroke')
        path.setAttribute('fill-rule', 'evenodd') 
        svg.appendChild(path)
      })

      // Handle Points
      const points = geom.type === 'Point'      ? [geom.coordinates]
                   : geom.type === 'MultiPoint' ? geom.coordinates
                   : []

      points.forEach(([x, y]) => {
        const localX = (x) / slW
        const localY = (y) / slW
        const circle = document.createElementNS(NS, 'circle')
        circle.setAttribute('cx', localX)
        circle.setAttribute('cy', localY)
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
    console.error(`Overlay fetch failed for ${fileKey}:`, e)
  }
}

export function clearOverlay(viewer, jobId) {
  if (activeOverlays.has(jobId)) {
    activeOverlays.get(jobId).forEach(item => {
      if (item.svg) {
        // Remove GeoJSON vector overlay
        viewer.removeOverlay(item.svg)
      } else if (item.tiledImage) {
        // Remove Raster Image layer
        viewer.world.removeItem(item.tiledImage)
      }
    })
    activeOverlays.delete(jobId)
  }
}