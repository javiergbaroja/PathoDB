import { useState, useEffect, useMemo } from 'react'
import { useParams } from 'react-router-dom'
import { Table, Th, Td, Tr, Btn, Spinner, useSortState, sortRows, SortIcon } from '../components/ui'
import { api } from '../api'

const VIEWER_FORMATS = new Set(['SVS','NDPI','TIF','TIFF','MRXS','SCN','VSI','BIF'])

const SCAN_COLS = [
  'patient_code','lis_submission_id','lis_probe_id','snomed_topo_code',
  'topo_description','submission_type','block_label','block_info',
  'stain_name','stain_category','file_path',
]

// Columns rendered in a monospace font (IDs / codes)
const MONO_COLS = new Set(['lis_submission_id', 'lis_probe_id', 'snomed_topo_code'])

// Columns that may contain long prose — truncated with a tooltip on hover
const TRUNCATE_COLS = new Set([
  'patient_code', 'topo_description', 'submission_type',
  'block_label', 'block_info', 'stain_name', 'stain_category',
])

// ── Minimal header (no full Layout — this is a shareable public-ish page) ─────

function PageHeader({ name, returnLevel, count, onCsv, onJson }) {
  return (
    <div style={{
      height: 52,
      padding: '0 var(--space-6)',
      borderBottom: '1px solid var(--border-l)',
      display: 'flex',
      alignItems: 'center',
      gap: 'var(--space-4)',
      background: 'var(--white)',
      position: 'sticky',
      top: 0,
      zIndex: 'var(--z-sticky)',
    }}>
      {/* Logo */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, paddingRight: 20, borderRight: '1px solid var(--border-l)', flexShrink: 0 }}>
        <div style={{ width: 24, height: 24, background: 'var(--crimson)', borderRadius: 5, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <svg width="13" height="13" viewBox="0 0 16 16" fill="white">
            <path d="M8 1a2 2 0 012 2v1h1a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2V6a2 2 0 012-2h1V3a2 2 0 012-2z"/>
          </svg>
        </div>
        <span style={{ fontFamily: 'var(--font-serif)', fontSize: 15, color: 'var(--navy)' }}>PathoDB</span>
      </div>

      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
        <span style={{ fontFamily: 'var(--font-serif)', fontSize: 18, color: 'var(--navy)' }}>{name}</span>
        <span style={{ fontSize: 12, color: 'var(--text-3)' }}>{returnLevel} level</span>
      </div>

      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 'var(--space-4)' }}>
        <span style={{ fontSize: 13, color: 'var(--text-2)' }}>
          <strong style={{ fontFamily: 'var(--font-serif)', fontSize: 20, color: 'var(--navy)' }}>{count}</strong>
          {' '}{returnLevel}s
        </span>
        <Btn variant="ghost" small onClick={onCsv}>Export CSV</Btn>
        <Btn variant="ghost" small onClick={onJson}>Export JSON</Btn>
      </div>
    </div>
  )
}

// ── Main ──────────────────────────────────────────────────────────────────────

export default function CohortResults() {
  const { cohortId } = useParams()
  const [data,    setData]    = useState(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState('')

  // Sort state must be declared before any early returns (rules of hooks)
  const { sortCol, sortDir, toggleSort } = useSortState()
  const sortedResults = useMemo(
    () => data ? sortRows(data.results, sortCol, sortDir) : [],
    [data, sortCol, sortDir],
  )

  useEffect(() => {
    api.getCohortResults(cohortId)
      .then(setData)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [cohortId])

  if (loading) return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--white)' }}>
      <PageHeader name="Loading…" returnLevel="" count={0} onCsv={() => {}} onJson={() => {}} />
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Spinner size={32} />
      </div>
    </div>
  )

  if (error) return (
    <div style={{ minHeight: '100vh', background: 'var(--white)', fontFamily: 'var(--font-sans)' }}>
      <PageHeader name="Error" returnLevel="" count={0} onCsv={() => {}} onJson={() => {}} />
      <div style={{ padding: 32, color: 'var(--crimson)', fontSize: 14 }}>Error: {error}</div>
    </div>
  )

  const isScan = data.return_level === 'scan'
  const cols   = isScan
    ? SCAN_COLS
    : (data.results.length > 0
        ? Object.keys(data.results[0]).filter(k => k !== 'scan_id' && k !== 'viewer_available')
        : [])

  function downloadCSV() {
    if (!data?.results?.length) return
    const headers = isScan ? SCAN_COLS : Object.keys(data.results[0]).filter(k => k !== 'scan_id' && k !== 'viewer_available')
    const csvRows = [headers.join(',')]
    for (const row of data.results) {
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
    const clean = data.results.map(({ scan_id, viewer_available, ...rest }) => rest)
    const blob  = new Blob([JSON.stringify(clean, null, 2)], { type: 'application/json' })
    const url   = URL.createObjectURL(blob)
    const a     = document.createElement('a')
    a.href      = url
    a.download  = `${data.name.replace(/\s+/g, '_')}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--white)', fontFamily: 'var(--font-sans)' }}>
      <PageHeader
        name={data.name}
        returnLevel={data.return_level}
        count={data.count}
        onCsv={downloadCSV}
        onJson={downloadJSON}
      />

      {/* overflowY scrolls the page vertically; the inner wrapper scrolls the table horizontally */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '0 0 var(--space-6)' }}>
        {data.results.length === 0 ? (
          <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-3)', fontSize: 14 }}>
            No results found — the database may have changed since this cohort was saved.
          </div>
        ) : (
          /* Horizontal scroll wrapper — lets the table grow wider than the viewport */
          <div style={{ overflowX: 'auto' }}>
            <Table style={{ fontSize: 12 }}>
              <thead style={{ position: 'sticky', top: 0, zIndex: 1 }}>
                <tr>
                  {cols.map(h => (
                    <Th key={h} onClick={() => toggleSort(h)}>
                      {h.replace(/_/g, ' ')}
                      <SortIcon col={h} sortCol={sortCol} sortDir={sortDir} />
                    </Th>
                  ))}
                  {isScan && <Th>viewer</Th>}
                </tr>
              </thead>
              <tbody>
                {sortedResults.map((row, i) => (
                  <Tr key={i}>
                    {cols.map(col => {
                      if (col === 'file_path') {
                        // File paths: already truncated to last N chars, mono font, tooltip shows full path
                        return (
                          <Td key={col} title={row[col] ?? undefined}>
                            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-2)' }}>
                              {row[col] ? '…' + row[col].slice(-35) : '—'}
                            </span>
                          </Td>
                        )
                      }
                      if (MONO_COLS.has(col)) {
                        // ID / code columns: monospace, no truncation (short and fixed-width)
                        return (
                          <Td key={col} mono>
                            {row[col] ?? '—'}
                          </Td>
                        )
                      }
                      // Text columns: truncate with ellipsis; full value shown on hover via title
                      const val = row[col] != null ? String(row[col]) : '—'
                      return (
                        <Td
                          key={col}
                          truncate={isScan ? TRUNCATE_COLS.has(col) : true}
                          title={row[col] != null ? val : undefined}
                        >
                          {val}
                        </Td>
                      )
                    })}
                    {isScan && (
                      <Td>
                        {row.viewer_available
                          ? <Btn variant="ghost" small onClick={() => window.open(`/viewer/${row.scan_id}`, '_blank')}>
                              View ↗
                            </Btn>
                          : <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-3)' }}>—</span>}
                      </Td>
                    )}
                  </Tr>
                ))}
              </tbody>
            </Table>
          </div>
        )}
      </div>
    </div>
  )
}
