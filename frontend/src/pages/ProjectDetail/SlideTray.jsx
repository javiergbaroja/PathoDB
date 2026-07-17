import { useState, useMemo, useRef, memo } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { formatHierarchy } from '../../lib/slideNaming'

// 1. Wrap the entire component in React.memo to block parent re-renders during panning/zooming
const SlideTray = memo(function SlideTray({ scans, activeScanId, onSelect, token, saving, onScanNoteChange, readOnly = false }) {
  // --- Filter State ---
  const [showFilters, setShowFilters] = useState(false)
  const [annotationFilter, setAnnotationFilter] = useState('all') 
  const [selectedStains, setSelectedStains] = useState([])
  const [searchQuery, setSearchQuery] = useState('') 

  // --- Derived Data ---
  const uniqueStains = useMemo(() => {
    const stains = new Set(scans.map(s => s.stain_name || 'Unknown stain'))
    return Array.from(stains).sort()
  }, [scans])

  const filteredScans = useMemo(() => {
    const lowerQuery = searchQuery.toLowerCase().trim();

    return scans.filter(scan => {
      const hasAnns = scan.annotation_count > 0
      const stain = scan.stain_name || 'Unknown stain'

      if (annotationFilter === 'annotated' && !hasAnns) return false
      if (annotationFilter === 'pending' && hasAnns) return false
      if (selectedStains.length > 0 && !selectedStains.includes(stain)) return false

      if (lowerQuery) {
        const hierarchyStr = formatHierarchy(scan).toLowerCase();
        const filePath = scan.file_path || '';
        const basename = filePath.split(/[\\/]/).pop().toLowerCase();

        if (!hierarchyStr.includes(lowerQuery) && !basename.includes(lowerQuery)) {
          return false;
        }
      }

      return true
    })
  }, [scans, annotationFilter, selectedStains, searchQuery]) 

  // --- Virtualization Setup ---
  // 2. Create a ref for the scrollable container
  const parentRef = useRef(null)

  // 3. Initialize the virtualizer
  const rowVirtualizer = useVirtualizer({
    count: filteredScans.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 140, // Rough height estimate of a single slide card
    overscan: 5,             // Render 5 extra items off-screen to prevent flickering
  })

  return (
    <div style={{
      width: 200, flexShrink: 0,
      background: 'var(--surface-dark-card)',
      borderRight: '1px solid var(--transparent-white-1)',
      display: 'flex', flexDirection: 'column',
      overflow: 'hidden',
    }}>
      {/* Header */}
      <div style={{
        padding: '9px 12px', borderBottom: '1px solid var(--transparent-white-0)',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 9, color: 'var(--transparent-white-5)', textTransform: 'uppercase', letterSpacing: '0.1em', fontWeight: 600 }}>
            Slides
          </span>
          <span style={{ fontSize: 9, color: 'var(--transparent-white-3)', fontFamily: 'monospace' }}>
            {filteredScans.length}{filteredScans.length !== scans.length ? `/${scans.length}` : ''}
          </span>
        </div>
        
        <button 
          onClick={() => setShowFilters(s => !s)}
          style={{
            background: showFilters ? 'var(--transparent-teal-2)' : 'transparent',
            border: `1px solid ${showFilters ? 'var(--transparent-teal-5)' : 'var(--transparent-white-1)'}`,
            color: showFilters ? 'var(--viewer-teal-light)' : 'var(--transparent-white-5)',
            borderRadius: 4, padding: '2px 6px', fontSize: 9, cursor: 'pointer',
            display: 'flex', alignItems: 'center', gap: 4, transition: 'all 0.15s'
          }}
        >
          <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
            <path d="M1.5 3h13a.5.5 0 01.5.5v1a.5.5 0 01-.15.35L10 9.71V14.5a.5.5 0 01-.26.44l-3 1.5A.5.5 0 016 16v-6.29L1.15 4.85A.5.5 0 011 4.5v-1A.5.5 0 011.5 3z"/>
          </svg>
          Filter
        </button>
      </div>

      {/* Expandable Filter Panel */}
      {showFilters && (
        <div style={{
          padding: '10px 12px', borderBottom: '1px solid var(--transparent-white-0)',
          background: 'var(--transparent-black-2)', flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 10
        }}>
          <div>
            <div style={{ fontSize: 9, color: 'var(--transparent-white-4)', textTransform: 'uppercase', marginBottom: 4 }}>Search</div>
            <input
              type="text"
              placeholder="Filename, probe, block..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              style={{
                width: '100%', background: 'var(--transparent-white-0)', color: 'var(--transparent-white-8)',
                border: '1px solid var(--transparent-white-1)', borderRadius: 4, padding: '4px 6px', fontSize: 10, outline: 'none'
              }}
            />
          </div>

          <div>
            <div style={{ fontSize: 9, color: 'var(--transparent-white-4)', textTransform: 'uppercase', marginBottom: 4 }}>Status</div>
            <select
              value={annotationFilter}
              onChange={e => setAnnotationFilter(e.target.value)}
              style={{
                width: '100%', background: 'var(--transparent-white-0)', color: 'var(--transparent-white-8)',
                border: '1px solid var(--transparent-white-1)', borderRadius: 4, padding: '3px 4px', fontSize: 10, outline: 'none'
              }}
            >
              <option value="all" style={{ background: 'var(--surface-dark)', color: 'var(--white)' }}>All Slides</option>
              <option value="annotated" style={{ background: 'var(--surface-dark)', color: 'var(--white)' }}>Annotated Only</option>
              <option value="pending" style={{ background: 'var(--surface-dark)', color: 'var(--white)' }}>Pending Only</option>
            </select>
          </div>

          {uniqueStains.length > 0 && (
            <div>
              <div style={{ fontSize: 9, color: 'var(--transparent-white-4)', textTransform: 'uppercase', marginBottom: 4 }}>Stains</div>
              <div style={{ maxHeight: 100, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
                {uniqueStains.map(stain => (
                  <label key={stain} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, color: 'var(--transparent-white-7)', cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={selectedStains.includes(stain)}
                      onChange={e => {
                        if (e.target.checked) setSelectedStains(prev => [...prev, stain])
                        else setSelectedStains(prev => prev.filter(s => s !== stain))
                      }}
                      style={{ accentColor: 'var(--viewer-teal)', margin: 0, cursor: 'pointer' }}
                    />
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{stain}</span>
                  </label>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Legend */}
      <div style={{ padding: '6px 12px', borderBottom: '1px solid var(--transparent-white-0)', flexShrink: 0, display: 'flex', gap: 10 }}>
        <LegendItem color="var(--viewer-teal)" label="Annotated" />
        <LegendItem color="var(--transparent-white-2)" label="Pending" />
      </div>

      {/* 4. Virtualized Scroll Area */}
      <div ref={parentRef} style={{ flex: 1, overflowY: 'auto', position: 'relative' }}>
        {filteredScans.length === 0 ? (
          <div style={{ padding: 20, textAlign: 'center', fontSize: 11, color: 'var(--transparent-white-3)' }}>
            No slides match your filters.
          </div>
        ) : (
          <div
            style={{
              height: `${rowVirtualizer.getTotalSize()}px`,
              width: '100%',
              position: 'relative',
            }}
          >
            {rowVirtualizer.getVirtualItems().map((virtualRow) => {
              const idx = virtualRow.index
              const scan = filteredScans[idx]
              const isActive = scan.scan_id === activeScanId
              const hasAnns = scan.annotation_count > 0

              return (
                <div
                  key={virtualRow.key}
                  data-index={virtualRow.index}
                  ref={rowVirtualizer.measureElement}
                  onClick={() => onSelect(scan.scan_id)}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${virtualRow.start}px)`,
                    display: 'flex', flexDirection: 'column', gap: 0,
                    padding: '0', cursor: 'pointer',
                    borderBottom: '1px solid var(--transparent-white-0)',
                    background: isActive ? 'var(--transparent-teal-1)' : 'transparent',
                    borderLeft: `3px solid ${isActive ? 'var(--viewer-teal)' : 'transparent'}`,
                    // We only transition colors here, NOT transforms, to avoid jitter while scrolling
                    transition: 'background 0.12s, border 0.12s',
                  }}
                >
                  {/* Thumbnail */}
                  <div style={{ height: 90, background: 'var(--surface-dark-2)', position: 'relative', overflow: 'hidden' }}>
                    <img
                      src={`/api/slides/${scan.scan_id}/thumbnail?width=200&token=${token}`}
                      alt={scan.stain_name || 'Slide'}
                      loading="lazy"
                      style={{ width: '100%', height: '100%', objectFit: 'contain' }}
                      onError={e => { e.target.style.display = 'none' }}
                    />
                    <div style={{
                      position: 'absolute', top: 5, right: 5,
                      width: 10, height: 10, borderRadius: '50%',
                      background: hasAnns ? 'var(--viewer-teal)' : 'var(--transparent-white-2)',
                      border: '1.5px solid var(--transparent-black-4)',
                    }} />
                    <div style={{
                      position: 'absolute', top: 5, left: 5,
                      fontSize: 9, fontFamily: 'monospace',
                      background: 'var(--transparent-black-7)', color: 'var(--transparent-white-6)',
                      padding: '1px 4px', borderRadius: 3,
                    }}>
                      {idx + 1}
                    </div>
                  </div>

                  {/* Meta */}
                  <div style={{ padding: '5px 8px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      <span style={{ flex: 1, fontSize: 10, fontWeight: 600, color: isActive ? 'var(--viewer-teal-light)' : 'var(--transparent-white-7)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {scan.stain_name || 'Unknown stain'}
                      </span>
                      {!isActive && scan.scan_note && (
                        <span
                          title={scan.scan_note}
                          style={{ fontSize: 7, color: 'var(--viewer-teal-light)', opacity: 0.6, flexShrink: 0, lineHeight: 1 }}
                        >
                          ●
                        </span>
                      )}
                    </div>

                    <div style={{ fontSize: 10, color: 'var(--transparent-white-5)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'monospace', marginTop: 2 }}>
                      {formatHierarchy(scan)}
                    </div>

                    {scan.topo_description && (
                      <div style={{ fontSize: 10, color: 'var(--transparent-white-3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 1, fontStyle: 'italic' }}>
                        {scan.topo_description}
                      </div>
                    )}

                    <div style={{ fontSize: 10, color: hasAnns ? 'var(--viewer-teal)' : 'var(--transparent-white-2)', marginTop: 4 }}>
                      {hasAnns ? `${scan.annotation_count} annotation${scan.annotation_count !== 1 ? 's' : ''}` : 'No annotations'}
                    </div>

                    {/* Slide note — shown only on the active card */}
                    {isActive && onScanNoteChange && (
                      <div onClick={e => e.stopPropagation()} style={{ marginTop: 6 }}>
                        <div style={{ fontSize: 8, color: 'var(--transparent-white-3)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 3 }}>
                          Slide note
                        </div>
                        <textarea
                          placeholder='Add a note for this slide…'
                          disabled={readOnly}
                          value={scan.scan_note || ''}
                          rows={2}
                          style={{
                            width: '100%',
                            boxSizing: 'border-box',
                            resize: 'none',
                            fontSize: 10,
                            fontFamily: 'var(--font-sans)',
                            lineHeight: 1.5,
                            background: 'var(--transparent-white-0)',
                            border: '1px solid var(--transparent-white-1)',
                            borderRadius: 4,
                            color: readOnly ? 'var(--transparent-white-3)' : 'var(--transparent-white-7)',
                            padding: '4px 6px',
                            outline: 'none',
                          }}
                          onChange={e => onScanNoteChange(scan.scan_id, e.target.value)}
                          onFocus={e => { if (!readOnly) e.target.style.borderColor = 'var(--viewer-teal)' }}
                          onBlur={e => { e.target.style.borderColor = 'var(--transparent-white-1)' }}
                        />
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      {saving && (
        <div style={{
          padding: '8px 12px', borderTop: '1px solid var(--transparent-white-0)',
          fontSize: 10, color: 'var(--amber)', display: 'flex', alignItems: 'center', gap: 6,
          flexShrink: 0,
        }}>
          <div style={{ width: 8, height: 8, borderRadius: '50%', border: '1.5px solid var(--amber)', borderTopColor: 'transparent', animation: 'spin 0.7s linear infinite' }} />
          Saving…
        </div>
      )}
    </div>
  )
})

export default SlideTray;

function LegendItem({ color, label }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
      <div style={{ width: 8, height: 8, borderRadius: '50%', background: color }} />
      <span style={{ fontSize: 9, color: 'var(--transparent-white-4)' }}>{label}</span>
    </div>
  )
}