import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import Layout from '../components/Layout'
import { Btn, SpinnerPage, ErrorMsg, IdCell } from '../components/ui'
import { api } from '../api'

function StatCard({ label, value, sub, accent }) {
  return (
    <div style={{
      background: 'white', border: '1px solid var(--border-l)',
      borderLeft: accent ? `3px solid ${accent}` : undefined,
      borderRadius: 8, padding: '12px 14px',
    }}>
      <div style={{ fontSize: 11, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: 22, fontFamily: 'var(--font-serif)', color: accent || 'var(--navy)', marginTop: 4 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>{sub}</div>}
    </div>
  )
}

function BNumberList({ submissionIds }) {
  const [expanded, setExpanded] = useState(false)
  const LIMIT = 3

  if (!submissionIds || submissionIds.length === 0) {
    return <span style={{ color: 'var(--text-3)', fontSize: 12 }}>—</span>
  }

  const shown = expanded ? submissionIds : submissionIds.slice(0, LIMIT)

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center' }}>
      {shown.map((sid, i) => (
        <span key={i} style={{
          fontFamily: 'var(--font-mono)', fontSize: 11,
          padding: '2px 6px', borderRadius: 4,
          color: 'var(--text-3)',
        }}>
          {sid}
        </span>
      ))}
      {!expanded && submissionIds.length > LIMIT && (
        <button
          onClick={e => { e.stopPropagation(); setExpanded(true) }}
          style={{ fontSize: 11, color: 'var(--navy)', background: 'none', border: 'none', cursor: 'pointer', padding: '2px 4px' }}
        >
          +{submissionIds.length - LIMIT} more
        </button>
      )}
    </div>
  )
}

