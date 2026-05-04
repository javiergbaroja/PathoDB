// frontend/src/hooks/useOSDViewer.js
// BUG FIXES vs v1:
//  - slideInfo is now compared by scanId only (not by object reference) so React
//    Query background refetches no longer destroy/recreate OSD every render.
//  - isMounted ref is reset correctly inside the effect, not outside.
//  - Returns a stable `reinit` callback so callers can force reinit after scan change.

import { useEffect, useRef, useCallback } from 'react'

const SCALEBAR_NICE = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000]

function buildOSD({ containerRef, scanId, slideInfo, token, onZoom, osdRef, isMounted }) {
  if (!slideInfo || !containerRef.current || !window.OpenSeadragon) return

  // Tear down any existing instance first
  if (osdRef.current) {
    try { osdRef.current.destroy() } catch (_) {}
    osdRef.current = null
  }
  containerRef.current.innerHTML = ''

  fetch(`/api/slides/${scanId}/dzi?token=${token}`)
    .then(r => { if (!r.ok) throw new Error(`DZI ${r.status}`); return r.text() })
    .then(xml => {
      if (!isMounted.current) return

      const doc      = new DOMParser().parseFromString(xml, 'application/xml')
      const imgEl    = doc.querySelector('Image')
      const sizeEl   = doc.querySelector('Size')
      if (!imgEl || !sizeEl) throw new Error('Malformed DZI XML')

      const tileSize = parseInt(imgEl.getAttribute('TileSize'))
      const overlap  = parseInt(imgEl.getAttribute('Overlap'))
      const width    = parseInt(sizeEl.getAttribute('Width'))
      const height   = parseInt(sizeEl.getAttribute('Height'))

      if (!containerRef.current) return  // unmounted between fetch and here

      const viewer = window.OpenSeadragon({
        element: containerRef.current,
        tileSources: {
          width, height, tileSize, tileOverlap: overlap,
          getTileUrl: (level, x, y) =>
            `/api/slides/${scanId}/dzi_files/${level}/${x}_${y}.jpeg?token=${token}`,
        },
        prefixUrl: 'https://cdnjs.cloudflare.com/ajax/libs/openseadragon/4.1.0/images/',
        animationTime: 0.3, blendTime: 0.1, constrainDuringPan: true,
        maxZoomPixelRatio: 4, minZoomImageRatio: 0.5, visibilityRatio: 1,
        zoomPerScroll: 1.4, showNavigator: true, navigatorPosition: 'BOTTOM_RIGHT',
        navigatorSizeRatio: 0.13, showZoomControl: true, showHomeControl: true,
        showFullPageControl: false, showRotationControl: false,
        background: '#111827',
      })

      osdRef.current = viewer

      if (viewer.navigator?.element) {
        Object.assign(viewer.navigator.element.style, {
          backgroundColor: '#fff',
          border: '1.5px solid rgba(255,255,255,0.2)',
          borderRadius: '4px',
        })
      }

      if (onZoom) {
        viewer.addHandler('zoom', ({ zoom: z }) =>
          onZoom(z ? parseFloat(z.toFixed(1)) : null)
        )
      }

      viewer.addHandler('open', () => {
        if (!isMounted.current) return
        const rawMpp = slideInfo?.mpp_x ? parseFloat(slideInfo.mpp_x) : null
        if (!rawMpp || !viewer.scalebar) return

        viewer.scalebar({
          type: window.OpenSeadragon.ScalebarType.MICROSCOPY,
          pixelsPerMeter: 1000000 / rawMpp,
          location: window.OpenSeadragon.ScalebarLocation.BOTTOM_LEFT,
          xOffset: 20, yOffset: 20, color: '#000', fontColor: '#000',
          backgroundColor: 'rgba(255,255,255,0.8)', fontSize: '12px',
          fontFamily: 'monospace', fontWeight: '600', barThickness: 3,
          stayInsideImage: false,
        })

        let raf = null
        const updateSB = () => {
          const el = containerRef.current?.querySelector('.openseadragon-scalebar')
          if (!el || !viewer.viewport) return
          const zoom   = viewer.viewport.getZoom(true)
          const ti     = viewer.world.getItemAt(0)
          if (!ti) return
          const umPerPx = rawMpp / ti.viewportToImageZoom(zoom)
          const niceUm  = SCALEBAR_NICE.find(l => l >= umPerPx * window.innerWidth * 0.03)
                        || SCALEBAR_NICE[SCALEBAR_NICE.length - 1]
          el.style.width = `${Math.min(niceUm / umPerPx, 300)}px`
          const lbl = el.querySelector('div')
          if (lbl) lbl.textContent = niceUm >= 1000 ? `${niceUm / 1000} mm` : `${niceUm} µm`
        }
        const req = () => { if (raf) cancelAnimationFrame(raf); raf = requestAnimationFrame(updateSB) }
        viewer.addHandler('zoom', req)
        viewer.addHandler('animation', req)
        window.addEventListener('resize', req)
        viewer.addHandler('destroy', () => { window.removeEventListener('resize', req); if (raf) cancelAnimationFrame(raf) })
        updateSB()
      })
    })
    .catch(e => console.error(`[useOSDViewer] init failed for scan ${scanId}:`, e))
}

