// frontend/src/pages/TMADetail/TMAGridPanel.jsx
import { useMemo, useState } from 'react'

const CORE_COLORS = {
  tissue_matched:   'var(--teal)',
  tissue_unmatched: 'rgba(255,255,255,0.12)',
  control:          '#a78bfa',
  empty:            'transparent',
}

const CORE_BORDER = {
  tissue_matched:   'var(--teal)',
  tissue_unmatched: 'rgba(255,255,255,0.2)',
  control:          '#a78bfa',
  empty:            'rgba(255,255,255,0.06)',
}

function CorePopover({ core, onClose }) {
  const isMatched = !!core.donor_block_id

  return (
    <div
      onClick={e => e.stopPropagation()}
      style={{
        position: 'absolute', zIndex: 200,
        background: 'rgba(3,8,25,0.98)',
        border: '1px solid rgba(255,255,255,0.12)',
        borderRadius: 8, padding: '12px 14px',
        minWidth: 200, maxWidth: 260,
        boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
        bottom: 'calc(100% + 6px)', left: '50%',
        transform: 'translateX(-50%)',
      }}
    >
      {/* Arrow */}
      <div style={{
        position: 'absolute', bottom: -5, left: '50%', transform: 'translateX(-50%)',
        width: 8, height: 8, background: 'rgba(3,8,25,0.98)',
        border: '1px solid rgba(255,255,255,0.12)',
        borderTop: 'none', borderLeft: 'none',
        transform: 'translateX(-50%) rotate(45deg)',
      }} />

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
        <span style={{ fontSize: 10, fontWeight: 700, color: 'rgba(255,255,255,0.5)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
          R{core.row_idx} · C{core.col_idx}
        </span>
        <button
          onClick={onClose}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'rgba(255,255,255,0.4)', fontSize: 14, lineHeight: 1, padding: 0 }}
        >
          ×
        </button>
      </div>

      {core.core_type === 'control' ? (
        <div>
          <div style={{ fontSize: 11, fontWeight: 600, color: '#a78bfa', marginBottom: 4 }}>Control core</div>
          {core.control_description && (
            <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)' }}>{core.control_description}</div>
          )}
        </div>
      ) : core.core_type === 'empty' ? (
        <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.35)' }}>Empty position</div>
      ) : isMatched ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          {core.patient_code && (
            <PopoverRow label="Patient" value={core.patient_code} mono />
          )}
          {core.lis_submission_id && (
            <PopoverRow label="Submission" value={core.lis_submission_id} mono />
          )}
          {core.lis_probe_id && (
            <PopoverRow label="Probe" value={core.lis_probe_id} mono />
          )}
          {core.block_label && (
            <PopoverRow label="Block" value={`Block ${core.block_label}`} />
          )}
        </div>
      ) : (
        <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.35)', fontStyle: 'italic' }}>
          No patient block matched
        </div>
      )}
    </div>
  )
}

function PopoverRow({ label, value, mono }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
      <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)', flexShrink: 0 }}>{label}</span>
      <span style={{
        fontSize: 11, color: 'rgba(255,255,255,0.8)', fontWeight: 500,
        fontFamily: mono ? 'var(--font-mono)' : 'var(--font-sans)',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>
        {value}
      </span>
    </div>
  )
}

