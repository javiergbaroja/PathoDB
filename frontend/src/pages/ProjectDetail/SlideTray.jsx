// frontend/src/pages/ProjectDetail/SlideTray.jsx
import { useState, useMemo } from 'react'

function formatHierarchy(scan) {
  const sub = scan.lis_submission_id || '';
  const prb = scan.lis_probe_id || '';
  const blk = scan.block_label || '';

  const parts = [];

  // Check if the probe itself is a full B-number (e.g., "B2014.456" or "B2018.333/003")
  const isFullBNumber = /^B\d{4}/i.test(prb);

  if (isFullBNumber) {
    // Eras 2 & 3: The probe inherently contains the year/case. 
    // We completely ignore the submission (which might be a range like B2012.222-225).
    parts.push(prb);
  } else {
    // Era 1 (Pre-2011): Probe is usually "1" or Roman numerals. 
    // We need the submission to know the case (e.g., B2001.111).
    if (sub) parts.push(sub);
    
    // Ignore the ETL's dummy "1" probe, but keep valid numerals (I, II, etc.)
    if (prb && prb !== '1') parts.push(prb);
  }

  // Append the exact Block label
  if (blk) parts.push(blk);

  return parts.join(' › ') || '—';
}

export default function SlideTray({ scans, activeScanId, onSelect, token, saving }) {
  // --- Filter State ---
  const [showFilters, setShowFilters] = useState(false)
  const [annotationFilter, setAnnotationFilter] = useState('all') // 'all', 'annotated', 'pending'
  const [selectedStains, setSelectedStains] = useState([])
  const [searchQuery, setSearchQuery] = useState('')

  // --- Derived Data ---
  // 1. Extract unique stains for the checkbox list
  const uniqueStains = useMemo(() => {
    const stains = new Set(scans.map(s => s.stain_name || 'Unknown stain'))
    return Array.from(stains).sort()
  }, [scans])

  // 2. Apply filters to the scans array
  // 2. Apply filters to the scans array
  const filteredScans = useMemo(() => {
    const lowerQuery = searchQuery.toLowerCase().trim();

    return scans.filter(scan => {
      const hasAnns = scan.annotation_count > 0
      const stain = scan.stain_name || 'Unknown stain'

      // Check annotation status
      if (annotationFilter === 'annotated' && !hasAnns) return false
      if (annotationFilter === 'pending' && hasAnns) return false

      // Check stain selection (if array is empty, show all)
      if (selectedStains.length > 0 && !selectedStains.includes(stain)) return false

      // Check free text search
      if (lowerQuery) {
        const hierarchyStr = formatHierarchy(scan).toLowerCase();
        
        // Safely extract the filename from the file_path (handles both / and \ slashes)
        const filePath = scan.file_path || '';
        const basename = filePath.split(/[\\/]/).pop().toLowerCase();

        // If neither the hierarchy nor the filename includes the search query, filter it out
        if (!hierarchyStr.includes(lowerQuery) && !basename.includes(lowerQuery)) {
          return false;
        }
      }

      return true
    })
  }, [scans, annotationFilter, selectedStains, searchQuery]) // <-- Remember to add searchQuery to dependencies

  return (
    <div style={{
      width: 200, flexShrink: 0,
      background: 'rgba(2,5,18,0.98)',
      borderRight: '1px solid rgba(255,255,255,0.07)',
      display: 'flex', flexDirection: 'column',
      overflow: 'hidden',
    }}>
      {/* Header */}
      <div style={{
        padding: '9px 12px', borderBottom: '1px solid rgba(255,255,255,0.05)',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.5)', textTransform: 'uppercase', letterSpacing: '0.1em', fontWeight: 600 }}>
            Slides
          </span>
          <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.3)', fontFamily: 'monospace' }}>
            {filteredScans.length}{filteredScans.length !== scans.length ? `/${scans.length}` : ''}
          </span>
        </div>
        
        {/* Toggle Filters Button */}
        <button 
          onClick={() => setShowFilters(s => !s)}
          style={{
            background: showFilters ? 'rgba(27,153,139,0.2)' : 'transparent',
            border: `1px solid ${showFilters ? 'rgba(27,153,139,0.5)' : 'rgba(255,255,255,0.1)'}`,
            color: showFilters ? '#6ee7b7' : 'rgba(255,255,255,0.5)',
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
          padding: '10px 12px', borderBottom: '1px solid rgba(255,255,255,0.05)',
          background: 'rgba(0,0,0,0.2)', flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 10
        }}>
          {/* Search Filter */}
          <div>
            <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase', marginBottom: 4 }}>Search</div>
            <input
              type="text"
              placeholder="Filename, probe, block..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              style={{
                width: '100%', background: 'rgba(255,255,255,0.05)', color: 'rgba(255,255,255,0.8)',
                border: '1px solid rgba(255,255,255,0.1)', borderRadius: 4, padding: '4px 6px', fontSize: 10, outline: 'none'
              }}
            />
          </div>
          {/* Status Filter */}
          <div>
            <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase', marginBottom: 4 }}>Status</div>
            <select
              value={annotationFilter}
              onChange={e => setAnnotationFilter(e.target.value)}
              style={{
                width: '100%', background: 'rgba(255,255,255,0.05)', color: 'rgba(255,255,255,0.8)',
                border: '1px solid rgba(255,255,255,0.1)', borderRadius: 4, padding: '3px 4px', fontSize: 10, outline: 'none'
              }}
            >
              {/* Added explicit dark backgrounds to the options */}
              <option value="all" style={{ background: '#111827', color: '#fff' }}>All Slides</option>
              <option value="annotated" style={{ background: '#111827', color: '#fff' }}>Annotated Only</option>
              <option value="pending" style={{ background: '#111827', color: '#fff' }}>Pending Only</option>
            </select>
          </div>

          {/* Stains Filter */}
          {uniqueStains.length > 0 && (
            <div>
              <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase', marginBottom: 4 }}>Stains</div>
              <div style={{ maxHeight: 100, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
                {uniqueStains.map(stain => (
                  <label key={stain} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, color: 'rgba(255,255,255,0.7)', cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={selectedStains.includes(stain)}
                      onChange={e => {
                        if (e.target.checked) setSelectedStains(prev => [...prev, stain])
                        else setSelectedStains(prev => prev.filter(s => s !== stain))
                      }}
                      style={{ accentColor: '#1b998b', margin: 0, cursor: 'pointer' }}
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
      <div style={{ padding: '6px 12px', borderBottom: '1px solid rgba(255,255,255,0.05)', flexShrink: 0, display: 'flex', gap: 10 }}>
        <LegendItem color="#1b998b" label="Annotated" />
        <LegendItem color="rgba(255,255,255,0.2)" label="Pending" />
      </div>

      {/* Scroll area */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {filteredScans.length === 0 ? (
          <div style={{ padding: 20, textAlign: 'center', fontSize: 11, color: 'rgba(255,255,255,0.3)' }}>
            No slides match your filters.
          </div>
        ) : (
          filteredScans.map((scan, idx) => {
            const isActive   = scan.scan_id === activeScanId
            const hasAnns    = scan.annotation_count > 0

            return (
              <div
                key={scan.scan_id}
                onClick={() => onSelect(scan.scan_id)}
                style={{
                  display: 'flex', flexDirection: 'column', gap: 0,
                  padding: '0', cursor: 'pointer',
                  borderBottom: '1px solid rgba(255,255,255,0.04)',
                  background: isActive ? 'rgba(27,153,139,0.12)' : 'transparent',
                  borderLeft: `3px solid ${isActive ? '#1b998b' : 'transparent'}`,
                  transition: 'all 0.12s',
                }}
              >
                {/* Thumbnail */}
                <div style={{ height: 90, background: '#0d1623', position: 'relative', overflow: 'hidden' }}>
                  <img
                    src={`/api/slides/${scan.scan_id}/thumbnail?width=200&token=${token}`}
                    alt={scan.stain_name || 'Slide'}
                    loading="lazy"
                    style={{ width: '100%', height: '100%', objectFit: 'contain' }}
                    onError={e => { e.target.style.display = 'none' }}
                  />
                  {/* Annotation dot */}
                  <div style={{
                    position: 'absolute', top: 5, right: 5,
                    width: 10, height: 10, borderRadius: '50%',
                    background: hasAnns ? '#1b998b' : 'rgba(255,255,255,0.2)',
                    border: '1.5px solid rgba(0,0,0,0.4)',
                  }} />
                  {/* Index badge */}
                  <div style={{
                    position: 'absolute', top: 5, left: 5,
                    fontSize: 9, fontFamily: 'monospace',
                    background: 'rgba(0,0,0,0.65)', color: 'rgba(255,255,255,0.6)',
                    padding: '1px 4px', borderRadius: 3,
                  }}>
                    {idx + 1}
                  </div>
                </div>

                {/* Meta */}
                <div style={{ padding: '5px 8px' }}>
                  {/* Line 1: Stain Name */}
                  <div style={{ fontSize: 10, fontWeight: 600, color: isActive ? '#6ee7b7' : 'rgba(255,255,255,0.65)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {scan.stain_name || 'Unknown stain'}
                  </div>
                  
                  {/* Line 2: Smart Hierarchy (Era-aware) */}
                  <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.45)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'monospace', marginTop: 2 }}>
                    {formatHierarchy(scan)}
                  </div>

                  {/* Line 3: Topography (Anatomy) */}
                  {scan.topo_description && (
                    <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 1, fontStyle: 'italic' }}>
                      {scan.topo_description}
                    </div>
                  )}

                  {/* Line 4: Annotation Status */}
                  <div style={{ fontSize: 10, color: hasAnns ? '#1b998b' : 'rgba(255,255,255,0.2)', marginTop: 4 }}>
                    {hasAnns ? `${scan.annotation_count} annotation${scan.annotation_count !== 1 ? 's' : ''}` : 'No annotations'}
                  </div>
                </div>
              </div>
            )
          })
        )}
      </div>

      {/* Save indicator */}
      {saving && (
        <div style={{
          padding: '8px 12px', borderTop: '1px solid rgba(255,255,255,0.05)',
          fontSize: 10, color: '#fbbf24', display: 'flex', alignItems: 'center', gap: 6,
          flexShrink: 0,
        }}>
          <div style={{ width: 8, height: 8, borderRadius: '50%', border: '1.5px solid #fbbf24', borderTopColor: 'transparent', animation: 'spin 0.7s linear infinite' }} />
          Saving…
        </div>
      )}
    </div>
  )
}

function LegendItem({ color, label }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
      <div style={{ width: 8, height: 8, borderRadius: '50%', background: color }} />
      <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.4)' }}>{label}</span>
    </div>
  )
}