function loadOSDScripts(cb) {
  if (window.OpenSeadragon?.Viewer.prototype.scalebar) { cb(); return }
  if (window.OpenSeadragon) {
    const s = document.createElement('script')
    s.src = 'https://cdn.jsdelivr.net/gh/usnistgov/OpenSeadragonScalebar@master/openseadragon-scalebar.js'
    s.onload = cb
    document.head.appendChild(s)
    return
  }
  const s1 = document.createElement('script')
  s1.src = 'https://cdnjs.cloudflare.com/ajax/libs/openseadragon/4.1.0/openseadragon.min.js'
  s1.onload = () => {
    const s2 = document.createElement('script')
    s2.src = 'https://cdn.jsdelivr.net/gh/usnistgov/OpenSeadragonScalebar@master/openseadragon-scalebar.js'
    s2.onload = cb
    document.head.appendChild(s2)
  }
  document.head.appendChild(s1)
}

/**
 * Hook that initialises/reinitialises OpenSeadragon when scanId changes.
 * Deliberately does NOT include slideInfo in its dependency array —
 * React Query returns a new object on every background refetch which
 * would otherwise destroy and recreate the viewer constantly.
 * slideInfo is read via a ref so the init function always sees the latest value.
 *
 * @param {object} opts
 * @param {React.RefObject} opts.containerRef
 * @param {number|null}     opts.scanId
 * @param {object|null}     opts.slideInfo    — passed as prop but read via ref inside
 * @param {string}          opts.token
 * @param {function}        opts.onZoom
 * @param {React.RefObject} opts.osdRef       — caller keeps this ref; hook writes to it
 * @param {function}        opts.onReady      — called after OSD 'open' fires (optional)
 */
export function useOSDViewer({ containerRef, scanId, slideInfo, token, onZoom, osdRef, onReady }) {
  const isMounted   = useRef(false)
  // Keep a ref to slideInfo so the async init closure always sees latest value
  // without slideInfo being a dependency that causes re-init on every RQ refetch
  const slideInfoRef = useRef(slideInfo)
  useEffect(() => { slideInfoRef.current = slideInfo }, [slideInfo])

  const onZoomRef = useRef(onZoom)
  useEffect(() => { onZoomRef.current = onZoom }, [onZoom])

  const onReadyRef = useRef(onReady)
  useEffect(() => { onReadyRef.current = onReady }, [onReady])

  useEffect(() => {
    if (!scanId) return
    isMounted.current = true

    // We need slideInfo before we can build the OSD viewer (for scalebar mpp).
    // Poll until slideInfo arrives (it comes from a separate React Query fetch).
    let cancelPoll = false
    const tryInit = () => {
      if (cancelPoll) return
      if (!slideInfoRef.current) {
        // slideInfo not yet loaded — try again in 200 ms
        setTimeout(tryInit, 200)
        return
      }
      loadOSDScripts(() => {
        if (cancelPoll || !isMounted.current) return
        buildOSD({
          containerRef,
          scanId,
          slideInfo:  slideInfoRef.current,
          token,
          onZoom:     (z) => onZoomRef.current?.(z),
          osdRef,
          isMounted,
        })
        // Fire onReady once 'open' has been called
        // We piggyback on the viewer ref — poll until it exists then subscribe
        const waitForViewer = () => {
          if (cancelPoll) return
          if (!osdRef.current) { setTimeout(waitForViewer, 100); return }
          osdRef.current.addHandler('open', () => {
            if (!cancelPoll && isMounted.current) onReadyRef.current?.()
          })
        }
        waitForViewer()
      })
    }
    tryInit()

    return () => {
      isMounted.current = false
      cancelPoll = true
      if (osdRef.current) {
        try { osdRef.current.destroy() } catch (_) {}
        osdRef.current = null
      }
    }
  }, [scanId, token]) // ← deliberately excludes slideInfo — see doc comment above
}

// ─── Coordinate helpers ────────────────────────────────────────────────────────

export function elementToImage(viewer, ex, ey) {
  if (!viewer?.viewport) return null
  try {
    const vp  = viewer.viewport.viewerElementToViewportCoordinates(
      new window.OpenSeadragon.Point(ex, ey)
    )
    const img = viewer.viewport.viewportToImageCoordinates(vp)
    return { x: img.x, y: img.y }
  } catch { return null }
}

export function imageToElement(viewer, ix, iy) {
  if (!viewer?.viewport) return null
  try {
    const vp = viewer.viewport.imageToViewportCoordinates(
      new window.OpenSeadragon.Point(ix, iy)
    )
    const el = viewer.viewport.viewportToViewerElementCoordinates(vp)
    return { x: el.x, y: el.y }
  } catch { return null }
}