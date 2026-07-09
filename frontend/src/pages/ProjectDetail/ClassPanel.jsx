// frontend/src/pages/ProjectDetail/ClassPanel.jsx

import { useState, useEffect, useRef, memo } from 'react'
import ProjectModelsPanel, { AI_ROI_CLASS } from './ProjectModelsPanel'
import { SegmentedControl, ProgressBar } from '../../components/ui'
import { shortcutGroupsFor, PROJECT_DETAIL_ACTIONS } from '../../lib/viewerKeymap'
import { useVirtualizer } from '@tanstack/react-virtual'

export default memo(function ClassPanel({
  classes,
  activeClass,
  setActiveClass,
  annotations,
  selectedAnnIds,
  onSelectAnnotation,
  onDeleteAnnotation,
  onChangeClass,
  onNoteChange,
  onSelectAllOfClass,
  readOnly,
  annotationCount,
  totalScans,
  annotatedScans,
  onOpenManageClasses,
  catalog          = [],
  scanId           = null,
  aiRoiAnnotations = [],
  onAutoImport,          // async (jobId, importMode) => number
  onSetActiveClass,      // (classObj) => void
}) {
  const [tab, setTab] = useState('classes')   // 'classes' | 'list' | 'ai'
  const listScrollRef = useRef(null)

  useEffect(() => {
    if (selectedAnnIds.size !== 1) return
    setTab('list')
    const [id] = selectedAnnIds
    setTimeout(() => {
      const el = listScrollRef.current?.querySelector(`[data-annid="${id}"]`)
      el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    }, 0)
  }, [selectedAnnIds])

  return (
    <div style={{
      width: 260, flexShrink: 0,
      background: 'var(--surface-dark-card)',
      borderLeft: '1px solid var(--border-dark)',
      display: 'flex', flexDirection: 'column',
      overflow: 'hidden',
    }}>
      {/* Header */}
      <div style={{ padding: '9px 12px', borderBottom: '1px solid var(--transparent-white-0)', flexShrink: 0 }}>
        <span style={{ fontSize: 9, color: 'var(--transparent-white-5)', textTransform: 'uppercase', letterSpacing: '0.1em', fontWeight: 600 }}>
          Annotations
        </span>
      </div>

      {/* Progress bar */}
      <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--transparent-white-0)', flexShrink: 0 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
          <span style={{ fontSize: 10, color: 'var(--transparent-white-4)' }}>Slides annotated</span>
          <span style={{ fontSize: 10, fontFamily: 'monospace', color: 'var(--viewer-teal-light)' }}>
            {annotatedScans}/{totalScans}
          </span>
        </div>
        <ProgressBar
          value={annotatedScans}
          max={totalScans || 1}
          height={3}
          color="var(--viewer-teal)"
          style={{ background: 'var(--transparent-white-1)' }}
        />
        <div style={{ fontSize: 10, color: 'var(--text-dark-3)', marginTop: 4 }}>
          {annotationCount} annotation{annotationCount !== 1 ? 's' : ''} this slide
        </div>
      </div>

      {/* Tabs */}
      <div style={{ padding: '6px 10px', borderBottom: '1px solid var(--transparent-white-0)', flexShrink: 0 }}>
        <SegmentedControl
          dark
          small
          value={tab}
          onChange={setTab}
          options={[
            { value: 'classes', label: 'Classes' },
            { value: 'list',    label: 'This slide' },
            {
              value: 'ai',
              label: (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                  AI
                  {tab !== 'ai' && aiRoiAnnotations.length > 0 && (
                    <span style={{
                      fontSize: 8, fontWeight: 700,
                      background: 'var(--purple-80)', color: 'var(--surface-dark-2)',
                      borderRadius: 6, padding: '1px 4px',
                      lineHeight: 1.4,
                    }}>
                      {aiRoiAnnotations.length}
                    </span>
                  )}
                </span>
              ),
            },
          ]}
        />
      </div>

      <div ref={listScrollRef} style={{ flex: 1, overflowY: 'auto' }}>
        {tab === 'classes' && (
          <ClassTab
            classes={classes}
            activeClass={activeClass}
            setActiveClass={setActiveClass}
            annotations={annotations}
            onSelectAllOfClass={onSelectAllOfClass}
            readOnly={readOnly}
            aiRoiAnnotations={aiRoiAnnotations}
            onSetAiClass={() => onSetActiveClass?.(AI_ROI_CLASS)}
            onOpenManageClasses={onOpenManageClasses}
          />
        )}
        {tab === 'list' && (
          <ListTab
            annotations={annotations}
            classes={classes}
            selectedAnnIds={selectedAnnIds}
            onSelect={onSelectAnnotation}
            onDelete={onDeleteAnnotation}
            onChangeClass={onChangeClass}
            onNoteChange={onNoteChange}
            readOnly={readOnly}
          />
        )}
        {tab === 'ai' && (
          <ProjectModelsPanel
            catalog={catalog}
            scanId={scanId}
            onAutoImport={onAutoImport}
            aiRoiAnnotations={aiRoiAnnotations}
            onSetActiveClass={onSetActiveClass}
            readOnly={readOnly}
          />
        )}
      </div>
    </div>
  )
})

