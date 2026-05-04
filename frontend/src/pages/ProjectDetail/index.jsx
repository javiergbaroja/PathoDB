// frontend/src/pages/ProjectDetail/index.jsx
//
// BUG FIXES vs v1:
//
// BUG 1 (root cause — viewer destroyed on every RQ refetch):
//   useOSDViewer no longer takes slideInfo as a dep.  The hook polls until
//   slideInfo arrives via its internal ref, then builds OSD exactly once per scanId.
//
// BUG 2 (tick handlers never attach):
//   Replaced the useEffect([activeScanId, slideInfo]) that ran before OSD was ready
//   with a stable onReady callback passed into useOSDViewer.  Handlers are attached
//   inside that callback, guaranteed to run after 'open' fires.
//
// BUG 3 (osdRef.current passed as a prop value, always null):
//   AnnotationLayer now receives the ref object itself (osdRef) and reads
//   osdRef.current internally, so it always has the live viewer instance.
//
// BUG 4 (stale closure in navigation auto-save wipes previous slide's annotations):
//   localAnnotations is now tracked in a ref (localAnnotationsRef) that is kept
//   in sync with state. The navigation-save effect reads the ref, not the stale
//   closure value, so it always captures the final set of annotations.
//
// BUG 5 (temp IDs never replaced after save — sync effect uses .length):
//   Sync now triggers on a saveGeneration counter that increments after every
//   successful save, not on rawAnnotations.length which is stable when N is unchanged.
//
// BUG 6 (save error swallowed silently):
//   Save errors now set a visible saveError state shown in the topbar.

