import { useState, useRef, useEffect } from 'react'
import { elementToImage, imageToElement } from '../../../hooks/useOSDViewer'
import {
  hitVertexHandle, hitRectHandle, hitEllipseHandle, hitTestBody,
  translateGeometry, applyRectHandle, applyEllipseHandle, dist,
  CLOSE_THRESH, FREEHAND_THRESH, FREEHAND_GAP, MOVE_THRESH,
  MIN_DRAG, circlePoly, capsulePoly, polygonContains
} from '../../../lib/annotationMath'
import { union, difference, constrainToBounds, fillHoles, simplify, roundCoordinates, validateTopology } from '../../../lib/PolygonOps'

// ─── 1. Select Tool Hook ──────────────────────────────────────────────────────
export function useSelectTool({ osdRef, annotations, selectedAnnId, onAnnotationClick, onAnnotationUpdated, readOnly }) {
  const [activeDrag, setActiveDrag] = useState(null)
  const activeDragRef = useRef(null)

  function setDragState(val) { activeDragRef.current = val; setActiveDrag(val) }

  useEffect(() => { if (activeDragRef.current) setDragState(null) }, [selectedAnnId])

  function onPointerDown(e, el, img, suppressClickRef, pendingDeselectRef) {
    const v = osdRef.current
    const selAnn = selectedAnnId ? annotations.find(a => a.id === selectedAnnId) : null

    if (!readOnly && selAnn && (selAnn.annotation_type === 'polygon' || selAnn.annotation_type === 'brush')) {
      const rawPts = selAnn.geometry?.points || []
      const is2D = Array.isArray(rawPts[0])
      const exterior = is2D ? rawPts[0] : rawPts
      
      const hit = hitVertexHandle(v, selAnn, el)
      if (hit) {
        if (hit.type === 'vertex' && e.altKey) {
          if (exterior.length > 3) {
            const newExt = exterior.filter((_, i) => i !== hit.idx)
            onAnnotationUpdated?.(selAnn.id, { points: is2D ? [newExt, ...rawPts.slice(1)] : newExt })
          }
          suppressClickRef.current = true; return true
        }
        if (hit.type === 'midpoint') {
          const a = hit.idx, b = (hit.idx + 1) % exterior.length
          const ins = { x: (exterior[a].x + exterior[b].x) / 2, y: (exterior[a].y + exterior[b].y) / 2 }
          const newExt = [...exterior.slice(0, a + 1), ins, ...exterior.slice(a + 1)]
          const finalPts = is2D ? [newExt, ...rawPts.slice(1)] : newExt
          setDragState({ kind: 'vtxEdit', annId: selAnn.id, pts: finalPts, idx: a + 1, is2D })
          suppressClickRef.current = true; return true
        }
        if (hit.type === 'vertex') {
          setDragState({ kind: 'vtxEdit', annId: selAnn.id, pts: rawPts, idx: hit.idx, is2D })
          suppressClickRef.current = true; return true
        }
      }
    }

    if (!readOnly && selAnn && selAnn.annotation_type === 'rectangle') {
      const hit = hitRectHandle(v, selAnn.geometry, el)
      if (hit) {
        setDragState({ kind: 'rectHandle', annId: selAnn.id, handleId: hit.id, origGeometry: selAnn.geometry, shiftKey: e.shiftKey })
        suppressClickRef.current = true; return true
      }
    }

    if (!readOnly && selAnn && selAnn.annotation_type === 'ellipse') {
      const hit = hitEllipseHandle(v, selAnn.geometry, el)
      if (hit) {
        setDragState({ kind: 'ellipseHandle', annId: selAnn.id, handleId: hit.id, origGeometry: selAnn.geometry, shiftKey: e.shiftKey })
        suppressClickRef.current = true; return true
      }
    }

    for (let i = annotations.length - 1; i >= 0; i--) {
      const ann = annotations[i]
      if (hitTestBody(v, ann, el)) {
        setDragState({ kind: 'pendingMove', annId: ann.id, startEl: el, startImg: readOnly ? null : img, origGeometry: ann.geometry, annotationType: ann.annotation_type })
        return true
      }
    }

    pendingDeselectRef.current = true
    return false
  }

  function onPointerMove(e, el) {
    const drag = activeDragRef.current
    if (!drag) return false

    if (drag.kind === 'pendingMove' && drag.startImg) {
      if (dist(el, drag.startEl) > MOVE_THRESH) {
        setDragState({ ...drag, kind: 'move' })
        if (drag.annId !== selectedAnnId) {
          const ann = annotations.find(a => a.id === drag.annId)
          if (ann) onAnnotationClick?.(ann)
        }
      }
      return true
    }

    if (drag.kind === 'vtxEdit') {
      const img = elementToImage(osdRef.current, el.x, el.y)
      if (img) {
         const newPts = drag.is2D 
           ? [ drag.pts[0].map((p, i) => i === drag.idx ? img : p), ...drag.pts.slice(1) ]
           : drag.pts.map((p, i) => i === drag.idx ? img : p)
         setDragState({ ...drag, pts: newPts })
      }
      return true
    }

    if (drag.kind === 'rectHandle' || drag.kind === 'ellipseHandle') {
      if (e.shiftKey !== drag.shiftKey) setDragState({ ...drag, shiftKey: e.shiftKey })
      return true
    }
    return false
  }

  function onPointerUp(e, mouseEl, suppressClickRef, pendingDeselectRef) {
    const drag = activeDragRef.current
    const v = osdRef.current

    if (drag) {
      if (drag.kind === 'pendingMove') {
        if (drag.annId !== selectedAnnId) {
          const ann = annotations.find(a => a.id === drag.annId)
          if (ann) onAnnotationClick?.(ann)
        }
        setDragState(null); suppressClickRef.current = true; pendingDeselectRef.current = false
        return true
      }

      if (drag.kind === 'move') {
        const curImg = mouseEl ? elementToImage(v, mouseEl.x, mouseEl.y) : null
        if (curImg && drag.startImg && !readOnly) {
          const dx = curImg.x - drag.startImg.x, dy = curImg.y - drag.startImg.y
          if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
            onAnnotationUpdated?.(drag.annId, translateGeometry(drag.annotationType, drag.origGeometry, dx, dy))
          }
        }
        setDragState(null); suppressClickRef.current = true; return true
      }

      if (drag.kind === 'vtxEdit') {
        if (!readOnly) onAnnotationUpdated?.(drag.annId, { points: drag.pts })
        setDragState(null); suppressClickRef.current = true; return true
      }

      if (drag.kind === 'rectHandle') {
        const curImg = mouseEl ? elementToImage(v, mouseEl.x, mouseEl.y) : null
        if (curImg && !readOnly) onAnnotationUpdated?.(drag.annId, applyRectHandle(drag.origGeometry, drag.handleId, curImg, drag.shiftKey))
        setDragState(null); suppressClickRef.current = true; return true
      }

      if (drag.kind === 'ellipseHandle') {
        const curImg = mouseEl ? elementToImage(v, mouseEl.x, mouseEl.y) : null
        if (curImg && !readOnly) onAnnotationUpdated?.(drag.annId, applyEllipseHandle(drag.origGeometry, drag.handleId, curImg, drag.shiftKey))
        setDragState(null); suppressClickRef.current = true; return true
      }
    }

    if (pendingDeselectRef.current) {
      pendingDeselectRef.current = false
      if (selectedAnnId) onAnnotationClick?.(null)
      suppressClickRef.current = true
      return true
    }
    return false
  }

  return { activeDrag, onPointerDown, onPointerMove, onPointerUp, cancel: () => setDragState(null) }
}