export default function TMAGridPanel({ cores }) {
  const [selectedCoreId, setSelectedCoreId] = useState(null)

  const { maxRow, maxCol } = useMemo(() => {
    let mr = 0, mc = 0
    cores.forEach(c => {
      if (c.row_idx > mr) mr = c.row_idx
      if (c.col_idx > mc) mc = c.col_idx
    })
    return { maxRow: mr, maxCol: mc }
  }, [cores])

  const grid = useMemo(() => {
    const arr = Array.from({ length: maxRow }, () => Array(maxCol).fill(null))
    cores.forEach(c => { arr[c.row_idx - 1][c.col_idx - 1] = c })
    return arr
  }, [cores, maxRow, maxCol])

  const stats = useMemo(() => {
    const tissue    = cores.filter(c => c.core_type === 'tissue')
    const matched   = tissue.filter(c => !!c.donor_block_id).length
    const control   = cores.filter(c => c.core_type === 'control').length
    return { total: cores.length, matched, unmatched: tissue.length - matched, control }
  }, [cores])

  if (cores.length === 0) {
    return (
      <div style={{
        width: 300, flexShrink: 0,
        background: 'rgba(2,5,18,0.98)',
        borderLeft: '1px solid rgba(255,255,255,0.07)',
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        justifyContent: 'center', gap: 10,
        color: 'rgba(255,255,255,0.35)', fontSize: 12, padding: 24, textAlign: 'center',
      }}>
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ opacity: 0.3 }}>
          <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/>
          <rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>
        </svg>
        <div>No core map uploaded yet</div>
      </div>
    )
  }

  const selectedCore = cores.find(c => c.id === selectedCoreId)

  return (
    <div style={{
      width: 300, flexShrink: 0,
      background: 'rgba(2,5,18,0.98)',
      borderLeft: '1px solid rgba(255,255,255,0.07)',
      display: 'flex', flexDirection: 'column', overflow: 'hidden',
    }}
      onClick={() => setSelectedCoreId(null)}
    >
      {/* Header */}
      <div style={{ padding: '10px 14px', borderBottom: '1px solid rgba(255,255,255,0.07)', flexShrink: 0 }}>
        <div style={{ fontSize: 9, fontWeight: 600, color: 'rgba(255,255,255,0.5)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 6 }}>
          Array Map · {maxRow}×{maxCol}
        </div>

        {/* Stats pills */}
        <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
          <StatPill color="var(--teal)"           label={`${stats.matched} matched`} />
          {stats.unmatched > 0 && (
            <StatPill color="rgba(255,255,255,0.3)" label={`${stats.unmatched} unmatched`} />
          )}
          {stats.control > 0 && (
            <StatPill color="#a78bfa"              label={`${stats.control} control`} />
          )}
        </div>
      </div>

      {/* Grid */}
      <div style={{ flex: 1, overflowY: 'auto', overflowX: 'auto', padding: 14 }}>
        {/* Column labels */}
        <div style={{ display: 'flex', marginLeft: 24, marginBottom: 3, gap: 3 }}>
          {Array.from({ length: maxCol }, (_, i) => (
            <div key={i} style={{
              width: 18, textAlign: 'center',
              fontSize: 8, color: 'rgba(255,255,255,0.2)',
              fontFamily: 'var(--font-mono)', flexShrink: 0,
            }}>
              {i + 1}
            </div>
          ))}
        </div>

        {/* Rows */}
        {grid.map((row, rIdx) => (
          <div key={rIdx} style={{ display: 'flex', alignItems: 'center', gap: 3, marginBottom: 3 }}>
            {/* Row label */}
            <div style={{
              width: 18, textAlign: 'right', marginRight: 3,
              fontSize: 8, color: 'rgba(255,255,255,0.2)',
              fontFamily: 'var(--font-mono)', flexShrink: 0,
            }}>
              {rIdx + 1}
            </div>

            {row.map((core, cIdx) => {
              const isSelected = core?.id === selectedCoreId
              const type = core
                ? core.core_type === 'control' ? 'control'
                : core.core_type === 'empty'   ? 'empty'
                : core.donor_block_id           ? 'tissue_matched'
                : 'tissue_unmatched'
                : 'empty'

              return (
                <div
                  key={cIdx}
                  onClick={e => { e.stopPropagation(); if (core) setSelectedCoreId(isSelected ? null : core.id) }}
                  style={{
                    position: 'relative',
                    width: 18, height: 18, borderRadius: '50%', flexShrink: 0,
                    background:    CORE_COLORS[type],
                    border:        `1.5px solid ${isSelected ? 'white' : CORE_BORDER[type]}`,
                    cursor:        core ? 'pointer' : 'default',
                    transition:    'transform 0.1s, border-color 0.1s',
                    transform:     isSelected ? 'scale(1.25)' : 'scale(1)',
                    boxShadow:     isSelected ? '0 0 0 2px rgba(255,255,255,0.3)' : 'none',
                  }}
                >
                  {isSelected && core && (
                    <CorePopover core={core} onClose={() => setSelectedCoreId(null)} />
                  )}
                </div>
              )
            })}
          </div>
        ))}
      </div>

      {/* Legend */}
      <div style={{ padding: '10px 14px', borderTop: '1px solid rgba(255,255,255,0.07)', flexShrink: 0 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 12px' }}>
          <LegendItem color="var(--teal)"           label="Matched tissue" />
          <LegendItem color="rgba(255,255,255,0.15)" label="Unmatched" />
          <LegendItem color="#a78bfa"               label="Control" />
        </div>
        <div style={{ marginTop: 6, fontSize: 9, color: 'rgba(255,255,255,0.2)' }}>
          Click any core for patient block details
        </div>
      </div>
    </div>
  )
}

function StatPill({ color, label }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10, color: 'rgba(255,255,255,0.5)' }}>
      <div style={{ width: 6, height: 6, borderRadius: '50%', background: color, flexShrink: 0 }} />
      {label}
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