import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import Layout from '../components/Layout'
import { Btn, StatCard, Table, Th, Td, Tr, IdCell, Badge, ErrorMsg, SpinnerPage } from '../components/ui'
import { api } from '../api'
import { getModality } from '../lib/modality'

// ── Collapsed accession list with expand ─────────────────────────────────────
// Each accession is tinted by its modality (histology / cytology / autopsy),
// using the same navy / purple / amber identity as the Patient Detail page, so
// the modality mix of a patient is legible at a glance from the list. External /
// unknown prefixes fall back to the neutral grey chip.

function AccessionList({ submissionIds }) {
  const [expanded, setExpanded] = useState(false)
  const LIMIT = 3

  if (!submissionIds?.length) {
    return <span style={{ color: 'var(--text-3)', fontSize: 12 }}>—</span>
  }

  const shown = expanded ? submissionIds : submissionIds.slice(0, LIMIT)

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center' }}>
      {shown.map((sid, i) => {
        const m = getModality(sid)
        return (
          <span key={i} title={m?.label} style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 'var(--text-sm)',
            padding: '2px 6px',
            borderRadius: 'var(--radius-sm)',
            color: m ? m.fg : 'var(--text-3)',
            background: m ? m.bg : 'transparent',
          }}>
            {sid}
          </span>
        )
      })}
      {!expanded && submissionIds.length > LIMIT && (
        <button
          onClick={e => { e.stopPropagation(); setExpanded(true) }}
          style={{
            fontSize: 'var(--text-sm)',
            color: 'var(--navy)',
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            padding: '2px 4px',
          }}
        >
          +{submissionIds.length - LIMIT} more
        </button>
      )}
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function Patients() {
  const navigate    = useNavigate()
  const [page, setPage] = useState(1)
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState('')
  const PAGE_SIZE = 50

  const { data: patients = [], isLoading, error: patientsError } = useQuery({
    queryKey: ['patients', page],
    queryFn:  () => api.getPatients({ page, page_size: PAGE_SIZE }),
  })

  const { data: stats, isLoading: statsLoading, error: statsError } = useQuery({
    queryKey: ['stats'],
    queryFn:  () => api.getStats(),
  })

  const error = patientsError?.message || statsError?.message || exportError

  const yearLabel = stats
    ? stats.year_min === stats.year_max
      ? String(stats.year_min ?? '—')
      : `${stats.year_min ?? '?'} – ${stats.year_max ?? '?'}`
    : '—'

  async function handleExport() {
    setExporting(true)
    setExportError('')
    try {
      const all     = await api.getPatients({ page: 1, page_size: 9999 })
      const headers = ['patient_code', 'date_of_birth', 'sex', 'last_report_date', 'has_malignancy', 'submission_ids']
      const rows    = all.map(p => [
        p.patient_code,
        p.date_of_birth    || '',
        p.sex              || '',
        p.last_report_date || '',
        p.has_malignancy ? 'yes' : 'no',
        (p.submission_ids  || []).join('; '),
      ])
      const csv  = [headers, ...rows].map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n')
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

  const actions = (
    <Btn variant="ghost" small onClick={handleExport} disabled={exporting}>
      {exporting ? 'Exporting…' : 'Export CSV'}
    </Btn>
  )

  return (
    <Layout title="Patients" actions={actions}>
      <div style={{ height: '100%', overflowY: 'auto', padding: 'var(--space-5) var(--space-6)' }}>

        {/* Stats row */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 'var(--space-4)' }}>
          <StatCard
            label="Patients"
            value={statsLoading ? '…' : (stats?.patient_count?.toLocaleString() ?? '—')}
            sub="total in database"
          />
          <StatCard
            label="Submission years"
            value={statsLoading ? '…' : yearLabel}
            sub="from submission IDs"
          />
          <StatCard
            label="Blocks"
            value={statsLoading ? '…' : (stats?.block_count?.toLocaleString() ?? '—')}
            sub={statsLoading ? '' : `${stats?.scanned_pct ?? 0}% scanned`}
          />
          <StatCard
            label="Malignancy rate"
            value={statsLoading ? '…' : `${stats?.malignancy_rate ?? 0}%`}
            sub="of submissions"
            accent="var(--crimson)"
          />
        </div>

        <ErrorMsg message={error} onDismiss={() => setExportError('')} />

        {isLoading ? <SpinnerPage /> : (
          <>
            <Table>
              <thead>
                <tr>
                  <Th>Patient code</Th>
                  <Th>DOB</Th>
                  <Th>Sex</Th>
                  <Th>Submission IDs</Th>
                  <Th>Last report</Th>
                  <Th>Malignancy</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {patients.map(p => (
                  <Tr key={p.id} onClick={() => navigate(`/patients/${p.id}`)}>
                    <Td><IdCell>{p.patient_code}</IdCell></Td>
                    <Td>{p.date_of_birth || '—'}</Td>
                    <Td>{p.sex || '—'}</Td>
                    <Td style={{ maxWidth: 280 }}>
                      <AccessionList submissionIds={p.submission_ids} />
                    </Td>
                    <Td>
                      {p.last_report_date
                        ? <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{p.last_report_date}</span>
                        : <span style={{ color: 'var(--text-3)' }}>—</span>}
                    </Td>
                    <Td>
                      {p.has_malignancy
                        ? <Badge variant="red">Malignant</Badge>
                        : <span style={{ fontSize: 12, color: 'var(--text-3)' }}>—</span>}
                    </Td>
                    <Td style={{ textAlign: 'right' }}>
                      <span style={{ fontSize: 18, color: 'var(--navy-20)' }}>›</span>
                    </Td>
                  </Tr>
                ))}
                {patients.length === 0 && (
                  <tr>
                    <td colSpan={7} style={{ padding: 24, textAlign: 'center', color: 'var(--text-3)' }}>
                      No patients found
                    </td>
                  </tr>
                )}
              </tbody>
            </Table>

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