import { useState, useEffect } from 'react'
import { useParams } from 'react-router-dom'
import { api } from '../api'

const VIEWER_FORMATS = new Set(['SVS','NDPI','TIF','TIFF','MRXS','SCN','VSI','BIF'])

const SCAN_COLS = [
  'patient_code','lis_submission_id','lis_probe_id','snomed_topo_code',
  'topo_description','submission_type','block_label','block_info',
  'stain_name','stain_category','file_path'
]

export default function CohortResults() {
  const { cohortId } = useParams()
  const [data, setData]       = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState('')

  // useEffect(() => {
  //   // No need to manually check token here; 
  //   // api.getCohortResults will trigger the redirect in api.js if unauthorized.
  //   api.getCohortResults(cohortId)
  //     .then(setData)
  //     .catch(e => {
  //       console.error("Fetch error:", e);
  //       setError(e.message);
  //     })
  //     .finally(() => setLoading(false));
  // }, [cohortId]);

  useEffect(() => {
    api.getCohortResults(cohortId)
      .then(setData)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [cohortId])

  if (loading) return (
    <div style={pageStyle}>
      <div style={headerStyle}>
        <Logo />
        <span style={{ color: 'var(--text-3)', fontSize: 13 }}>Loading cohort…</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 1 }}>
        <Spinner />
      </div>
    </div>
  )

  if (error) return (
    <div style={pageStyle}>
      <div style={headerStyle}><Logo /></div>
      <div style={{ padding: 32, color: 'var(--crimson)', fontSize: 14 }}>Error: {error}</div>
    </div>
  )

  const isScan = data.return_level === 'scan'
  const cols   = isScan ? SCAN_COLS : (data.results.length > 0 ? Object.keys(data.results[0]).filter(k => k !== 'scan_id' && k !== 'viewer_available') : [])

  return (
    <div style={pageStyle}>
      {/* Header */}
      <div style={headerStyle}>
        <Logo />
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
          <span style={{ fontFamily: 'var(--font-serif)', fontSize: 18, color: 'var(--navy)' }}>{data.name}</span>
          <span style={{ fontSize: 12, color: 'var(--text-3)' }}>{data.return_level} level</span>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 16 }}>
          <span style={{ fontSize: 13, color: 'var(--text-2)' }}>
            <strong style={{ fontFamily: 'var(--font-serif)', fontSize: 20, color: 'var(--navy)' }}>{data.count}</strong> {data.return_level}s
          </span>
          <button onClick={downloadCSV} style={dlBtn}>Export CSV</button>
          <button onClick={downloadJSON} style={dlBtn}>Export JSON</button>
        </div>
      </div>

      {/* Table */}
      <div style={{ flex: 1, overflowY: 'auto', overflowX: 'auto', padding: '0 0 24px' }}>
        {data.results.length === 0 ? (
          <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-3)', fontSize: 14 }}>
            No results found — the database may have changed since this cohort was saved.
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead style={{ position: 'sticky', top: 0, zIndex: 1 }}>
              <tr style={{ background: 'var(--navy-05)' }}>
                {cols.map(h => (
                  <th key={h} style={thStyle}>{h.replace(/_/g, ' ')}</th>
                ))}
                {isScan && <th style={thStyle}>viewer</th>}
              </tr>
            </thead>
            <tbody>
              {data.results.map((row, i) => (
                <tr key={i}
                  onMouseEnter={e => e.currentTarget.style.background = 'var(--navy-05)'}
                  onMouseLeave={e => e.currentTarget.style.background = i % 2 === 0 ? 'white' : 'var(--navy-05)'}
                  style={{ background: i % 2 === 0 ? 'white' : '#fafbfd' }}
                >
                  {cols.map(col => (
                    <td key={col} style={tdStyle}>
                      {col === 'file_path'
                        ? <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-2)' }} title={row[col]}>
                            {row[col] ? '…' + row[col].slice(-35) : '—'}
                          </span>
                        : <span style={{
                            fontFamily: ['lis_submission_id','lis_probe_id','snomed_topo_code'].includes(col) ? 'var(--font-mono)' : 'inherit',
                            fontSize: 12,
                          }}>
                            {row[col] ?? '—'}
                          </span>
                      }
                    </td>
                  ))}
                  {isScan && (
                    <td style={tdStyle}>
                      {row.viewer_available
                        ? <button
                            onClick={() => window.open(`/viewer/${row.scan_id}`, '_blank')}
                            style={{ fontSize: 11, padding: '3px 8px', background: 'var(--navy-05)', border: '1px solid var(--navy-20)', borderRadius: 4, cursor: 'pointer', color: 'var(--navy)', fontFamily: 'var(--font-sans)', fontWeight: 500, whiteSpace: 'nowrap' }}
                            onMouseEnter={e => e.currentTarget.style.background = 'var(--navy-10)'}
                            onMouseLeave={e => e.currentTarget.style.background = 'var(--navy-05)'}
                          >
                            View ↗
                          </button>
                        : <span style={{ fontSize: 11, color: 'var(--text-3)' }}>—</span>
                      }
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )

  function downloadCSV() {
    if (!data?.results?.length) return
    const rows    = data.results
    const headers = isScan ? SCAN_COLS : Object.keys(rows[0]).filter(k => k !== 'scan_id' && k !== 'viewer_available')
    const csvRows = [headers.join(',')]
    for (const row of rows) {
      csvRows.push(headers.map(h => `"${(row[h] ?? '').toString().replace(/"/g, '""')}"`).join(','))
    }
    const blob = new Blob([csvRows.join('\n')], { type: 'text/csv;charset=utf-8;' })
    const url  = URL.createObjectURL(blob)
    const a    = document.createElement('a')
    a.href     = url
    a.download = `${data.name.replace(/\s+/g, '_')}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  function downloadJSON() {
    if (!data?.results?.length) return
    const clean = data.results.map(r => {
      const { scan_id, viewer_available, ...rest } = r
      return rest
    })
    const blob = new Blob([JSON.stringify(clean, null, 2)], { type: 'application/json' })
    const url  = URL.createObjectURL(blob)
    const a    = document.createElement('a')
    a.href     = url
    a.download = `${data.name.replace(/\s+/g, '_')}.json`
    a.click()
    URL.revokeObjectURL(url)
  }
}

function Logo() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingRight: 20, borderRight: '1px solid var(--border-l)', flexShrink: 0 }}>
      <div style={{ width: 24, height: 24, background: 'var(--crimson)', borderRadius: 5, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <svg width="13" height="13" viewBox="0 0 16 16" fill="white">
          <path d="M8 1a2 2 0 012 2v1h1a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2V6a2 2 0 012-2h1V3a2 2 0 012-2z"/>
        </svg>
      </div>
      <span style={{ fontFamily: 'var(--font-serif)', fontSize: 15, color: 'var(--navy)' }}>PathoDB</span>
    </div>
  )
}

function Spinner() {
  return <div style={{ width: 32, height: 32, borderRadius: '50%', border: '2px solid var(--navy-20)', borderTopColor: 'var(--navy)', animation: 'spin 0.6s linear infinite' }} />
}

const pageStyle  = { minHeight: '100vh', display: 'flex', flexDirection: 'column', background: 'white', fontFamily: 'var(--font-sans)' }
const headerStyle = { height: 52, padding: '0 24px', borderBottom: '1px solid var(--border-l)', display: 'flex', alignItems: 'center', gap: 16, flexShrink: 0, background: 'white', position: 'sticky', top: 0, zIndex: 10 }
const thStyle    = { padding: '10px 12px', textAlign: 'left', fontSize: 10, fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.06em', borderBottom: '1px solid var(--border-l)', whiteSpace: 'nowrap', background: 'var(--navy-05)' }
const tdStyle    = { padding: '8px 12px', borderBottom: '1px solid var(--border-l)', verticalAlign: 'middle', color: 'var(--text-2)' }
const dlBtn      = { padding: '6px 14px', fontSize: 12, fontFamily: 'var(--font-sans)', background: 'white', border: '1px solid var(--border)', borderRadius: 6, cursor: 'pointer', color: 'var(--text-2)' }

const styleEl = document.createElement('style')
styleEl.textContent = `@keyframes spin { to { transform: rotate(360deg); } }`
document.head.appendChild(styleEl)