// frontend/src/pages/ProjectDetail/ClassPanel.jsx

import { useState, memo } from 'react'
import ProjectModelsPanel, { AI_ROI_CLASS } from './ProjectModelsPanel'

export default memo(function ClassPanel({
  classes,
  activeClass,
  setActiveClass,
  annotations,
  selectedAnnIds,
  onSelectAnnotation,
  onDeleteAnnotation,
  onChangeClass,
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

  return (
    <div style={{
      width: 260, flexShrink: 0,
      background: 'rgba(2,5,18,0.98)',
      borderLeft: '1px solid rgba(255,255,255,0.07)',
      display: 'flex', flexDirection: 'column',
      overflow: 'hidden',
    }}>
      {/* Header */}
      <div style={{ padding: '9px 12px', borderBottom: '1px solid rgba(255,255,255,0.05)', flexShrink: 0 }}>
        <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.5)', textTransform: 'uppercase', letterSpacing: '0.1em', fontWeight: 600 }}>
          Annotations
        </span>
      </div>

      {/* Progress bar */}
      <div style={{ padding: '8px 12px', borderBottom: '1px solid rgba(255,255,255,0.05)', flexShrink: 0 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
          <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)' }}>Slides annotated</span>
          <span style={{ fontSize: 10, fontFamily: 'monospace', color: '#6ee7b7' }}>
            {annotatedScans}/{totalScans}
          </span>
        </div>
        <div style={{ height: 3, background: 'rgba(255,255,255,0.08)', borderRadius: 2 }}>
          <div style={{
            height: '100%', borderRadius: 2, background: '#1b998b',
            width: `${totalScans > 0 ? (annotatedScans / totalScans) * 100 : 0}%`,
            transition: 'width 0.3s',
          }} />
        </div>
        <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.35)', marginTop: 4 }}>
          {annotationCount} annotation{annotationCount !== 1 ? 's' : ''} this slide
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', borderBottom: '1px solid rgba(255,255,255,0.05)', flexShrink: 0 }}>
        {[
          ['classes', 'Classes'],
          ['list',    'This slide'],
          ['ai',      'AI'],
        ].map(([val, lbl]) => (
          <button key={val} onClick={() => setTab(val)} style={{
            flex: 1, padding: '7px 0', fontSize: 11,
            fontFamily: 'sans-serif', cursor: 'pointer', border: 'none',
            background: tab === val
              ? (val === 'ai' ? 'rgba(167,139,250,0.1)' : 'rgba(27,153,139,0.12)')
              : 'transparent',
            color: tab === val
              ? (val === 'ai' ? '#a78bfa' : '#6ee7b7')
              : 'rgba(255,255,255,0.4)',
            borderBottom: tab === val
              ? `2px solid ${val === 'ai' ? '#a78bfa' : '#1b998b'}`
              : '2px solid transparent',
            position: 'relative',
          }}>
            {lbl}
            {/* Badge: show AI ROI count on the AI tab when not active */}
            {val === 'ai' && tab !== 'ai' && aiRoiAnnotations.length > 0 && (
              <span style={{
                position: 'absolute', top: 4, right: 8,
                fontSize: 8, fontWeight: 700,
                background: '#a78bfa', color: '#0a0f1e',
                borderRadius: 6, padding: '1px 4px',
                lineHeight: 1.4,
              }}>
                {aiRoiAnnotations.length}
              </span>
            )}
          </button>
        ))}
      </div>

      <div style={{ flex: 1, overflowY: 'auto' }}>
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
  const SHORTCUTS = [
    { key: 'M', label: 'Select / move' },
    { key: 'G', label: 'Polygon' },
    { key: 'R', label: 'Rectangle' },
    { key: 'E', label: 'Ellipse' },
    { key: 'B', label: 'Brush' },
    { key: '⇧+Click', label: 'Multi-select' },
    { key: 'Alt+Click', label: 'Select all of class' },
    { key: 'CTRL+Click', label: 'Select overlapping annotation' },
    { key: 'Del', label: 'Delete selected' },
    { key: 'Esc', label: 'Deselect / Back' },
  ]

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
        <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.35)', textAlign: 'center', margin: '16px 0' }}>
          No classes defined for this project.
        </div>
        <ShortcutLegend shortcuts={SHORTCUTS} />
      </div>
    )
  }

  return (
    <div style={{ padding: '8px' }}>
      <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.35)', marginBottom: 8, padding: '0 4px' }}>
        {readOnly ? 'Classes' : 'Select a class, then draw on the slide'}
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, padding: '0 4px' }}>
        <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.35)' }}>
          {readOnly ? 'Classes' : 'Select a class, then draw on the slide'}
        </div>
        {!readOnly && (
          <button 
            onClick={onOpenManageClasses} 
            style={{ background: 'none', border: 'none', color: '#6ee7b7', fontSize: 10, cursor: 'pointer', padding: '0 4px', textDecoration: 'underline', textUnderlineOffset: '2px' }}
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
      <div style={{ height: 1, background: 'rgba(255,255,255,0.05)', margin: '6px 0 8px' }} />

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
                background: isActive ? `${cls.color}22` : 'rgba(255,255,255,0.03)',
                border: `1.5px solid ${isActive ? cls.color : 'rgba(255,255,255,0.08)'}`,
                cursor: readOnly ? 'default' : 'pointer',
                transition: 'all 0.15s', textAlign: 'left', minWidth: 0,
              }}
            >
              <div style={{
                width: 14, height: 14, borderRadius: 3, flexShrink: 0,
                background: cls.color, border: '1px solid rgba(255,255,255,0.2)',
              }} />
              <span style={{
                fontSize: 12,
                color: isActive ? cls.color : 'rgba(255,255,255,0.7)',
                flex: 1, fontWeight: isActive ? 600 : 400,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>
                {cls.name}
              </span>
              {count > 0 && (
                <span style={{
                  fontSize: 10, color: 'rgba(255,255,255,0.5)', fontFamily: 'monospace',
                  background: 'rgba(255,255,255,0.08)', padding: '2px 6px', borderRadius: 10,
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
                  background: 'rgba(255,255,255,0.05)',
                  border: '1px solid rgba(255,255,255,0.1)',
                  color: 'rgba(255,255,255,0.6)', cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  transition: 'all 0.15s',
                }}
                onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.15)'; e.currentTarget.style.color = '#fff' }}
                onMouseLeave={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.05)'; e.currentTarget.style.color = 'rgba(255,255,255,0.6)' }}
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

      <div style={{ marginTop: 16, borderTop: '1px solid rgba(255,255,255,0.05)', paddingTop: 12 }}>
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
          background: isActive ? 'rgba(167,139,250,0.13)' : 'rgba(167,139,250,0.04)',
          border: `1.5px solid ${isActive ? '#a78bfa' : 'rgba(167,139,250,0.2)'}`,
          cursor: readOnly ? 'default' : 'pointer',
          transition: 'all 0.15s', textAlign: 'left', minWidth: 0,
        }}
      >
        {/* Violet square with "AI" glyph */}
        <div style={{
          width: 14, height: 14, borderRadius: 3, flexShrink: 0,
          background: '#a78bfa', border: '1px solid rgba(255,255,255,0.2)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <svg width='9' height='9' viewBox='0 0 16 16' fill='white'>
            <path d='M5 3l-1 10M11 3l1 10M3 8h10M2 5.5h12M2 10.5h12' stroke='white' strokeWidth='2.2' strokeLinecap='round'/>
          </svg>
        </div>
        <span style={{
          fontSize: 12,
          color: isActive ? '#a78bfa' : 'rgba(255,255,255,0.55)',
          flex: 1, fontWeight: isActive ? 600 : 400,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          AI Model ROI
        </span>
        {/* System badge */}
        <span style={{
          fontSize: 8, padding: '1px 5px', borderRadius: 3,
          background: 'rgba(167,139,250,0.12)',
          color: 'rgba(167,139,250,0.7)',
          border: '1px solid rgba(167,139,250,0.18)',
          fontWeight: 600, letterSpacing: '0.04em',
          flexShrink: 0,
        }}>
          SYSTEM
        </span>
        {count > 0 && (
          <span style={{
            fontSize: 10, color: '#a78bfa', fontFamily: 'monospace',
            background: 'rgba(167,139,250,0.12)', padding: '2px 6px', borderRadius: 10,
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
            background: 'rgba(167,139,250,0.06)',
            border: '1px solid rgba(167,139,250,0.18)',
            color: 'rgba(167,139,250,0.7)', cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            transition: 'all 0.15s',
          }}
          onMouseEnter={e => { e.currentTarget.style.background = 'rgba(167,139,250,0.18)'; e.currentTarget.style.color = '#a78bfa' }}
          onMouseLeave={e => { e.currentTarget.style.background = 'rgba(167,139,250,0.06)'; e.currentTarget.style.color = 'rgba(167,139,250,0.7)' }}
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
        fontSize: 9, color: 'rgba(255,255,255,0.25)',
        textTransform: 'uppercase', letterSpacing: '0.08em',
        fontWeight: 600, marginBottom: 4,
      }}>
        Keyboard shortcuts
      </div>
      {shortcuts.map(({ key, label }) => (
        <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <kbd style={{
            fontSize: 9, fontFamily: 'monospace',
            background: 'rgba(255,255,255,0.07)',
            border: '1px solid rgba(255,255,255,0.14)',
            borderRadius: 3, padding: '1px 5px',
            color: 'rgba(255,255,255,0.55)',
            minWidth: 22, textAlign: 'center', flexShrink: 0,
          }}>
            {key}
          </kbd>
          <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.3)' }}>{label}</span>
        </div>
      ))}
    </div>
  )
}

// ── List tab ──────────────────────────────────────────────────────────────────
function ListTab({ annotations, classes, selectedAnnIds, onSelect, onDelete, onChangeClass, readOnly }) {
  // Build classMap including the system AI ROI class so it renders correctly
  const classMap = {
    [AI_ROI_CLASS.id]: AI_ROI_CLASS,
    ...Object.fromEntries((classes || []).map(c => [c.id, c])),
  }

  if (annotations.length === 0) {
    return (
      <div style={{ padding: 16, fontSize: 12, color: 'rgba(255,255,255,0.35)', textAlign: 'center' }}>
        No annotations on this slide yet.
      </div>
    )
  }

  return (
    <div style={{ padding: '6px' }}>
      {annotations.map((ann, i) => {
        const cls        = classMap[ann.class_id]
        const color      = cls?.color || ann._color || '#94a3b8'
        const isSelected = selectedAnnIds.has(ann.id)
        const isAiRoi    = ann.class_id === AI_ROI_CLASS.id
        const typeLabel  = {
          polygon:   'Poly',
          rectangle: 'Rect',
          ellipse:   'Ellipse',
          point:     'Point',
          brush:     'Brush',
        }[ann.annotation_type] || ann.annotation_type

        return (
          <div
            key={ann.id}
            onClick={e => onSelect(ann.id, e.shiftKey, e.altKey)}
            style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '6px 8px', borderRadius: 5, marginBottom: 3,
              background: isSelected
                ? (isAiRoi ? 'rgba(167,139,250,0.1)' : 'rgba(255,255,255,0.07)')
                : 'rgba(255,255,255,0.02)',
              border: `1px solid ${isSelected
                ? (isAiRoi ? 'rgba(167,139,250,0.3)' : 'rgba(255,255,255,0.15)')
                : 'rgba(255,255,255,0.05)'}`,
              cursor: 'pointer',
            }}
          >
            <div style={{ width: 10, height: 10, borderRadius: 2, background: color, flexShrink: 0 }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.7)', fontWeight: isSelected ? 600 : 400 }}>
                {isAiRoi ? 'AI Model ROI' : (ann.class_name || 'Unclassified')}
              </div>
              <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.3)', fontFamily: 'monospace' }}>
                {typeLabel} #{ann.id ?? i + 1}
                {ann.area_px ? ` · ${Math.round(ann.area_px).toLocaleString()}px²` : ''}
              </div>
            </div>

            {/* Class reassign: hide for AI ROI annotations (system class) */}
            {!readOnly && isSelected && !isAiRoi && classes?.length > 0 && (
              <select
                onClick={e => e.stopPropagation()}
                value={ann.class_id || ''}
                onChange={e => {
                  const cls = classes.find(c => c.id === e.target.value)
                  onChangeClass(ann.id, e.target.value, cls?.name || '')
                }}
                style={{
                  fontSize: 10, background: 'rgba(255,255,255,0.07)',
                  border: '1px solid rgba(255,255,255,0.15)', borderRadius: 4,
                  color: 'rgba(255,255,255,0.7)', padding: '1px 4px',
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
                  color: 'rgba(255,100,100,0.5)', fontSize: 13, lineHeight: 1,
                  padding: '0 2px', flexShrink: 0,
                }}
              >
                ×
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}