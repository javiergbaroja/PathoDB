// frontend/src/components/ModelPickerCards.jsx
//
// Shared model-picker shell used by both the Slide Viewer's Analysis Models
// panel (SlideViewer/ModelsPanel.jsx) and Project Detail's AI tab
// (ProjectDetail/ProjectModelsPanel.jsx). Owns the card-list UI: category
// tabs, expand/collapse, status badge, description, and stain-compatibility
// badges. What appears *inside* an expanded card (scope selection, params,
// run controls) is supplied by the caller via `children`, a render-prop
// function `(model) => ReactNode`, since that part differs meaningfully
// between the two contexts (see PathoDB audit Finding 3).
//
// Two contexts, two layouts:
//   - Slide Viewer: this panel IS its own scrollable sidebar → scrollable=true (default)
//   - Project Detail: this renders inside ClassPanel's already-scrollable
//     tab body → scrollable=false, showHeader=false

import { useState } from 'react'
import { JobStatusBadge, SegmentedControl, SectionLabel } from './ui'
import { CATEGORY_COLORS } from '../constants/viewer'

export default function ModelPickerCards({
  catalog,
  expandedId: controlledExpandedId,
  onExpandedChange,
  statusFor,            // optional (modelId) => job status string | undefined
  headerRight,          // optional node shown top-right of the header (e.g. "N running")
  title = 'Analysis models',
  showHeader = true,    // set false when the surrounding UI already labels this area
  scrollable = true,    // set false when embedded in an already-scrollable parent
  children,             // (model) => ReactNode — rendered inside the expanded card
}) {
  const [internalExpandedId, setInternalExpandedId] = useState(null)
  const isControlled  = controlledExpandedId !== undefined
  const expandedId    = isControlled ? controlledExpandedId : internalExpandedId
  const setExpandedId = isControlled ? (onExpandedChange || (() => {})) : setInternalExpandedId

  const [categoryTab, setCategoryTab] = useState('All')
  const categories = ['All', ...Array.from(new Set(catalog.map(m => m.category)))]
  const visible    = categoryTab === 'All' ? catalog : catalog.filter(m => m.category === categoryTab)

  const rootStyle = scrollable
    ? { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }
    : { display: 'flex', flexDirection: 'column' }

  const listStyle = scrollable
    ? { flex: 1, overflowY: 'auto', padding: '0 8px 10px' }
    : { padding: 0 }

  return (
    <div style={rootStyle}>
      {showHeader && (
        <div style={{ padding: '9px 12px', borderBottom: '1px solid var(--border-dark)', display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          <SectionLabel style={{ flex: 1, color: 'var(--text-dark-2)' }}>{title}</SectionLabel>
          {headerRight}
        </div>
      )}

      <div style={{ padding: showHeader ? '6px 10px' : '0 0 6px', flexShrink: 0, overflowX: 'auto' }}>
        <SegmentedControl
          dark
          small
          options={categories.map(c => [c, c])}
          value={categoryTab}
          onChange={setCategoryTab}
        />
      </div>

      <div style={listStyle}>
        {visible.map(model => {
          const isOpen   = expandedId === model.id
          const status   = statusFor?.(model.id)
          const catColor = CATEGORY_COLORS[model.category] || CATEGORY_COLORS.other

          return (
            <div
              key={model.id}
              style={{
                border: `1px solid ${isOpen ? 'var(--transparent-teal-4)' : 'var(--border-dark)'}`,
                borderRadius: 7, marginBottom: 6, overflow: 'hidden',
                transition: 'var(--transition-base)',
              }}
            >
              {/* Model header */}
              <div
                onClick={() => setExpandedId(isOpen ? null : model.id)}
                style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', cursor: 'pointer' }}
              >
                <div style={{ width: 6, height: 6, borderRadius: '50%', background: catColor, flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-dark-1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {model.name}
                  </div>
                  <div style={{ fontSize: 9, color: 'var(--text-dark-2)', marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {model.description}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexShrink: 0 }}>
                  {status && <JobStatusBadge status={status} />}
                  <span style={{ fontSize: 9, color: 'var(--text-dark-2)', background: 'var(--transparent-white-0)', padding: '2px 5px', borderRadius: 3 }}>
                    ~{model.estimated_minutes}m
                  </span>
                </div>
              </div>

              {/* Expanded body */}
              {isOpen && (
                <div style={{ borderTop: '1px solid var(--transparent-white-0)', padding: '10px 10px 12px' }}>
                  <p style={{ fontSize: 11, color: 'var(--text-dark-2)', lineHeight: 1.55, margin: '0 0 10px' }}>
                    {model.description}
                  </p>

                  <div style={{ display: 'flex', gap: 4, marginBottom: 10, flexWrap: 'wrap' }}>
                    {(model.stain_compatibility || []).map(s => (
                      <span key={s} style={{ fontSize: 9, padding: '2px 6px', borderRadius: 3, background: 'var(--transparent-white-0)', color: 'var(--text-dark-2)', border: '1px solid var(--transparent-white-1)' }}>
                        {s}
                      </span>
                    ))}
                  </div>

                  {children(model)}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}