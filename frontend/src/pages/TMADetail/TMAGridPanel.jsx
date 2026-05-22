// frontend/src/pages/TMADetail/TMAGridPanel.jsx
import { useMemo } from 'react'

export default function TMAGridPanel({ cores }) {
  // Compute grid dimensions dynamically based on data
  const { maxRow, maxCol } = useMemo(() => {
    let mr = 0, mc = 0;
    cores.forEach(c => {
      if (c.row_idx > mr) mr = c.row_idx;
      if (c.col_idx > mc) mc = c.col_idx;
    });
    return { maxRow: mr, maxCol: mc };
  }, [cores]);

  if (cores.length === 0) return null;

  // Build a 2D array representation for easier rendering
  const grid = useMemo(() => {
    const arr = Array.from({ length: maxRow }, () => Array(maxCol).fill(null));
    cores.forEach(c => {
      arr[c.row_idx - 1][c.col_idx - 1] = c;
    });
    return arr;
  }, [cores, maxRow, maxCol]);

  return (
    <div style={{ 
      width: 320, background: 'var(--navy-05)', borderLeft: '1px solid rgba(255,255,255,0.05)', 
      display: 'flex', flexDirection: 'column', overflow: 'hidden' 
    }}>
      <div style={{ padding: '16px 20px', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--white)' }}>Array Map</div>
        <div style={{ fontSize: 11, color: 'var(--text-3)' }}>{maxRow} x {maxCol} cores ({cores.length} total)</div>
      </div>

      <div style={{ flex: 1, overflow: 'auto', padding: 20 }}>
        <div style={{ 
          display: 'grid', 
          gridTemplateColumns: `repeat(${maxCol}, minmax(16px, 1fr))`, 
          gap: 4 
        }}>
          {grid.map((row, rIdx) => 
            row.map((core, cIdx) => {
              let bg = 'rgba(255,255,255,0.05)'; // Empty
              if (core?.core_type === 'tissue') bg = 'var(--teal)';
              if (core?.core_type === 'control') bg = '#a78bfa';

              return (
                <div 
                  key={`${rIdx}-${cIdx}`}
                  title={core ? `Row ${core.row_idx}, Col ${core.col_idx}\nBlock: ${core.donor_block_id || 'N/A'}` : `Empty`}
                  style={{
                    aspectRatio: '1/1',
                    borderRadius: '50%',
                    background: bg,
                    border: '1px solid rgba(255,255,255,0.1)',
                    cursor: core ? 'pointer' : 'default',
                    opacity: core ? 1 : 0.3
                  }}
                />
              )
            })
          )}
        </div>
      </div>

      {/* Legend */}
      <div style={{ padding: 16, borderTop: '1px solid rgba(255,255,255,0.05)', display: 'flex', gap: 12, fontSize: 11, color: 'var(--text-3)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <div style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--teal)' }}/> Tissue
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#a78bfa' }}/> Control
        </div>
      </div>
    </div>
  )
}