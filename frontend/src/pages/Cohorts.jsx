import { useState, useEffect, useRef } from 'react'
import Layout from '../components/Layout'
import {
  Btn, Panel, ErrorMsg, SpinnerPage,
  Table, Th, Td, Tr,
  FormLabel, FormInput, FormSelect, FormTextarea, FormField,
  SegmentedControl, MultiSelect,
} from '../components/ui'
import { api } from '../api'

const EMPTY_FILTER = {
  snomed_topo_codes:       [],
  topo_description_search: [],
  stain_names:             [],
  submission_types:        null,
  stain_categories:        null,
  file_formats:            null,
  magnification_min:       null,
  magnification_max:       null,
  submission_date_from:    '',
  submission_date_to:      '',
  malignancy_flag:         null,
  has_scan:                null,
  block_info_search:       '',
  return_level:            'block',
}

// ── Scan-level results table ──────────────────────────────────────────────────

const SCAN_COLS = ['patient_code','lis_submission_id','lis_probe_id','snomed_topo_code',
                   'topo_description','submission_type','block_label','block_info',
                   'stain_name','stain_category','file_path']
const MONO_COLS = new Set(['lis_submission_id','lis_probe_id','snomed_topo_code'])
const LIMIT     = 50

function ScanResultsTable({ rows }) {
  const shown = rows.slice(0, LIMIT)
  return (
    <div style={{ overflowX: 'auto', marginBottom: 4 }}>
      <Table>
        <thead>
          <tr>
            {SCAN_COLS.map(h => <Th key={h}>{h.replace(/_/g, ' ')}</Th>)}
            <Th>Viewer</Th>
          </tr>
        </thead>
        <tbody>
          {shown.map((row, i) => (
            <Tr key={i}>
              {SCAN_COLS.map(col => (
                <Td key={col} mono={MONO_COLS.has(col)}>
                  {col === 'file_path'
                    ? <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-2)' }} title={row[col]}>
                        {row[col] ? '…' + row[col].slice(-30) : '—'}
                      </span>
                    : <span>{row[col] ?? '—'}</span>}
                </Td>
              ))}
              <Td>
                {row.viewer_available
                  ? <Btn variant="ghost" small onClick={() => window.open(`/viewer/${row.scan_id}`, '_blank')}>View ↗</Btn>
                  : <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-3)' }}>—</span>}
              </Td>
            </Tr>
          ))}
        </tbody>
      </Table>
      {rows.length > LIMIT && (
        <div style={{ padding: '8px 10px', fontSize: 'var(--text-sm)', color: 'var(--text-3)', borderTop: '1px solid var(--border-l)' }}>
          Showing {LIMIT} of {rows.length} — export CSV/JSON for full results
        </div>
      )}
    </div>
  )
}

function GenericResultsTable({ rows }) {
  const shown = rows.slice(0, LIMIT)
  if (!shown.length) return null
  const cols = Object.keys(shown[0])
  return (
    <div style={{ overflowX: 'auto', marginBottom: 4 }}>
      <Table>
        <thead>
          <tr>{cols.map(h => <Th key={h}>{h.replace(/_/g, ' ')}</Th>)}</tr>
        </thead>
        <tbody>
          {shown.map((row, i) => (
            <Tr key={i}>
              {cols.map((col, j) => <Td key={j}>{row[col] == null ? '—' : String(row[col])}</Td>)}
            </Tr>
          ))}
        </tbody>
      </Table>
      {rows.length > LIMIT && (
        <div style={{ padding: '8px 10px', fontSize: 'var(--text-sm)', color: 'var(--text-3)' }}>
          Showing {LIMIT} of {rows.length} — export for full results
        </div>
      )}
    </div>
  )
}

// ── Saved cohort card ─────────────────────────────────────────────────────────