// ── Classes tab ────────────────────────────────────────────────────────────────
function ClassTab({ classes, activeClass, setActiveClass, annotations, onSelectAllOfClass, readOnly, aiRoiAnnotations, onSetAiClass, onOpenManageClasses }) {
  const SHORTCUTS = shortcutGroupsFor(PROJECT_DETAIL_ACTIONS)
    .flatMap(g => g.items)
    .map(i => ({ key: i.keys.join('+'), label: i.label }))

  const isAiRoiActive = activeClass?.id === AI_ROI_CLASS.id

  if (!classes || classes.length === 0) {
    return (
      <div style={{ padding: 16 }}>
        {/* AI ROI system class — always shown */}
        <AiRoiClassRow
          isActive={isAiRoiActive}
          count={aiRoiAnnotations.length}
          onActivate={onSetAiClass}
          onSelectAll={() => onSelectAllOfClass?.(AI_ROI_CLASS.id)}
          readOnly={readOnly}
        />
        <div style={{ fontSize: 12, color: 'var(--text-dark-3)', textAlign: 'center', margin: '16px 0' }}>
          No classes defined for this project.
        </div>
        <ShortcutLegend shortcuts={SHORTCUTS} />
      </div>
    )
  }

  return (
    <div style={{ padding: '8px' }}>
      <div style={{ fontSize: 10, color: 'var(--text-dark-3)', marginBottom: 8, padding: '0 4px' }}>
        {readOnly ? 'Classes' : 'Select a class, then draw on the slide'}
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, padding: '0 4px' }}>
        <div style={{ fontSize: 10, color: 'var(--text-dark-3)' }}>
          {readOnly ? 'Classes' : 'Select a class, then draw on the slide'}
        </div>
        {!readOnly && (
          <button 
            onClick={onOpenManageClasses} 
            style={{ background: 'none', border: 'none', color: 'var(--viewer-teal-light)', fontSize: 10, cursor: 'pointer', padding: '0 4px', textDecoration: 'underline', textUnderlineOffset: '2px' }}
          >
            Edit
          </button>
        )}
      </div>

      <AiRoiClassRow
        isActive={isAiRoiActive}
        count={aiRoiAnnotations.length}
        onActivate={onSetAiClass}
        onSelectAll={() => onSelectAllOfClass?.(AI_ROI_CLASS.id)}
        readOnly={readOnly}
      />

      {/* Subtle separator */}
      <div style={{ height: 1, background: 'var(--transparent-white-0)', margin: '6px 0 8px' }} />

      {/* ── Project classes ─────────────────────────────────────────────────── */}
      {classes.map(cls => {
        const isActive = activeClass?.id === cls.id
        const count    = annotations.filter(a => a.class_id === cls.id).length

        return (
          <div key={cls.id} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
            <button
              onClick={() => !readOnly && setActiveClass(isActive ? null : cls)}
              disabled={readOnly}
              style={{
                flex: 1, display: 'flex', alignItems: 'center', gap: 10,
                padding: '8px 10px', borderRadius: 6,
                background: isActive ? `${cls.color}22` : 'var(--transparent-white-0)',
                border: `1.5px solid ${isActive ? cls.color : 'var(--transparent-white-1)'}`,
                cursor: readOnly ? 'default' : 'pointer',
                transition: 'all 0.15s', textAlign: 'left', minWidth: 0,
              }}
            >
              <div style={{
                width: 14, height: 14, borderRadius: 3, flexShrink: 0,
                background: cls.color, border: '1px solid var(--transparent-white-2)',
              }} />
              <span style={{
                fontSize: 12,
                color: isActive ? cls.color : 'var(--transparent-white-7)',
                flex: 1, fontWeight: isActive ? 600 : 400,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>
                {cls.name}
              </span>
              {count > 0 && (
                <span style={{
                  fontSize: 10, color: 'var(--transparent-white-5)', fontFamily: 'monospace',
                  background: 'var(--transparent-white-1)', padding: '2px 6px', borderRadius: 10,
                }}>
                  {count}
                </span>
              )}
            </button>

            {count > 0 && (
              <button
                onClick={() => onSelectAllOfClass(cls.id)}
                title={`Select all ${count} annotations`}
                style={{
                  width: 32, height: 32, flexShrink: 0, borderRadius: 6,
                  background: 'var(--transparent-white-0)',
                  border: '1px solid var(--transparent-white-1)',
                  color: 'var(--transparent-white-6)', cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  transition: 'all 0.15s',
                }}
                onMouseEnter={e => { e.currentTarget.style.background = 'var(--transparent-white-2)'; e.currentTarget.style.color = 'var(--white)' }}
                onMouseLeave={e => { e.currentTarget.style.background = 'var(--transparent-white-0)'; e.currentTarget.style.color = 'var(--transparent-white-6)' }}
              >
                <svg width='14' height='14' viewBox='0 0 16 16' fill='currentColor'>
                  <path d='M4 4h2v1.5H4.5V7H3V5a1 1 0 011-1zM12 4h-2v1.5h1.5V7H13V5a1 1 0 00-1-1zM4 12h2v-1.5H4.5V9H3v2a1 1 0 001 1zM12 12h-2v-1.5h1.5V9H13v2a1 1 0 01-1 1z'/>
                  <rect x='6.5' y='6.5' width='3' height='3' />
                </svg>
              </button>
            )}
          </div>
        )
      })}

      <div style={{ marginTop: 16, borderTop: '1px solid var(--transparent-white-0)', paddingTop: 12 }}>
        <ShortcutLegend shortcuts={SHORTCUTS} />
      </div>
    </div>
  )
}

