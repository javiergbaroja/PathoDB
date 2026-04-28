import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { api } from '../../api'
import JobOutcomeDispatcher from '../../components/AnalysisOutcomes/JobOutcomeDispatcher'
import { useAuth } from '../../context/AuthContext'
import { STAIN_COLORS } from '../../constants/stains'
import { fetchAndRenderOverlay, clearOverlay } from '../../lib/overlayRenderer'
import ClinicalPanel from './ClinicalPanel'
import Filmstrip from './Filmstrip'
import ModelsPanel from './ModelsPanel'

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


  async function handleToggleOverlay(jobId) {
    const viewer = osdLeftRef.current
    if (!viewer) return
    const isOn = activeOverlays[jobId]

    if (isOn) {
      clearOverlay(viewer, jobId) // Calling our new library function
      setActiveOverlays(o => ({ ...o, [jobId]: false }))
    } else {
      try {
        const result = await api.getAnalysisResult(jobId)
        const overlays = result.overlays || []

        if (overlays.length === 0) {
          console.warn("No overlays manifest found for this job.")
          return
        }

        for (const overlay of overlays) {
          // Calling our new library function and passing in token & leftInfo
          await fetchAndRenderOverlay(viewer, jobId, overlay, token, leftInfo) 
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
// UTILITIES
// ─────────────────────────────────────────────────────────────────────────────
function Spinner() {
  return <div style={{ width: 26, height: 26, borderRadius: '50%', border: '2px solid rgba(255,255,255,0.08)', borderTopColor: '#1b998b', animation: 'sv-spin 0.7s linear infinite' }} />
}