function SavedCohortCard({ c, onOpen, onExportCsv, onExportJson, onDelete, deleting }) {
  return (
    <div style={{
      padding: '10px 12px',
      border: '1px solid var(--border-l)',
      borderRadius: 'var(--radius-lg)',
      transition: 'var(--transition-base)',
    }}
      onMouseEnter={e => e.currentTarget.style.borderColor = 'var(--navy-20)'}
      onMouseLeave={e => e.currentTarget.style.borderColor = 'var(--border-l)'}
    >
      <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--navy)', marginBottom: 2 }}>{c.name}</div>
      {c.description && <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-3)', marginBottom: 4 }}>{c.description}</div>}
      <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-3)', marginBottom: 8 }}>
        {c.result_count != null ? `${c.result_count} results` : '—'}
        {c.last_run_at && ` · ${new Date(c.last_run_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`}
      </div>

      {deleting?.id === c.id ? (
        <div style={{ background: 'var(--crimson-10)', border: '1px solid var(--crimson)', borderRadius: 'var(--radius-md)', padding: '8px 10px', fontSize: 12 }}>
          <div style={{ color: 'var(--crimson)', fontWeight: 500, marginBottom: 6 }}>Delete "{c.name}"?</div>
          <div style={{ display: 'flex', gap: 6 }}>
            <Btn variant="danger"  small onClick={() => onDelete(c)}>Yes, delete</Btn>
            <Btn variant="ghost"   small onClick={() => onDelete(null)}>Cancel</Btn>
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 6 }}>
          <Btn variant="primary" small onClick={() => onOpen(c.id)}>Open ↗</Btn>
          <Btn variant="ghost"   small onClick={() => onExportCsv(c)}>CSV</Btn>
          <Btn variant="ghost"   small onClick={() => onExportJson(c)}>JSON</Btn>
          <Btn variant="ghost"   small style={{ fontSize: 'var(--text-sm)', color: 'var(--crimson)', marginLeft: 'auto' }}
            onClick={() => onDelete(c)}>Delete</Btn>
        </div>
      )}
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function Cohorts() {
  const [mode,     setMode]     = useState('filter')
  const [filter,   setFilter]   = useState(EMPTY_FILTER)
  const [idType,   setIdType]   = useState('patient_code')
  const [bScope,   setBScope]   = useState('all')
  const [idText,   setIdText]   = useState('')
  const [listLevel,setListLevel]= useState('scan')
  const [result,   setResult]   = useState(null)
  const [querying, setQuerying] = useState(false)
  const [error,    setError]    = useState('')
  const [saveName, setSaveName] = useState('')
  const [saving,   setSaving]   = useState(false)
  const [saved,    setSaved]    = useState([])
  const [deleting, setDeleting] = useState(null)

  useEffect(() => {
    api.getCohorts().then(setSaved).catch(() => {})
  }, [])

  function setF(key, val) { setFilter(f => ({ ...f, [key]: val === '' ? null : val })) }

  async function runQuery() {
    setQuerying(true); setError(''); setResult(null)
    try {
      if (mode === 'filter') {
        const clean = Object.fromEntries(Object.entries(filter).filter(([, v]) => v !== '' && v !== null))
        setResult(await api.queryCohort(clean))
      } else {
        const ids = idText.split('\n').map(s => s.trim()).filter(Boolean)
        if (!ids.length) { setError('Paste at least one ID'); setQuerying(false); return }
        setResult(await api.queryList({ id_type: idType, b_scope: bScope, ids, return_level: listLevel }))
      }
    } catch (e) { setError(e.message) }
    finally     { setQuerying(false) }
  }

  async function saveCohort() {
    if (!saveName.trim()) return
    setSaving(true)
    try {
      let filter_json
      if (mode === 'filter') {
        filter_json = Object.fromEntries(Object.entries(filter).filter(([, v]) => v !== '' && v !== null))
      } else {
        filter_json = { is_list_query: true, ids: idText.split('\n').map(s => s.trim()).filter(Boolean), id_type: idType, b_scope: bScope, return_level: listLevel }
      }
      await api.saveCohort({ name: saveName, filter_json })
      setSaveName('')
      setSaved(await api.getCohorts())
    } catch (e) { setError(e.message) }
    finally     { setSaving(false) }
  }

  async function deleteCohort(cohort) {
    if (!cohort) { setDeleting(null); return }
    try {
      await api.deleteCohort(cohort.id)
      setSaved(await api.getCohorts())
    } catch (e) { setError(e.message) }
    finally     { setDeleting(null) }
  }

  function downloadCSV() {
    if (!result?.results?.length) return
    const isScan  = result.return_level === 'scan'
    const headers = isScan ? SCAN_COLS : Object.keys(result.results[0])
    const csvRows = [headers.join(',')]
    for (const row of result.results) {
      csvRows.push(headers.map(h => `"${(row[h] ?? '').toString().replace(/"/g, '""')}"`).join(','))
    }
    const blob = new Blob([csvRows.join('\n')], { type: 'text/csv;charset=utf-8;' })
    const url  = URL.createObjectURL(blob)
    Object.assign(document.createElement('a'), { href: url, download: 'cohort_export.csv' }).click()
    URL.revokeObjectURL(url)
  }

  function downloadJSON() {
    if (!result?.results?.length) return
    const blob = new Blob([JSON.stringify(result.results, null, 2)], { type: 'application/json' })
    const url  = URL.createObjectURL(blob)
    Object.assign(document.createElement('a'), { href: url, download: 'cohort_export.json' }).click()
    URL.revokeObjectURL(url)
  }

  const returnLevel = mode === 'filter' ? filter.return_level : listLevel
  const isScanLevel = returnLevel === 'scan'

  const actions = mode === 'filter'
    ? <Btn variant="ghost" small onClick={() => { setFilter(EMPTY_FILTER); setResult(null) }}>Reset filters</Btn>
    : <Btn variant="ghost" small onClick={() => { setIdText(''); setResult(null) }}>Clear</Btn>

  const RETURN_LEVEL_OPTS = ['patient','submission','probe','block','scan'].map(v => [v, v.charAt(0).toUpperCase() + v.slice(1)])

  return (
    <Layout title="Cohort Builder" actions={actions}>
      <div style={{ height: '100%', overflowY: 'auto', padding: 'var(--space-5) var(--space-6)' }}>
        <ErrorMsg message={error} onDismiss={() => setError('')} />

        {/* Mode toggle */}
        <div style={{ marginBottom: 'var(--space-5)' }}>
          <SegmentedControl
            options={[['filter', 'Filter mode'], ['list', 'List mode']]}
            value={mode}
            onChange={val => { setMode(val); setResult(null); setError('') }}
          />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 'var(--space-4)' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>

            {/* ── Filter mode ── */}
            {mode === 'filter' && (
              <Panel title="Filters">
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
                  <MultiSelect label="Topology Description" field="topo_description"
                    selected={filter.topo_description_search}
                    onChange={val => setF('topo_description_search', val)}
                    loadOptions={(val) => api.lookup('topo_description', val)}
                    placeholder="Type to search (e.g. 'Colon', 'Lung')…" />
                  <MultiSelect label="Stain Name" field="stain_name"
                    selected={filter.stain_names}
                    onChange={val => setF('stain_names', val)}
                    loadOptions={(val) => api.lookup('stain_name', val)}
                    placeholder="Type to search (e.g. 'H&E', 'CD3')…" />
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginTop: 10 }}>
                  <MultiSelect label="SNOMED Code" field="snomed_topo_code"
                    selected={filter.snomed_topo_codes}
                    onChange={val => setF('snomed_topo_codes', val)}
                    loadOptions={(val) => api.lookup('snomed_topo_code', val)}
                    placeholder="Type to search (e.g. 'T59600')…" />
                  <FormField label="Return level">
                    <FormSelect value={filter.return_level} onChange={e => setF('return_level', e.target.value)}>
                      {RETURN_LEVEL_OPTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </FormSelect>
                  </FormField>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginTop: 10 }}>
                  <FormField label="Report date from">
                    <FormInput type="date" onChange={e => setF('submission_date_from', e.target.value)} />
                  </FormField>
                  <FormField label="Report date to">
                    <FormInput type="date" onChange={e => setF('submission_date_to', e.target.value)} />
                  </FormField>
                  <FormField label="Malignancy">
                    <FormSelect onChange={e => setF('malignancy_flag', e.target.value === '' ? null : e.target.value === 'true')}>
                      <option value="">Any</option>
                      <option value="true">Positive</option>
                      <option value="false">Negative</option>
                    </FormSelect>
                  </FormField>
                </div>
                <Btn variant="primary" style={{ marginTop: 'var(--space-5)' }} onClick={runQuery} disabled={querying}>
                  {querying ? 'Running query…' : 'Run query'}
                </Btn>
              </Panel>
            )}

            {/* ── List mode ── */}
            {mode === 'list' && (
              <Panel title="Query by list">
                <FormField label="ID type">
                  <SegmentedControl
                    options={[['patient_code', 'Patient code'], ['b_number', 'B-number']]}
                    value={idType}
                    onChange={setIdType}
                  />
                </FormField>

                {idType === 'b_number' && (
                  <FormField label="Scope per B-number">
                    <SegmentedControl
                      options={[['all', 'All submissions from patient'], ['matched', 'Only the matched submission']]}
                      value={bScope}
                      onChange={setBScope}
                    />
                    <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-3)', marginTop: 5 }}>
                      {bScope === 'all'
                        ? 'Returns all tissue from the patient, regardless of which submission the B-number matched.'
                        : 'Returns only the submission directly matched by this B-number.'}
                    </div>
                  </FormField>
                )}

                <FormField label="Return level">
                  <FormSelect value={listLevel} onChange={e => setListLevel(e.target.value)} style={{ width: 200 }}>
                    {RETURN_LEVEL_OPTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </FormSelect>
                </FormField>

                <FormField label={`Paste ${idType === 'b_number' ? 'B-numbers' : 'patient codes'} (one per line)`}>
                  <FormTextarea
                    value={idText}
                    onChange={e => setIdText(e.target.value)}
                    placeholder={idType === 'b_number' ? 'B2019.14823\nB2015.00392' : '581561\n795492'}
                    rows={8}
                    style={{ fontFamily: 'var(--font-mono)' }}
                  />
                  <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-3)', marginTop: 4 }}>
                    {idText.split('\n').filter(s => s.trim()).length} IDs entered
                    ({new Set(idText.split('\n').filter(s => s.trim())).size} unique)
                  </div>
                </FormField>

                <Btn variant="primary" onClick={runQuery} disabled={querying || !idText.trim()}>
                  {querying ? 'Running…' : 'Run query'}
                </Btn>
              </Panel>
            )}

            {/* ── Results ── */}
            {result && (
              <Panel title="Results">
                <div style={{ display: 'flex', alignItems: 'flex-end', gap: 'var(--space-4)', marginBottom: 'var(--space-4)' }}>
                  <div>
                    <div style={{ fontFamily: 'var(--font-serif)', fontSize: 36, color: 'var(--navy)', lineHeight: 1 }}>{result.count}</div>
                    <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 4 }}>{result.return_level}s matching</div>
                  </div>
                  <div style={{ display: 'flex', gap: 10, marginTop: 10 }}>
                    <Btn variant="ghost" small onClick={downloadCSV}>Export CSV</Btn>
                    <Btn variant="ghost" small onClick={downloadJSON}>Export JSON</Btn>
                  </div>
                </div>

                {result.not_found?.length > 0 && (
                  <div style={{
                    background: 'var(--warning-bg)', border: '1px solid #e8c84a',
                    borderRadius: 'var(--radius-md)', padding: '8px 12px',
                    fontSize: 12, color: 'var(--warning)', marginBottom: 12,
                  }}>
                    <strong>{result.not_found.length} ID{result.not_found.length !== 1 ? 's' : ''} not found:</strong>{' '}
                    {result.not_found.join(', ')}
                  </div>
                )}

                {result.results.length > 0 && (
                  isScanLevel
                    ? <ScanResultsTable rows={result.results} />
                    : <GenericResultsTable rows={result.results} />
                )}

                {/* Save cohort */}
                <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                  <FormInput
                    placeholder="Cohort name…"
                    value={saveName}
                    onChange={e => setSaveName(e.target.value)}
                    style={{ flex: 1 }}
                  />
                  <Btn variant="primary" small onClick={saveCohort} disabled={saving || !saveName.trim()}>
                    {saving ? 'Saving…' : 'Save cohort'}
                  </Btn>
                </div>
              </Panel>
            )}
          </div>

          {/* ── Saved cohorts ── */}
          <Panel title="Saved cohorts">
            {saved.length === 0
              ? <div style={{ color: 'var(--text-3)', fontSize: 13 }}>No saved cohorts yet.</div>
              : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {saved.map(c => (
                    <SavedCohortCard
                      key={c.id}
                      c={c}
                      deleting={deleting}
                      onOpen={id => window.open(`/saved-results/${id}`, '_blank')}
                      onExportCsv={c => api.exportCohort(c.id, 'csv', c.name).catch(e => setError(e.message))}
                      onExportJson={c => api.exportCohort(c.id, 'json', c.name).catch(e => setError(e.message))}
                      onDelete={c => c ? setDeleting(c) : setDeleting(null)}
                    />
                  ))}
                  {/* Trigger actual delete when confirmed */}
                  {deleting && (
                    <SavedCohortCard
                      c={deleting}
                      deleting={deleting}
                      onOpen={() => {}}
                      onExportCsv={() => {}}
                      onExportJson={() => {}}
                      onDelete={c => c ? deleteCohort(c) : setDeleting(null)}
                    />
                  )}
                </div>
              )}
          </Panel>
        </div>
      </div>
    </Layout>
  )
}