import { useState, useEffect, useRef, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../api'
import { useOSDViewer } from '../../hooks/useOSDViewer'
import AnnotationLayer from './AnnotationLayer'
import AnnotationToolbar from './AnnotationToolbar'
import ClassPanel from './ClassPanel'
import SlideTray from './SlideTray'

// ── Style injection ───────────────────────────────────────────────────────────
if (!document.getElementById('pd-styles')) {
  const s = document.createElement('style')
  s.id = 'pd-styles'
  s.textContent = `
    @keyframes spin { to { transform: rotate(360deg); } }
    @keyframes pd-pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }
  `
  document.head.appendChild(s)
}

// ── Gamma SVG filter (shared with SlideViewer) ────────────────────────────────
function ensureGammaFilter() {
  if (document.getElementById('sv-gamma-svg')) return
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('id', 'sv-gamma-svg')
  svg.setAttribute('style', 'position:absolute;width:0;height:0;overflow:hidden')
  svg.innerHTML = `<defs><filter id="sv-gamma"><feComponentTransfer>
    <feFuncR type="gamma" exponent="1"/>
    <feFuncG type="gamma" exponent="1"/>
    <feFuncB type="gamma" exponent="1"/>
  </feComponentTransfer></filter></defs>`
  document.body.appendChild(svg)
}

export default function ProjectDetail() {
  const { projectId } = useParams()
  const navigate      = useNavigate()
  const token         = localStorage.getItem('pathodb_token')
  const queryClient   = useQueryClient()

  // ── Project & scans ──────────────────────────────────────────────────────────
  const { data: project, isLoading: projLoading } = useQuery({
    queryKey: ['project', projectId],
    queryFn:  () => api.getProject(Number(projectId)),
  })

  const { data: projectScans = [], refetch: refetchScans } = useQuery({
    queryKey: ['project-scans', projectId],
    queryFn:  () => api.getProjectScans(Number(projectId)),
    enabled:  !!project,
  })

  const { data: progress } = useQuery({
    queryKey: ['project-progress', projectId],
    queryFn:  () => api.getProjectProgress(Number(projectId)),
    enabled:  !!project,
    refetchInterval: 15000,
  })

  // ── Active slide ─────────────────────────────────────────────────────────────
  const [activeScanId, setActiveScanId] = useState(null)
  useEffect(() => {
    if (projectScans.length > 0 && !activeScanId) {
      setActiveScanId(projectScans[0].scan_id)
    }
  }, [projectScans]) // eslint-disable-line

  // ── Slide info (used only for scalebar + ruler; NOT an OSD dep) ───────────────
  const { data: slideInfo } = useQuery({
    queryKey: ['slide', activeScanId, 'info'],
    queryFn:  () => api.getSlideInfo(activeScanId, token),
    enabled:  !!activeScanId && !!token,
    staleTime: 60_000,   // slide dimensions don't change — cache aggressively
  })

  // ── Raw annotations from server ───────────────────────────────────────────────
  // saveGeneration is bumped after every successful save so we can use it as
  // a stable dependency that correctly triggers re-sync (fixes BUG 5).
  const [saveGeneration, setSaveGeneration] = useState(0)

  const { data: rawAnnotations = [], refetch: refetchAnnotations } = useQuery({
    queryKey: ['annotations', projectId, activeScanId],
    queryFn:  () => api.getAnnotations(Number(projectId), activeScanId),
    enabled:  !!activeScanId && !!project,
  })

  // ── Class map ────────────────────────────────────────────────────────────────
  const classMap = Object.fromEntries((project?.classes || []).map(c => [c.id, c]))

  // ── Local annotation state ────────────────────────────────────────────────────
  const [localAnnotations, setLocalAnnotations] = useState([])
  const [selectedAnnId, setSelectedAnnId]       = useState(null)
  const [saving, setSaving]                     = useState(false)
  const [pendingSave, setPendingSave]            = useState(false)
  const [saveError, setSaveError]               = useState('')
  const saveTimerRef = useRef(null)

  // FIX BUG 4: keep a ref always in sync with current annotations so navigation
  // save doesn't capture a stale closure value.
  const localAnnotationsRef = useRef([])
  useEffect(() => { localAnnotationsRef.current = localAnnotations }, [localAnnotations])

  // FIX BUG 5: sync from server after a successful save (saveGeneration) OR when
  // the active scan changes.  Do NOT depend on rawAnnotations.length.
  useEffect(() => {
    if (!rawAnnotations) return
    const merged = rawAnnotations.map(a => ({
      ...a,
      _color: classMap[a.class_id]?.color || '#94a3b8',
    }))
    setLocalAnnotations(merged)
    setSelectedAnnId(null)
  }, [activeScanId, saveGeneration]) // eslint-disable-line

  // ── Tool state ───────────────────────────────────────────────────────────────
  const [activeTool, setActiveTool]       = useState(null)
  const [activeClass, setActiveClass]     = useState(null)
  const [brushRadius, setBrushRadius]     = useState(80)
  const [isRulerActive, setIsRulerActive] = useState(false)
  const [showAdjust, setShowAdjust]       = useState(false)
  const [brightness, setBrightness]       = useState(100)
  const [contrast, setContrast]           = useState(100)
  const [gamma, setGamma]                 = useState(1.0)
  const [zoom, setZoom]                   = useState(null)

  // ── OSD ─────────────────────────────────────────────────────────────────────
  const containerRef = useRef(null)
  const osdRef       = useRef(null)

  // FIX BUG 2: tick is bumped inside onReady callback so OSD handlers are
  // attached only after the viewer's 'open' event, guaranteed to be non-null.
  const [tick, setTick] = useState(0)

  const handleOSDReady = useCallback(() => {
    const v = osdRef.current
    if (!v) return
    const bump = () => setTick(n => n + 1)
    v.addHandler('animation', bump)
    v.addHandler('zoom',      bump)
    v.addHandler('pan',       bump)
    v.addHandler('resize',    bump)
    // No need to remove — OSD cleans handlers on destroy
  }, [])

  useOSDViewer({
    containerRef,
    scanId:    activeScanId,
    slideInfo,      // passed so the hook can read it via internal ref
    token,
    onZoom:    setZoom,
    osdRef,
    onReady:   handleOSDReady,  // fires after OSD 'open' — safe to attach handlers
  })

  // ── Gamma filter ─────────────────────────────────────────────────────────────
  useEffect(() => {
    ensureGammaFilter()
    const exp = (1 / gamma).toFixed(4)
    document.querySelectorAll('#sv-gamma feFuncR, #sv-gamma feFuncG, #sv-gamma feFuncB')
      .forEach(el => el.setAttribute('exponent', exp))
  }, [gamma])

  // ── Ruler tool ───────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!isRulerActive || !osdRef.current) return
    const viewer    = osdRef.current
    const container = viewer.element
    viewer.setMouseNavEnabled(false)
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    Object.assign(svg.style, {
      position: 'absolute', inset: '0', width: '100%', height: '100%',
      pointerEvents: 'none', zIndex: 100,
    })
    container.appendChild(svg)
    let sp = null, line = null, label = null
    const tracker = new window.OpenSeadragon.MouseTracker({
      element: container,
      pressHandler: e => {
        svg.innerHTML = ''
        sp    = e.position
        line  = document.createElementNS('http://www.w3.org/2000/svg', 'line')
        line.setAttribute('stroke', '#00ffcc')
        line.setAttribute('stroke-width', '2')
        svg.appendChild(line)
        label = document.createElementNS('http://www.w3.org/2000/svg', 'text')
        label.setAttribute('fill', '#00ffcc')
        label.setAttribute('style', 'font-family:monospace;font-size:13px;font-weight:bold;paint-order:stroke;stroke:#000;stroke-width:3px')
        svg.appendChild(label)
      },
      dragHandler: e => {
        if (!sp || !line) return
        const ep = e.position
        line.setAttribute('x1', sp.x); line.setAttribute('y1', sp.y)
        line.setAttribute('x2', ep.x); line.setAttribute('y2', ep.y)
        const iz  = viewer.world.getItemAt(0)?.viewportToImageZoom(viewer.viewport.getZoom(true)) || 1
        const mpp = parseFloat(slideInfo?.mpp_x) || 0.25
        const um  = (Math.hypot(ep.x - sp.x, ep.y - sp.y) / iz) * mpp
        label.textContent = um >= 1000 ? `${(um / 1000).toFixed(2)} mm` : `${um.toFixed(1)} µm`
        label.setAttribute('x', ep.x + 10)
        label.setAttribute('y', ep.y - 10)
      },
    })
    return () => {
      tracker.destroy()
      if (container.contains(svg)) container.removeChild(svg)
      if (osdRef.current) viewer.setMouseNavEnabled(true)
    }
  }, [isRulerActive, slideInfo])

  // ── Keyboard shortcuts ────────────────────────────────────────────────────────
  useEffect(() => {
    const toolMap = { g: 'polygon', r: 'rectangle', e: 'ellipse', p: 'point', b: 'brush' }
    function handler(ev) {
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return
      const k = ev.key.toLowerCase()
      if (toolMap[k]) {
        setActiveTool(prev => prev === toolMap[k] ? null : toolMap[k])
        setIsRulerActive(false)
        return
      }
      if (k === 'l') { setIsRulerActive(r => !r); setActiveTool(null) }
      if (k === 'a') setShowAdjust(s => !s)
      if (ev.key === 'Escape') { setActiveTool(null); setIsRulerActive(false) }
      if (ev.key === 'Delete' && selectedAnnId) handleDeleteAnnotation(selectedAnnId)
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [selectedAnnId]) // eslint-disable-line

  // ── Save helpers ──────────────────────────────────────────────────────────────
  const readOnly = project?.access === 'read'

  /**
   * Debounced save — called after every local mutation.
   * FIX BUG 6: errors are surfaced to the user via saveError state.
   */
  const triggerSave = useCallback((anns) => {
    if (readOnly) return
    clearTimeout(saveTimerRef.current)
    setPendingSave(true)
    setSaveError('')

    saveTimerRef.current = setTimeout(async () => {
      if (!activeScanId) return
      setSaving(true)
      try {
        await api.bulkSaveAnnotations(Number(projectId), activeScanId, anns)
        // Refetch to replace temp IDs with real DB IDs
        await refetchAnnotations()
        // Bump generation so the sync effect re-runs (FIX BUG 5)
        setSaveGeneration(g => g + 1)
        // Update scan list annotation counts
        refetchScans()
        queryClient.invalidateQueries({ queryKey: ['project-progress', projectId] })
      } catch (e) {
        console.error('[ProjectDetail] auto-save failed:', e)
        setSaveError(e.message || 'Save failed — changes may be lost')
      } finally {
        setSaving(false)
        setPendingSave(false)
      }
    }, 800)
  }, [activeScanId, projectId, readOnly]) // eslint-disable-line

  /**
   * Immediate save — fired when navigating away from a slide.
   * FIX BUG 4: reads from ref, not from stale closure.
   */
  const prevScanRef = useRef(null)
  useEffect(() => {
    const prev = prevScanRef.current
    prevScanRef.current = activeScanId

    if (prev && prev !== activeScanId) {
      clearTimeout(saveTimerRef.current)
      const annsToSave = localAnnotationsRef.current
      if (annsToSave.length === 0) {
        // Still call the API so that a deliberate delete-all is persisted
      }
      api.bulkSaveAnnotations(Number(projectId), prev, annsToSave)
        .then(() => {
          refetchScans()
          queryClient.invalidateQueries({ queryKey: ['project-progress', projectId] })
        })
        .catch(e => console.error('[ProjectDetail] navigation save failed:', e))
    }
  }, [activeScanId]) // eslint-disable-line — intentionally narrow dep

  // Save on page unload (tab close / hard navigation).
  // sendBeacon only supports POST; our bulk-save endpoint is PUT.
  // fetch with keepalive:true supports any method and outlives the page.
  useEffect(() => {
    const handleUnload = () => {
      if (!activeScanId || readOnly) return
      const anns = localAnnotationsRef.current
      const tk   = localStorage.getItem('pathodb_token')
      try {
        fetch(`/api/projects/${projectId}/scans/${activeScanId}/annotations`, {
          method:  'PUT',
          headers: {
            'Content-Type': 'application/json',
            ...(tk ? { Authorization: `Bearer ${tk}` } : {}),
          },
          body:      JSON.stringify({ annotations: anns }),
          keepalive: true,
        })
      } catch (_) { /* ignore — some browsers throw synchronously during unload */ }
    }
    window.addEventListener('beforeunload', handleUnload)
    return () => window.removeEventListener('beforeunload', handleUnload)
  }, [activeScanId, projectId, readOnly])

  // ── Annotation mutation handlers ──────────────────────────────────────────────
  function handleAnnotationCreated(annCreate) {
    const tempId = `temp_${Date.now()}_${Math.random().toString(36).slice(2)}`
    const newAnn = {
      id:         tempId,
      project_id: Number(projectId),
      scan_id:    activeScanId,
      ...annCreate,
      _color:     classMap[annCreate.class_id]?.color || '#94a3b8',
      created_at: new Date().toISOString(),
    }
    const next = [...localAnnotationsRef.current, newAnn]
    setLocalAnnotations(next)
    setSelectedAnnId(tempId)
    triggerSave(next)
  }

  function handleDeleteAnnotation(annId) {
    const next = localAnnotationsRef.current.filter(a => a.id !== annId)
    setLocalAnnotations(next)
    setSelectedAnnId(null)
    triggerSave(next)
  }

  function handleChangeClass(annId, classId, className) {
    const next = localAnnotationsRef.current.map(a =>
      a.id === annId
        ? { ...a, class_id: classId, class_name: className,
            _color: classMap[classId]?.color || '#94a3b8' }
        : a
    )
    setLocalAnnotations(next)
    triggerSave(next)
  }

  // ── Derived ───────────────────────────────────────────────────────────────────
  const filterStr  = `brightness(${brightness}%) contrast(${contrast}%) url(#sv-gamma)`
  const activeScan = projectScans.find(s => s.scan_id === activeScanId)

  if (projLoading) return (
    <div style={{ width:'100vw', height:'100vh', background:'#111827', display:'flex',
      alignItems:'center', justifyContent:'center', color:'rgba(255,255,255,0.4)', fontSize:14 }}>
      Loading project…
    </div>
  )

  return (
    <div style={{ width:'100vw', height:'100vh', background:'#111827',
      display:'flex', flexDirection:'column', overflow:'hidden' }}>

      {/* ── Topbar ─────────────────────────────────────────────────────────── */}
      <div style={{
        height: 48, flexShrink: 0, background: 'rgba(3,8,25,0.97)',
        borderBottom: '1px solid rgba(255,255,255,0.07)',
        display: 'flex', alignItems: 'center', gap: 10, padding: '0 14px',
      }}>
        <button onClick={() => navigate('/projects')} title="Back to Projects"
          style={{ display:'flex', alignItems:'center', gap:6, padding:'4px 10px',
            borderRadius:6, background:'rgba(255,255,255,0.05)',
            border:'1px solid rgba(255,255,255,0.12)', color:'rgba(255,255,255,0.65)',
            cursor:'pointer', fontSize:12, fontFamily:'sans-serif' }}>
          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
            <path d="M15 8a.5.5 0 00-.5-.5H2.707l3.147-3.146a.5.5 0 10-.708-.708l-4 4a.5.5 0 000 .708l4 4a.5.5 0 00.708-.708L2.707 8.5H14.5A.5.5 0 0015 8z"/>
          </svg>
          Projects
        </button>

        <div style={{ width:1, height:18, background:'rgba(255,255,255,0.08)' }} />
        <span style={{ fontFamily:'serif', fontSize:13, color:'rgba(255,255,255,0.4)' }}>PathoDB</span>
        <span style={{ fontSize:11, color:'rgba(255,255,255,0.25)' }}>·</span>
        <span style={{ fontSize:13, fontWeight:500, color:'rgba(255,255,255,0.8)' }}>{project?.name}</span>

        {project?.project_type === 'cell_detection' && (
          <span style={{ fontSize:9, padding:'2px 8px', borderRadius:20,
            background:'rgba(251,191,36,0.15)', color:'#fbbf24',
            fontWeight:600, textTransform:'uppercase', letterSpacing:'0.06em' }}>
            Cell detection
          </span>
        )}
        {project?.project_type === 'region_annotation' && (
          <span style={{ fontSize:9, padding:'2px 8px', borderRadius:20,
            background:'rgba(27,153,139,0.18)', color:'#6ee7b7',
            fontWeight:600, textTransform:'uppercase', letterSpacing:'0.06em' }}>
            Region annotation
          </span>
        )}
        {readOnly && (
          <span style={{ fontSize:9, padding:'2px 8px', borderRadius:20,
            background:'rgba(148,163,184,0.15)', color:'#94a3b8',
            fontWeight:600, textTransform:'uppercase', letterSpacing:'0.06em' }}>
            Read only
          </span>
        )}

        <div style={{ flex:1 }} />

        {/* Slide info */}
        {activeScan && (
          <div style={{ display:'flex', alignItems:'center', gap:12 }}>
            <span style={{ fontSize:11, fontFamily:'monospace', color:'rgba(255,255,255,0.35)' }}>
              {activeScan.lis_submission_id}
            </span>
            <span style={{ fontSize:11, fontFamily:'monospace', color:'rgba(255,255,255,0.55)', fontWeight:600 }}>
              {activeScan.stain_name}
            </span>
            {zoom && (
              <span style={{ fontSize:10, fontFamily:'monospace', color:'rgba(255,255,255,0.3)',
                background:'rgba(255,255,255,0.05)', padding:'1px 6px', borderRadius:3 }}>
                {zoom}×
              </span>
            )}
          </div>
        )}

        {/* Save status — BUG 6 fix: errors surfaced here */}
        {saveError && (
          <div style={{ display:'flex', alignItems:'center', gap:5, fontSize:10,
            color:'#ff8099', background:'rgba(230,0,46,0.12)',
            border:'1px solid rgba(230,0,46,0.25)', padding:'3px 8px', borderRadius:4 }}>
            ⚠ {saveError}
            <button onClick={() => setSaveError('')}
              style={{ background:'none', border:'none', color:'#ff8099', cursor:'pointer', fontSize:12, lineHeight:1 }}>×</button>
          </div>
        )}
        {!saveError && (saving || pendingSave) && (
          <div style={{ display:'flex', alignItems:'center', gap:5, fontSize:10, color:'#fbbf24' }}>
            <div style={{ width:7, height:7, borderRadius:'50%',
              border:'1.5px solid #fbbf24', borderTopColor:'transparent',
              animation:'spin 0.7s linear infinite' }} />
            {saving ? 'Saving…' : 'Pending…'}
          </div>
        )}
        {!saveError && !saving && !pendingSave && localAnnotations.length > 0 && (
          <div style={{ fontSize:10, color:'#1b998b', display:'flex', alignItems:'center', gap:4 }}>
            <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
              <path d="M13.854 3.646a.5.5 0 010 .708l-7 7a.5.5 0 01-.708 0l-3.5-3.5a.5.5 0 11.708-.708L6.5 10.293l6.646-6.647a.5.5 0 01.708 0z"/>
            </svg>
            Saved
          </div>
        )}

        <button
          onClick={() => window.open(`/api/projects/${projectId}/export`, '_blank')}
          style={{ display:'flex', alignItems:'center', gap:5, padding:'5px 12px',
            borderRadius:6, background:'rgba(27,153,139,0.15)',
            border:'1px solid rgba(27,153,139,0.3)', color:'#6ee7b7',
            cursor:'pointer', fontSize:11, fontFamily:'sans-serif' }}>
          <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor">
            <path d="M.5 9.9a.5.5 0 01.5.5v2.5a1 1 0 001 1h12a1 1 0 001-1v-2.5a.5.5 0 011 0v2.5a2 2 0 01-2 2H2a2 2 0 01-2-2v-2.5a.5.5 0 01.5-.5z"/>
            <path d="M7.646 11.854a.5.5 0 00.708 0l3-3a.5.5 0 00-.708-.708L8.5 10.293V1.5a.5.5 0 00-1 0v8.793L5.354 8.146a.5.5 0 10-.708.708l3 3z"/>
          </svg>
          Export
        </button>
      </div>

      {/* ── Body ──────────────────────────────────────────────────────────── */}
      <div style={{ flex:1, display:'flex', overflow:'hidden', minHeight:0 }}>

        <SlideTray
          scans={projectScans}
          activeScanId={activeScanId}
          onSelect={setActiveScanId}
          token={token}
          saving={saving}
        />

        <AnnotationToolbar
          activeTool={activeTool}
          setActiveTool={setActiveTool}
          brushRadius={brushRadius}
          setBrushRadius={setBrushRadius}
          readOnly={readOnly}
          brightness={brightness} contrast={contrast} gamma={gamma}
          setBrightness={setBrightness} setContrast={setContrast} setGamma={setGamma}
          resetAdjustments={() => { setBrightness(100); setContrast(100); setGamma(1.0) }}
          showAdjust={showAdjust} setShowAdjust={setShowAdjust}
          isRulerActive={isRulerActive} setIsRulerActive={setIsRulerActive}
        />

        {/* Canvas area */}
        <div style={{ flex:1, position:'relative', overflow:'hidden' }}>
          {!activeScanId && (
            <div style={{ position:'absolute', inset:0, display:'flex',
              alignItems:'center', justifyContent:'center',
              color:'rgba(255,255,255,0.3)', fontSize:13 }}>
              Select a slide from the tray
            </div>
          )}

          <div style={{ width:'100%', height:'100%', filter:filterStr }}>
            <div ref={containerRef} style={{ width:'100%', height:'100%' }} />
          </div>

          {/* FIX BUG 3: pass osdRef (the ref object) not osdRef.current (the value).
              AnnotationLayer reads osdRef.current internally on every render,
              so it always has the live viewer instance. */}
          {activeScanId && (
            <AnnotationLayer
              osdRef={osdRef}
              activeTool={activeTool}
              activeClass={activeClass}
              brushRadius={brushRadius}
              annotations={localAnnotations}
              selectedAnnId={selectedAnnId}
              onAnnotationClick={ann => setSelectedAnnId(ann.id === selectedAnnId ? null : ann.id)}
              onAnnotationCreated={handleAnnotationCreated}
              readOnly={readOnly}
              tick={tick}
            />
          )}

          {activeTool && !readOnly && (
            <div style={{
              position:'absolute', bottom:16, left:'50%', transform:'translateX(-50%)',
              background:'rgba(0,0,0,0.75)', color:'rgba(255,255,255,0.7)',
              fontSize:11, padding:'5px 14px', borderRadius:20, pointerEvents:'none',
              fontFamily:'sans-serif',
            }}>
              {activeTool === 'polygon'   && 'Click to add vertices · Double-click or click first point to close'}
              {activeTool === 'rectangle' && 'Click and drag to draw rectangle'}
              {activeTool === 'ellipse'   && 'Click and drag to draw ellipse'}
              {activeTool === 'point'     && 'Click to place point'}
              {activeTool === 'brush'     && 'Click and drag to paint · release to finish'}
            </div>
          )}
        </div>

        <ClassPanel
          classes={project?.classes || []}
          activeClass={activeClass}
          setActiveClass={setActiveClass}
          annotations={localAnnotations}
          selectedAnnId={selectedAnnId}
          onSelectAnnotation={setSelectedAnnId}
          onDeleteAnnotation={handleDeleteAnnotation}
          onChangeClass={handleChangeClass}
          readOnly={readOnly}
          annotationCount={localAnnotations.length}
          totalScans={progress?.total_scans     || projectScans.length}
          annotatedScans={progress?.annotated_scans || 0}
        />
      </div>
    </div>
  )
}