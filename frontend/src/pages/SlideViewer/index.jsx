import { useState, useEffect, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { api } from '../../api'
import { fetchAndRenderOverlay, clearOverlay, clearAllOverlays } from '../../lib/overlayRenderer'
import ClinicalPanel  from './ClinicalPanel'
import Filmstrip      from './Filmstrip'
import ModelsPanel    from './ModelsPanel'
import PolygonTool    from './PolygonTool'
import { useViewerStore } from '../../store/viewerStore'
import Toolbar from './Toolbar'
import { useOSDViewer, elementToImage } from '../../hooks/useOSDViewer'
import { estimateSimilarity, applyTransform, invertTransform, rmsResidual } from '../../lib/registrationMath'
import { useGammaFilter } from '../../hooks/useGammaFilter'
import { attachRuler } from '../../lib/rulerTool'
import {
  useModelsCatalog,
  useSlideInfo,
  useRelatedScans,
  useAnalysisJobs,
} from '../../hooks/useSlideData'

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
export default function SlideViewer() {
  const { scanId } = useParams()
  const navigate   = useNavigate()
  const {
    isRulerActive,   setIsRulerActive,
    isPolygonActive, setIsPolygonActive,
    polygons,        setPolygons,
    showBrightness,  setShowBrightness,
    showModels,      setShowModels,
    panelOpen,       setPanelOpen,
    showShortcuts,   setShowShortcuts,
    brightness,      contrast,  gamma,
  } = useViewerStore()

  const token = localStorage.getItem('pathodb_token')

  // ── Scan IDs ───────────────────────────────────────────────────────────────
  const [leftScanId,  setLeftScanId]  = useState(parseInt(scanId))
  const [rightScanId, setRightScanId] = useState(null)
  const [leftZoom,    setLeftZoom]    = useState(null)
  const [rightZoom,   setRightZoom]   = useState(null)

  // ── React Query data ───────────────────────────────────────────────────────
  const { data: catalogResponse } = useModelsCatalog()
  const catalog = catalogResponse?.models || []

  const { data: leftInfo,     isLoading: leftLoading, error: leftError } = useSlideInfo(leftScanId, token)
  const { data: rightInfo }   = useSlideInfo(rightScanId, token)
  const { data: relatedScans = [] }                                       = useRelatedScans(leftScanId, token)
  const { data: analysisJobs, refetch: refetchJobs }                      = useAnalysisJobs(leftScanId)

  const loading = leftLoading
  const error   = leftError?.message || ''

  function handleJobsChange() { refetchJobs() }

  // ── Layout / UI ────────────────────────────────────────────────────────────
  const [compareMode,      setCompareMode]      = useState(false)
  const [isSynced,         setIsSynced]         = useState(false)
  const [isDragging,       setIsDragging]       = useState(false)
  const [panelSide,        setPanelSide]        = useState('left')
  const [reportOpen,       setReportOpen]       = useState(false)
  const [filmstripVisible, setFilmstripVisible] = useState(true)
  const [filmstripHeight,  setFilmstripHeight]  = useState(190)
  const [levelPopover,     setLevelPopover]     = useState(null)
  const [activeOverlays,   setActiveOverlays]   = useState({})

  // ── Registration (slide co-alignment) ───────────────────────────────────────
  const [registration, setRegistration] = useState(null)   // {scale,rotation,tx,ty} moving->fixed
  const [alignMode,     setAlignMode]    = useState(false)
  const [landmarks,     setLandmarks]    = useState([])     // [{fixed:{x,y}, moving:{x,y}}]
  const [pendingMarker, setPendingMarker] = useState(null)  // fixed-side point awaiting a moving click
  const [autoBusy,      setAutoBusy]     = useState(false)
  const [regError,      setRegError]     = useState('')
  const pendingRef       = useRef(null)
  const overlaysLeftRef  = useRef([])
  const overlaysRightRef = useRef([])

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

  // ── Disable OSD mouse nav when polygon tool is active ──────────────────────
  // This prevents pan/zoom clicks from firing while placing vertices.
  useEffect(() => {
    const viewer = osdLeftRef.current
    if (!viewer?.setMouseNavEnabled) return
    viewer.setMouseNavEnabled(!isPolygonActive)
    // Restore on unmount or when tool deactivates
    return () => { viewer.setMouseNavEnabled(true) }
  }, [isPolygonActive])

  // ── Gamma SVG filter ───────────────────────────────────────────────────────
  useGammaFilter(gamma)

  // ── Cleanup OSD overlays on unmount
  useEffect(() => {
    return () => {
      if (osdLeftRef.current)  clearAllOverlays(osdLeftRef.current)
      if (osdRightRef.current) clearAllOverlays(osdRightRef.current)
    }
  }, [])

  // ── OSD viewers (left + optional right for compare mode) ────────────────────
  // Both share the same setup, scalebar, and script-loading via the hook.
  useOSDViewer({
    containerRef: leftViewerRef,
    scanId:       leftScanId,
    slideInfo:    leftInfo,
    token,
    onZoom:       setLeftZoom,
    osdRef:       osdLeftRef,
  })
  useOSDViewer({
    containerRef: rightViewerRef,
    scanId:       rightScanId,
    slideInfo:    rightInfo,
    token,
    onZoom:       setRightZoom,
    osdRef:       osdRightRef,
  })

  // ── Sync engine ────────────────────────────────────────────────────────────
  // Two modes:
  //  • Registered: a similarity transform maps moving(right)<->fixed(left) image
  //    pixels, so pan/zoom/rotation track tissue features.
  //  • Fallback: the original fixed pan-offset + zoom-ratio link (no transform).
  useEffect(() => {
    if (!isSynced || !osdLeftRef.current || !osdRightRef.current) return
    const L = osdLeftRef.current, R = osdRightRef.current
    const OSDPoint = window.OpenSeadragon.Point
    let sl = false, sr = false

    if (registration && leftInfo?.width && rightInfo?.width) {
      const T    = registration                 // moving(right) -> fixed(left)
      const Tinv = invertTransform(T)
      const zoomFactor = T.scale * (rightInfo.width / leftInfo.width)  // zR = zL * factor
      // Orient the moving pane so its tissue matches the fixed pane.
      // ROT_SIGN isolates the OSD/image-axis sign convention — flip to -1 if a
      // verified rotated pair appears mirrored in the browser.
      const ROT_SIGN = 1
      try {
        const baseDeg = L.viewport.getRotation ? L.viewport.getRotation() : 0
        R.viewport.setRotation(baseDeg + ROT_SIGN * T.rotation * 180 / Math.PI)
      } catch (_) {}

      const lh = () => {
        if (sr) return; sl = true
        try {
          const c = L.viewport.viewportToImageCoordinates(L.viewport.getCenter())
          const m = applyTransform(Tinv, c.x, c.y)
          R.viewport.panTo(R.viewport.imageToViewportCoordinates(new OSDPoint(m.x, m.y)), true)
          R.viewport.zoomTo(L.viewport.getZoom() * zoomFactor, null, true)
        } catch (_) {}
        sl = false
      }
      const rh = () => {
        if (sl) return; sr = true
        try {
          const c = R.viewport.viewportToImageCoordinates(R.viewport.getCenter())
          const f = applyTransform(T, c.x, c.y)
          L.viewport.panTo(L.viewport.imageToViewportCoordinates(new OSDPoint(f.x, f.y)), true)
          L.viewport.zoomTo(R.viewport.getZoom() / zoomFactor, null, true)
        } catch (_) {}
        sr = false
      }
      lh()  // snap right to the current left view immediately
      L.addHandler('pan', lh); L.addHandler('zoom', lh)
      R.addHandler('pan', rh); R.addHandler('zoom', rh)
      return () => {
        L.removeHandler('pan', lh); L.removeHandler('zoom', lh)
        R.removeHandler('pan', rh); R.removeHandler('zoom', rh)
        try { R.viewport.setRotation(0) } catch (_) {}
      }
    }

    // Fallback link (no registration)
    const lc = L.viewport.getCenter(), rc = R.viewport.getCenter()
    const panOff = { x: rc.x - lc.x, y: rc.y - lc.y }
    const zRatio = R.viewport.getZoom() / L.viewport.getZoom()
    const lh = () => { if (sr) return; sl = true; const c = L.viewport.getCenter(); R.viewport.panTo(new OSDPoint(c.x + panOff.x, c.y + panOff.y), true); R.viewport.zoomTo(L.viewport.getZoom() * zRatio, null, true); sl = false }
    const rh = () => { if (sl) return; sr = true; const c = R.viewport.getCenter(); L.viewport.panTo(new OSDPoint(c.x - panOff.x, c.y - panOff.y), true); L.viewport.zoomTo(R.viewport.getZoom() / zRatio, null, true); sr = false }
    L.addHandler('pan', lh); L.addHandler('zoom', lh)
    R.addHandler('pan', rh); R.addHandler('zoom', rh)
    return () => { L.removeHandler('pan', lh); L.removeHandler('zoom', lh); R.removeHandler('pan', rh); R.removeHandler('zoom', rh) }
  }, [isSynced, registration, leftInfo?.width, rightInfo?.width])

  // ── Load any saved registration for the current pair ────────────────────────
  useEffect(() => {
    setRegistration(null); setLandmarks([]); setAlignMode(false); setRegError(''); pendingRef.current = null; setPendingMarker(null)
    if (!compareMode || !leftScanId || !rightScanId) return
    let cancelled = false
    api.getRegistration(leftScanId, rightScanId)
      .then(r => { if (!cancelled && r?.found && r.transform) {
        const t = r.transform
        setRegistration({ scale: t.scale, rotation: t.rotation, tx: t.tx, ty: t.ty })
      }})
      .catch(() => {})
    return () => { cancelled = true }
  }, [leftScanId, rightScanId, compareMode])

  // ── Landmark picking: capture clicks on each pane while aligning ─────────────
  useEffect(() => {
    if (!alignMode) return
    const L = osdLeftRef.current, R = osdRightRef.current
    if (!L || !R) return
    const prevL = L.gestureSettingsMouse?.clickToZoom
    const prevR = R.gestureSettingsMouse?.clickToZoom
    if (L.gestureSettingsMouse) L.gestureSettingsMouse.clickToZoom = false
    if (R.gestureSettingsMouse) R.gestureSettingsMouse.clickToZoom = false

    const onLeft = (e) => {
      if (!e.quick) return
      const p = elementToImage(L, e.position.x, e.position.y)
      if (!p) return
      pendingRef.current = p; setPendingMarker(p)   // wait for the matching right click
    }
    const onRight = (e) => {
      if (!e.quick || !pendingRef.current) return
      const p = elementToImage(R, e.position.x, e.position.y)
      if (!p) return
      const fixed = pendingRef.current
      pendingRef.current = null; setPendingMarker(null)
      setLandmarks(prev => [...prev, { fixed, moving: p }])
    }
    L.addHandler('canvas-click', onLeft)
    R.addHandler('canvas-click', onRight)
    return () => {
      L.removeHandler('canvas-click', onLeft); R.removeHandler('canvas-click', onRight)
      if (L.gestureSettingsMouse) L.gestureSettingsMouse.clickToZoom = prevL
      if (R.gestureSettingsMouse) R.gestureSettingsMouse.clickToZoom = prevR
      pendingRef.current = null; setPendingMarker(null)
    }
  }, [alignMode, leftScanId, rightScanId])

  // ── Render landmark markers as OSD overlays (auto-tracked on pan/zoom) ───────
  useEffect(() => {
    const L = osdLeftRef.current, R = osdRightRef.current
    const OSD = window.OpenSeadragon
    const clear = (viewer, store) => {
      if (viewer) store.current.forEach(el => { try { viewer.removeOverlay(el) } catch (_) {} })
      store.current = []
    }
    clear(L, overlaysLeftRef); clear(R, overlaysRightRef)
    if (!alignMode || !OSD) return

    const addMarker = (viewer, store, pt, label, color) => {
      if (!viewer?.viewport || !pt) return
      try {
        const el = document.createElement('div')
        el.textContent = label
        Object.assign(el.style, {
          width: '18px', height: '18px', borderRadius: '50%', background: color,
          color: '#fff', font: '600 11px sans-serif', display: 'flex',
          alignItems: 'center', justifyContent: 'center', border: '2px solid #fff',
          boxShadow: '0 0 4px rgba(0,0,0,0.6)', pointerEvents: 'none',
        })
        viewer.addOverlay({ element: el, location: viewer.viewport.imageToViewportCoordinates(new OSD.Point(pt.x, pt.y)), placement: 'CENTER' })
        store.current.push(el)
      } catch (_) {}
    }
    landmarks.forEach((lm, i) => {
      addMarker(L, overlaysLeftRef,  lm.fixed,  String(i + 1), '#1b998b')
      addMarker(R, overlaysRightRef, lm.moving, String(i + 1), '#1b998b')
    })
    if (pendingMarker) addMarker(L, overlaysLeftRef, pendingMarker, '?', '#e69a00')
  }, [landmarks, pendingMarker, alignMode, leftScanId, rightScanId])

  // ── Ruler tool ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!isRulerActive) return
    const targets = [
      { viewer: osdLeftRef.current,  mpp: parseFloat(leftInfo?.mpp_x) },
      { viewer: osdRightRef.current, mpp: parseFloat(rightInfo?.mpp_x) },
    ].filter(t => t.viewer)
    const cleanups = targets.map(t => attachRuler(t.viewer, t.mpp))
    return () => cleanups.forEach(fn => fn())
  }, [isRulerActive, leftInfo, rightInfo, rightScanId])

  // ── Keyboard shortcuts ─────────────────────────────────────────────────────
  useEffect(() => {
    function handler(e) {
      if (['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return

      if (e.key === 'p' || e.key === 'P') {
        // Polygon tool — mutually exclusive with ruler
        if (isRulerActive) setIsRulerActive(false)
        setIsPolygonActive(o => !o)
        return
      }
      if (e.key === 'i' || e.key === 'I') { setPanelOpen(o => !o);       return }
      if (e.key === 'r' || e.key === 'R') {
        if (isPolygonActive) setIsPolygonActive(false)
        setIsRulerActive(o => !o)
        return
      }
      if (e.key === 'b' || e.key === 'B') { setShowBrightness(o => !o);  return }
      if (e.key === '?')                  { setShowShortcuts(o => !o);    return }
      if (e.key === 'm' || e.key === 'M') { setShowModels(o => !o);       return }
      if (e.key === ' ') {
        e.preventDefault()
        osdLeftRef.current?.viewport?.goHome(true)
        osdRightRef.current?.viewport?.goHome(true)
        return
      }
      if (e.key === 'Escape') {
        if (alignMode)        { setAlignMode(false); pendingRef.current = null; setPendingMarker(null); return }
        if (isPolygonActive)  { setIsPolygonActive(false);  return }
        if (isRulerActive)    { setIsRulerActive(false);     return }
        if (showBrightness)   { setShowBrightness(false);    return }
        if (showShortcuts)    { setShowShortcuts(false);      return }
        if (showModels)       { setShowModels(false);         return }
        if (rightScanId)      { setRightScanId(null); setCompareMode(false); setIsSynced(false) }
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [isPolygonActive, isRulerActive, rightScanId, showBrightness, showShortcuts, showModels, alignMode])

  // ── Auto-scroll filmstrip ──────────────────────────────────────────────────
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
    document.addEventListener('mouseup',  onUp)
    return () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp) }
  }, [])

  // ── Handlers ───────────────────────────────────────────────────────────────
  function handleBack() {
    if (window.history.length > 1) navigate(-1)
    else navigate('/patients')
  }

  function handleDrop(e, side) {
    e.preventDefault(); setIsDragging(false)
    const id = parseInt(e.dataTransfer.getData('scanId'))
    if (!id) return
    if (side === 'left') navigate(`/viewer/${id}`)
    else { setRightScanId(id); setCompareMode(true); setIsSynced(false) }
  }

  function handleCompareToggle() {
    if (compareMode) { setCompareMode(false); setRightScanId(null); setIsSynced(false) }
    else             { setCompareMode(true) }
  }

  // ── Registration handlers ────────────────────────────────────────────────────
  function enterAlignMode() { setRegError(''); setIsSynced(false); setAlignMode(true) }
  function exitAlignMode()  { setAlignMode(false); pendingRef.current = null; setPendingMarker(null) }
  function clearLandmarks() { setLandmarks([]); pendingRef.current = null; setPendingMarker(null); setRegError('') }
  function undoLastLandmark() { setLandmarks(prev => prev.slice(0, -1)); pendingRef.current = null; setPendingMarker(null) }

  function applyLandmarks() {
    try {
      const src = landmarks.map(l => l.moving)   // moving (right)
      const dst = landmarks.map(l => l.fixed)    // fixed (left)
      const T   = estimateSimilarity(src, dst)
      const rms = rmsResidual(T, src, dst)
      setRegistration(T); setAlignMode(false); setIsSynced(true)
      pendingRef.current = null; setPendingMarker(null)
      api.saveRegistration({ fixedScanId: leftScanId, movingScanId: rightScanId,
        scale: T.scale, rotation: T.rotation, tx: T.tx, ty: T.ty, method: 'manual' }).catch(() => {})
      setRegError(rms > 50 ? `Aligned, but the landmark fit is loose (RMS ${Math.round(rms)} px). Add or re-place points for a tighter result.` : '')
    } catch (e) { setRegError(e.message || 'Could not compute alignment') }
  }

  async function handleAutoAlign() {
    setAutoBusy(true); setRegError('')
    try {
      const res = await api.autoRegister(leftScanId, rightScanId)
      if (res?.found && res.transform) {
        const t = res.transform
        const T = { scale: t.scale, rotation: t.rotation, tx: t.tx, ty: t.ty }
        setRegistration(T); setAlignMode(false); setIsSynced(true)
        api.saveRegistration({ fixedScanId: leftScanId, movingScanId: rightScanId,
          scale: T.scale, rotation: T.rotation, tx: T.tx, ty: T.ty, method: 'auto' }).catch(() => {})
      } else { setRegError('Automatic alignment did not return a transform.') }
    } catch (e) { setRegError(e.message || 'Automatic alignment failed (try manual landmarks).') }
    finally { setAutoBusy(false) }
  }

  function removeRegistration() {
    setRegistration(null); clearLandmarks()
    api.deleteRegistration(leftScanId, rightScanId).catch(() => {})
  }

  async function handleToggleOverlay(jobId) {
    const viewer = osdLeftRef.current
    if (!viewer) return
    if (activeOverlays[jobId]) {
      clearOverlay(viewer, jobId)
      setActiveOverlays(o => ({ ...o, [jobId]: false }))
    } else {
      try {
        const result = await api.getAnalysisResult(jobId)

        // For batch results, find overlays for the currently-viewed scan.
        let overlays = result.overlays || []
        if (!overlays.length && result.scans?.length) {
          const scanEntry = result.scans.find(s => s.scan_id === leftScanId)
          overlays = scanEntry?.overlays || []
        }
        if (!overlays.length) return

        for (const overlay of overlays) {
          await fetchAndRenderOverlay(viewer, jobId, overlay, token, leftInfo, leftScanId)
        }
        setActiveOverlays(o => ({ ...o, [jobId]: true }))
      } catch (e) { console.error('Failed to toggle overlay:', e) }
    }
  }

  // ── Derived ────────────────────────────────────────────────────────────────
  const displayInfo = (panelSide === 'right' && rightInfo) ? rightInfo : leftInfo
  const filterStr   = `brightness(${brightness}%) contrast(${contrast}%) url(#sv-gamma)`

  const pillStyle = (active) => ({
    background: active ? '#1b998b' : 'rgba(3,8,25,0.9)',
    border: `1px solid ${active ? '#1b998b' : 'rgba(255,255,255,0.22)'}`,
    color: 'white', padding: '5px 14px', borderRadius: 20, cursor: 'pointer',
    fontSize: 11, fontWeight: 600,
  })
  const miniBtn = (enabled) => ({
    background: enabled ? 'rgba(27,153,139,0.18)' : 'rgba(255,255,255,0.05)',
    border: '1px solid rgba(255,255,255,0.18)',
    color: enabled ? '#6ee7b7' : 'rgba(255,255,255,0.4)',
    padding: '4px 10px', borderRadius: 6, cursor: enabled ? 'pointer' : 'not-allowed',
    fontSize: 11, fontWeight: 600,
  })

  // ─────────────────────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div style={{ width: '100vw', height: '100vh', background: '#111827', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

      {/* Topbar */}
      <Toolbar
        handleBack={handleBack}
        leftInfo={leftInfo}
        rightInfo={rightInfo}
        compareMode={compareMode}
        leftZoom={leftZoom}
        rightZoom={rightZoom}
        handleCompareToggle={handleCompareToggle}
      />

      {/* Main area */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden', minHeight: 0 }}>

        {/* Viewers + filmstrip column */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}>

          {/* Canvas row */}
          <div style={{ flex: 1, display: 'flex', position: 'relative', minHeight: 0 }}>

            {/* ── LEFT VIEWER ── */}
            <div
              style={{ flex: 1, position: 'relative', overflow: 'hidden', borderRight: compareMode ? '1px solid rgba(255,255,255,0.12)' : 'none' }}
              onDragOver={e => e.preventDefault()}
              onDrop={e => handleDrop(e, 'left')}
            >
              {loading && (
                <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, color: 'rgba(255,255,255,0.45)', fontSize: 13, zIndex: 2 }}>
                  <Spinner /> Loading…
                </div>
              )}
              {error && (
                <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2, color: '#ff8099', padding: 20, fontSize: 13, textAlign: 'center' }}>
                  {error}
                </div>
              )}

              {/* OSD canvas — filtered */}
              <div style={{ width: '100%', height: '100%', filter: filterStr }}>
                <div ref={leftViewerRef} style={{ width: '100%', height: '100%' }} />
              </div>

              {/* ── Polygon tool SVG overlay (above OSD, below UI chrome) ── */}
              <PolygonTool
                viewer={osdLeftRef.current}
                isActive={isPolygonActive}
                polygons={polygons}
                setPolygons={setPolygons}
              />

              {isDragging && (
                <div style={{ position: 'absolute', inset: 8, border: '2px dashed #1b998b', background: 'rgba(27,153,139,0.07)', borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#1b998b', fontWeight: 600, fontSize: 13, pointerEvents: 'none', zIndex: 50 }}>
                  Replace left scan
                </div>
              )}
            </div>

            {/* Compare controls: link + registration */}
            {compareMode && rightScanId && (
              <div style={{ position: 'absolute', left: '50%', top: 14, transform: 'translateX(-50%)', zIndex: 60, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <button onClick={() => setIsSynced(o => !o)} style={pillStyle(isSynced)} title="Lock the two viewers together">
                    {isSynced ? (registration ? 'Aligned · linked' : 'Viewers linked') : 'Link viewers'}
                  </button>
                  {!alignMode && (
                    <button onClick={enterAlignMode} style={pillStyle(false)} title="Co-register the two slides by tissue features">
                      {registration ? 'Re-align…' : 'Align…'}
                    </button>
                  )}
                  {registration && !alignMode && (
                    <button onClick={removeRegistration} style={pillStyle(false)} title="Remove the saved alignment">Clear alignment</button>
                  )}
                </div>

                {alignMode && (
                  <div style={{ background: 'rgba(3,8,25,0.96)', border: '1px solid rgba(255,255,255,0.18)', borderRadius: 10, padding: '10px 12px', width: 310, color: 'rgba(255,255,255,0.85)', fontSize: 12, fontFamily: 'sans-serif', boxShadow: '0 6px 24px rgba(0,0,0,0.5)' }}>
                    <div style={{ fontWeight: 700, marginBottom: 6 }}>Align slides</div>
                    <div style={{ opacity: 0.75, lineHeight: 1.45, marginBottom: 8 }}>
                      Click a feature on the <b>left</b>, then the same feature on the <b>right</b>. Add at least 2 pairs (3+ gives a tighter fit). Or use <b>Auto-align</b>.
                    </div>
                    <div style={{ marginBottom: 8 }}>
                      Landmark pairs: <b>{landmarks.length}</b>{pendingMarker ? ' — now click the match on the right' : ''}
                    </div>
                    {regError && <div style={{ color: '#ffb4a2', marginBottom: 8, lineHeight: 1.4 }}>{regError}</div>}
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                      <button onClick={applyLandmarks} disabled={landmarks.length < 2} style={miniBtn(landmarks.length >= 2)}>Apply</button>
                      <button onClick={handleAutoAlign} disabled={autoBusy} style={miniBtn(!autoBusy)}>{autoBusy ? 'Auto…' : 'Auto-align'}</button>
                      <button onClick={undoLastLandmark} disabled={!landmarks.length} style={miniBtn(!!landmarks.length)}>Undo point</button>
                      <button onClick={clearLandmarks} style={miniBtn(true)}>Clear</button>
                      <button onClick={exitAlignMode} style={miniBtn(true)}>Done</button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* ── RIGHT VIEWER ── */}
            {compareMode && (
              <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }} onDragOver={e => e.preventDefault()} onDrop={e => handleDrop(e, 'right')}>
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

            {/* Filmstrip toggle pill */}
            <button onClick={() => setFilmstripVisible(o => !o)} style={{ position: 'absolute', bottom: 0, left: '50%', transform: 'translateX(-50%)', background: 'rgba(3,8,25,0.92)', border: '1px solid rgba(255,255,255,0.07)', borderBottom: 'none', borderRadius: '6px 6px 0 0', color: 'rgba(255,255,255,0.4)', padding: '3px 16px', fontSize: 10, cursor: 'pointer', textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 600, zIndex: 10 }}>
              {filmstripVisible ? '▾ Scans' : '▴ Scans'}
            </button>
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

        {/* Models panel — receives the OSD viewer so it can read viewport bounds */}
        {showModels && (
          <ModelsPanel
            catalog={catalog}
            scanId={leftScanId}
            scanInfo={leftInfo}
            jobs={analysisJobs}
            activeOverlays={activeOverlays}
            setActiveOverlays={setActiveOverlays}
            onToggleOverlay={handleToggleOverlay}
            onJobsChange={handleJobsChange}
            viewer={osdLeftRef.current}
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

function Spinner() {
  return (
    <div style={{ width: 26, height: 26, borderRadius: '50%', border: '2px solid rgba(255,255,255,0.08)', borderTopColor: '#1b998b', animation: 'sv-spin 0.7s linear infinite' }} />
  )
}