// ─── 2. Brush Tool Hook ───────────────────────────────────────────────────────
export function useBrushTool({ osdRef, activeTool, brushRadius, annotations, selectedAnnId, readOnly, onEmit }) {
  const [brushROI, setBrushROI] = useState(null)
  const [brushLimitsV, setBrushLimitsV] = useState(false)
  const brushROIRef = useRef(null)
  const lastBrushPt = useRef(null)
  const editingAnn = useRef(null)
  const subtractMode = useRef(false)
  const brushDown = useRef(false)
  const pressureRef = useRef(1.0)

  // REMOVED async effect: useEffect(() => { brushROIRef.current = brushROI }, [brushROI])

  useEffect(() => { if (activeTool !== 'brush') cancel() }, [activeTool])
  
  useEffect(() => {
    if (activeTool !== 'brush') return
    const h = ev => { 
      if ((ev.key === 'f' || ev.key === 'F') && brushROIRef.current) {
        // SYNCHRONOUS UPDATE
        const next = fillHoles(brushROIRef.current)
        brushROIRef.current = next
        setBrushROI(next)
      } 
    }
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [activeTool])

  function effectiveBrushR() { return brushRadius * pressureRef.current }

  function applyBrush(geom, current) {
    let next = subtractMode.current ? difference(current, geom) : union(current, geom)
    let validState = next;

    const totalPts = Array.isArray(validState[0]) ? validState.reduce((sum, ring) => sum + ring.length, 0) : validState.length;
    if (totalPts > 8) {
       let simplified = simplify(validState, 0.1)
       if (validateTopology(simplified)) validState = simplified;
    }

    let rounded = roundCoordinates(validState)
    if (validateTopology(rounded)) validState = rounded;

    const info = osdRef.current?.source
    if (info?.width && info?.height) {
       validState = constrainToBounds(validState, info.width, info.height)
    }
    return validState
  }

  function findEditableAnnUnder(img) {
    for (const ann of [...annotations].reverse()) {
      if (ann.annotation_type !== 'brush' && ann.annotation_type !== 'polygon') continue
      const pts = ann.geometry?.points || []
      if (!pts.length) continue
      const ring = Array.isArray(pts[0]) ? pts[0] : pts
      const xs = ring.map(p => p.x), ys = ring.map(p => p.y)
      if (img.x < Math.min(...xs) || img.x > Math.max(...xs) || img.y < Math.min(...ys) || img.y > Math.max(...ys)) continue
      if (polygonContains(ring, img)) return ann
    }
    return null
  }

  function onPointerDown(e, img) {
    if (readOnly) return
    brushDown.current = true
    subtractMode.current = e.altKey || (e.pointerType === 'pen' && (e.buttons & 32))
    pressureRef.current = (e.pressure && e.pressure > 0) ? e.pressure : 1.0

    let existing = findEditableAnnUnder(img)
    if (subtractMode.current && !existing && selectedAnnId) {
      const sel = annotations.find(a => a.id === selectedAnnId)
      if (sel && (sel.annotation_type === 'brush' || sel.annotation_type === 'polygon')) existing = sel
    }

    const startROI = existing ? (existing.geometry?.points || []) : []
    editingAnn.current = existing || null
    
    // SYNCHRONOUS UPDATE
    const nextROI = applyBrush(circlePoly(img.x, img.y, effectiveBrushR()), startROI)
    brushROIRef.current = nextROI
    setBrushROI(nextROI)
    
    lastBrushPt.current = img
  }

  function onPointerMove(e, img) {
    setBrushLimitsV(true)
    if (!brushDown.current || readOnly) return
    pressureRef.current = (e.pressure && e.pressure > 0) ? e.pressure : pressureRef.current
    const r = effectiveBrushR(), last = lastBrushPt.current
    const geom = (!last || (Math.abs(last.x - img.x) < 0.5 && Math.abs(last.y - img.y) < 0.5)) ? circlePoly(img.x, img.y, r) : capsulePoly(last.x, last.y, img.x, img.y, r)
    
    // SYNCHRONOUS UPDATE
    const currentROI = brushROIRef.current || []
    const nextROI = applyBrush(geom, currentROI)
    brushROIRef.current = nextROI
    setBrushROI(nextROI)
    
    lastBrushPt.current = img
  }

  function onPointerUp() {
    if (!brushDown.current || readOnly) return
    brushDown.current = false
    const final = brushROIRef.current || []
    
    if (final.length >= 3 || (Array.isArray(final[0]) && final[0].length >= 3)) {
      onEmit(editingAnn.current ? { annotation_type: 'brush', geometry: { points: final }, _replaceId: editingAnn.current.id } : { annotation_type: 'brush', geometry: { points: final } })
    } else if (editingAnn.current && final.length < 3) {
      // NOTE: Parent (AnnotationLayer) handles sending this to the backend
      onEmit({ annotation_type: 'brush', geometry: { points: [] }, _replaceId: editingAnn.current.id })
    }
    
    // SYNCHRONOUS CLEANUP
    brushROIRef.current = null
    setBrushROI(null)
    lastBrushPt.current = null
    editingAnn.current = null
    subtractMode.current = false
  }

  function cancel() { 
    brushDown.current = false; 
    brushROIRef.current = null; // SYNCHRONOUS CLEANUP
    setBrushROI(null); 
    lastBrushPt.current = null; 
    editingAnn.current = null; 
    setBrushLimitsV(false) 
  }

  return { brushROI, brushLimitsV, editingAnn, subtractMode, pressureRef, onPointerDown, onPointerMove, onPointerUp, onPointerLeave: cancel, cancel }
}

// ─── 3. Polygon Tool Hook ─────────────────────────────────────────────────────
export function usePolygonTool({ osdRef, activeTool, readOnly, onEmit }) {
  const [polyPts, setPolyPts] = useState([])
  const polyRef = useRef([])
  const polyDownRef = useRef(false)
  const polyPressElRef = useRef(null)
  const polyFreehandRef = useRef(false)

  // Polygon arrays are small enough and clicks are slow enough that useState syncing is safe here
  useEffect(() => { polyRef.current = polyPts }, [polyPts])
  
  useEffect(() => { if (activeTool !== 'polygon') cancel() }, [activeTool])
  
  useEffect(() => {
    if (activeTool !== 'polygon') return
    const h = ev => {
      if (ev.key !== 'Backspace' || ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return
      ev.preventDefault()
      if (polyRef.current.length) setPolyPts(polyRef.current.slice(0, -1))
    }
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [activeTool])

  function onClick(e, el, img) {
    if (e.detail >= 2 || polyFreehandRef.current) return
    const cur = polyRef.current
    if (cur.length >= 3) {
      const firstEl = imageToElement(osdRef.current, cur[0].x, cur[0].y)
      if (firstEl && dist(el, firstEl) <= CLOSE_THRESH) {
        onEmit({ annotation_type: 'polygon', geometry: { points: cur } })
        setPolyPts([]); return
      }
    }
    setPolyPts([...cur, img])
  }

  function onDoubleClick(e) {
    e.stopPropagation()
    const cur = polyRef.current
    if (cur.length >= 3) onEmit({ annotation_type: 'polygon', geometry: { points: cur } })
    cancel()
  }

  function onPointerDown(e, el) { polyDownRef.current = true; polyPressElRef.current = el; polyFreehandRef.current = false }

  function onPointerMove(e, el, img) {
    if (!polyDownRef.current) return
    const pressEl = polyPressElRef.current; if (!pressEl) return

    if (!polyFreehandRef.current) {
      if (polyRef.current.length > 0) return
      if (Math.hypot(el.x - pressEl.x, el.y - pressEl.y) < FREEHAND_THRESH) return
      polyFreehandRef.current = true
      const si = elementToImage(osdRef.current, pressEl.x, pressEl.y)
      if (si) setPolyPts([si])
    }
    const cur = polyRef.current
    if (cur.length > 0) {
      const lastEl = imageToElement(osdRef.current, cur[cur.length - 1].x, cur[cur.length - 1].y)
      if (lastEl && dist(el, lastEl) < FREEHAND_GAP) return
    }
    setPolyPts([...cur, img])
  }

  function onPointerUp() {
    if (polyFreehandRef.current && polyRef.current.length >= 3) {
      onEmit({ annotation_type: 'polygon', geometry: { points: polyRef.current } })
      setPolyPts([])
    }
    cancel()
  }

  function cancel() { setPolyPts([]); polyDownRef.current = false; polyFreehandRef.current = false; polyPressElRef.current = null }

  return { polyPts, polyFreehandRef, onClick, onDoubleClick, onPointerDown, onPointerMove, onPointerUp, cancel }
}

// ─── 4. Shape (Rect/Ellipse) Tool Hook ────────────────────────────────────────
export function useShapeTool({ activeTool, onEmit }) {
  const [dragStart, setDragStart] = useState(null)
  const [dragEnd, setDragEnd] = useState(null)
  const [isShift, setIsShift] = useState(false)

  useEffect(() => { if (activeTool !== 'rectangle' && activeTool !== 'ellipse') cancel() }, [activeTool])

  useEffect(() => {
    if (!dragStart) return
    const down = e => { if (e.key === 'Shift') setIsShift(true) }
    const up   = e => { if (e.key === 'Shift') setIsShift(false) }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up) }
  }, [dragStart])

  function onPointerDown(e, img) { setDragStart(img); setDragEnd(img); setIsShift(e.shiftKey) }
  function onPointerMove(e, img) { if (dragStart) { setDragEnd(img); setIsShift(e.shiftKey) } }
  
  function onPointerUp(e) {
    if (!dragStart || !dragEnd) return
    const finalShift = e.shiftKey !== undefined ? e.shiftKey : isShift
    const dx = dragEnd.x - dragStart.x, dy = dragEnd.y - dragStart.y
    const absDx = Math.abs(dx), absDy = Math.abs(dy)
    if (absDx < MIN_DRAG && absDy < MIN_DRAG) { cancel(); return }

    let finalW = absDx, finalH = absDy
    if (finalShift) {
      const max = Math.max(absDx, absDy)
      finalW = max; finalH = max
    }
    
    const finalX = dx < 0 ? dragStart.x - finalW : dragStart.x
    const finalY = dy < 0 ? dragStart.y - finalH : dragStart.y

    if (activeTool === 'rectangle') {
      onEmit({ annotation_type: 'rectangle', geometry: { x: finalX, y: finalY, width: finalW, height: finalH } })
    } else if (activeTool === 'ellipse') {
      const cx = dragStart.x + (dx < 0 ? -finalW : finalW) / 2
      const cy = dragStart.y + (dy < 0 ? -finalH : finalH) / 2
      onEmit({ annotation_type: 'ellipse', geometry: { cx, cy, rx: finalW / 2, ry: finalH / 2 } })
    }
    cancel()
  }

  function cancel() { setDragStart(null); setDragEnd(null); setIsShift(false) }

  return { dragStart, dragEnd, isShift, onPointerDown, onPointerMove, onPointerUp, cancel }
}