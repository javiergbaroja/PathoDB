import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { api } from '../api'
import JobOutcomeDispatcher from '../components/AnalysisOutcomes/JobOutcomeDispatcher'
import { useAuth } from '../context/AuthContext'
// ── Stain category colour map ─────────────────────────────────────────────────
const STAIN_COLORS = {
  HE:            '#6ee7b7',
  IHC:           '#a78bfa',
  special_stain: '#fbbf24',
  FISH:          '#60a5fa',
  other:         '#94a3b8',
}

// ── Style injection ───────────────────────────────────────────────────────────
if (!document.getElementById('sv-styles')) {
  const s = document.createElement('style')
  s.id = 'sv-styles'
  s.textContent = `
    @keyframes sv-spin { to { transform: rotate(360deg); } }
    .osd-scalebar canvas { width:auto!important;height:auto!important;max-width:none!important;max-height:none!important; }
    .osd-scalebar { transition: width 0.1s linear; }
    .sv-tool-btn { display:flex;align-items:center;gap:5px;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.14);border-radius:5px;color:rgba(255,255,255,0.7);padding:4px 10px;cursor:pointer;font-size:12px;font-family:sans-serif;transition:all 0.15s; }
    .sv-tool-btn:hover { background:rgba(255,255,255,0.1);border-color:rgba(255,255,255,0.25); }
    .sv-tool-btn.active { background:rgba(27,153,139,0.2);border-color:#1b998b;color:#6ee7b7; }
    .sv-scan-chip { transition:border-color 0.15s,background 0.15s; }
    .sv-scan-chip:hover:not(.sv-active-l):not(.sv-active-r) { border-color:rgba(255,255,255,0.35)!important; background:rgba(255,255,255,0.06)!important; }
  `
  document.head.appendChild(s)
}