export default function Patients() {
  const navigate = useNavigate()
  const [page, setPage] = useState(1)
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState('')
  const PAGE_SIZE = 50

  // ── 1. REACT QUERY: Fetch Patients (Cached per page) ──
  const { 
    data: patients = [], 
    isLoading: loading, 
    error: patientsError 
  } = useQuery({
    queryKey: ['patients', page], // The cache key automatically tracks the page number!
    queryFn: () => api.getPatients({ page, page_size: PAGE_SIZE })
  })

  // ── 2. REACT QUERY: Fetch Stats (Cached globally) ──
  const { 
    data: stats, 
    isLoading: statsLoading,
    error: statsError
  } = useQuery({
    queryKey: ['stats'],
    queryFn: () => api.getStats()
  })

  const error = (patientsError?.message || statsError?.message || exportError)

  const yearLabel = stats
    ? stats.year_min === stats.year_max
      ? String(stats.year_min ?? '—')
      : `${stats.year_min ?? '?'} – ${stats.year_max ?? '?'}`
    : '—'

  const actions = (
    <Btn variant="ghost" small onClick={handleExport} disabled={exporting}>
      {exporting ? 'Exporting…' : 'Export CSV'}
    </Btn>
  )

  async function handleExport() {
    setExporting(true)
    setExportError('')
    try {
      const all = await api.getPatients({ page: 1, page_size: 9999 })
      const headers = ['patient_code', 'date_of_birth', 'sex', 'last_report_date', 'has_malignancy', 'submission_ids']
      const rows = all.map(p => [
        p.patient_code,
        p.date_of_birth    || '',
        p.sex              || '',
        p.last_report_date || '',
        p.has_malignancy ? 'yes' : 'no',
        (p.submission_ids  || []).join('; '),
      ])

      const csv = [headers, ...rows].map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\n')
      const blob = new Blob([csv], { type: 'text/csv' })
      const url  = URL.createObjectURL(blob)
      const a    = document.createElement('a')
      a.href     = url
      a.download = `patients_${new Date().toISOString().slice(0, 10)}.csv`
      a.click()
      URL.revokeObjectURL(url)
    } catch (e) {
      setExportError(e.message)
    } finally {
      setExporting(false)
    }
  }

  return (
    <Layout title="Patients" actions={actions}>
      <div style={{ height: '100%', overflowY: 'auto', padding: '20px 24px' }}>

        {/* Stats */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 12, marginBottom: 16 }}>
          <StatCard label="Patients" value={statsLoading ? '…' : (stats?.patient_count?.toLocaleString() ?? '—')} sub="total in database" />
          <StatCard label="Submission years" value={statsLoading ? '…' : yearLabel} sub="from submission IDs" />
          <StatCard label="Blocks" value={statsLoading ? '…' : (stats?.block_count?.toLocaleString() ?? '—')} sub={statsLoading ? '' : `${stats?.scanned_pct ?? 0}% scanned`} />
          <StatCard label="Malignancy rate" value={statsLoading ? '…' : `${stats?.malignancy_rate ?? 0}%`} sub="of submissions" accent="var(--crimson)" />
        </div>

        <ErrorMsg message={error} />

        {/* Table */}
        {loading ? <SpinnerPage /> : (
          <>
            <div style={{ background: 'white', border: '1px solid var(--border-l)', borderRadius: 8, overflow: 'hidden' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ background: 'var(--navy-05)' }}>
                    {['Patient code', 'DOB', 'Sex', 'Submission IDs', 'Last report', 'Malignancy', ''].map(h => (
                      <th key={h} style={thStyle}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {patients.map(p => (
                    <tr
                      key={p.id}
                      onClick={() => navigate(`/patients/${p.id}`)}
                      style={{ cursor: 'pointer', transition: 'background 0.1s' }}
                      onMouseEnter={e => e.currentTarget.style.background = 'var(--navy-05)'}
                      onMouseLeave={e => e.currentTarget.style.background = 'white'}
                    >
                      <td style={tdStyle}><IdCell>{p.patient_code}</IdCell></td>
                      <td style={tdStyle}>{p.date_of_birth || '—'}</td>
                      <td style={tdStyle}>{p.sex || '—'}</td>
                      <td style={{ ...tdStyle, maxWidth: 280 }}>
                        <BNumberList submissionIds={p.submission_ids || []} />
                      </td>
                      <td style={{ ...tdStyle, whiteSpace: 'nowrap' }}>
                        {p.last_report_date
                          ? <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{p.last_report_date}</span>
                          : <span style={{ color: 'var(--text-3)' }}>—</span>
                        }
                      </td>
                      <td style={tdStyle}>
                        {p.has_malignancy
                          ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 600, color: 'var(--crimson)', background: 'var(--crimson-10)', padding: '2px 8px', borderRadius: 20 }}>Malignant</span>
                          : <span style={{ fontSize: 12, color: 'var(--text-3)' }}>—</span>
                        }
                      </td>
                      <td style={{ ...tdStyle, textAlign: 'right' }}>
                        <span style={{ fontSize: 18, color: 'var(--navy-20)' }}>›</span>
                      </td>
                    </tr>
                  ))}
                  {patients.length === 0 && (
                    <tr>
                      <td colSpan={7} style={{ padding: '24px', textAlign: 'center', color: 'var(--text-3)' }}>
                        No patients found
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 12 }}>
              <span style={{ fontSize: 12, color: 'var(--text-3)' }}>{patients.length} records on this page</span>
              <div style={{ display: 'flex', gap: 6 }}>
                <Btn variant="ghost" small disabled={page === 1} onClick={() => setPage(p => p - 1)}>← Prev</Btn>
                <Btn variant="ghost" small disabled={patients.length < PAGE_SIZE} onClick={() => setPage(p => p + 1)}>Next →</Btn>
              </div>
            </div>
          </>
        )}
      </div>
    </Layout>
  )
}

const thStyle = { padding: '10px 14px', textAlign: 'left', fontSize: 11, fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.06em', borderBottom: '1px solid var(--border-l)' }
const tdStyle = { padding: '11px 14px', borderBottom: '1px solid var(--border-l)', color: 'var(--text-2)', verticalAlign: 'middle' }