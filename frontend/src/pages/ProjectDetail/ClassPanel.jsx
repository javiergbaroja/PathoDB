// frontend/src/pages/ProjectDetail/ClassPanel.jsx
import { useState } from 'react'

export default function ClassPanel({
  classes,
  activeClass,
  setActiveClass,
  annotations,
  selectedAnnId,
  onSelectAnnotation,
  onDeleteAnnotation,
  onChangeClass,
  readOnly,
  annotationCount,
  totalScans,
  annotatedScans,
}) {
  const [tab, setTab] = useState('classes')   // 'classes' | 'list'

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
        {[['classes','Classes'],['list','This slide']].map(([val, lbl]) => (
          <button key={val} onClick={() => setTab(val)} style={{
            flex: 1, padding: '7px 0', fontSize: 11,
            fontFamily: 'sans-serif', cursor: 'pointer', border: 'none',
            background: tab === val ? 'rgba(27,153,139,0.12)' : 'transparent',
            color: tab === val ? '#6ee7b7' : 'rgba(255,255,255,0.4)',
            borderBottom: tab === val ? '2px solid #1b998b' : '2px solid transparent',
          }}>
            {lbl}
          </button>
        ))}
      </div>

      <div style={{ flex: 1, overflowY: 'auto' }}>
        {tab === 'classes' && (
          <ClassTab
            classes={classes}
            activeClass={activeClass}
            setActiveClass={setActiveClass}
            readOnly={readOnly}
          />
        )}
        {tab === 'list' && (
          <ListTab
            annotations={annotations}
            classes={classes}
            selectedAnnId={selectedAnnId}
            onSelect={onSelectAnnotation}
            onDelete={onDeleteAnnotation}
            onChangeClass={onChangeClass}
            readOnly={readOnly}
          />
        )}
      </div>
    </div>
  )
}

// ── Classes tab ────────────────────────────────────────────────────────────────
function ClassTab({ classes, activeClass, setActiveClass, readOnly }) {
  if (!classes || classes.length === 0) {
    return (
      <div style={{ padding: 16, fontSize: 12, color: 'rgba(255,255,255,0.35)', textAlign: 'center' }}>
        No classes defined for this project.
      </div>
    )
  }

  return (
    <div style={{ padding: '8px' }}>
      <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.35)', marginBottom: 8, padding: '0 4px' }}>
        {readOnly ? 'Classes' : 'Select a class, then draw on the slide'}
      </div>
      {classes.map(cls => {
        const isActive = activeClass?.id === cls.id
        return (
          <button
            key={cls.id}
            onClick={() => !readOnly && setActiveClass(isActive ? null : cls)}
            disabled={readOnly}
            style={{
              width: '100%', display: 'flex', alignItems: 'center', gap: 10,
              padding: '8px 10px', borderRadius: 6, marginBottom: 4,
              background: isActive ? `${cls.color}22` : 'rgba(255,255,255,0.03)',
              border: `1.5px solid ${isActive ? cls.color : 'rgba(255,255,255,0.08)'}`,
              cursor: readOnly ? 'default' : 'pointer',
              transition: 'all 0.15s', textAlign: 'left',
            }}
          >
            <div style={{
              width: 14, height: 14, borderRadius: 3, flexShrink: 0,
              background: cls.color, border: '1px solid rgba(255,255,255,0.2)',
            }} />
            <span style={{ fontSize: 12, color: isActive ? cls.color : 'rgba(255,255,255,0.7)', flex: 1, fontWeight: isActive ? 600 : 400 }}>
              {cls.name}
            </span>
            {isActive && (
              <svg width="10" height="10" viewBox="0 0 16 16" fill={cls.color}>
                <path d="M13.854 3.646a.5.5 0 010 .708l-7 7a.5.5 0 01-.708 0l-3.5-3.5a.5.5 0 11.708-.708L6.5 10.293l6.646-6.647a.5.5 0 01.708 0z"/>
              </svg>
            )}
          </button>
        )
      })}

      <div style={{ marginTop: 12, padding: '8px 4px', borderTop: '1px solid rgba(255,255,255,0.05)' }}>
        <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.25)' }}>
          Keyboard: G polygon · R rect · E ellipse · P point · B brush
        </div>
      </div>
    </div>
  )
}

// ── List tab ──────────────────────────────────────────────────────────────────
function ListTab({ annotations, classes, selectedAnnId, onSelect, onDelete, onChangeClass, readOnly }) {
  const classMap = Object.fromEntries((classes || []).map(c => [c.id, c]))

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
        const cls   = classMap[ann.class_id]
        const color = cls?.color || ann._color || '#94a3b8'
        const isSelected = ann.id === selectedAnnId
        const typeLabel = { polygon: 'Poly', rectangle: 'Rect', ellipse: 'Ellipse', point: 'Point', brush: 'Brush' }[ann.annotation_type] || ann.annotation_type

        return (
          <div
            key={ann.id}
            onClick={() => onSelect(ann.id)}
            style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '6px 8px', borderRadius: 5, marginBottom: 3,
              background: isSelected ? 'rgba(255,255,255,0.07)' : 'rgba(255,255,255,0.02)',
              border: `1px solid ${isSelected ? 'rgba(255,255,255,0.15)' : 'rgba(255,255,255,0.05)'}`,
              cursor: 'pointer',
            }}
          >
            <div style={{ width: 10, height: 10, borderRadius: 2, background: color, flexShrink: 0 }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.7)', fontWeight: isSelected ? 600 : 400 }}>
                {ann.class_name || 'Unclassified'}
              </div>
              <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.3)', fontFamily: 'monospace' }}>
                {typeLabel} #{ann.id ?? i+1}
                {ann.area_px ? ` · ${Math.round(ann.area_px).toLocaleString()}px²` : ''}
              </div>
            </div>

            {/* Quick class reassign */}
            {!readOnly && isSelected && classes?.length > 0 && (
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
                <option value="">—</option>
                {classes.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            )}

            {!readOnly && (
              <button
                onClick={e => { e.stopPropagation(); onDelete(ann.id) }}
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