// ─────────────────────────────────────────────────────────────────────────────
// MAIN COMPONENT
// ─────────────────────────────────────────────────────────────────────────────
export default function SlideViewer() {
  const { scanId } = useParams()
  const navigate   = useNavigate()
  const token      = localStorage.getItem('pathodb_token')

  // ── Scan IDs ───────────────────────────────────────────────────────────────
  const [leftScanId,  setLeftScanId]  = useState(parseInt(scanId))
  const [rightScanId, setRightScanId] = useState(null)

  // ── Data ───────────────────────────────────────────────────────────────────
  const [leftInfo,     setLeftInfo]     = useState(null)
  const [rightInfo,    setRightInfo]    = useState(null)
  const [relatedScans, setRelatedScans] = useState([])
  const [loading,      setLoading]      = useState(true)
  const [error,        setError]        = useState('')

  // ── Zoom (rendered in topbar) ──────────────────────────────────────────────
  const [leftZoom,  setLeftZoom]  = useState(null)
  const [rightZoom, setRightZoom] = useState(null)
  const [gamma,      setGamma]      = useState(1.0)

  // ── Layout / UI ────────────────────────────────────────────────────────────
  const [compareMode,      setCompareMode]      = useState(false)
  const [isSynced,         setIsSynced]         = useState(false)
  const [isDragging,       setIsDragging]       = useState(false)
  const [panelOpen,        setPanelOpen]        = useState(false)
  const [panelSide,        setPanelSide]        = useState('left')
  const [reportOpen,       setReportOpen]       = useState(false)
  const [filmstripVisible, setFilmstripVisible] = useState(true)
  const [filmstripHeight,  setFilmstripHeight]  = useState(190)
  const [levelPopover,     setLevelPopover]     = useState(null)

  // ── Tools ──────────────────────────────────────────────────────────────────
  const [isRulerActive,  setIsRulerActive]  = useState(false)
  const [showBrightness, setShowBrightness] = useState(false)
  const [brightness,     setBrightness]     = useState(100)
  const [contrast,       setContrast]       = useState(100)
  const [showShortcuts,  setShowShortcuts]  = useState(false)
  const [showModels,     setShowModels]     = useState(false)

  // ── Analysis jobs ──────────────────────────────────────────────────────────
  const [catalog,        setCatalog]        = useState([])
  const [analysisJobs,   setAnalysisJobs]   = useState([])
  const [activeOverlays, setActiveOverlays] = useState({})  // jobId → true/false
  const [overlayData,    setOverlayData]    = useState({})  // jobId → {file → geojson}
  const overlayRefs      = useRef({})                        // jobId → [svg elements]

  // ── Refs ───────────────────────────────────────────────────────────────────
  const leftViewerRef      = useRef(null)
  const rightViewerRef     = useRef(null)
  const osdLeftRef         = useRef(null)
  const osdRightRef        = useRef(null)
  const filmstripScrollRef = useRef(null)
  const activeChipRef      = useRef(null)
  const resizingRef        = useRef(false)
  const resizeStartY       = useRef(0)
  const resizeStartH       = useRef(0)

  // ── URL sync ───────────────────────────────────────────────────────────────
  useEffect(() => {
    const id = parseInt(scanId)
    if (id !== leftScanId) setLeftScanId(id)
  }, [scanId])

  // ── Fetch slide info + conditionally related scans ─────────────────────────
  // getRelatedScans returns ALL scans for the whole submission. Navigating
  // between chips in the same case must not re-fetch — the data is identical
  // and re-fetching causes probe labels to disappear while the request is
  // in-flight. A ref (not state) tracks the last fetched submission ID so the
  // comparison happens inside the .then() callback against the actual fresh
  // API value — no render cycle, no stale closure, no derived state.
  const lastFetchedSubmissionRef = useRef(null)

  useEffect(() => {
    let svg = document.getElementById('sv-gamma-svg')
    if (!svg) {
      svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
      svg.setAttribute('id', 'sv-gamma-svg')
      svg.setAttribute('style', 'position:absolute;width:0;height:0;overflow:hidden')
      svg.innerHTML = `<defs><filter id="sv-gamma">
        <feComponentTransfer>
          <feFuncR type="gamma" exponent="1"/>
          <feFuncG type="gamma" exponent="1"/>
          <feFuncB type="gamma" exponent="1"/>
        </feComponentTransfer>
      </filter></defs>`
      document.body.appendChild(svg)
    }
    const exponent = (1 / gamma).toFixed(4)
    svg.querySelectorAll('feFuncR, feFuncG, feFuncB')
      .forEach(el => el.setAttribute('exponent', exponent))
  }, [gamma])

  useEffect(() => {
    if (!token) { navigate('/login'); return }
    setLoading(true)
    setError('')
    api.getSlideInfo(leftScanId, token)
      .then(info => {
        setLeftInfo(info)
        if (info.lis_submission_id !== lastFetchedSubmissionRef.current) {
          lastFetchedSubmissionRef.current = info.lis_submission_id
          api.getRelatedScans(leftScanId, token)
            .then(scans => setRelatedScans(scans))
            .catch(() => {})
        }
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [leftScanId, token, navigate])

  // ── Fetch right info ───────────────────────────────────────────────────────
  useEffect(() => {
    if (!rightScanId) { setRightInfo(null); return }
    api.getSlideInfo(rightScanId, token)
      .then(setRightInfo)
      .catch(e => setError(`Right slide: ${e.message}`))
  }, [rightScanId, token])

  // ── OSD creation helper ────────────────────────────────────────────────────
  const createOSDInstance = useCallback((containerRef, id, info, setZoom, osdRef, isMounted) => {
    if (!info || !containerRef.current || !window.OpenSeadragon) return
    if (osdRef.current) { osdRef.current.destroy(); osdRef.current = null }
    containerRef.current.innerHTML = ''

    fetch(`/api/slides/${id}/dzi?token=${token}`)
      .then(r => { if (!r.ok) throw new Error(`DZI ${r.status}`); return r.text() })
      .then(xml => {
        if (!isMounted.current) return
        const doc      = new DOMParser().parseFromString(xml, 'application/xml')
        const imgEl    = doc.querySelector('Image')
        const sizeEl   = doc.querySelector('Size')
        const tileSize = parseInt(imgEl.getAttribute('TileSize'))
        const overlap  = parseInt(imgEl.getAttribute('Overlap'))
        const width    = parseInt(sizeEl.getAttribute('Width'))
        const height   = parseInt(sizeEl.getAttribute('Height'))

        const viewer = window.OpenSeadragon({
          element: containerRef.current,
          tileSources: {
            width, height, tileSize, tileOverlap: overlap,
            getTileUrl: (level, x, y) => `/api/slides/${id}/dzi_files/${level}/${x}_${y}.jpeg?token=${token}`,
          },
          prefixUrl: 'https://cdnjs.cloudflare.com/ajax/libs/openseadragon/4.1.0/images/',
          animationTime: 0.3, blendTime: 0.1, constrainDuringPan: true,
          maxZoomPixelRatio: 4, minZoomImageRatio: 0.5, visibilityRatio: 1, zoomPerScroll: 1.4,
          showNavigator: true, navigatorPosition: 'BOTTOM_RIGHT', navigatorSizeRatio: 0.15,
          showZoomControl: true, showHomeControl: true, showFullPageControl: false, showRotationControl: false,
          background: '#111827',
        })
        osdRef.current = viewer

        if (viewer.navigator?.element) {
          Object.assign(viewer.navigator.element.style, {
            backgroundColor: '#fff', border: '1.5px solid rgba(255,255,255,0.2)', borderRadius: '4px',
          })
        }

        viewer.addHandler('zoom', ({ zoom: z }) => setZoom(z ? parseFloat(z.toFixed(1)) : null))

        viewer.addHandler('open', () => {
          const rawMpp = info?.mpp_x ? parseFloat(info.mpp_x) : null
          if (!rawMpp || !viewer.scalebar) return
          viewer.scalebar({
            type: window.OpenSeadragon.ScalebarType.MICROSCOPY,
            pixelsPerMeter: 1000000 / rawMpp,
            location: window.OpenSeadragon.ScalebarLocation.BOTTOM_LEFT,
            xOffset: 20, yOffset: 20,
            color: '#000', fontColor: '#000', backgroundColor: 'rgba(255,255,255,0.8)',
            fontSize: '12px', fontFamily: 'monospace', fontWeight: '600', barThickness: 3, stayInsideImage: false,
          })
          const NICE = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000]
          let raf = null
          const updateSB = () => {
            const el = containerRef.current?.querySelector('.openseadragon-scalebar')
            if (!el || !viewer.viewport) return
            const zoom = viewer.viewport.getZoom(true)
            const ti = viewer.world.getItemAt(0)
            if (!ti) return
            const umPerPx = rawMpp / ti.viewportToImageZoom(zoom)
            const niceUm = NICE.find(l => l >= umPerPx * window.innerWidth * 0.03) || NICE[NICE.length - 1]
            el.style.width = `${Math.min(niceUm / umPerPx, 300)}px`
            const lbl = el.querySelector('div')
            if (lbl) lbl.textContent = niceUm >= 1000 ? `${niceUm / 1000} mm` : `${niceUm} µm`
          }
          const req = () => { if (raf) cancelAnimationFrame(raf); raf = requestAnimationFrame(updateSB) }
          viewer.addHandler('zoom', req)
          viewer.addHandler('animation', req)
          window.addEventListener('resize', req)
          viewer.addHandler('destroy', () => window.removeEventListener('resize', req))
          updateSB()
        })
      })
      .catch(e => setError(`Failed to load slide: ${e.message}`))
  }, [token])

  // ── Init left viewer ───────────────────────────────────────────────────────
  useEffect(() => {
    const isMounted = { current: true }
    const init = () => createOSDInstance(leftViewerRef, leftScanId, leftInfo, setLeftZoom, osdLeftRef, isMounted)
    if (window.OpenSeadragon?.Viewer.prototype.scalebar) {
      init()
    } else if (window.OpenSeadragon) {
      const s = document.createElement('script')
      s.src = 'https://cdn.jsdelivr.net/gh/usnistgov/OpenSeadragonScalebar@master/openseadragon-scalebar.js'
      s.onload = init; document.head.appendChild(s)
    } else {
      const s1 = document.createElement('script')
      s1.src = 'https://cdnjs.cloudflare.com/ajax/libs/openseadragon/4.1.0/openseadragon.min.js'
      s1.onload = () => {
        const s2 = document.createElement('script')
        s2.src = 'https://cdn.jsdelivr.net/gh/usnistgov/OpenSeadragonScalebar@master/openseadragon-scalebar.js'
        s2.onload = init; document.head.appendChild(s2)
      }
      document.head.appendChild(s1)
    }
    return () => { isMounted.current = false; if (osdLeftRef.current) { osdLeftRef.current.destroy(); osdLeftRef.current = null } }
  }, [leftScanId, leftInfo, createOSDInstance])

  // ── Init right viewer ──────────────────────────────────────────────────────
  useEffect(() => {
    const isMounted = { current: true }
    if (!rightScanId || !rightInfo) return
    if (window.OpenSeadragon?.Viewer.prototype.scalebar) {
      createOSDInstance(rightViewerRef, rightScanId, rightInfo, setRightZoom, osdRightRef, isMounted)
    }
    return () => { isMounted.current = false; if (osdRightRef.current) { osdRightRef.current.destroy(); osdRightRef.current = null } }
  }, [rightScanId, rightInfo, createOSDInstance])

  // ── Sync engine ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!isSynced || !osdLeftRef.current || !osdRightRef.current) return
    const L = osdLeftRef.current, R = osdRightRef.current
    const lc = L.viewport.getCenter(), rc = R.viewport.getCenter()
    const panOff = { x: rc.x - lc.x, y: rc.y - lc.y }
    const zRatio = R.viewport.getZoom() / L.viewport.getZoom()
    let sl = false, sr = false
    const lh = () => { if (sr) return; sl = true; const c = L.viewport.getCenter(); R.viewport.panTo(new window.OpenSeadragon.Point(c.x + panOff.x, c.y + panOff.y), true); R.viewport.zoomTo(L.viewport.getZoom() * zRatio, null, true); sl = false }
    const rh = () => { if (sl) return; sr = true; const c = R.viewport.getCenter(); L.viewport.panTo(new window.OpenSeadragon.Point(c.x - panOff.x, c.y - panOff.y), true); L.viewport.zoomTo(R.viewport.getZoom() / zRatio, null, true); sr = false }
    L.addHandler('pan', lh); L.addHandler('zoom', lh)
    R.addHandler('pan', rh); R.addHandler('zoom', rh)
    return () => { L.removeHandler('pan', lh); L.removeHandler('zoom', lh); R.removeHandler('pan', rh); R.removeHandler('zoom', rh) }
  }, [isSynced])

  // ── Ruler tool ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!isRulerActive) return
    const viewers = [osdLeftRef.current, osdRightRef.current].filter(Boolean)
    const cleanup = []
    viewers.forEach(viewer => {
      viewer.setMouseNavEnabled(false)
      const container = viewer.element
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
      Object.assign(svg.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', pointerEvents: 'none', zIndex: 100 })
      container.appendChild(svg)
      let sp = null, line = null, label = null
      const tracker = new window.OpenSeadragon.MouseTracker({
        element: container,
        pressHandler: e => {
          svg.innerHTML = ''; sp = e.position
          line = document.createElementNS('http://www.w3.org/2000/svg', 'line')
          line.setAttribute('stroke', '#00ffcc'); line.setAttribute('stroke-width', '2')
          svg.appendChild(line)
          label = document.createElementNS('http://www.w3.org/2000/svg', 'text')
          label.setAttribute('fill', '#00ffcc')
          label.setAttribute('style', 'font-family:monospace;font-size:13px;font-weight:bold;paint-order:stroke;stroke:#000;stroke-width:3px')
          svg.appendChild(label)
        },
        dragHandler: e => {
          if (!sp || !line) return
          const ep = e.position
          line.setAttribute('x1', sp.x); line.setAttribute('y1', sp.y); line.setAttribute('x2', ep.x); line.setAttribute('y2', ep.y)
          const iz = viewer.world.getItemAt(0)?.viewportToImageZoom(viewer.viewport.getZoom(true)) || 1
          const mpp = parseFloat(viewer === osdLeftRef.current ? leftInfo?.mpp_x : rightInfo?.mpp_x) || 0.25
          const um = (Math.hypot(ep.x - sp.x, ep.y - sp.y) / iz) * mpp
          label.textContent = um >= 1000 ? `${(um / 1000).toFixed(2)} mm` : `${um.toFixed(1)} µm`
          label.setAttribute('x', ep.x + 10); label.setAttribute('y', ep.y - 10)
        },
      })
      cleanup.push({ tracker, svg, container, viewer })
    })
    return () => cleanup.forEach(({ tracker, svg, container, viewer }) => {
      tracker.destroy()
      if (container.contains(svg)) container.removeChild(svg)
      if (viewer?.viewport) viewer.setMouseNavEnabled(true)
    })
  }, [isRulerActive, leftInfo, rightInfo, rightScanId])

  // ── Keyboard shortcuts ─────────────────────────────────────────────────────
  useEffect(() => {
    function handler(e) {
      if (['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return
      if (e.key === 'i' || e.key === 'I') { setPanelOpen(o => !o); return }
      if (e.key === 'r' || e.key === 'R') { setIsRulerActive(o => !o); return }
      if (e.key === 'b' || e.key === 'B') { setShowBrightness(o => !o); return }
      if (e.key === '?')                  { setShowShortcuts(o => !o); return }
      if (e.key === ' ')                  { e.preventDefault(); osdLeftRef.current?.viewport?.goHome(true); osdRightRef.current?.viewport?.goHome(true); return }
      if (e.key === 'm' || e.key === 'M') { setShowModels(o => !o); return }
      if (e.key === 'Escape') {
        if (isRulerActive)  { setIsRulerActive(false); return }
        if (showBrightness) { setShowBrightness(false); return }
        if (showShortcuts)  { setShowShortcuts(false); return }
        if (showModels)    { setShowModels(false); return }
        if (rightScanId)    { setRightScanId(null); setCompareMode(false); setIsSynced(false) }
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [isRulerActive, rightScanId, showBrightness, showShortcuts, showModels])

  // ── Auto-scroll filmstrip to active scan ───────────────────────────────────
  useEffect(() => {
    if (activeChipRef.current && filmstripScrollRef.current) {
      const chip      = activeChipRef.current
      const container = filmstripScrollRef.current
      const chipLeft  = chip.offsetLeft - container.offsetLeft
      const target    = chipLeft - (container.offsetWidth / 2) + (chip.offsetWidth / 2)
      container.scrollTo({ left: Math.max(0, target), behavior: 'smooth' })
    }
  }, [leftScanId])

  // ── Resize handle ──────────────────────────────────────────────────────────
  useEffect(() => {
    const onMove = e => {
      if (!resizingRef.current) return
      const delta = resizeStartY.current - e.clientY
      setFilmstripHeight(Math.max(100, Math.min(320, resizeStartH.current + delta)))
    }
    const onUp = () => { resizingRef.current = false }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    return () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp) }
  }, [])

  // ── Fetch model catalog once on mount ──────────────────────────────────────
  useEffect(() => {
    api.getModels()
      .then(data => setCatalog(data.models || []))
      .catch(() => {})
  }, [])

  // ── Fetch jobs for current scan; poll every 5s when any are non-terminal ───
  useEffect(() => {
    if (!leftScanId) return
    let cancelled = false

    function fetchJobs() {
      api.getAnalysisJobs(leftScanId)
        .then(jobs => { if (!cancelled) setAnalysisJobs(jobs) })
        .catch(() => {})
    }

    fetchJobs()

    const hasActive = analysisJobs.some(j => j.status === 'queued' || j.status === 'running')
    const interval  = hasActive ? setInterval(fetchJobs, 5000) : null

    return () => {
      cancelled = true
      if (interval) clearInterval(interval)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leftScanId, analysisJobs.map(j => j.status).join(',')])

  // ── Handlers ───────────────────────────────────────────────────────────────
  function handleBack() {
    if (window.history.length > 1) navigate(-1)
    else navigate('/patients')
  }

  function handleDrop(e, side) {
    e.preventDefault(); setIsDragging(false)
    const id = parseInt(e.dataTransfer.getData('scanId'))
    if (!id) return
    if (side === 'left')  { navigate(`/viewer/${id}`) }
    else                  { setRightScanId(id); setCompareMode(true); setIsSynced(false) }
  }

  function handleCompareToggle() {
    if (compareMode) { setCompareMode(false); setRightScanId(null); setIsSynced(false) }
    else             { setCompareMode(true) }
  }

  async function fetchAndRenderOverlay(jobId, overlayDef, viewer) {
    const { file_key: fileKey, legend, type } = overlayDef
    const cacheKey = `${jobId}:${fileKey}`

    // ==========================================
    // RASTER TILE SERVER HANDLING (OME-TIFF)
    // ==========================================
    if (type === 'tiled_image') {
      // 1. Get the TRUE dimensions of the mask from the JSON
      // (Fallback to slide info just in case older jobs don't have it)
      const maskWidth = overlayDef.mask_width || parseFloat(leftInfo?.width || 100000);
      const maskHeight = overlayDef.mask_height || parseFloat(leftInfo?.height || 100000);
      
      // Calculate max level based ONLY on the mask's true dimensions
      const maxLevel = Math.ceil(Math.log2(Math.max(maskWidth, maskHeight)));

      viewer.addTiledImage({
        tileSource: {
          width: maskWidth,
          height: maskHeight,
          tileSize: 256,
          minLevel: 0,
          maxLevel: maxLevel,
          getTileUrl: function(level, x, y) {
            return `/api/analysis/jobs/${jobId}/tiles/${fileKey}?level=${level}&x=${x}&y=${y}&token=${token}`;
          }
        },
        opacity: 0.7,
        
        // 2. THE FIX: Tell OSD to anchor and stretch this perfectly over the WSI
        x: 0,
        y: 0,
        width: 1.0,
        
        success: function (event) {
          if (!overlayRefs.current[jobId]) overlayRefs.current[jobId] = []
          overlayRefs.current[jobId].push({ tiledImage: event.item })
        }
      });
      return; 
    }
    if (type === 'image') {
      // Endpoint where your backend serves the image/tiles
      const imageUrl = `/api/analysis/jobs/${jobId}/overlay?file=${fileKey}`;

      viewer.addTiledImage({
        tileSource: {
          type: 'image',
          url: imageUrl
        },
        opacity: 0.65, // Keep it slightly transparent
        x: 0,
        y: 0,
        width: 1, // OSD standardizes the WSI width to exactly 1.0
        success: function (event) {
          // Store the reference so we can delete it later
          if (!overlayRefs.current[jobId]) overlayRefs.current[jobId] = []
          overlayRefs.current[jobId].push({ tiledImage: event.item })
        }
      });
      return; // Exit early, no need to parse JSON!
    }

    // ==========================================
    // 2. VECTOR HANDLING (GeoJSON Polygons & Points)
    // ==========================================
    try {
      const geojson = await api.getAnalysisOverlay(jobId, fileKey)
      const info    = leftInfo
      const slW     = info?.width
      const slH     = info?.height
      
      if (!slW || !slH || !viewer || !geojson?.features?.length) return

      const offsetX = parseFloat(info?.bounds_x || info?.offset_x || 0)
      const offsetY = parseFloat(info?.bounds_y || info?.offset_y || 0)
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

      if (!overlayRefs.current[jobId]) overlayRefs.current[jobId] = []
      overlayRefs.current[jobId].push({ svg, viewer })
      setOverlayData(prev => ({ ...prev, [cacheKey]: geojson }))

    } catch (e) {
      console.error(`Overlay fetch failed for ${fileKey}:`, e)
    }
  }

  function clearOverlay(jobId, viewer) {
    if (overlayRefs.current[jobId]) {
      overlayRefs.current[jobId].forEach(item => {
        if (item.svg) {
          // Remove GeoJSON vector overlay
          viewer.removeOverlay(item.svg)
        } else if (item.tiledImage) {
          // Remove Raster Image layer
          viewer.world.removeItem(item.tiledImage)
        }
      })
      delete overlayRefs.current[jobId]
    }
  }

  async function handleToggleOverlay(jobId) {
    const viewer = osdLeftRef.current
    if (!viewer) return
    const isOn = activeOverlays[jobId]

    if (isOn) {
      clearOverlay(jobId, viewer)
      setActiveOverlays(o => ({ ...o, [jobId]: false }))
    } else {
      try {
        // 1. Fetch the manifest to know WHAT to render
        const result = await api.getAnalysisResult(jobId)
        const overlays = result.overlays || []

        if (overlays.length === 0) {
          console.warn("No overlays manifest found for this job.")
          return
        }

        // 2. Loop through the manifest and render dynamically
        for (const overlay of overlays) {
          // Pass the entire overlay object, not just the fileKey and legend
          await fetchAndRenderOverlay(jobId, overlay, viewer) 
        }
        
        setActiveOverlays(o => ({ ...o, [jobId]: true }))
      } catch (e) {
        console.error("Failed to toggle overlay:", e)
      }
    }
  }

  // ── Derived ────────────────────────────────────────────────────────────────
  const displayInfo = (panelSide === 'right' && rightInfo) ? rightInfo : leftInfo
  const filterStr = `brightness(${brightness}%) contrast(${contrast}%) url(#sv-gamma)`

  // ─────────────────────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div style={{ width: '100vw', height: '100vh', background: '#111827', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

      {/* ── Topbar ──────────────────────────────────────────────────────── */}
      <div style={{ height: 48, flexShrink: 0, background: 'rgba(3,8,25,0.97)', borderBottom: '1px solid rgba(255,255,255,0.07)', display: 'flex', alignItems: 'center', gap: 10, padding: '0 14px' }}>

        {/* Back + logo */}
        <button onClick={handleBack} title="Back" className="sv-tool-btn" style={{ gap: 6, paddingLeft: 8 }}>
          <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M15 8a.5.5 0 00-.5-.5H2.707l3.147-3.146a.5.5 0 10-.708-.708l-4 4a.5.5 0 000 .708l4 4a.5.5 0 00.708-.708L2.707 8.5H14.5A.5.5 0 0015 8z"/></svg>
        </button>
        <div style={{ width: 1, height: 18, background: 'rgba(255,255,255,0.08)', flexShrink: 0 }} />
        <span style={{ fontFamily: 'serif', fontSize: 13, color: 'rgba(255,255,255,0.4)', letterSpacing: '0.03em', flexShrink: 0 }}>PathoDB</span>
        <div style={{ width: 1, height: 18, background: 'rgba(255,255,255,0.08)', flexShrink: 0 }} />

        {/* Scan info */}
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8, overflow: 'hidden' }}>
          {leftInfo && <>
            <span style={{ fontFamily: 'monospace', fontSize: 12, color: 'rgba(255,255,255,0.4)', flexShrink: 0 }}>{leftInfo.lis_submission_id}</span>
            <StainBadge name={leftInfo.stain_name} category={leftInfo.stain_category} side={compareMode ? 'L' : null} zoom={leftZoom} />
            {compareMode && rightInfo && <StainBadge name={rightInfo.stain_name} category={rightInfo.stain_category} side="R" zoom={rightZoom} />}
            {leftInfo.malignancy_flag && (
              <span style={{ fontSize: 10, fontWeight: 700, color: '#ff8099', background: 'rgba(230,0,46,0.18)', padding: '2px 8px', borderRadius: 20, letterSpacing: '0.06em', textTransform: 'uppercase', flexShrink: 0 }}>
                Malignant
              </span>
            )}
          </>}
        </div>

        {/* Tools */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0 }}>

          <button className={`sv-tool-btn${isRulerActive ? ' active' : ''}`} onClick={() => setIsRulerActive(o => !o)} title="Ruler (R)">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M.5 1a.5.5 0 00-.5.5v13a.5.5 0 00.5.5H2a.5.5 0 00.5-.5V13H3a.5.5 0 000-1h-.5v-1H4a.5.5 0 000-1H2.5V9H3a.5.5 0 000-1h-.5V7H4a.5.5 0 000-1H2.5V5H3a.5.5 0 000-1h-.5v-1H4a.5.5 0 000-1H2.5V1.5A.5.5 0 002 1H.5zm7 0a.5.5 0 00-.5.5v13a.5.5 0 00.5.5h7a.5.5 0 00.5-.5v-13A.5.5 0 0015.5 1h-7z"/></svg>
            <span>Ruler</span>
          </button>

          <div style={{ position: 'relative' }}>
            <button className={`sv-tool-btn${showBrightness ? ' active' : ''}`} onClick={() => setShowBrightness(o => !o)} title="Brightness / contrast (B)">
              <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M8 11a3 3 0 110-6 3 3 0 010 6zm0 1a4 4 0 100-8 4 4 0 000 8zM8 0a.5.5 0 01.5.5v2a.5.5 0 01-1 0v-2A.5.5 0 018 0zm0 13a.5.5 0 01.5.5v2a.5.5 0 01-1 0v-2A.5.5 0 018 13zm8-5a.5.5 0 01-.5.5h-2a.5.5 0 010-1h2a.5.5 0 01.5.5zM3 8a.5.5 0 01-.5.5h-2a.5.5 0 010-1h2A.5.5 0 013 8zm10.657-5.657a.5.5 0 010 .707l-1.414 1.415a.5.5 0 11-.707-.708l1.414-1.414a.5.5 0 01.707 0zm-9.193 9.193a.5.5 0 010 .707L3.05 13.657a.5.5 0 01-.707-.707l1.414-1.414a.5.5 0 01.707 0zm9.193 2.121a.5.5 0 01-.707 0l-1.414-1.414a.5.5 0 00.707-.707l1.414 1.414a.5.5 0 010 .707zM4.464 4.465a.5.5 0 01-.707 0L2.343 3.05a.5.5 0 11.707-.707l1.414 1.414a.5.5 0 010 .708z"/></svg>
              <span>Adjust</span>
            </button>
            {showBrightness && (
              <BrightnessPanel
                brightness={brightness} contrast={contrast} gamma={gamma}
                onBrightness={setBrightness} onContrast={setContrast} onGamma={setGamma}
                onReset={() => { setBrightness(100); setContrast(100); setGamma(1.0) }}
              />
            )}
          </div>


          <div style={{ width: 1, height: 18, background: 'rgba(255,255,255,0.08)' }} />

          <button className={`sv-tool-btn${compareMode ? ' active' : ''}`} onClick={handleCompareToggle} title="Compare two slides side by side">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M0 3a2 2 0 012-2h5a2 2 0 012 2v10a2 2 0 01-2 2H2a2 2 0 01-2-2V3zm9 0a2 2 0 012-2h3a2 2 0 012 2v10a2 2 0 01-2 2h-3a2 2 0 01-2-2V3z"/></svg>
            <span>{compareMode ? 'Split on' : 'Compare'}</span>
          </button>

          <button className={`sv-tool-btn${showModels ? ' active' : ''}`} onClick={() => setShowModels(o => !o)} title="Analysis models (M)">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M2 2a2 2 0 012-2h8a2 2 0 012 2v12a2 2 0 01-2 2H4a2 2 0 01-2-2V2zm2 0v12h8V2H4zm1 2h2a.5.5 0 010 1H5a.5.5 0 010-1zm0 2h6a.5.5 0 010 1H5a.5.5 0 010-1zm0 2h6a.5.5 0 010 1H5a.5.5 0 010-1zm0 2h4a.5.5 0 010 1H5a.5.5 0 010-1z"/></svg>
            <span>Models</span>
          </button>

          <div style={{ width: 1, height: 18, background: 'rgba(255,255,255,0.08)' }} />

          <button className={`sv-tool-btn${panelOpen ? ' active' : ''}`} onClick={() => setPanelOpen(o => !o)} title="Clinical info panel (I)">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M8 15A7 7 0 108 1a7 7 0 000 14zm0 1A8 8 0 118 0a8 8 0 010 16z"/><path d="M5.255 5.786a.237.237 0 00.241.247h.825c.138 0 .248-.113.266-.25.09-.656.54-1.134 1.342-1.134.686 0 1.314.343 1.314 1.168 0 .635-.374.927-.965 1.371-.673.489-1.206 1.06-1.168 1.987l.003.217a.25.25 0 00.25.246h.811a.25.25 0 00.25-.25v-.105c0-.718.273-.927 1.01-1.486.609-.463 1.244-.977 1.244-2.056 0-1.511-1.276-2.241-2.673-2.241-1.267 0-2.655.59-2.75 2.286zm1.557 5.763c0 .533.425.927 1.01.927.609 0 1.028-.394 1.028-.927 0-.552-.42-.94-1.029-.94-.584 0-1.009.388-1.009.94z"/></svg>
            <span>Info</span>
          </button>

          <button className={`sv-tool-btn${showShortcuts ? ' active' : ''}`} onClick={() => setShowShortcuts(o => !o)} title="Keyboard shortcuts (?)">
            <span style={{ fontWeight: 700 }}>?</span>
          </button>
        </div>
      </div>

      {/* ── Main area ────────────────────────────────────────────────────── */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden', minHeight: 0 }}>

        {/* Viewers + filmstrip */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>

          {/* Canvas row */}
          <div style={{ flex: 1, display: 'flex', position: 'relative', minHeight: 0 }}>

            {/* LEFT VIEWER */}
            <div
              style={{ flex: 1, position: 'relative', overflow: 'hidden', borderRight: compareMode ? '1px solid rgba(255,255,255,0.12)' : 'none' }}
              onDragOver={e => e.preventDefault()} onDrop={e => handleDrop(e, 'left')}
            >
              {loading && (
                <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, color: 'rgba(255,255,255,0.45)', fontSize: 13, zIndex: 2 }}>
                  <Spinner /> Loading…
                </div>
              )}
              {error && (
                <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2, color: '#ff8099', padding: 20, fontSize: 13, textAlign: 'center' }}>{error}</div>
              )}
              <div style={{ width: '100%', height: '100%', filter: filterStr }}>
                <div ref={leftViewerRef} style={{ width: '100%', height: '100%' }} />
              </div>
              {isDragging && (
                <div style={{ position: 'absolute', inset: 8, border: '2px dashed #1b998b', background: 'rgba(27,153,139,0.07)', borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#1b998b', fontWeight: 600, fontSize: 13, pointerEvents: 'none', zIndex: 50 }}>
                  Replace left scan
                </div>
              )}
            </div>

            {/* SYNC BUTTON */}
            {compareMode && rightScanId && (
              <button onClick={() => setIsSynced(o => !o)} style={{ position: 'absolute', left: '50%', top: 14, transform: 'translateX(-50%)', zIndex: 60, background: isSynced ? '#1b998b' : 'rgba(3,8,25,0.9)', border: `1px solid ${isSynced ? '#1b998b' : 'rgba(255,255,255,0.22)'}`, color: 'white', padding: '5px 14px', borderRadius: 20, cursor: 'pointer', fontSize: 11, fontWeight: 600 }}>
                {isSynced ? 'Viewers linked' : 'Link viewers'}
              </button>
            )}

            {/* RIGHT VIEWER */}
            {compareMode && (
              <div
                style={{ flex: 1, position: 'relative', overflow: 'hidden' }}
                onDragOver={e => e.preventDefault()} onDrop={e => handleDrop(e, 'right')}
              >
                {!rightScanId ? (
                  <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, color: 'rgba(255,255,255,0.50)', fontSize: 13 }}>
                    <svg width="28" height="28" viewBox="0 0 16 16" fill="currentColor" style={{ opacity: 0.3 }}><path d="M4.5 3a2.5 2.5 0 015 0v9a1.5 1.5 0 01-3 0V5a.5.5 0 011 0v7a.5.5 0 001 0V3a1.5 1.5 0 00-3 0v9a2.5 2.5 0 005 0V5a.5.5 0 011 0v7a3.5 3.5 0 11-7 0V3z"/></svg>
                    Drag a scan from the filmstrip to compare
                    {isDragging && <div style={{ position: 'absolute', inset: 8, border: '2px dashed #e69a00', background: 'rgba(230,154,0,0.07)', borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#e69a00', fontWeight: 600, pointerEvents: 'none', zIndex: 50 }}>Drop here</div>}
                  </div>
                ) : (
                  <>
                    <div style={{ width: '100%', height: '100%', filter: filterStr }}>
                      <div ref={rightViewerRef} style={{ width: '100%', height: '100%' }} />
                    </div>
                    {isDragging && <div style={{ position: 'absolute', inset: 8, border: '2px dashed #e69a00', background: 'rgba(230,154,0,0.07)', borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#e69a00', fontWeight: 600, fontSize: 13, pointerEvents: 'none', zIndex: 50 }}>Replace right scan</div>}
                  </>
                )}
                <button onClick={() => { setRightScanId(null); setCompareMode(false); setIsSynced(false) }} style={{ position: 'absolute', top: 12, right: 12, background: 'rgba(0,0,0,0.65)', border: '1px solid rgba(255,255,255,0.15)', color: 'rgba(255,255,255,0.7)', width: 26, height: 26, borderRadius: '50%', cursor: 'pointer', zIndex: 60, fontSize: 13, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>✕</button>
              </div>
            )}

            {/* Filmstrip toggle pill at canvas bottom */}
            <button onClick={() => setFilmstripVisible(o => !o)} style={{ position: 'absolute', bottom: 0, left: '50%', transform: 'translateX(-50%)', background: 'rgba(3,8,25,0.92)', border: '1px solid rgba(255,255,255,0.07)', borderBottom: 'none', borderRadius: '6px 6px 0 0', color: 'rgba(255,255,255,0.4)', padding: '3px 16px', fontSize: 10, cursor: 'pointer', textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 600, zIndex: 10 }}>
              {filmstripVisible ? '▾ Scans' : '▴ Scans'}
            </button>

            {/* Shortcuts overlay */}
            {showShortcuts && <ShortcutsOverlay onClose={() => setShowShortcuts(false)} />}
          </div>

          {/* Resize handle */}
          {filmstripVisible && (
            <div
              onMouseDown={e => { e.preventDefault(); resizingRef.current = true; resizeStartY.current = e.clientY; resizeStartH.current = filmstripHeight }}
              style={{ height: 6, background: 'rgba(255,255,255,0.02)', cursor: 'row-resize', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, borderTop: '1px solid rgba(255,255,255,0.05)' }}
            >
              <div style={{ width: 28, height: 2, background: 'rgba(255,255,255,0.1)', borderRadius: 2 }} />
            </div>
          )}

          {/* Filmstrip */}
          <div style={{ height: filmstripVisible ? filmstripHeight : 0, overflow: 'hidden', flexShrink: 0, background: '#0a0f1e', borderTop: filmstripVisible ? '1px solid rgba(255,255,255,0.05)' : 'none', transition: 'height 0.2s ease' }}>
            <Filmstrip
              scans={relatedScans}
              leftScanId={leftScanId}
              rightScanId={rightScanId}
              token={token}
              navigate={navigate}
              setIsDragging={setIsDragging}
              scrollRef={filmstripScrollRef}
              activeChipRef={activeChipRef}
              levelPopover={levelPopover}
              setLevelPopover={setLevelPopover}
              submissionId={leftInfo?.lis_submission_id}
            />
          </div>
        </div>

        {/* Models panel */}
        {showModels && (
          <ModelsPanel
            catalog={catalog}
            scanId={leftScanId}
            scanInfo={leftInfo}
            jobs={analysisJobs}
            activeOverlays={activeOverlays}
            setActiveOverlays={setActiveOverlays}
            onToggleOverlay={handleToggleOverlay}
            onJobsChange={setAnalysisJobs}
          />
        )}

        {/* Clinical info panel */}
        {panelOpen && displayInfo && (
          <ClinicalPanel
            displayInfo={displayInfo}
            compareMode={compareMode}
            hasRight={!!rightInfo}
            panelSide={panelSide}
            setPanelSide={setPanelSide}
            reportOpen={reportOpen}
            setReportOpen={setReportOpen}
          />
        )}
      </div>
    </div>
  )
}


// ─────────────────────────────────────────────────────────────────────────────
// TOPBAR SUB-COMPONENTS
// ─────────────────────────────────────────────────────────────────────────────
function StainBadge({ name, category, side, zoom }) {
  const color = STAIN_COLORS[category] || STAIN_COLORS.other
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0 }}>
      <div style={{ width: 6, height: 6, borderRadius: '50%', background: color, flexShrink: 0 }} />
      <span style={{ fontFamily: 'monospace', fontSize: 12, fontWeight: 600, color }}>
        {name}{side ? ` (${side})` : ''}
      </span>
      {zoom && <span style={{ fontFamily: 'monospace', fontSize: 10, color: 'rgba(255,255,255,0.3)', background: 'rgba(255,255,255,0.05)', padding: '1px 5px', borderRadius: 3 }}>{zoom}×</span>}
    </div>
  )
}

function BrightnessPanel({ brightness, contrast, gamma, onBrightness, onContrast, onGamma, onReset }) {
  return (
    <div style={{ position: 'absolute', top: 'calc(100% + 6px)', right: 0, zIndex: 300, background: 'rgba(3,8,25,0.98)', border: '1px solid rgba(255,255,255,0.14)', borderRadius: 8, padding: '12px 14px', width: 210 }}>
      <SliderRow label="Brightness" value={brightness} min={50}  max={200} step={1}   onChange={onBrightness} unit="%" />
      <SliderRow label="Contrast"   value={contrast}   min={50}  max={200} step={1}   onChange={onContrast}   unit="%" />
      <SliderRow label="Gamma"      value={gamma}      min={0.2} max={3.0} step={0.05} onChange={onGamma}     unit="" format={v => v.toFixed(2)} />
      <button onClick={onReset} style={{ marginTop: 6, width: '100%', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 4, color: 'rgba(255,255,255,0.45)', fontSize: 11, padding: '4px 0', cursor: 'pointer' }}>Reset</button>
    </div>
  )
}

function SliderRow({ label, value, min, max, step = 1, onChange, unit, format }) {
  const display = format ? format(value) : value
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
        <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.45)' }}>{label}</span>
        <span style={{ fontSize: 11, fontFamily: 'monospace', color: 'rgba(255,255,255,0.65)' }}>{display}{unit}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(parseFloat(e.target.value))}
        style={{ width: '100%', accentColor: '#1b998b', cursor: 'pointer' }} />
    </div>
  )
}