// ── AI ROI system class row ────────────────────────────────────────────────────
function AiRoiClassRow({ isActive, count, onActivate, onSelectAll, readOnly }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
      <button
        onClick={() => !readOnly && onActivate()}
        disabled={readOnly}
        title='Draw regions for AI model analysis'
        style={{
          flex: 1, display: 'flex', alignItems: 'center', gap: 10,
          padding: '8px 10px', borderRadius: 6,
          background: isActive ? 'var(--transparent-purple-1)' : 'var(--transparent-purple-1)',
          border: `1.5px solid ${isActive ? 'var(--purple-80)' : 'var(--transparent-purple-2)'}`,
          cursor: readOnly ? 'default' : 'pointer',
          transition: 'all 0.15s', textAlign: 'left', minWidth: 0,
        }}
      >
        {/* Violet square with "AI" glyph */}
        <div style={{
          width: 14, height: 14, borderRadius: 3, flexShrink: 0,
          background: 'var(--purple-80)', border: '1px solid var(--transparent-white-2)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <svg width='9' height='9' viewBox='0 0 16 16' fill='white'>
            <path d='M5 3l-1 10M11 3l1 10M3 8h10M2 5.5h12M2 10.5h12' stroke='white' strokeWidth='2.2' strokeLinecap='round'/>
          </svg>
        </div>
        <span style={{
          fontSize: 12,
          color: isActive ? 'var(--purple-80)' : 'var(--text-dark-2)',
          flex: 1, fontWeight: isActive ? 600 : 400,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          AI Model ROI
        </span>
        {/* System badge */}
        <span style={{
          fontSize: 8, padding: '1px 5px', borderRadius: 3,
          background: 'var(--transparent-purple-1)',
          color: 'var(--transparent-purple-7)',
          border: '1px solid var(--transparent-purple-2)',
          fontWeight: 600, letterSpacing: '0.04em',
          flexShrink: 0,
        }}>
          SYSTEM
        </span>
        {count > 0 && (
          <span style={{
            fontSize: 10, color: 'var(--purple-80)', fontFamily: 'monospace',
            background: 'var(--transparent-purple-1)', padding: '2px 6px', borderRadius: 10,
          }}>
            {count}
          </span>
        )}
      </button>

      {count > 0 && (
        <button
          onClick={onSelectAll}
          title={`Select all ${count} AI ROI regions`}
          style={{
            width: 32, height: 32, flexShrink: 0, borderRadius: 6,
            background: 'var(--transparent-purple-1)',
            border: '1px solid var(--transparent-purple-2)',
            color: 'var(--transparent-purple-7)', cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            transition: 'all 0.15s',
          }}
          onMouseEnter={e => { e.currentTarget.style.background = 'var(--transparent-purple-2)'; e.currentTarget.style.color = 'var(--purple-80)' }}
          onMouseLeave={e => { e.currentTarget.style.background = 'var(--transparent-purple-1)'; e.currentTarget.style.color = 'var(--transparent-purple-7)' }}
        >
          <svg width='14' height='14' viewBox='0 0 16 16' fill='currentColor'>
            <path d='M4 4h2v1.5H4.5V7H3V5a1 1 0 011-1zM12 4h-2v1.5h1.5V7H13V5a1 1 0 00-1-1zM4 12h2v-1.5H4.5V9H3v2a1 1 0 001 1zM12 12h-2v-1.5h1.5V9H13v2a1 1 0 01-1 1z'/>
            <rect x='6.5' y='6.5' width='3' height='3' />
          </svg>
        </button>
      )}
    </div>
  )
}

// ── Shortcut legend ───────────────────────────────────────────────────────────
function ShortcutLegend({ shortcuts }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{
        fontSize: 9, color: 'var(--transparent-white-3)',
        textTransform: 'uppercase', letterSpacing: '0.08em',
        fontWeight: 600, marginBottom: 4,
      }}>
        Keyboard shortcuts
      </div>
      {shortcuts.map(({ key, label }) => (
        <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <kbd style={{
            fontSize: 9, fontFamily: 'monospace',
            background: 'var(--border-dark)',
            border: '1px solid var(--transparent-white-1)',
            borderRadius: 3, padding: '1px 5px',
            color: 'var(--text-dark-2)',
            minWidth: 22, textAlign: 'center', flexShrink: 0,
          }}>
            {key}
          </kbd>
          <span style={{ fontSize: 10, color: 'var(--transparent-white-3)' }}>{label}</span>
        </div>
      ))}
    </div>
  )
}

// ── List tab ──────────────────────────────────────────────────────────────────
function ListTab({ annotations, classes, selectedAnnIds, onSelect, onDelete, onChangeClass, onNoteChange, readOnly }) {
  // Build classMap including the system AI ROI class so it renders correctly
  const classMap = {
    [AI_ROI_CLASS.id]: AI_ROI_CLASS,
    ...Object.fromEntries((classes || []).map(c => [c.id, c])),
  }

  const scrollRef = useRef(null)

  const rowVirtualizer = useVirtualizer({
    count: annotations.length,
    getScrollElement: () => scrollRef.current,
    // Selected rows expand to show the note textarea — use measureElement for accuracy.
    estimateSize: (i) => selectedAnnIds.has(annotations[i]?.id) ? 110 : 46,
    overscan: 8,
  })

  if (annotations.length === 0) {
    return (
      <div style={{ padding: 16, fontSize: 12, color: 'var(--text-dark-3)', textAlign: 'center' }}>
        No annotations on this slide yet.
      </div>
    )
  }

  return (
    <div ref={scrollRef} style={{ padding: '6px', height: '100%', overflowY: 'auto' }}>
      <div style={{ position: 'relative', height: rowVirtualizer.getTotalSize() }}>
        {rowVirtualizer.getVirtualItems().map(virtualRow => {
          const ann         = annotations[virtualRow.index]
          const i           = virtualRow.index
          const cls         = classMap[ann.class_id]
          const color       = cls?.color || ann._color || 'var(--gray-blue)'
          const isSelected  = selectedAnnIds.has(ann.id)
          const isAiRoi     = ann.class_id === AI_ROI_CLASS.id
          const typeLabel   = {
            polygon:   'Poly',
            rectangle: 'Rect',
            ellipse:   'Ellipse',
            point:     'Point',
            brush:     'Brush',
          }[ann.annotation_type] || ann.annotation_type

          return (
            <div
              key={ann.id}
              data-annid={ann.id}
              ref={rowVirtualizer.measureElement}
              data-index={virtualRow.index}
              onClick={e => onSelect(ann.id, e.shiftKey, e.altKey)}
              style={{
                position: 'absolute', top: 0, left: 0, right: 0,
                transform: `translateY(${virtualRow.start}px)`,
                display: 'flex', flexDirection: 'column',
                padding: '6px 8px', borderRadius: 5, marginBottom: 3,
                background: isSelected
                  ? (isAiRoi ? 'var(--transparent-purple-1)' : 'var(--border-dark)')
                  : 'var(--transparent-white-0)',
                border: `1px solid ${isSelected
                  ? (isAiRoi ? 'var(--transparent-purple-3)' : 'var(--transparent-white-2)')
                  : 'var(--transparent-white-0)'}`,
                cursor: 'pointer',
              }}
            >
              {/* ── Top row: dot · label/meta · class picker · delete ── */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ width: 10, height: 10, borderRadius: 2, background: color, flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <span style={{ fontSize: 11, color: 'var(--transparent-white-7)', fontWeight: isSelected ? 600 : 400 }}>
                      {isAiRoi ? 'AI Model ROI' : (ann.class_name || 'Unclassified')}
                    </span>
                    {!isSelected && ann.notes && (
                      <span
                        title={ann.notes}
                        style={{ fontSize: 7, color: 'var(--viewer-teal-light)', lineHeight: 1, opacity: 0.8 }}
                      >
                        ●
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: 9, color: 'var(--transparent-white-3)', fontFamily: 'monospace' }}>
                    {typeLabel} #{ann.id ?? i + 1}
                    {ann.area_px ? ` · ${Math.round(ann.area_px).toLocaleString()}px²` : ''}
                  </div>
                </div>

                {!readOnly && isSelected && !isAiRoi && classes?.length > 0 && (
                  <select
                    onClick={e => e.stopPropagation()}
                    value={ann.class_id || ''}
                    onChange={e => {
                      const cls = classes.find(c => c.id === e.target.value)
                      onChangeClass(ann.id, e.target.value, cls?.name || '')
                    }}
                    style={{
                      fontSize: 10, background: 'var(--border-dark)',
                      border: '1px solid var(--transparent-white-2)', borderRadius: 4,
                      color: 'var(--transparent-white-7)', padding: '1px 4px',
                    }}
                  >
                    <option value=''>—</option>
                    {classes.map(c => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </select>
                )}

                {!readOnly && (
                  <button
                    onClick={e => { e.stopPropagation(); onDelete(ann.id) }}
                    title='Delete annotation (Del)'
                    style={{
                      background: 'none', border: 'none', cursor: 'pointer',
                      color: 'var(--transparent-crimson60-5)', fontSize: 13, lineHeight: 1,
                      padding: '0 2px', flexShrink: 0,
                    }}
                  >
                    ×
                  </button>
                )}
              </div>

              {/* ── Note strip — only when selected and not an AI ROI ── */}
              {isSelected && !isAiRoi && (
                <div onClick={e => e.stopPropagation()} style={{ marginTop: 6 }}>
                  <textarea
                    placeholder='Add a note…'
                    disabled={readOnly}
                    value={ann.notes || ''}
                    onChange={e => onNoteChange && onNoteChange(ann.id, e.target.value)}
                    rows={2}
                    style={{
                      width: '100%',
                      boxSizing: 'border-box',
                      resize: 'none',
                      fontSize: 10,
                      fontFamily: 'var(--font-sans)',
                      lineHeight: 1.5,
                      background: 'var(--transparent-white-0)',
                      border: '1px solid var(--transparent-white-2)',
                      borderRadius: 4,
                      color: readOnly ? 'var(--transparent-white-3)' : 'var(--transparent-white-7)',
                      padding: '4px 6px',
                      outline: 'none',
                    }}
                    onFocus={e => { if (!readOnly) e.target.style.borderColor = 'var(--viewer-teal)' }}
                    onBlur={e => { e.target.style.borderColor = 'var(--transparent-white-2)' }}
                  />
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}