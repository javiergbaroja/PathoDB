// frontend/src/pages/ProjectDetail/index.jsx
import { useState, useEffect, useRef, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../api'
import { useOSDViewer } from '../../hooks/useOSDViewer'
import { useGammaFilter } from '../../hooks/useGammaFilter'
import { attachRuler } from '../../lib/rulerTool'
import { useModelsCatalog } from '../../hooks/useSlideData'
import AnnotationLayer from './AnnotationLayer'
import AnnotationToolbar from './AnnotationToolbar'
import ClassPanel from './ClassPanel'
import SlideTray from './SlideTray'
import ImportModal from './ImportModal'
import { AI_ROI_CLASS } from './ProjectModelsPanel'
import ManageClassesModal from '../../components/ManageClassesModal'
import BatchAIModal from './BatchAIModal'
import RBush from 'rbush'
import { getAnnotationBBox } from '../../lib/annotationMath'
import { toolForEvent, panelForEvent, isEditableTarget } from '../../lib/viewerKeymap'

if (!document.getElementById('pd-styles')) {
  const s = document.createElement('style')
  s.id = 'pd-styles'
  s.textContent = `
    @keyframes spin { to { transform: rotate(360deg); } }
    @keyframes pd-pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }
  `
  document.head.appendChild(s)
}

// Build a {client_id → server_id} map from a bulk-save response.
function buildSavedIdMap(result) {
  const map = result?.id_map
  const idMap = new Map()
  if (Array.isArray(map)) {
    for (const e of map) {
      if (e && e.client_id != null && e.client_id !== e.id) idMap.set(e.client_id, e.id)
    }
  }
  return idMap
}

// Return a copy of `list` with any temporary ids replaced by their server ids.
function remapAnnotationIds(list, idMap) {
  if (!idMap.size) return list
  let changed = false
  const next = list.map(a => {
    if (idMap.has(a.id)) { changed = true; return { ...a, id: idMap.get(a.id) } }
    return a
  })
  return changed ? next : list
}

export default function ProjectDetail() {
  const { projectId } = useParams()
  const [showBatchAIModal, setShowBatchAIModal] = useState(false)
  const [showManageClasses, setShowManageClasses] = useState(false);
  const navigate      = useNavigate()
  const token         = localStorage.getItem('pathodb_token')
  const queryClient   = useQueryClient()

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

  // ── Model catalog ──────────────────────────────────────────────────────────
  const { data: catalogResponse } = useModelsCatalog()
  const catalog = catalogResponse?.models || []

  const [activeScanId, setActiveScanId] = useState(null)
  useEffect(() => {
    if (projectScans.length > 0 && !activeScanId) {
      setActiveScanId(projectScans[0].scan_id)
    }
  }, [projectScans]) // eslint-disable-line

  const { data: slideInfo } = useQuery({
    queryKey: ['slide', activeScanId, 'info'],
    queryFn:  () => api.getSlideInfo(activeScanId, token),
    enabled:  !!activeScanId && !!token,
    staleTime: 60_000,
  })

  const { data: rawAnnotations = [], refetch: refetchAnnotations, isFetching } = useQuery({
    queryKey: ['annotations', projectId, activeScanId],
    queryFn:  () => api.getAnnotations(Number(projectId), activeScanId),
    enabled:  !!activeScanId && !!project,
  })

  // ── Class map — includes the system AI ROI class ───────────────────────────
  const classMap = {
    [AI_ROI_CLASS.id]: AI_ROI_CLASS,                                  // ← NEW
    ...Object.fromEntries((project?.classes || []).map(c => [c.id, c])),
  }

  const [localAnnotations, setLocalAnnotations] = useState([])
  const [selectedAnnIds, setSelectedAnnIds] = useState(new Set())
  const isShiftDownRef = useRef(false)
  const isAltDownRef   = useRef(false)
  const [saving, setSaving]       = useState(false)
  const [pendingSave, setPendingSave] = useState(false)
  const [saveError, setSaveError] = useState('')
  const saveTimerRef = useRef(null)

  useEffect(() => {
    const handleKeyDown = e => {
      if (e.key === 'Shift') isShiftDownRef.current = true
      if (e.key === 'Alt')   isAltDownRef.current   = true
    }
    const handleKeyUp = e => {
      if (e.key === 'Shift') isShiftDownRef.current = false
      if (e.key === 'Alt')   isAltDownRef.current   = false
    }
    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup',   handleKeyUp)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup',   handleKeyUp)
    }
  }, [])

  const localAnnotationsRef = useRef([])
  useEffect(() => { localAnnotationsRef.current = localAnnotations }, [localAnnotations])

  const rtreeRef = useRef(null)

  useEffect(() => {
    const tree  = new RBush()
    const items = localAnnotations.map(ann => {
      const bbox = getAnnotationBBox(ann)
      return { minX: bbox.x, minY: bbox.y, maxX: bbox.x + bbox.w, maxY: bbox.y + bbox.h, ann }
    })
    tree.load(items)
    rtreeRef.current = tree
  }, [localAnnotations])

  const initializedScanRef = useRef(null)
  const loadedDataRef      = useRef(null)
  // The exact array reference we last wrote into the React-Query cache after a
  // save. The re-init effect uses it to distinguish our own optimistic writes
  // (which must NOT clobber local state / clear the selection) from genuine
  // server reloads (initial load, slide switch, import, class edits).
  const lastSyncedCacheRef = useRef(null)

  useEffect(() => {
    if (!rawAnnotations || isFetching) return
    // Cache update that we wrote ourselves after a save: just record it as the
    // loaded baseline and leave local edits + selection untouched.
    if (rawAnnotations === lastSyncedCacheRef.current) {
      initializedScanRef.current = activeScanId
      loadedDataRef.current      = rawAnnotations
      return
    }
    if (initializedScanRef.current !== activeScanId || loadedDataRef.current !== rawAnnotations) {
      initializedScanRef.current = activeScanId
      loadedDataRef.current      = rawAnnotations
      const merged = rawAnnotations.map(a => ({
        ...a,
        _color: classMap[a.class_id]?.color || 'var(--gray-blue)',
      }))
      localAnnotationsRef.current = merged
      setLocalAnnotations(merged)
      setSelectedAnnIds(new Set())
    }
  }, [rawAnnotations, isFetching, activeScanId]) // eslint-disable-line

  const [activeTool,      setActiveTool]      = useState(null)
  const [activeClass,     setActiveClass]     = useState(null)
  const [brushRadius,     setBrushRadius]     = useState(80)
  const [isRulerActive,   setIsRulerActive]   = useState(false)
  const [showAdjust,      setShowAdjust]      = useState(false)
  const [showAnnotations, setShowAnnotations] = useState(true)
  const [fillAnnotations, setFillAnnotations] = useState(true)
  const [brightness,      setBrightness]      = useState(100)
  const [contrast,        setContrast]        = useState(100)
  const [gamma,           setGamma]           = useState(1.0)
  const [zoom,            setZoom]            = useState(null)
  const [showImportModal, setShowImportModal] = useState(false)

  const containerRef = useRef(null)
  const osdRef       = useRef(null)
  const [tick, setTick] = useState(0)

  // ── Derived: AI ROI annotations on the current slide ──────────────────────
  // These are stored as normal annotations with class_id === AI_ROI_CLASS.id
  const aiRoiAnnotations = localAnnotations.filter(
    a => a.class_id === AI_ROI_CLASS.id
  )

  const readOnly = project?.access === 'read'

  // ── Undo / redo history ────────────────────────────────────────────────────
  const historyPastRef   = useRef([])
  const historyFutureRef = useRef([])

  // Keep the active scan id reachable from async save callbacks without making
  // them re-create on every change.
  const activeScanIdRef = useRef(null)
  useEffect(() => { activeScanIdRef.current = activeScanId }, [activeScanId])

  // ── Serialized auto-save ─────────────────────────────────────────────────────
  // All saves run through a single promise chain so two PUTs for the same scan
  // can never overlap (overlapping PUTs made the backend reconcile double-insert,
  // producing duplicate annotations). After each save we adopt the server-assigned
  // ids so the client stops re-sending temporary ids, and mirror the result into
  // the query cache tagged via lastSyncedCacheRef so the re-init effect knows it
  // is our own write and does not clobber local edits or resurrect deletions.
  const saveChainRef        = useRef(Promise.resolve())
  const outstandingSavesRef = useRef(0)

  const reconcileSavedIds = useCallback((idMap) => {
    if (!idMap.size) return
    const remap = (list) => remapAnnotationIds(list, idMap)

    // Update the ref synchronously so the next chained save reads real ids.
    localAnnotationsRef.current = remap(localAnnotationsRef.current)
    setLocalAnnotations(localAnnotationsRef.current)
    historyPastRef.current   = historyPastRef.current.map(remap)
    historyFutureRef.current = historyFutureRef.current.map(remap)
    setSelectedAnnIds(prev => {
      let changed = false
      const next = new Set()
      prev.forEach(id => {
        if (idMap.has(id)) { changed = true; next.add(idMap.get(id)) } else next.add(id)
      })
      return changed ? next : prev
    })
  }, [])

  const enqueueSave = useCallback((scanId, annsOrFn) => {
    if (readOnly || !scanId) return Promise.resolve()
    outstandingSavesRef.current += 1
    setSaving(true)
    setPendingSave(false)
    const run = saveChainRef.current.then(async () => {
      const anns = typeof annsOrFn === 'function' ? annsOrFn() : annsOrFn
      const result = await api.bulkSaveAnnotations(Number(projectId), scanId, anns)
      const idMap = buildSavedIdMap(result)
      if (scanId === activeScanIdRef.current) {
        // Adopt server ids into the live state, then mirror that state into the
        // query cache. We tag the written reference so the re-init effect treats
        // it as our own write and leaves local edits + selection untouched.
        reconcileSavedIds(idMap)
        const synced = localAnnotationsRef.current
        lastSyncedCacheRef.current = synced
        queryClient.setQueryData(['annotations', projectId, scanId], synced)
      } else {
        // Saved for a scan the user already left (slide switch): keep that scan's
        // cache fresh so revisiting it shows the saved edits without a stale flash.
        queryClient.setQueryData(['annotations', projectId, scanId], remapAnnotationIds(anns, idMap))
      }
      setSaveError('')
    })
    // Single error-handling tail. The chain is advanced to this tail (which never
    // rejects) so one failed save can't stall every later save, and the returned
    // promise also never rejects so fire-and-forget callers produce no unhandled
    // rejection. The next chained save only starts after this tail, guaranteeing
    // id reconciliation from this save lands before the next one reads the ref.
    const tail = run
      .catch(e => {
        console.error('[ProjectDetail] save failed:', e)
        setSaveError(e?.message || 'Save failed — changes may be lost')
      })
      .finally(() => {
        outstandingSavesRef.current -= 1
        if (outstandingSavesRef.current === 0) {
          setSaving(false)
          setPendingSave(false)
          refetchScans()
          queryClient.invalidateQueries({ queryKey: ['project-progress', projectId] })
        }
      })
    saveChainRef.current = tail
    return tail
  }, [readOnly, projectId, reconcileSavedIds, refetchScans, queryClient])

  // Debounced auto-save. The snapshot is read from the live ref at flush time so
  // it always reflects the latest (id-reconciled) state rather than a stale copy.
  const triggerSave = useCallback(() => {
    if (readOnly) return
    clearTimeout(saveTimerRef.current)
    setPendingSave(true)
    setSaveError('')
    saveTimerRef.current = setTimeout(() => {
      enqueueSave(activeScanIdRef.current, () => localAnnotationsRef.current)
    }, 800)
  }, [readOnly, enqueueSave])

  const commitAnnotationChange = useCallback((nextAnnotations) => {
    historyPastRef.current.push(localAnnotationsRef.current)
    if (historyPastRef.current.length > 50) historyPastRef.current.shift()
    historyFutureRef.current = []
    localAnnotationsRef.current = nextAnnotations
    setLocalAnnotations(nextAnnotations)
    triggerSave()
  }, [triggerSave])

  const handleUndo = useCallback(() => {
    if (readOnly || historyPastRef.current.length === 0) return
    const previousState = historyPastRef.current.pop()
    historyFutureRef.current.push(localAnnotationsRef.current)
    localAnnotationsRef.current = previousState
    setLocalAnnotations(previousState)
    setSelectedAnnIds(new Set())
    triggerSave()
  }, [readOnly, triggerSave])

  const handleRedo = useCallback(() => {
    if (readOnly || historyFutureRef.current.length === 0) return
    const nextState = historyFutureRef.current.pop()
    historyPastRef.current.push(localAnnotationsRef.current)
    localAnnotationsRef.current = nextState
    setLocalAnnotations(nextState)
    setSelectedAnnIds(new Set())
    triggerSave()
  }, [readOnly, triggerSave])

  // ── Auto-import handler (called by ProjectModelsPanel on job completion) ───
  //
  // Flow:
  //  1. Flush any pending local annotations so the DB is up-to-date before import
  //  2. Fetch all vector overlays from the completed job
  //  3. For each overlay, convert GeoJSON → Blob → POST to /annotations/import
  //  4. Re-fetch the annotation list so localAnnotations reflects the merge
  //  5. Return the total imported count to the panel for display
  const handleAutoImport = useCallback(async (jobId, importMode) => {
    if (!activeScanId || readOnly) return 0

    // 1. Flush pending local saves, BUT filter out the AI ROI so it is consumed
    clearTimeout(saveTimerRef.current)
    try {
      const annotationsToSave = localAnnotationsRef.current.filter(
        a => a.class_id !== AI_ROI_CLASS.id
      )
      await enqueueSave(activeScanId, annotationsToSave)
    } catch (e) {
      console.warn('[handleAutoImport] pre-flush failed, continuing anyway:', e)
    }

    // 2. Retrieve job result to get the overlay manifest
    let vectorOverlays = []
    try {
      const result = await api.getAnalysisResult(jobId)
      
      // Look directly at the 'files' dictionary. 
      // If a file path ends in .geojson (e.g., download_file), queue it for import.
      if (result.files) {
        vectorOverlays = Object.keys(result.files)
          .filter(key => {
            const filePath = result.files[key]
            return typeof filePath === 'string' && filePath.toLowerCase().endsWith('.geojson')
          })
          .map(key => ({ file_key: key, type: 'vector' }))
      }
    } catch (e) {
      throw new Error(`Could not read analysis result: ${e.message}`)
    }

    if (vectorOverlays.length === 0) {
      await refetchAnnotations()
      return 0
    }

    // 3. Filter to vector overlays (GeoJSON) only — skip raster tile layers
    if (vectorOverlays.length === 0) {
      await refetchAnnotations()
      return 0
    }

    let totalImported = 0

    for (const overlay of vectorOverlays) {
      // 1. Fetch the raw Blob directly to guarantee it matches manual import byte-for-byte
      const blob = await api.getAnalysisOverlayBlob(jobId, overlay.file_key)
      
      // 2. Wrap it in a File object
      const file = new File(
        [blob],
        `${overlay.file_key}.geojson`,
        { type: 'application/json' }
      )

      // 3. Append to FormData
      const formData = new FormData()
      formData.append('file', file)
      formData.append('import_mode', importMode)

      // 4. Send to backend
      const importResult = await api.importAnnotations(
        projectId,
        activeScanId,
        formData
      )
      totalImported += importResult.imported || 0
    }

    // 5. Re-sync the annotation list from the DB (reflects the merge)
    await refetchAnnotations()
    queryClient.invalidateQueries({ queryKey: ['project-progress', projectId] })

    return totalImported
  }, [activeScanId, projectId, readOnly, queryClient, refetchAnnotations, enqueueSave]) // eslint-disable-line

  // ── GeoJSON import from file (Import button) ───────────────────────────────
  const handleImportGeoJSON = async (file, mode, classMapping) => {
    if (!readOnly && activeScanId && localAnnotationsRef.current.length > 0) {
      clearTimeout(saveTimerRef.current)
      await enqueueSave(activeScanId, localAnnotationsRef.current)
    }
    const formData = new FormData()
    formData.append('file', file)
    formData.append('import_mode', mode)
    if (classMapping) formData.append('class_mapping', JSON.stringify(classMapping))
    await api.importAnnotations(projectId, activeScanId, formData)
    await refetchAnnotations()
    queryClient.invalidateQueries({ queryKey: ['project-progress', projectId] })
  }

  // ── Navigate between slides — save on departure ────────────────────────────
  const prevScanRef = useRef(null)
  useEffect(() => {
    const prev = prevScanRef.current
    prevScanRef.current = activeScanId
    if (prev && prev !== activeScanId) {
      clearTimeout(saveTimerRef.current)
      // Capture the departing scan's annotations now — the re-init effect will
      // soon replace localAnnotations with the incoming scan's data.
      const snapshot = localAnnotationsRef.current
      enqueueSave(prev, snapshot)
    }
  }, [activeScanId]) // eslint-disable-line

  // ── Save on page unload ────────────────────────────────────────────────────
  useEffect(() => {
    const handleUnload = () => {
      if (!activeScanId || readOnly) return
      const tk = localStorage.getItem('pathodb_token')
      try {
        fetch(`/api/projects/${projectId}/scans/${activeScanId}/annotations`, {
          method:  'PUT',
          headers: { 'Content-Type': 'application/json', ...(tk ? { Authorization: `Bearer ${tk}` } : {}) },
          body:      JSON.stringify({ annotations: localAnnotationsRef.current }),
          keepalive: true,
        })
      } catch (_) {}
    }
    window.addEventListener('beforeunload', handleUnload)
    return () => window.removeEventListener('beforeunload', handleUnload)
  }, [activeScanId, projectId, readOnly])

  // ── OSD setup ──────────────────────────────────────────────────────────────
  const handleOSDReady = useCallback(() => {
    const v = osdRef.current
    if (!v) return
    if (v.gestureSettingsMouse) {
      v.gestureSettingsMouse.dblClickToZoom = false
      v.gestureSettingsMouse.clickToZoom    = false
      v.gestureSettingsMouse.scrollToZoom   = true
    }
    if (v.gestureSettingsTouch) {
      v.gestureSettingsTouch.dblClickToZoom = false
      v.gestureSettingsTouch.clickToZoom    = false
    }
    const bump = () => setTick(n => n + 1)
    v.addHandler('animation', bump)
    v.addHandler('zoom',      bump)
    v.addHandler('pan',       bump)
    v.addHandler('resize',    bump)
  }, [])

  useOSDViewer({
    containerRef,
    scanId:              activeScanId,
    slideInfo,
    token,
    onZoom:              setZoom,
    osdRef,
    onReady:             handleOSDReady,
    disableDblClickZoom: true,
  })

  // ── Gamma filter ───────────────────────────────────────────────────────────
  useGammaFilter(gamma)

  // ── Ruler tool ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!isRulerActive || !osdRef.current) return
    return attachRuler(osdRef.current, parseFloat(slideInfo?.mpp_x))
  }, [isRulerActive, slideInfo])

  // ── Keyboard shortcuts ─────────────────────────────────────────────────────
  useEffect(() => {
    function handler(ev) {
      if (isEditableTarget()) return
      const isMac        = navigator.platform.toUpperCase().indexOf('MAC') >= 0
      const isCmdOrCtrl  = isMac ? ev.metaKey : ev.ctrlKey
      if (isCmdOrCtrl) {
        if (ev.key.toLowerCase() === 'z') { ev.preventDefault(); ev.shiftKey ? handleRedo() : handleUndo(); return }
        if (ev.key.toLowerCase() === 'y') { ev.preventDefault(); handleRedo(); return }
      }
      const k = ev.key.toLowerCase()
      const tool = toolForEvent(ev)
      if (tool === 'ruler') { setIsRulerActive(r => !r); setActiveTool(null); return }
      if (tool)             { setActiveTool(prev => prev === tool ? null : tool); setIsRulerActive(false); return }
      if (panelForEvent(ev) === 'adjust') setShowAdjust(s => !s)
      if (k === 'h') setShowAnnotations(s => !s)
      if (k === 'o') setFillAnnotations(s => !s)
      if (ev.key === 'Escape') { setActiveTool('select'); setIsRulerActive(false) }
      if (ev.key === 'Delete' && selectedAnnIds.size > 0) handleDeleteSelected()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [selectedAnnIds])

  // ── Annotation mutation helpers ────────────────────────────────────────────
  function handleDeleteSelected() {
    if (readOnly || selectedAnnIds.size === 0) return
    const next = localAnnotationsRef.current.filter(a => !selectedAnnIds.has(a.id))
    localAnnotationsRef.current = next
    setLocalAnnotations(next)
    setSelectedAnnIds(new Set())
    triggerSave()
  }

  function handleSelectAllOfClass(classId) {
    const ids = localAnnotationsRef.current.filter(a => a.class_id === classId).map(a => a.id)
    setSelectedAnnIds(new Set(ids))
  }

  function handleAnnotationCreated(annCreate) {
    const { _replaceId, ...rest } = annCreate
    const tempId = `temp_${Date.now()}_${Math.random().toString(36).slice(2)}`
    const newAnn = {
      id: tempId, project_id: Number(projectId), scan_id: activeScanId, ...rest,
      _color: classMap[rest.class_id]?.color || 'var(--gray-blue)',
      created_at: new Date().toISOString(),
    }
    const base = _replaceId
      ? localAnnotationsRef.current.filter(a => a.id !== _replaceId)
      : localAnnotationsRef.current
    const next = [...base, newAnn]
    commitAnnotationChange(next)
    setSelectedAnnIds(new Set([tempId]))
  }

  function handleDeleteAnnotation(annId) {
    if (selectedAnnIds.has(annId)) {
      handleDeleteSelected()
    } else {
      const next = localAnnotationsRef.current.filter(a => a.id !== annId)
      commitAnnotationChange(next)
    }
  }

  function handleChangeClass(annId, classId, className) {
    const targetIds = selectedAnnIds.has(annId) ? selectedAnnIds : new Set([annId])
    const next = localAnnotationsRef.current.map(a =>
      targetIds.has(a.id)
        ? { ...a, class_id: classId, class_name: className, _color: classMap[classId]?.color || 'var(--gray-blue)' }
        : a
    )
    commitAnnotationChange(next)
  }

  function handleAnnotationUpdated(annId, newGeometry) {
    if (readOnly) return
    const ann = localAnnotationsRef.current.find(a => a.id === annId)
    if (!ann) return
    const isPolygonType = ann.annotation_type === 'brush' || ann.annotation_type === 'polygon'
    if (isPolygonType && (!newGeometry.points || newGeometry.points.length === 0)) {
      handleDeleteAnnotation(annId); return
    }
    const next = localAnnotationsRef.current.map(a =>
      a.id === annId ? { ...a, geometry: newGeometry } : a
    )
    commitAnnotationChange(next)
  }

  function handleAnnotationsDeleted(ids) {
    if (readOnly || !ids.length) return
    const idSet = new Set(ids)
    const next  = localAnnotationsRef.current.filter(a => !idSet.has(a.id))
    historyPastRef.current.push(localAnnotationsRef.current)
    if (historyPastRef.current.length > 50) historyPastRef.current.shift()
    historyFutureRef.current = []
    localAnnotationsRef.current = next
    setLocalAnnotations(next)
    setSelectedAnnIds(prev => { const s = new Set(prev); ids.forEach(id => s.delete(id)); return s })
    triggerSave()
  }

  // ── Save on back-navigation ────────────────────────────────────────────────
  const handleBackToProjects = async () => {
    if (!readOnly && activeScanId) {
      clearTimeout(saveTimerRef.current)
      try {
        await enqueueSave(activeScanId, localAnnotationsRef.current)
      } catch (e) { console.error('[ProjectDetail] Failed to save on exit:', e) }
    }
    navigate('/projects')
  }

  // ── Derived ────────────────────────────────────────────────────────────────
  const filterStr  = `brightness(${brightness}%) contrast(${contrast}%) url(#sv-gamma)`
  const activeScan = projectScans.find(s => s.scan_id === activeScanId)

  if (projLoading) return (
    <div style={{ width:'100vw', height:'100vh', background:'var(--surface-dark)', display:'flex',
      alignItems:'center', justifyContent:'center', color:'var(--transparent-white-4)', fontSize:14 }}>
      Loading project…
    </div>
  )

  // ─────────────────────────────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div style={{ width:'100vw', height:'100vh', background:'var(--surface-dark)',
      display:'flex', flexDirection:'column', overflow:'hidden' }}>

      {/* ── Topbar ─────────────────────────────────────────────────────────── */}
      <div style={{
        height: 48, flexShrink: 0, background: 'var(--surface-dark-card)',
        borderBottom: '1px solid var(--border-dark)',
        display: 'flex', alignItems: 'center', gap: 10, padding: '0 14px',
      }}>
        <button onClick={handleBackToProjects} title='Back to Projects'
          style={{ display:'flex', alignItems:'center', gap:6, padding:'4px 10px',
            borderRadius:6, background:'var(--transparent-white-0)',
            border:'1px solid var(--transparent-white-1)', color:'var(--transparent-white-7)',
            cursor:'pointer', fontSize:12, fontFamily:'sans-serif' }}>
          <svg width='12' height='12' viewBox='0 0 16 16' fill='currentColor'>
            <path d='M15 8a.5.5 0 00-.5-.5H2.707l3.147-3.146a.5.5 0 10-.708-.708l-4 4a.5.5 0 000 .708l4 4a.5.5 0 00.708-.708L2.707 8.5H14.5A.5.5 0 0015 8z'/>
          </svg>
          Projects
        </button>

        <div style={{ width:1, height:18, background:'var(--transparent-white-1)' }} />
        <span style={{ fontFamily:'serif', fontSize:13, color:'var(--transparent-white-4)' }}>PathoDB</span>
        <span style={{ fontSize:11, color:'var(--transparent-white-3)' }}>·</span>
        <span style={{ fontSize:13, fontWeight:500, color:'var(--transparent-white-8)' }}>{project?.name}</span>

        {project?.project_type === 'cell_detection' && (
          <span style={{ fontSize:9, padding:'2px 8px', borderRadius:20,
            background:'var(--transparent-amber-2)', color:'var(--viewer-amber)',
            fontWeight:600, textTransform:'uppercase', letterSpacing:'0.06em' }}>
            Cell detection
          </span>
        )}
        {project?.project_type === 'region_annotation' && (
          <span style={{ fontSize:9, padding:'2px 8px', borderRadius:20,
            background:'var(--transparent-teal-2)', color:'var(--viewer-teal-light)',
            fontWeight:600, textTransform:'uppercase', letterSpacing:'0.06em' }}>
            Region annotation
          </span>
        )}
        {readOnly && (
          <span style={{ fontSize:9, padding:'2px 8px', borderRadius:20,
            background:'var(--transparent-gray-blue-2)', color:'var(--gray-blue)',
            fontWeight:600, textTransform:'uppercase', letterSpacing:'0.06em' }}>
            Read only
          </span>
        )}

        <div style={{ flex:1 }} />

        {activeTool && (
          <span style={{ fontSize:10, fontFamily:'monospace', color:'var(--text-dark-3)',
            background:'var(--transparent-white-0)', padding:'2px 8px', borderRadius:4 }}>
            {activeTool}
          </span>
        )}

        {activeScan && (
          <div style={{ display:'flex', alignItems:'center', gap:12 }}>
            <span style={{ fontSize:11, fontFamily:'monospace', color:'var(--text-dark-3)' }}>
              {activeScan.lis_submission_id}
            </span>
            <span style={{ fontSize:11, fontFamily:'monospace', color:'var(--text-dark-2)', fontWeight:600 }}>
              {activeScan.stain_name}
            </span>
            {zoom && (
              <span style={{ fontSize:10, fontFamily:'monospace', color:'var(--transparent-white-3)',
                background:'var(--transparent-white-0)', padding:'1px 6px', borderRadius:3 }}>
                {zoom}×
              </span>
            )}
          </div>
        )}

        {saveError && (
          <div style={{ display:'flex', alignItems:'center', gap:5, fontSize:10,
            color:'var(--viewer-red)', background:'var(--transparent-crimson-1)',
            border:'1px solid var(--transparent-crimson-3)', padding:'3px 8px', borderRadius:4 }}>
            ⚠ {saveError}
            <button onClick={() => setSaveError('')}
              style={{ background:'none', border:'none', color:'var(--viewer-red)', cursor:'pointer', fontSize:12, lineHeight:1 }}>×</button>
          </div>
        )}
        {!saveError && (saving || pendingSave) && (
          <div style={{ display:'flex', alignItems:'center', gap:5, fontSize:10, color:'var(--viewer-amber)' }}>
            <div style={{ width:7, height:7, borderRadius:'50%',
              border:'1.5px solid var(--viewer-amber)', borderTopColor:'transparent',
              animation:'spin 0.7s linear infinite' }} />
            {saving ? 'Saving…' : 'Pending…'}
          </div>
        )}
        {!saveError && !saving && !pendingSave && localAnnotations.length > 0 && (
          <div style={{ fontSize:10, color:'var(--viewer-teal)', display:'flex', alignItems:'center', gap:4 }}>
            <svg width='10' height='10' viewBox='0 0 16 16' fill='currentColor'>
              <path d='M13.854 3.646a.5.5 0 010 .708l-7 7a.5.5 0 01-.708 0l-3.5-3.5a.5.5 0 11.708-.708L6.5 10.293l6.646-6.647a.5.5 0 01.708 0z'/>
            </svg>
            Saved
          </div>
        )}

        {!readOnly && (
          <button 
            onClick={() => setShowBatchAIModal(true)}
            style={{ display:'flex', alignItems:'center', gap:5, padding:'5px 12px', 
              background: 'var(--transparent-purple-2)', color: 'var(--purple-80)', 
              border: '1px solid var(--transparent-purple-3)', borderRadius: 6, 
              fontSize: 11, fontWeight: 600, cursor: 'pointer', fontFamily:'sans-serif' }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
            Batch AI
          </button>
        )}

        {!readOnly && (
          <button onClick={() => setShowImportModal(true)}
            style={{ display:'flex', alignItems:'center', gap:5, padding:'5px 12px',
              borderRadius:6, background:'var(--transparent-white-0)',
              border:'1px solid var(--transparent-white-2)', color:'var(--transparent-white-8)',
              cursor:'pointer', fontSize:11, fontFamily:'sans-serif' }}>
            <svg width='12' height='12' viewBox='0 0 16 16' fill='currentColor'>
              <path d='M8 12a.5.5 0 00.5-.5V4.707l2.146 2.147a.5.5 0 00.708-.708l-3-3a.5.5 0 00-.708 0l-3 3a.5.5 0 10.708.708L7.5 4.707V11.5a.5.5 0 00.5.5z'/>
              <path d='M1 14.5A1.5 1.5 0 002.5 16h11a1.5 1.5 0 001.5-1.5v-2a.5.5 0 00-1 0v2a.5.5 0 01-.5.5h-11a.5.5 0 01-.5-.5v-2a.5.5 0 00-1 0v2z'/>
            </svg>
            Import
          </button>
        )}        

        <button onClick={() => api.exportProject(projectId)}
          style={{ display:'flex', alignItems:'center', gap:5, padding:'5px 12px',
            borderRadius:6, background:'var(--transparent-teal-2)',
            border:'1px solid var(--transparent-teal-3)', color:'var(--viewer-teal-light)',
            cursor:'pointer', fontSize:11, fontFamily:'sans-serif' }}>
          <svg width='11' height='11' viewBox='0 0 16 16' fill='currentColor'>
            <path d='M.5 9.9a.5.5 0 01.5.5v2.5a1 1 0 001 1h12a1 1 0 001-1v-2.5a.5.5 0 011 0v2.5a2 2 0 01-2 2H2a2 2 0 01-2-2v-2.5a.5.5 0 01.5-.5z'/>
            <path d='M7.646 11.854a.5.5 0 00.708 0l3-3a.5.5 0 00-.708-.708L8.5 10.293V1.5a.5.5 0 00-1 0v8.793L5.354 8.146a.5.5 0 10-.708.708l3 3z'/>
          </svg>
          Export
        </button>
      </div>

      {/* ── Body ───────────────────────────────────────────────────────────── */}
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
          showAnnotations={showAnnotations} setShowAnnotations={setShowAnnotations}
          fillAnnotations={fillAnnotations} setFillAnnotations={setFillAnnotations}
        />

        {/* Canvas area */}
        <div style={{ flex:1, position:'relative', overflow:'hidden' }}>
          {!activeScanId && (
            <div style={{ position:'absolute', inset:0, display:'flex',
              alignItems:'center', justifyContent:'center',
              color:'var(--transparent-white-3)', fontSize:13 }}>
              Select a slide from the tray
            </div>
          )}

          <div style={{ width:'100%', height:'100%', filter:filterStr }}>
            <div ref={containerRef} style={{ width:'100%', height:'100%' }} />
          </div>

          {activeScanId && (
            <AnnotationLayer
              osdRef={osdRef}
              activeTool={activeTool}
              activeClass={activeClass}
              brushRadius={brushRadius}
              setBrushRadius={setBrushRadius}
              annotations={localAnnotations}
              selectedAnnIds={selectedAnnIds}
              onAnnotationClick={ann => {
                const isShift = isShiftDownRef.current
                const isAlt   = isAltDownRef.current
                if (!ann) { if (!isShift) setSelectedAnnIds(new Set()); return }
                if (isAlt) {
                  const sameClassIds = localAnnotationsRef.current
                    .filter(a => a.class_id === ann.class_id).map(a => a.id)
                  setSelectedAnnIds(prev => {
                    const next = isShift ? new Set(prev) : new Set()
                    sameClassIds.forEach(id => next.add(id))
                    return next
                  })
                  return
                }
                setSelectedAnnIds(prev => {
                  const next = new Set(prev)
                  if (isShift) { if (next.has(ann.id)) next.delete(ann.id); else next.add(ann.id) }
                  else { next.clear(); next.add(ann.id) }
                  return next
                })
              }}
              onAnnotationCreated={handleAnnotationCreated}
              onAnnotationUpdated={handleAnnotationUpdated}
              onAnnotationsDeleted={handleAnnotationsDeleted}
              readOnly={readOnly}
              tick={tick}
              showAnnotations={showAnnotations}
              fillAnnotations={fillAnnotations}
              rtreeRef={rtreeRef}
            />
          )}

          {activeTool && activeTool !== 'select' && !readOnly && (
            <div style={{
              position:'absolute', bottom:16, left:'50%', transform:'translateX(-50%)',
              background:'var(--transparent-black-8)', color:'var(--transparent-white-7)',
              fontSize:11, padding:'5px 14px', borderRadius:20, pointerEvents:'none',
              fontFamily:'sans-serif',
            }}>
              {activeTool === 'polygon'   && 'Click to add vertices · Double-click or click first point to close'}
              {activeTool === 'rectangle' && 'Click and drag to draw rectangle'}
              {activeTool === 'ellipse'   && 'Click and drag to draw ellipse'}
              {activeTool === 'point'     && 'Click to place point'}
              {activeTool === 'brush'     && 'Drag to paint · drag on existing annotation to expand it'}
            </div>
          )}

          {/* AI ROI active hint — shown when AI_ROI_CLASS is the active drawing class */}
          {activeClass?.id === AI_ROI_CLASS.id && activeTool && activeTool !== 'select' && (
            <div style={{
              position: 'absolute', top: 12, left: '50%', transform: 'translateX(-50%)',
              background: 'var(--transparent-purple-2)',
              border: '1px solid var(--transparent-purple-3)',
              color: 'var(--purple-80)', fontSize: 11,
              padding: '4px 14px', borderRadius: 20, pointerEvents: 'none',
              fontFamily: 'sans-serif', display: 'flex', alignItems: 'center', gap: 6,
            }}>
              <div style={{ width: 6, height: 6, borderRadius: 2, background: 'var(--purple-80)' }} />
              Drawing AI Model ROI — switch to the AI tab to run analysis
            </div>
          )}
        </div>

        {/* ── ClassPanel — now includes AI tab ─────────────────────────────── */}
        <ClassPanel
          classes={project?.classes || []}
          activeClass={activeClass}
          setActiveClass={setActiveClass}
          annotations={localAnnotations}
          selectedAnnIds={selectedAnnIds}
          onSelectAllOfClass={handleSelectAllOfClass}
          onSelectAnnotation={(id, isShift, isAlt) => {
            if (isAlt) {
              const ann = localAnnotations.find(a => a.id === id)
              if (!ann) return
              const sameClassIds = localAnnotations.filter(a => a.class_id === ann.class_id).map(a => a.id)
              setSelectedAnnIds(prev => {
                const next = isShift ? new Set(prev) : new Set()
                sameClassIds.forEach(i => next.add(i))
                return next
              })
              return
            }
            setSelectedAnnIds(prev => {
              const next = new Set(prev)
              if (isShift) { if (next.has(id)) next.delete(id); else next.add(id) }
              else { next.clear(); next.add(id) }
              return next
            })
          }}
          onDeleteAnnotation={handleDeleteAnnotation}
          onChangeClass={handleChangeClass}
          readOnly={readOnly}
          annotationCount={localAnnotations.length}
          totalScans={progress?.total_scans     || projectScans.length}
          annotatedScans={progress?.annotated_scans || 0}
          // ── AI model props ──────────────────────────────────────────────
          catalog={catalog}
          scanId={activeScanId}
          aiRoiAnnotations={aiRoiAnnotations}
          onAutoImport={handleAutoImport}
          onSetActiveClass={cls => {
            setActiveClass(cls)
            // Auto-switch to a drawing tool if none is active
            if (!activeTool || activeTool === 'select') setActiveTool('polygon')
          }}
          onOpenManageClasses={() => setShowManageClasses(true)}
        />
      </div>

      <ImportModal
        isOpen={showImportModal}
        onClose={() => setShowImportModal(false)}
        onImport={handleImportGeoJSON}
        projectClasses={project?.classes || []}
      />
      <BatchAIModal 
        isOpen={showBatchAIModal} 
        onClose={() => setShowBatchAIModal(false)} 
        projectId={Number(projectId)}
        projectClasses={project?.classes || []} // <--- Pass classes directly
        projectScans={projectScans}             // <--- Pass scans directly
      />
      <ManageClassesModal 
        isOpen={showManageClasses} 
        onClose={() => setShowManageClasses(false)} 
        project={project} 
      />
    </div>
  )
}