function ShortcutsOverlay({ onClose }) {
  const rows = [['R', 'Toggle ruler'], ['B', 'Brightness / contrast'], ['M', 'Analysis models panel'], ['I', 'Clinical info panel'], ['Space', 'Reset view (home)'], ['Esc', 'Close active tool / split'], ['?', 'This help']]
  return (
    <div onClick={onClose} style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200 }}>
      <div onClick={e => e.stopPropagation()} style={{ background: 'rgba(3,8,25,0.98)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 10, padding: '18px 22px', minWidth: 230 }}>
        <div style={{ fontSize: 10, fontWeight: 600, color: 'rgba(255,255,255,0.55)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 14 }}>Keyboard shortcuts</div>
        {rows.map(([key, desc]) => (
          <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 9 }}>
            <kbd style={{ fontSize: 11, fontFamily: 'monospace', background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.14)', borderRadius: 4, padding: '2px 8px', color: 'rgba(255,255,255,0.75)', minWidth: 52, textAlign: 'center' }}>{key}</kbd>
            <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.55)' }}>{desc}</span>
          </div>
        ))}
        <button onClick={onClose} style={{ marginTop: 6, width: '100%', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.09)', borderRadius: 4, color: 'rgba(255,255,255,0.4)', fontSize: 11, padding: '5px 0', cursor: 'pointer' }}>Close</button>
      </div>
    </div>
  )
}


// ─────────────────────────────────────────────────────────────────────────────
// CLINICAL PANEL
// ─────────────────────────────────────────────────────────────────────────────
function ClinicalPanel({ displayInfo, compareMode, hasRight, panelSide, setPanelSide, reportOpen, setReportOpen }) {
  const hasMacro = !!displayInfo.report_macro
  const hasMicro = !!displayInfo.report_microscopy
  return (
    <div style={{ width: 296, flexShrink: 0, background: 'rgba(2,5,18,0.98)', borderLeft: '1px solid rgba(255,255,255,0.07)', overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: '9px 14px', borderBottom: '1px solid rgba(255,255,255,0.05)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
        <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.50)', textTransform: 'uppercase', letterSpacing: '0.1em', fontWeight: 600 }}>Clinical information</span>
        {compareMode && hasRight && (
          <div style={{ display: 'flex', gap: 4 }}>
            {['left', 'right'].map(side => (
              <button key={side} onClick={() => setPanelSide(side)} style={{ padding: '2px 8px', fontSize: 10, fontWeight: 600, background: panelSide === side ? 'rgba(27,153,139,0.2)' : 'rgba(255,255,255,0.04)', border: `1px solid ${panelSide === side ? '#1b998b' : 'rgba(255,255,255,0.1)'}`, borderRadius: 4, color: panelSide === side ? '#6ee7b7' : 'rgba(255,255,255,0.35)', cursor: 'pointer' }}>
                {side === 'left' ? 'L' : 'R'}
              </button>
            ))}
          </div>
        )}
      </div>

      <PanelSection label="Patient">
        <PanelRow label="Code" value={displayInfo.patient_code} mono />
        <PanelRow label="DOB"  value={displayInfo.date_of_birth} />
        <PanelRow label="Sex"  value={displayInfo.patient_sex} />
      </PanelSection>

      <PanelSection label="Submission">
        <PanelRow label="ID"         value={displayInfo.lis_submission_id} mono />
        <PanelRow label="Report date" value={displayInfo.report_date} />
        <PanelRow label="Malignancy" value={displayInfo.malignancy_flag === true ? 'Yes' : displayInfo.malignancy_flag === false ? 'No' : null} accent={displayInfo.malignancy_flag ? '#ff8099' : null} />
      </PanelSection>

      <PanelSection label="Probe">
        <PanelRow label="ID"         value={displayInfo.lis_probe_id} mono />
        <PanelRow label="Topography" value={displayInfo.topo_description} />
        <PanelRow label="SNOMED"     value={displayInfo.snomed_topo_code} mono />
        <PanelRow label="Type"       value={displayInfo.submission_type} />
        <PanelRow label="Location"   value={displayInfo.location_additional} />
      </PanelSection>

      <PanelSection label="Block">
        <PanelRow label="Label"  value={displayInfo.block_label ? `Block ${displayInfo.block_label}` : null} />
        <PanelRow label="Info"   value={displayInfo.block_info} />
        <PanelRow label="Tissue" value={displayInfo.tissue_count != null ? `×${displayInfo.tissue_count}` : null} />
      </PanelSection>

      <PanelSection label="Scan">
        <PanelRow label="Stain"    value={displayInfo.stain_name} />
        <PanelRow label="Category" value={displayInfo.stain_category} />
        <PanelRow label="Format"   value={displayInfo.file_format} />
        <PanelRow label="Power"    value={displayInfo.objective_power ? `${displayInfo.objective_power}×` : null} />
        <PanelRow label="MPP"      value={displayInfo.mpp_x ? `${parseFloat(displayInfo.mpp_x).toFixed(4)} µm/px` : null} />
        <PanelRow label="Vendor"   value={displayInfo.vendor} />
        <PanelRow label="Size"     value={(displayInfo.width && displayInfo.height) ? `${displayInfo.width.toLocaleString()} × ${displayInfo.height.toLocaleString()} px` : null} />
      </PanelSection>

      {(hasMacro || hasMicro) && (
        <div style={{ borderTop: '1px solid rgba(255,255,255,0.05)' }}>
          <button onClick={() => setReportOpen(o => !o)} style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', background: 'none', border: 'none', cursor: 'pointer', color: 'rgba(255,255,255,0.55)', fontFamily: 'sans-serif' }}>
            <span style={{ fontSize: 9, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.1em' }}>
              Reports {hasMacro && hasMicro ? '(macro + micro)' : hasMacro ? '(macro)' : '(micro)'}
            </span>
            <span style={{ fontSize: 12 }}>{reportOpen ? '▾' : '▸'}</span>
          </button>
          {reportOpen && (
            <div style={{ padding: '0 14px 14px', display: 'flex', flexDirection: 'column', gap: 10 }}>
              {hasMacro && <ReportBlock label="Macroscopy" text={displayInfo.report_macro} />}
              {hasMicro && <ReportBlock label="Microscopy" text={displayInfo.report_microscopy} />}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function PanelSection({ label, children }) {
  return (
    <div style={{ padding: '9px 14px', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
      <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.45)', textTransform: 'uppercase', letterSpacing: '0.1em', fontWeight: 600, marginBottom: 6 }}>{label}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>{children}</div>
    </div>
  )
}

function PanelRow({ label, value, mono, accent }) {
  if (value === null || value === undefined || value === '') return null
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
      <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.50)', minWidth: 72, flexShrink: 0 }}>{label}</span>
      <span style={{ fontSize: 12, color: accent || 'rgba(255,255,255,0.72)', fontFamily: mono ? 'monospace' : 'sans-serif', wordBreak: 'break-word', lineHeight: 1.4 }}>{value}</span>
    </div>
  )
}

function ReportBlock({ label, text }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.50)', textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: 11.5, color: text ? 'rgba(255,255,255,0.62)' : 'rgba(255,255,255,0.18)', lineHeight: 1.65, whiteSpace: 'pre-wrap', background: 'rgba(255,255,255,0.03)', borderRadius: 5, padding: '7px 9px', fontStyle: text ? 'normal' : 'italic' }}>
        {text || 'Not available'}
      </div>
    </div>
  )
}


// ─────────────────────────────────────────────────────────────────────────────
// FILMSTRIP — flat probe → block → stain chip layout
// ─────────────────────────────────────────────────────────────────────────────
function Filmstrip({ scans, leftScanId, rightScanId, token, navigate, setIsDragging, scrollRef, activeChipRef, levelPopover, setLevelPopover, submissionId }) {

  const groupedData = useMemo(() => {
    const probeMap = {}
    scans.forEach(scan => {
      if (!probeMap[scan.probe_id]) {
        probeMap[scan.probe_id] = {
          probe_id:        scan.probe_id,
          lis_probe_id:    scan.lis_probe_id || String(scan.probe_id),
          topo_description: scan.topo_description || 'Unknown site',
          blocks: {},
        }
      }
      const probe = probeMap[scan.probe_id]
      if (!probe.blocks[scan.block_id]) {
        probe.blocks[scan.block_id] = { block_id: scan.block_id, block_label: scan.block_label, stains: {} }
      }
      const block = probe.blocks[scan.block_id]
      if (!block.stains[scan.stain_name]) block.stains[scan.stain_name] = []
      block.stains[scan.stain_name].push(scan)
    })

    return Object.values(probeMap)
      .sort((a, b) => a.probe_id - b.probe_id)
      .map(probe => ({
        ...probe,
        blocks: Object.values(probe.blocks)
          .sort((a, b) => a.block_label.localeCompare(b.block_label, undefined, { numeric: true }))
          .map(block => ({
            ...block,
            stainGroups: Object.entries(block.stains)
              .sort(([a], [b]) => {
                // H&E first, then IHC alphabetically, then others
                const catA = block.stains[a][0]?.stain_category || 'other'
                const catB = block.stains[b][0]?.stain_category || 'other'
                if (catA === 'HE' && catB !== 'HE') return -1
                if (catB === 'HE' && catA !== 'HE') return  1
                return a.localeCompare(b)
              })
              .map(([name, scans]) => ({ name, scans })),
          })),
      }))
  }, [scans])

  if (!scans.length) return null

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* Toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', padding: '4px 14px', borderBottom: '1px solid rgba(255,255,255,0.04)', gap: 12, flexShrink: 0 }}>
        <span style={{ fontSize: 9, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.6)', flexShrink: 0 }}>
          {submissionId || 'Case'} · {scans.length} scan{scans.length !== 1 ? 's' : ''}
        </span>
        <div style={{ display: 'flex', gap: 10 }}>
          {[['HE','H&E'], ['IHC','IHC'], ['special_stain','Special'], ['FISH','FISH']].map(([cat, lbl]) =>
            scans.some(s => s.stain_category === cat) ? (
              <div key={cat} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <div style={{ width: 6, height: 6, borderRadius: '50%', background: STAIN_COLORS[cat] }} />
                <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.55)' }}>{lbl}</span>
              </div>
            ) : null
          )}
        </div>
      </div>

      {/* Scrollable scan area */}
      <div ref={scrollRef} style={{ flex: 1, overflowX: 'auto', overflowY: 'clip', display: 'flex', alignItems: 'flex-start', padding: '8px 14px 8px', gap: 0 }}>
        {groupedData.map((probe, pi) => (
          <div key={probe.probe_id} style={{ display: 'flex', alignItems: 'flex-start', flexShrink: 0 }}>
            {pi > 0 && <div style={{ width: 1, alignSelf: 'stretch', background: 'rgba(255,255,255,0.07)', margin: '0 14px' }} />}
            <div style={{ display: 'flex', flexDirection: 'column', flexShrink: 0 }}>
              {/* Probe header */}
              <div style={{ fontSize: 10, fontWeight: 600, color: 'rgba(255,255,255,0.70)', letterSpacing: '0.04em', textTransform: 'uppercase', paddingBottom: 5, maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {probe.lis_probe_id} · {probe.topo_description}
              </div>
              {/* Blocks */}
              <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                {probe.blocks.map((block, bi) => (
                  <div key={block.block_id} style={{ display: 'flex', flexDirection: 'column', flexShrink: 0 }}>
                    {probe.blocks.length > 1 && (
                      <div style={{ fontSize: 9, fontWeight: 600, color: 'rgba(255,255,255,0.55)', textAlign: 'center', paddingBottom: 4 }}>
                        Block {block.block_label}
                      </div>
                    )}
                    <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
                      {block.stainGroups.map(({ name: sName, scans: sScans }) => (
                        <StainChip
                          key={sName}
                          stainName={sName}
                          stainScans={sScans}
                          blockId={block.block_id}
                          leftScanId={leftScanId}
                          rightScanId={rightScanId}
                          token={token}
                          navigate={navigate}
                          setIsDragging={setIsDragging}
                          activeChipRef={activeChipRef}
                          levelPopover={levelPopover}
                          setLevelPopover={setLevelPopover}
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}


// ─────────────────────────────────────────────────────────────────────────────
// STAIN CHIP — one card per stain (+ level popover if >1 scan)
// ─────────────────────────────────────────────────────────────────────────────
function StainChip({ stainName, stainScans, blockId, leftScanId, rightScanId, token, navigate, setIsDragging, activeChipRef, levelPopover, setLevelPopover }) {
  const hasMultiple  = stainScans.length > 1
  const isLeftActive  = stainScans.some(s => s.scan_id === leftScanId)
  const isRightActive = stainScans.some(s => s.scan_id === rightScanId)
  const repScan  = stainScans.find(s => s.scan_id === leftScanId) || stainScans.find(s => s.scan_id === rightScanId) || stainScans[0]
  const color    = STAIN_COLORS[repScan.stain_category] || STAIN_COLORS.other
  const borderColor = isLeftActive ? '#1b998b' : isRightActive ? '#e69a00' : 'rgba(255,255,255,0.09)'
  const bg = isLeftActive ? 'rgba(27,153,139,0.1)' : isRightActive ? 'rgba(230,154,0,0.1)' : 'rgba(255,255,255,0.02)'
  const popoverOpen = levelPopover?.blockId === blockId && levelPopover?.stainName === stainName

  function handleClick() {
    if (hasMultiple) {
      setLevelPopover(popoverOpen ? null : { blockId, stainName })
    } else if (!isLeftActive) {
      navigate(`/viewer/${stainScans[0].scan_id}`)
    }
  }

  return (
    <div style={{ position: 'relative', flexShrink: 0 }}>
      <div
        ref={isLeftActive ? activeChipRef : null}
        className={`sv-scan-chip${isLeftActive ? ' sv-active-l' : isRightActive ? ' sv-active-r' : ''}`}
        draggable
        onDragStart={e => { e.dataTransfer.setData('scanId', String(repScan.scan_id)); setIsDragging(true) }}
        onDragEnd={() => setIsDragging(false)}
        onClick={handleClick}
        title={`${stainName}${hasMultiple ? ` (${stainScans.length} levels)` : ''}`}
        style={{ width: 84, border: `1.5px solid ${borderColor}`, borderRadius: 6, overflow: 'hidden', cursor: isLeftActive && !hasMultiple ? 'default' : 'pointer', background: bg, userSelect: 'none' }}
      >
        {/* Stain category bar */}
        <div style={{ height: 3, background: color }} />
        {/* Thumbnail */}
        <div style={{ height: 70, background: '#0d1623', position: 'relative', overflow: 'hidden' }}>
          <img
            src={`/api/slides/${repScan.scan_id}/thumbnail?width=128&token=${token}`}
            alt={stainName} loading="lazy"
            style={{ width: '100%', height: '100%', objectFit: 'contain' }}
          />
          {hasMultiple && (
            <div style={{ position: 'absolute', top: 3, right: 3, background: 'rgba(0,0,0,0.75)', color: 'white', fontSize: 9, fontWeight: 700, padding: '1px 5px', borderRadius: 3 }}>
              {stainScans.length}
            </div>
          )}
          {isLeftActive  && <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: 2, background: '#1b998b' }} />}
          {isRightActive && !isLeftActive && <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: 2, background: '#e69a00' }} />}
        </div>
        {/* Labels */}
        <div style={{ padding: '3px 6px 5px' }}>
          <div style={{ fontSize: 10, fontWeight: 600, color: 'rgba(255,255,255,0.78)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{stainName}</div>
          <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.55)', marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {repScan.stain_category}{repScan.magnification ? ` · ${repScan.magnification}×` : ''}{hasMultiple ? ` · ${stainScans.length} lvl` : ''}
          </div>
        </div>
      </div>

      {popoverOpen && (
        <LevelPopover
          scans={stainScans}
          stainName={stainName}
          leftScanId={leftScanId}
          rightScanId={rightScanId}
          token={token}
          navigate={navigate}
          setIsDragging={setIsDragging}
          onClose={() => setLevelPopover(null)}
        />
      )}
    </div>
  )
}


// ─────────────────────────────────────────────────────────────────────────────
// LEVEL POPOVER — inline popover for multi-level stains
// ─────────────────────────────────────────────────────────────────────────────
function LevelPopover({ scans, stainName, leftScanId, rightScanId, token, navigate, setIsDragging, onClose }) {
  const ref = useRef(null)
  useEffect(() => {
    function handler(e) { if (ref.current && !ref.current.contains(e.target)) onClose() }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose])

  return (
    <div ref={ref} style={{ position: 'absolute', bottom: 'calc(100% + 6px)', left: 0, zIndex: 200, background: 'rgba(3,8,25,0.98)', border: '1px solid rgba(255,255,255,0.14)', borderRadius: 8, padding: '8px', display: 'flex', gap: 6, alignItems: 'flex-end', boxShadow: '0 8px 24px rgba(0,0,0,0.6)' }}>
      <div style={{ fontSize: 9, fontWeight: 600, color: 'rgba(255,255,255,0.60)', textTransform: 'uppercase', letterSpacing: '0.08em', alignSelf: 'center', marginRight: 4, flexShrink: 0 }}>{stainName}</div>
      {scans.map((scan, i) => {
        const isLeft  = scan.scan_id === leftScanId
        const isRight = scan.scan_id === rightScanId
        return (
          <div
            key={scan.scan_id}
            draggable
            onDragStart={e => { e.dataTransfer.setData('scanId', String(scan.scan_id)); setIsDragging(true) }}
            onDragEnd={() => setIsDragging(false)}
            onClick={() => { if (!isLeft) { navigate(`/viewer/${scan.scan_id}`); onClose() } }}
            style={{ width: 72, cursor: isLeft ? 'default' : 'pointer', border: `1.5px solid ${isLeft ? '#1b998b' : isRight ? '#e69a00' : 'rgba(255,255,255,0.1)'}`, borderRadius: 5, overflow: 'hidden', background: isLeft ? 'rgba(27,153,139,0.1)' : 'rgba(255,255,255,0.02)', flexShrink: 0 }}
          >
            <div style={{ height: 56, background: '#0d1623', position: 'relative' }}>
              <img src={`/api/slides/${scan.scan_id}/thumbnail?width=96&token=${token}`} alt={`Level ${i + 1}`} loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
              {isLeft && <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: 2, background: '#1b998b' }} />}
            </div>
            <div style={{ padding: '3px 5px 4px', fontSize: 9, color: 'rgba(255,255,255,0.55)', textAlign: 'center' }}>Level {i + 1}</div>
          </div>
        )
      })}
    </div>
  )
}


// ─────────────────────────────────────────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────────────────────────────────────────
function Spinner() {
  return <div style={{ width: 26, height: 26, borderRadius: '50%', border: '2px solid rgba(255,255,255,0.08)', borderTopColor: '#1b998b', animation: 'sv-spin 0.7s linear infinite' }} />
}


// ─────────────────────────────────────────────────────────────────────────────
// MODELS PANEL
// ─────────────────────────────────────────────────────────────────────────────

const CATEGORY_COLORS = {
  Segmentation: '#6ee7b7',
  Detection:    '#a78bfa',
  Scoring:      '#fbbf24',
  other:        '#94a3b8',
}

function ModelsPanel({ catalog, scanId, scanInfo, jobs, activeOverlays, setActiveOverlays, onJobsChange, onToggleOverlay }) {
  const [expandedId,  setExpandedId]  = useState(null)
  const [categoryTab, setCategoryTab] = useState('All')
  const [submitting,  setSubmitting]  = useState(false)
  const [submitError, setSubmitError] = useState('')

  // Per-model scope + param state, keyed by model id
  const [modelScope,  setModelScope]  = useState({})
  const [modelParams, setModelParams] = useState({})

  const categories = ['All', ...Array.from(new Set(catalog.map(m => m.category)))]

  const visible = categoryTab === 'All'
    ? catalog
    : catalog.filter(m => m.category === categoryTab)

  function scopeFor(id)  { return modelScope[id]  || 'whole_slide' }
  function paramsFor(id) { return modelParams[id]  || {} }

  function setScope(id, val)       { setModelScope(s  => ({ ...s, [id]: val })) }
  function setParam(id, key, val)  { setModelParams(p => ({ ...p, [id]: { ...paramsFor(id), [key]: val } })) }

  function jobsForModel(modelId) {
    return jobs.filter(j => j.model_id === modelId)
               .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
  }

  function latestJob(modelId) { return jobsForModel(modelId)[0] || null }

  async function handleRun(model) {
    if (!scanId) return
    setSubmitting(true)
    setSubmitError('')
    try {
      // Build params from current UI state (fall back to model defaults)
      const params = {}
      ;(model.params || []).forEach(p => {
        params[p.key] = paramsFor(model.id)[p.key] ?? p.default
      })
      const job = await api.submitAnalysis(scanId, {
        model_id: model.id,
        scope:    scopeFor(model.id),
        params,
      })
      onJobsChange(prev => [job, ...prev])
    } catch (e) {
      setSubmitError(e.message || 'Submission failed')
    } finally {
      setSubmitting(false)
    }
  }

  async function handleCancel(job) {
    try {
      await api.cancelAnalysis(job.id)
      onJobsChange(prev => prev.map(j => j.id === job.id ? { ...j, status: 'cancelled' } : j))
    } catch (_) {}
  }

  async function handleDelete(job) {
    if (!window.confirm('Are you sure you want to permanently delete this run and all its files?')) return
    try {
      // If the overlay is currently active, toggle it off to remove the SVG from the screen
      if (activeOverlays[job.id]) {
        onToggleOverlay(job.id, job.model_id)
      }
      
      await api.deleteAnalysis(job.id) // Make sure this exists in your api.js
      
      // Remove the job from the local state
      onJobsChange(prev => prev.filter(j => j.id !== job.id))
    } catch (e) {
      alert(`Failed to delete job: ${e.message}`)
    }
  }

  // Active overlays = done jobs with overlay toggled on
  const overlayJobs = jobs.filter(j => j.status === 'done' && activeOverlays[j.id])
  const runningCount = jobs.filter(j => j.status === 'queued' || j.status === 'running').length

  return (
    <div style={{ width: 296, flexShrink: 0, background: 'rgba(2,5,18,0.98)', borderLeft: '1px solid rgba(255,255,255,0.07)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

      {/* Header */}
      <div style={{ padding: '9px 12px', borderBottom: '1px solid rgba(255,255,255,0.05)', display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.50)', textTransform: 'uppercase', letterSpacing: '0.1em', fontWeight: 600, flex: 1 }}>Analysis models</span>
        {runningCount > 0 && (
          <span style={{ fontSize: 9, color: '#fbbf24', background: 'rgba(251,191,36,0.12)', padding: '2px 7px', borderRadius: 3, fontWeight: 600 }}>
            {runningCount} running
          </span>
        )}
        <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.25)' }}>gpu-invest</span>
      </div>

      {/* Category tabs */}
      <div style={{ display: 'flex', gap: 4, padding: '6px 10px', flexShrink: 0, overflowX: 'auto' }}>
        {categories.map(cat => (
          <button
            key={cat}
            onClick={() => setCategoryTab(cat)}
            style={{ fontSize: 10, padding: '3px 9px', borderRadius: 20, cursor: 'pointer', whiteSpace: 'nowrap', background: categoryTab === cat ? 'rgba(27,153,139,0.18)' : 'rgba(255,255,255,0.04)', border: `1px solid ${categoryTab === cat ? 'rgba(27,153,139,0.4)' : 'rgba(255,255,255,0.08)'}`, color: categoryTab === cat ? '#6ee7b7' : 'rgba(255,255,255,0.40)' }}
          >
            {cat}
          </button>
        ))}
      </div>

      {/* Model list */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '0 8px' }}>
        {submitError && (
          <div style={{ margin: '4px 2px 6px', padding: '6px 8px', background: 'rgba(230,0,46,0.12)', border: '1px solid rgba(230,0,46,0.25)', borderRadius: 5, fontSize: 10, color: '#ff8099' }}>
            {submitError}
          </div>
        )}

        {visible.map(model => {
          const latest  = latestJob(model.id)
          const isOpen  = expandedId === model.id
          const catColor = CATEGORY_COLORS[model.category] || CATEGORY_COLORS.other

          return (
            <div key={model.id} style={{ border: `1px solid ${isOpen ? 'rgba(27,153,139,0.35)' : 'rgba(255,255,255,0.07)'}`, borderRadius: 7, marginBottom: 6, overflow: 'hidden', transition: 'border-color 0.15s' }}>

              {/* Card header */}
              <div
                onClick={() => setExpandedId(isOpen ? null : model.id)}
                style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', cursor: 'pointer' }}
              >
                <div style={{ width: 6, height: 6, borderRadius: '50%', background: catColor, flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, fontWeight: 500, color: 'rgba(255,255,255,0.82)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{model.name}</div>
                  <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.40)', marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{model.description}</div>
                </div>
                <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexShrink: 0 }}>
                  <StatusBadge job={latest} />
                  <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.30)', background: 'rgba(255,255,255,0.05)', padding: '2px 5px', borderRadius: 3 }}>~{model.estimated_minutes}m</span>
                  <svg width="10" height="10" viewBox="0 0 16 16" fill="rgba(255,255,255,0.3)" style={{ transform: isOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}><path d="M7.646 4.646a.5.5 0 01.708 0l6 6a.5.5 0 01-.708.708L8 5.707l-5.646 5.647a.5.5 0 01-.708-.708l6-6z"/></svg>
                </div>
              </div>

              {/* Expanded content */}
              {isOpen && (
                <div style={{ borderTop: '1px solid rgba(255,255,255,0.05)', padding: '10px 10px 12px' }}>
                  <p style={{ fontSize: 11, color: 'rgba(255,255,255,0.55)', lineHeight: 1.55, margin: '0 0 10px' }}>{model.description}</p>

                  {/* Stain compatibility */}
                  <div style={{ display: 'flex', gap: 4, marginBottom: 10 }}>
                    {(model.stain_compatibility || []).map(s => (
                      <span key={s} style={{ fontSize: 9, padding: '2px 6px', borderRadius: 3, background: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.50)', border: '1px solid rgba(255,255,255,0.1)' }}>{s}</span>
                    ))}
                  </div>

                  {/* Parameters */}
                  {(model.params || []).map(param => (
                    <ParamRow key={param.key} param={param} value={paramsFor(model.id)[param.key] ?? param.default} onChange={val => setParam(model.id, param.key, val)} />
                  ))}

                  {/* Scope selector */}
                  <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.45)', margin: '8px 0 5px' }}>Analysis scope</div>
                  <div style={{ display: 'flex', gap: 5, marginBottom: 10 }}>
                    {[['whole_slide', 'Whole slide'], ['visible_region', 'Visible region']].map(([val, lbl]) => (
                      <button key={val} onClick={() => setScope(model.id, val)}
                        style={{ flex: 1, fontSize: 10, padding: '4px 0', borderRadius: 4, cursor: 'pointer', border: `1px solid ${scopeFor(model.id) === val ? 'rgba(27,153,139,0.4)' : 'rgba(255,255,255,0.1)'}`, background: scopeFor(model.id) === val ? 'rgba(27,153,139,0.15)' : 'transparent', color: scopeFor(model.id) === val ? '#6ee7b7' : 'rgba(255,255,255,0.40)' }}>
                        {lbl}
                      </button>
                    ))}
                  </div>

                  {/* Run button or job state */}
                  <ModelRunArea
                    latest={latest}
                    model={model}
                    submitting={submitting}
                    scanInfo={scanInfo}
                    onRun={() => handleRun(model)}
                    onCancel={() => handleCancel(latest)}
                  />

                  {/* Past jobs for this model */}
                  <PastJobsList
                    jobs={jobsForModel(model.id)}
                    catalog={catalog}
                    activeOverlays={activeOverlays}
                    onToggleOverlay={onToggleOverlay}
                    onDeleteJob={handleDelete}
                  />
                </div>
              )}
            </div>
          )
        })}

        {visible.length === 0 && (
          <div style={{ textAlign: 'center', padding: '24px 0', fontSize: 12, color: 'rgba(255,255,255,0.25)' }}>No models in this category</div>
        )}
      </div>

      {/* Active overlays section */}
      {overlayJobs.length > 0 && (
        <div style={{ borderTop: '1px solid rgba(255,255,255,0.05)', padding: '8px 10px', flexShrink: 0 }}>
          <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.35)', textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 600, marginBottom: 6 }}>Active overlays</div>
          {overlayJobs.map(job => (
            <div key={job.id} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#1b998b', flexShrink: 0 }} />
              <span style={{ flex: 1, fontSize: 11, color: 'rgba(255,255,255,0.65)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {catalog.find(m => m.id === job.model_id)?.name || job.model_id}
              </span>
              <button onClick={() => onToggleOverlay(job.id)}
                style={{ fontSize: 10, padding: '2px 8px', borderRadius: 3, background: 'rgba(230,0,46,0.1)', border: '1px solid rgba(230,0,46,0.2)', color: '#ff8099', cursor: 'pointer' }}>
                Hide
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Status badge ──────────────────────────────────────────────────────────────
function StatusBadge({ job }) {
  if (!job) return null
  const map = {
    queued:    { label: 'Queued',    bg: 'rgba(148,163,184,0.15)', color: '#94a3b8' },
    running:   { label: 'Running',   bg: 'rgba(251,191,36,0.15)',  color: '#fbbf24' },
    done:      { label: 'Done',      bg: 'rgba(27,153,139,0.18)',  color: '#6ee7b7' },
    failed:    { label: 'Failed',    bg: 'rgba(230,0,46,0.15)',    color: '#ff8099' },
    cancelled: { label: 'Cancelled', bg: 'rgba(148,163,184,0.12)', color: '#64748b' },
  }
  const s = map[job.status] || map.queued
  return (
    <span style={{ fontSize: 9, padding: '2px 6px', borderRadius: 3, fontWeight: 500, background: s.bg, color: s.color }}>
      {s.label}
    </span>
  )
}

// ── Parameter row ─────────────────────────────────────────────────────────────
function ParamRow({ param, value, onChange }) {
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
        <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.45)' }}>{param.label}</span>
        <span style={{ fontSize: 10, fontFamily: 'monospace', color: 'rgba(255,255,255,0.65)' }}>
          {param.type === 'float' ? parseFloat(value).toFixed(2) : value}
        </span>
      </div>
      {param.options ? (
        <div style={{ display: 'flex', gap: 4 }}>
          {param.options.map(opt => (
            <button key={opt} onClick={() => onChange(opt)}
              style={{ flex: 1, fontSize: 10, padding: '3px 0', borderRadius: 3, cursor: 'pointer', border: `1px solid ${value === opt ? 'rgba(27,153,139,0.4)' : 'rgba(255,255,255,0.1)'}`, background: value === opt ? 'rgba(27,153,139,0.15)' : 'transparent', color: value === opt ? '#6ee7b7' : 'rgba(255,255,255,0.40)' }}>
              {opt}
            </button>
          ))}
        </div>
      ) : (
        <input type="range" min={param.min} max={param.max} step={param.step || 1} value={value}
          onChange={e => onChange(param.type === 'float' ? parseFloat(e.target.value) : parseInt(e.target.value))}
          style={{ width: '100%', accentColor: '#1b998b', cursor: 'pointer' }} />
      )}
    </div>
  )
}

// ── Run area (run button / progress / done state) ─────────────────────────────
function ModelRunArea({ latest, model, submitting, scanInfo, onRun, onCancel }) {
  const stainOk = !model.stain_compatibility?.length ||
    model.stain_compatibility.includes(scanInfo?.stain_category)

  // Running or queued
  if (latest && (latest.status === 'queued' || latest.status === 'running')) {
    return (
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'rgba(255,255,255,0.50)', marginBottom: 4 }}>
          <span>SLURM #{latest.slurm_job_id || '—'}</span>
          <ElapsedTimer since={latest.created_at} />
        </div>
        <div style={{ height: 2, background: 'rgba(255,255,255,0.06)', borderRadius: 1, marginBottom: 5, overflow: 'hidden' }}>
          <div style={{ height: '100%', background: '#1b998b', borderRadius: 1, width: `${latest.progress || 0}%`, transition: 'width 0.5s' }} />
        </div>
        <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.35)', marginBottom: 8 }}>
          {latest.status === 'queued' ? 'Waiting in queue…' : `Processing… ${latest.progress || 0}%`}
        </div>
        <button onClick={onCancel}
          style={{ width: '100%', padding: '6px 0', borderRadius: 5, border: '1px solid rgba(255,255,255,0.12)', background: 'rgba(255,255,255,0.04)', color: 'rgba(255,255,255,0.40)', fontSize: 11, cursor: 'pointer' }}>
          Cancel job
        </button>
      </div>
    )
  }

  // Done
  if (latest?.status === 'done') {
    return (
      <div>
        <div style={{ fontSize: 10, color: '#6ee7b7', marginBottom: 8 }}>
          ✓ Analysis complete
        </div>
        <button onClick={onRun} disabled={submitting}
          style={{ width: '100%', padding: '6px 0', borderRadius: 5, border: 'none', background: 'rgba(27,153,139,0.15)', color: '#6ee7b7', fontSize: 11, cursor: 'pointer', marginBottom: 4 }}>
          Run again →
        </button>
      </div>
    )
  }

  // Default: run button
  const incompatible = !stainOk
  return (
    <div>
      {incompatible && (
        <div style={{ fontSize: 10, color: '#fbbf24', marginBottom: 6 }}>
          ⚠ Current stain may not match — expects {model.stain_compatibility?.join(', ')}
        </div>
      )}
      <button onClick={onRun} disabled={submitting}
        style={{ width: '100%', padding: '7px 0', borderRadius: 5, border: 'none', background: submitting ? 'rgba(255,255,255,0.06)' : '#1b998b', color: submitting ? 'rgba(255,255,255,0.30)' : 'white', fontSize: 12, fontWeight: 500, cursor: submitting ? 'default' : 'pointer' }}>
        {submitting ? 'Submitting…' : 'Run on GPU →'}
      </button>
    </div>
  )
}

// ── Past jobs list ────────────────────────────────────────────────────────────
function PastJobsList({ jobs, catalog, activeOverlays, onToggleOverlay, onDeleteJob }) {
  const past = jobs.filter(j => j.status === 'done' || j.status === 'failed' || j.status === 'cancelled')
  if (!past.length) return null

  return (
    <div style={{ marginTop: 10, borderTop: '1px solid rgba(255,255,255,0.05)', paddingTop: 8 }}>
      <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.35)', textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 600, marginBottom: 5 }}>
        Previous runs
      </div>
      
      {past.map(job => {
        // Look up the model from the catalog once per job
        const model = catalog.find(m => m.id === job.model_id)

        return (
          <div key={job.id} style={{ marginBottom: 12 }}>
            
            {/* 1. Header Row: Status, Date, Action Buttons */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
              <StatusBadge job={job} />
              
              <span style={{ flex: 1, fontSize: 10, color: 'rgba(255,255,255,0.40)' }}>
                {new Date(job.created_at).toLocaleDateString()}
              </span>
              
              {/* Action Buttons */}
              <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                
                {/* View/Hide Overlay Button */}
                {job.status === 'done' && (
                  <button 
                    onClick={() => onToggleOverlay(job.id)}
                    style={{ 
                      fontSize: 10, padding: '2px 8px', borderRadius: 3, cursor: 'pointer', 
                      border: `1px solid ${activeOverlays[job.id] ? 'rgba(230,0,46,0.25)' : 'rgba(27,153,139,0.25)'}`, 
                      background: activeOverlays[job.id] ? 'rgba(230,0,46,0.1)' : 'rgba(27,153,139,0.1)', 
                      color: activeOverlays[job.id] ? '#ff8099' : '#6ee7b7' 
                    }}
                  >
                    {activeOverlays[job.id] ? 'Hide' : 'View'}
                  </button>
                )}
                
                {/* Error Info Icon */}
                {job.status === 'failed' && job.error_message && (
                  <span title={job.error_message} style={{ fontSize: 10, color: '#ff8099', cursor: 'help', padding: '0 4px' }}>ⓘ</span>
                )}

                {/* Delete Run & Files Button */}
                <button 
                  onClick={() => onDeleteJob(job)} 
                  title="Delete run and files"
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 22, height: 22, borderRadius: 3, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.4)', cursor: 'pointer', transition: 'all 0.15s' }}
                  onMouseOver={e => { e.currentTarget.style.color = '#ff8099'; e.currentTarget.style.borderColor = 'rgba(230,0,46,0.3)' }}
                  onMouseOut={e => { e.currentTarget.style.color = 'rgba(255,255,255,0.4)'; e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)' }}
                >
                  <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor">
                    <path fillRule="evenodd" d="M5.5 5.5A.5.5 0 016 6v6a.5.5 0 01-1 0V6a.5.5 0 01.5-.5zm2.5 0a.5.5 0 01.5.5v6a.5.5 0 01-1 0V6a.5.5 0 01.5-.5zm3 .5a.5.5 0 00-1 0v6a.5.5 0 001 0V6z"/>
                    <path fillRule="evenodd" d="M14.5 3a1 1 0 01-1 1H13v9a2 2 0 01-2 2H5a2 2 0 01-2-2V4h-.5a1 1 0 01-1-1V2a1 1 0 011-1H6a1 1 0 011-1h2a1 1 0 011 1h3.5a1 1 0 011 1v1zM4.118 4L4 4.059V13a1 1 0 001 1h6a1 1 0 001-1V4.059L11.882 4H4.118zM2.5 3V2h11v1h-11z"/>
                  </svg>
                </button>
              </div>
            </div>

            {/* 2. Dispatcher Row: Displays the model's math/JSON results */}
            {job.status === 'done' && (
              <JobOutcomeDispatcher 
                jobId={job.id} 
                model={model} 
              />
            )}
            
          </div>
        )
      })}
    </div>
  )
}

// ── Elapsed timer ─────────────────────────────────────────────────────────────
function ElapsedTimer({ since }) {
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    const start = new Date(since).getTime()
    const tick = () => setElapsed(Math.floor((Date.now() - start) / 1000))
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [since])
  const m = Math.floor(elapsed / 60)
  const s = elapsed % 60
  return <span>{m}m {String(s).padStart(2, '0')}s</span>
}