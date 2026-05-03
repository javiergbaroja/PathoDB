// frontend/src/pages/ProjectDetail/SlideTray.jsx
// Vertical left-side panel showing all project slides with annotation progress.

export default function SlideTray({ scans, activeScanId, onSelect, token, saving }) {
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
        <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.5)', textTransform: 'uppercase', letterSpacing: '0.1em', fontWeight: 600 }}>
          Slides
        </span>
        <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.3)', fontFamily: 'monospace' }}>
          {scans.length}
        </span>
      </div>

      {/* Legend */}
      <div style={{ padding: '6px 12px', borderBottom: '1px solid rgba(255,255,255,0.05)', flexShrink: 0, display: 'flex', gap: 10 }}>
        <LegendItem color="#1b998b" label="Annotated" />
        <LegendItem color="rgba(255,255,255,0.2)" label="Pending" />
      </div>

      {/* Scroll area */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {scans.map((scan, idx) => {
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
                <div style={{ fontSize: 10, fontWeight: 600, color: isActive ? '#6ee7b7' : 'rgba(255,255,255,0.65)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {scan.stain_name || 'Unknown stain'}
                </div>
                <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.35)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontFamily: 'monospace' }}>
                  {scan.lis_probe_id || scan.lis_submission_id || '—'}
                </div>
                <div style={{ fontSize: 9, color: hasAnns ? '#1b998b' : 'rgba(255,255,255,0.2)', marginTop: 2 }}>
                  {hasAnns ? `${scan.annotation_count} annotation${scan.annotation_count !== 1 ? 's' : ''}` : 'No annotations'}
                </div>
              </div>
            </div>
          )
        })}
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