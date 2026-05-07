// frontend/src/pages/ProjectDetail/AnnotationLayer.jsx
import { useState, useEffect, useRef } from 'react'
import { elementToImage, imageToElement } from '../../hooks/useOSDViewer'
import {
  toSVGPath, projectPoints, translateGeometry,
  applyRectHandle, applyEllipseHandle, dist,
  VERTEX_R, FIRST_VERTEX_R, CLOSE_THRESH,
  RECT_CURSOR, ELLIPSE_CURSOR,
  hitVertexHandle, hitRectHandle, hitEllipseHandle, hitTestBody,
} from '../../lib/annotationMath'
import { useSelectTool, useBrushTool, usePolygonTool, useShapeTool } from './hooks/useAnnotationTools'
import {
  AnnotationShape, LiveAnnotation,
  RectHandleOverlay, EllipseHandleOverlay, PolygonHandleOverlay,
} from './AnnotationShapes'
import BrushLimits from './BrushLimits'


export default function AnnotationLayer({
  osdRef, activeTool, activeClass, brushRadius, setBrushRadius,
  annotations, selectedAnnIds, onAnnotationClick, onAnnotationCreated,
  onAnnotationUpdated, readOnly, tick, showAnnotations=true, fillAnnotations=true
}) {
  const svgRef = useRef(null)
  const [mouse, setMouse] = useState(null)
  const suppressClickRef  = useRef(false)
  const pendingDeselectRef = useRef(false)
  const mouseRef = useRef(null)

  const [isSpacePan,   setIsSpacePan]   = useState(false)
  const [isMiddlePan,  setIsMiddlePan]  = useState(false)
  const isSpacePanRef  = useRef(false)
  const isMiddlePanRef = useRef(false)
  const navOverride = isSpacePan || isMiddlePan
  const singleSelectedId = selectedAnnIds.size === 1 ? Array.from(selectedAnnIds)[0] : null;
  const toolColor = activeClass?.color || '#6ee7b7'
  const select = useSelectTool({ 
    osdRef, annotations, 
    selectedAnnId: singleSelectedId, 
    onAnnotationClick, onAnnotationUpdated, readOnly, suppressClickRef, pendingDeselectRef 
  })

  function onEmit(ann) {
    if (readOnly) return
    if (ann._replaceId) {
      const original = annotations.find(a => a.id === ann._replaceId)
      if (onAnnotationCreated) {
        onAnnotationCreated({
          ...ann,
          class_id:   original?.class_id   ?? activeClass?.id,
          class_name: original?.class_name ?? activeClass?.name,
        })
      }
      return
    }
    if (onAnnotationCreated) {
      onAnnotationCreated({ ...ann, class_id: activeClass?.id, class_name: activeClass?.name })
    }
  }

  const brush  = useBrushTool({ osdRef, activeTool, brushRadius, annotations, selectedAnnId: singleSelectedId, readOnly, onEmit })
  const poly   = usePolygonTool({ osdRef, activeTool, readOnly, onEmit })
  const shape  = useShapeTool({ activeTool, onEmit })

  useEffect(() => {
    const v = osdRef.current
    if (!v?.setMouseNavEnabled) return
    v.setMouseNavEnabled(readOnly || !activeTool || navOverride)
    return () => v.setMouseNavEnabled(true)
  }, [activeTool, navOverride, osdRef, readOnly])

  useEffect(() => {
    if (!activeTool || readOnly) return
    const notInput = () => !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)
    const dn = ev => { if (ev.code !== 'Space' || !notInput()) return; ev.preventDefault(); isSpacePanRef.current = true; setIsSpacePan(true) }
    const up = ev => { if (ev.code !== 'Space') return; isSpacePanRef.current = false; setIsSpacePan(false) }
    const bl = () => { isSpacePanRef.current = false; setIsSpacePan(false) }
    window.addEventListener('keydown', dn); window.addEventListener('keyup', up); window.addEventListener('blur', bl)
    return () => { window.removeEventListener('keydown', dn); window.removeEventListener('keyup', up); window.removeEventListener('blur', bl) }
  }, [activeTool, readOnly])

  useEffect(() => {
    if (!activeTool) return
    const up = ev => { if (ev.button !== 1) return; isMiddlePanRef.current = false; setIsMiddlePan(false) }
    window.addEventListener('mouseup', up)
    return () => window.removeEventListener('mouseup', up)
  }, [activeTool])

  function getEl(e) {
    const r = svgRef.current.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  function onPointerDown(e) {
    if (e.button === 1) { isMiddlePanRef.current = true; setIsMiddlePan(true); osdRef.current?.setMouseNavEnabled(true); return }
    if (isSpacePanRef.current || isMiddlePanRef.current || e.button !== 0) return
    if (!activeTool || (readOnly && activeTool !== 'select')) return

    svgRef.current.setPointerCapture(e.pointerId)
    e.stopPropagation()
    const el  = getEl(e)
    const img = elementToImage(osdRef.current, el.x, el.y)

    if (activeTool === 'select')    select.onPointerDown(e, el, img, suppressClickRef, pendingDeselectRef)
    if (activeTool === 'brush')     brush.onPointerDown(e, img)
    if (activeTool === 'polygon')   poly.onPointerDown(e, el)
    if (activeTool === 'rectangle' || activeTool === 'ellipse') shape.onPointerDown(e, img)
  }

  function onPointerMove(e) {
    if (isSpacePanRef.current || isMiddlePanRef.current) return
    const el  = getEl(e)
    const img = elementToImage(osdRef.current, el.x, el.y)
    mouseRef.current = el      // ← sync ref updated before setState
    setMouse(el)

    if (activeTool === 'select')  select.onPointerMove(e, el)
    if (activeTool === 'brush'    && !readOnly) brush.onPointerMove(e, img)
    if (activeTool === 'polygon'  && !readOnly) poly.onPointerMove(e, el, img)
    if ((activeTool === 'rectangle' || activeTool === 'ellipse') && !readOnly) shape.onPointerMove(e, img)
  }

  function onPointerUp(e) {
    if (!activeTool || e.button !== 0) return
    const upEl = getEl(e)   // always use the actual event position, never stale state
    if (activeTool === 'select')  select.onPointerUp(e, upEl, suppressClickRef, pendingDeselectRef)
    if (activeTool === 'brush'    && !readOnly) brush.onPointerUp()
    if (activeTool === 'polygon'  && !readOnly) poly.onPointerUp()
    if ((activeTool === 'rectangle' || activeTool === 'ellipse') && !readOnly) shape.onPointerUp(e)
    svgRef.current?.releasePointerCapture?.(e.pointerId)
  }

  function onPointerLeave() { setMouse(null); brush.onPointerLeave() }
  function onPointerCancel() {
    select.cancel(); brush.cancel(); poly.cancel(); shape.cancel()
    pendingDeselectRef.current = false
    suppressClickRef.current   = false
  }

  function onClick(e) {
    if (isSpacePanRef.current || isMiddlePanRef.current) return
    if (suppressClickRef.current) { suppressClickRef.current = false; return }
    if (!activeTool || readOnly) return
    const el  = getEl(e)
    const img = elementToImage(osdRef.current, el.x, el.y)
    if (activeTool === 'polygon') poly.onClick(e, el, img)
    if (activeTool === 'point' && img) onEmit({ annotation_type: 'point', geometry: { x: img.x, y: img.y } })
  }

  function onDblClick(e) {
    if (isSpacePanRef.current || isMiddlePanRef.current || !activeTool || readOnly) return
    if (activeTool === 'polygon') poly.onDoubleClick(e)
  }

  function handleWheel(e) {
    if (e.altKey && activeTool === 'brush') {
      e.preventDefault()
      e.stopPropagation()
      setBrushRadius(r => Math.max(10, Math.min(500, Math.round(r + (e.deltaY < 0 ? 5 : -5)))))
      return
    }
    const v = osdRef.current
    if (v?.viewport) {
      e.preventDefault()
      const el       = getEl(e)
      const refPoint = v.viewport.viewerElementToViewportCoordinates(
        new window.OpenSeadragon.Point(el.x, el.y)
      )
      const factor = e.deltaY < 0
        ? (v.zoomPerScroll ?? 1.4)
        : 1 / (v.zoomPerScroll ?? 1.4)
      v.viewport.zoomBy(factor, refPoint)
    }
  }

  const wheelHandlerRef = useRef(handleWheel)
  useEffect(() => { wheelHandlerRef.current = handleWheel })

  useEffect(() => {
    const el = svgRef.current
    if (!el) return
    const handler = (e) => wheelHandlerRef.current(e)
    el.addEventListener('wheel', handler, { passive: false })
    return () => el.removeEventListener('wheel', handler)
  }, [])

  // ── Derived render state ───────────────────────────────────────────────────
  const viewer  = osdRef.current
  const livePos = mouseRef.current ?? mouse
  const curImg  = livePos ? elementToImage(viewer, livePos.x, livePos.y) : null

  const dragAnn = select.activeDrag?.annId
    ? annotations.find(a => a.id === select.activeDrag.annId) ?? null
    : null
  const selAnn = (activeTool === 'select' && singleSelectedId)
    ? annotations.find(a => a.id === singleSelectedId) ?? null
    : null

  const hiddenIds = new Set()
  if (select.activeDrag && ['move', 'vtxEdit', 'rectHandle', 'ellipseHandle'].includes(select.activeDrag.kind)) {
    hiddenIds.add(select.activeDrag.annId)
  }
  if (brush.editingAnn.current) hiddenIds.add(brush.editingAnn.current.id)

  let liveGeom = null, liveType = null, liveColor = '#6ee7b7'
  if (select.activeDrag && curImg) {
    const k = select.activeDrag.kind
    if (k === 'move' && select.activeDrag.startImg) {
      const dx = curImg.x - select.activeDrag.startImg.x
      const dy = curImg.y - select.activeDrag.startImg.y
      liveGeom  = translateGeometry(select.activeDrag.annotationType, select.activeDrag.origGeometry, dx, dy)
      liveType  = select.activeDrag.annotationType
      liveColor = dragAnn?._color || '#6ee7b7'
    } else if (k === 'rectHandle') {
      liveGeom  = applyRectHandle(select.activeDrag.origGeometry, select.activeDrag.handleId, curImg, select.activeDrag.shiftKey)
      liveType  = 'rectangle'
      liveColor = dragAnn?._color || '#6ee7b7'
    } else if (k === 'ellipseHandle') {
      liveGeom  = applyEllipseHandle(select.activeDrag.origGeometry, select.activeDrag.handleId, curImg, select.activeDrag.shiftKey)
      liveType  = 'ellipse'
      liveColor = dragAnn?._color || '#6ee7b7'
    }
  }

  const liveVtxPts   = select.activeDrag?.kind === 'vtxEdit' ? select.activeDrag.pts : null
  const overlayGeom  = (liveGeom && (select.activeDrag?.kind === 'rectHandle' || select.activeDrag?.kind === 'ellipseHandle'))
    ? liveGeom
    : selAnn?.geometry
  const overlayVtxPts = liveVtxPts
    ?? ((selAnn?.annotation_type === 'polygon' || selAnn?.annotation_type === 'brush')
        ? (selAnn.geometry?.points ?? [])
        : null)
  const showHandles = activeTool === 'select' && selAnn && !readOnly && select.activeDrag?.kind !== 'move'

  const projPolyPts = poly.polyPts
    .map(p => imageToElement(viewer, p.x, p.y))
    .filter(Boolean)
  const nearFirst = activeTool === 'polygon'
    && projPolyPts.length >= 3
    && mouse
    && dist(mouse, projPolyPts[0] ?? { x: -999, y: -999 }) <= CLOSE_THRESH

  let dragProj = null
  if (shape.dragStart && shape.dragEnd) {
    const ds = imageToElement(viewer, shape.dragStart.x, shape.dragStart.y)
    const de = imageToElement(viewer, shape.dragEnd.x,   shape.dragEnd.y)
    if (ds && de) dragProj = { ds, de }
  }

  const projBrushROI = brush.brushROI ? projectPoints(brush.brushROI, viewer) : null

  const viewRadius = () => {
    if (!viewer?.viewport) return 20
    const o = imageToElement(viewer, 0, 0)
    const f = imageToElement(viewer, brushRadius * brush.pressureRef.current, 0)
    return (o && f) ? Math.max(1, Math.abs(f.x - o.x)) : 20
  }

  const dynamicCursor = (() => {
    if (!activeTool) return 'default'
    if (navOverride) return 'grab'
    if (activeTool === 'brush') return 'none'
    if (activeTool === 'point') return 'cell'
    if (activeTool === 'polygon') return nearFirst ? 'cell' : 'crosshair'
    if (activeTool === 'rectangle' || activeTool === 'ellipse') return 'crosshair'
    if (activeTool === 'select') {
      const drag = select.activeDrag
      if (drag) {
        if (['move', 'pendingMove', 'vtxEdit'].includes(drag.kind)) return 'move'
        if (drag.kind === 'rectHandle')    return RECT_CURSOR[drag.handleId]    || 'move'
        if (drag.kind === 'ellipseHandle') return ELLIPSE_CURSOR[drag.handleId] || 'move'
      }
      if (!mouse) return 'default'
      if (selAnn && !readOnly) {
        if (selAnn.annotation_type === 'polygon' || selAnn.annotation_type === 'brush') {
          const h = hitVertexHandle(viewer, selAnn, mouse)
          if (h) return h.type === 'vertex' ? 'move' : 'cell'
        }
        if (selAnn.annotation_type === 'rectangle') {
          const h = hitRectHandle(viewer, selAnn.geometry, mouse)
          if (h) return RECT_CURSOR[h.id] || 'move'
        }
        if (selAnn.annotation_type === 'ellipse') {
          const h = hitEllipseHandle(viewer, selAnn.geometry, mouse)
          if (h) return ELLIPSE_CURSOR[h.id] || 'move'
        }
      }
      for (let i = annotations.length - 1; i >= 0; i--) {
        if (hitTestBody(viewer, annotations[i], mouse))
          return selectedAnnIds.has(annotations[i].id) ? (readOnly ? 'pointer' : 'move') : 'pointer'
      }
      return 'default'
    }
    return 'crosshair'
  })()

  return (
    <svg
      ref={svgRef}
      style={{
        position: 'absolute', inset: 0, width: '100%', height: '100%',
        pointerEvents: activeTool ? 'all' : 'none',
        cursor: dynamicCursor, zIndex: 50,
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={onPointerLeave}
      onPointerCancel={onPointerCancel}
      onClick={onClick}
      onDoubleClick={onDblClick}
    >
      {showAnnotations && annotations.filter(a => !hiddenIds.has(a.id)).map(ann => (
        <AnnotationShape key={ann.id} viewer={viewer} ann={ann} selected={selectedAnnIds.has(ann.id)} fillAnnotations={fillAnnotations}/>
      ))}

      {liveGeom && liveType && (
        <LiveAnnotation viewer={viewer} type={liveType} geometry={liveGeom} color={liveColor} />
      )}
      {liveVtxPts && dragAnn && (
        <LiveAnnotation viewer={viewer} type={dragAnn.annotation_type} geometry={{ points: liveVtxPts }} color={dragAnn._color || '#6ee7b7'} />
      )}

      {showAnnotations && showHandles && (
        <>
          {['polygon', 'brush'].includes(selAnn.annotation_type) && overlayVtxPts && (
            <PolygonHandleOverlay viewer={viewer} pts={overlayVtxPts} color={selAnn._color || '#6ee7b7'} />
          )}
          {selAnn.annotation_type === 'rectangle' && overlayGeom && (
            <RectHandleOverlay viewer={viewer} g={overlayGeom} color={selAnn._color || '#6ee7b7'} />
          )}
          {selAnn.annotation_type === 'ellipse' && overlayGeom && (
            <EllipseHandleOverlay viewer={viewer} g={overlayGeom} color={selAnn._color || '#6ee7b7'} />
          )}
        </>
      )}

      {projBrushROI && (
        <path
          d={toSVGPath(projBrushROI, true)} fillRule="evenodd"
          fill={brush.subtractMode.current ? 'rgba(230,0,46,0.15)' : toolColor + '33'}
          stroke={brush.subtractMode.current ? 'rgba(230,0,46,0.8)' : toolColor}
          strokeWidth={1.5} strokeLinejoin="round"
          style={{ pointerEvents: 'none' }}
        />
      )}

      {activeTool === 'polygon' && projPolyPts.length > 0 && (
        <g>
          {projPolyPts.length >= 3 && (
            <path d={toSVGPath(projPolyPts, true)} fill={toolColor} fillOpacity={0.25} stroke="none" />
          )}
          <path d={toSVGPath(projPolyPts, false)} fill="none" stroke={toolColor} strokeWidth={1.5} strokeLinejoin="round" />
          {mouse && (
            <>
              <line
                x1={projPolyPts[projPolyPts.length - 1].x} y1={projPolyPts[projPolyPts.length - 1].y}
                x2={mouse.x} y2={mouse.y}
                stroke={toolColor} strokeWidth={1.5} strokeDasharray="6 3" opacity={0.85}
              />
              {projPolyPts.length >= 2 && (
                <line
                  x1={mouse.x} y1={mouse.y}
                  x2={projPolyPts[0].x} y2={projPolyPts[0].y}
                  stroke={toolColor} strokeWidth={1} strokeDasharray="2 6" opacity={0.35}
                />
              )}
            </>
          )}
          {projPolyPts.map((p, i) => (
            <circle key={i} cx={p.x} cy={p.y}
              r={i === 0 ? FIRST_VERTEX_R : VERTEX_R}
              fill={i === 0 ? '#ff7c00' : toolColor} stroke="white" strokeWidth={1.5}
            />
          ))}
          {poly.polyFreehandRef.current && projPolyPts.length > 2 && (
            <text
              x={projPolyPts[projPolyPts.length - 1].x + 10}
              y={projPolyPts[projPolyPts.length - 1].y - 10}
              fill={toolColor} fontSize={10} fontFamily="monospace"
              style={{ pointerEvents: 'none', userSelect: 'none' }}
            >freehand</text>
          )}
        </g>
      )}

      {activeTool === 'rectangle' && dragProj && (() => {
        const dx = dragProj.de.x - dragProj.ds.x, dy = dragProj.de.y - dragProj.ds.y
        let w = Math.abs(dx), h = Math.abs(dy)
        if (shape.isShift) { const max = Math.max(w, h); w = max; h = max }
        const x = dx < 0 ? dragProj.ds.x - w : dragProj.ds.x
        const y = dy < 0 ? dragProj.ds.y - h : dragProj.ds.y
        return <rect x={x} y={y} width={w} height={h} fill={toolColor} fillOpacity={0.2} stroke={toolColor} strokeWidth={1.5} strokeDasharray="6 3" />
      })()}

      {activeTool === 'ellipse' && dragProj && (() => {
        const dx = dragProj.de.x - dragProj.ds.x, dy = dragProj.de.y - dragProj.ds.y
        let w = Math.abs(dx), h = Math.abs(dy)
        if (shape.isShift) { const max = Math.max(w, h); w = max; h = max }
        const cx = dragProj.ds.x + (dx < 0 ? -w : w) / 2
        const cy = dragProj.ds.y + (dy < 0 ? -h : h) / 2
        return <ellipse cx={cx} cy={cy} rx={w / 2} ry={h / 2} fill={toolColor} fillOpacity={0.2} stroke={toolColor} strokeWidth={1.5} strokeDasharray="6 3" />
      })()}

      {activeTool === 'point' && mouse && (
        <g style={{ pointerEvents: 'none' }}>
          <circle cx={mouse.x} cy={mouse.y} r={8} fill={toolColor} fillOpacity={0.3} stroke={toolColor} strokeWidth={1.5} />
          <circle cx={mouse.x} cy={mouse.y} r={2} fill={toolColor} />
        </g>
      )}

      {mouse && activeTool === 'brush' && (
        <BrushLimits cx={mouse.x} cy={mouse.y} radius={viewRadius()} subtract={brush.subtractMode.current} visible={brush.brushLimitsV} />
      )}
    </svg>
  )
}