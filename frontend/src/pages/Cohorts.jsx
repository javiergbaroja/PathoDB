import { useState, useEffect, useRef } from 'react'
import Layout from '../components/Layout'
import {
  Btn, Panel, ErrorMsg, SpinnerPage,
  Table, Th, Td, Tr,
  FormLabel, FormInput, FormSelect, FormTextarea, FormField,
  SegmentedControl, MultiSelect, ConfirmDialog,
} from '../components/ui'
import { api } from '../api'

const EMPTY_FILTER = {
  snomed_topo_codes:       [],
  topo_description_search: [],
  stain_names:             [],
  stain_categories:        [],
  submission_types:        [],
  file_formats:            [],
  magnification_min:       null,
  magnification_max:       null,
  submission_date_from:    '',
  submission_date_to:      '',
  malignancy_flag:         null,
  has_scan:                null,
  block_info_search:       '',
  return_level:            'block',
}

const EMPTY_LIST_FILTER = {
  snomed_topo_codes:       [],
  topo_description_search: [],
  submission_types:        [],
  malignancy_flag:         null,
  has_scan:                null,
  block_info_search:       '',
  submission_date_from:    '',
  submission_date_to:      '',
  stain_names:             [],
  stain_categories:        [],
  file_formats:            [],
  magnification_min:       null,
  magnification_max:       null,
}

// ── Result summary helpers ────────────────────────────────────────────────────

function computeSummary(result) {
  if (!result?.results?.length) return null
  const rows = result.results

  const uniquePatients    = new Set(rows.map(r => r.patient_code)).size
  const uniqueSubmissions = new Set(rows.map(r => r.lis_submission_id).filter(Boolean)).size

  const topoCounts = {}
  rows.forEach(r => { if (r.topo_description) topoCounts[r.topo_description] = (topoCounts[r.topo_description] || 0) + 1 })
  const topTopos = Object.entries(topoCounts).sort((a, b) => b[1] - a[1]).slice(0, 6)

  let topStains = null
  if (result.return_level === 'scan') {
    const stainCounts = {}
    rows.forEach(r => { if (r.stain_name) stainCounts[r.stain_name] = (stainCounts[r.stain_name] || 0) + 1 })
    topStains = Object.entries(stainCounts).sort((a, b) => b[1] - a[1]).slice(0, 6)
  }

  return { uniquePatients, uniqueSubmissions, topTopos, topStains }
}

function MiniBar({ label, count, max }) {
  const pct = max > 0 ? Math.round((count / max) * 100) : 0
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, marginBottom: 3 }}>
      <div style={{ width: 110, color: 'var(--text-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flexShrink: 0 }} title={label}>{label}</div>
      <div style={{ flex: 1, background: 'var(--border-l)', borderRadius: 3, overflow: 'hidden', height: 8 }}>
        <div style={{ width: `${pct}%`, background: 'var(--navy-20)', height: '100%', borderRadius: 3 }} />
      </div>
      <div style={{ width: 30, textAlign: 'right', color: 'var(--text-3)', fontFamily: 'var(--font-mono)', fontSize: 10 }}>{count}</div>
    </div>
  )
}

function ResultSummary({ result }) {
  const s = computeSummary(result)
  if (!s) return null

  return (
    <div style={{ background: 'var(--bg-subtle, rgba(0,0,0,0.02))', border: '1px solid var(--border-l)', borderRadius: 'var(--radius-md)', padding: '10px 14px', marginBottom: 12 }}>
      {/* Key counts */}
      <div style={{ display: 'flex', gap: 20, marginBottom: s.topTopos.length ? 10 : 0, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 12 }}>
          <span style={{ fontWeight: 600, color: 'var(--navy)' }}>{s.uniquePatients}</span>
          <span style={{ color: 'var(--text-3)', marginLeft: 3 }}>patient{s.uniquePatients !== 1 ? 's' : ''}</span>
        </div>
        {s.uniqueSubmissions > 0 && (
          <div style={{ fontSize: 12 }}>
            <span style={{ fontWeight: 600, color: 'var(--navy)' }}>{s.uniqueSubmissions}</span>
            <span style={{ color: 'var(--text-3)', marginLeft: 3 }}>submission{s.uniqueSubmissions !== 1 ? 's' : ''}</span>
          </div>
        )}
        {s.topTopos.length > 0 && (
          <div style={{ fontSize: 12 }}>
            <span style={{ fontWeight: 600, color: 'var(--navy)' }}>{Object.keys(Object.fromEntries(s.topTopos)).length}+</span>
            <span style={{ color: 'var(--text-3)', marginLeft: 3 }}>topograph{s.topTopos.length !== 1 ? 'ies' : 'y'}</span>
          </div>
        )}
      </div>

      {/* Breakdowns */}
      <div style={{ display: 'grid', gridTemplateColumns: s.topStains ? '1fr 1fr' : '1fr', gap: 14 }}>
        {s.topTopos.length > 0 && (
          <div>
            <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>Top topographies</div>
            {s.topTopos.map(([label, count]) => (
              <MiniBar key={label} label={label} count={count} max={s.topTopos[0][1]} />
            ))}
          </div>
        )}
        {s.topStains && s.topStains.length > 0 && (
          <div>
            <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>Top stains</div>
            {s.topStains.map(([label, count]) => (
              <MiniBar key={label} label={label} count={count} max={s.topStains[0][1]} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
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

function SavedCohortCard({ c, onOpen, onExportCsv, onExportJson, onDelete }) {
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

      <div style={{ display: 'flex', gap: 6 }}>
        <Btn variant="primary" small onClick={() => onOpen(c.id)}>Open ↗</Btn>
        <Btn variant="ghost"   small onClick={() => onExportCsv(c)}>CSV</Btn>
        <Btn variant="ghost"   small onClick={() => onExportJson(c)}>JSON</Btn>
        <Btn variant="ghost"   small style={{ fontSize: 'var(--text-sm)', color: 'var(--crimson)', marginLeft: 'auto' }}
          onClick={() => onDelete(c)}>Delete</Btn>
      </div>
    </div>
  )
}

// ── Inline section divider ────────────────────────────────────────────────────

function SectionLabel({ children }) {
  return (
    <div style={{
      fontSize: 10, fontWeight: 600, color: 'var(--text-3)',
      textTransform: 'uppercase', letterSpacing: '0.06em',
      marginTop: 14, marginBottom: 6,
      display: 'flex', alignItems: 'center', gap: 8,
    }}>
      {children}
      <div style={{ flex: 1, height: 1, background: 'var(--border-l)' }} />
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function Cohorts() {
  const [mode,          setMode]          = useState('filter')
  const [filter,        setFilter]        = useState(EMPTY_FILTER)
  const [idType,        setIdType]        = useState('patient_code')
  const [bScope,        setBScope]        = useState('all')
  const [idText,        setIdText]        = useState('')
  const [listLevel,     setListLevel]     = useState('scan')
  const [listFilter,    setListFilter]    = useState(EMPTY_LIST_FILTER)
  const [showListFilters, setShowListFilters] = useState(false)
  const [result,        setResult]        = useState(null)
  const [querying,      setQuerying]      = useState(false)
  const [error,         setError]         = useState('')
  const [saveName,      setSaveName]      = useState('')
  const [saveDesc,      setSaveDesc]      = useState('')
  const [saving,        setSaving]        = useState(false)
  const [saved,         setSaved]         = useState([])
  const [deleteTarget,  setDeleteTarget]  = useState(null)
  const [deleteBusy,    setDeleteBusy]    = useState(false)

  useEffect(() => {
    api.getCohorts().then(setSaved).catch(() => {})
  }, [])

  // Helpers to update individual filter keys
  function setF(key, val) { setFilter(f => ({ ...f, [key]: val === '' ? null : val })) }
  function setLF(key, val) { setListFilter(f => ({ ...f, [key]: val === '' ? null : val })) }

  // Count active list-mode filters
  const activeListFilterCount = Object.entries(listFilter).filter(([, v]) => {
    if (v === null || v === '') return false
    if (Array.isArray(v)) return v.length > 0
    return true
  }).length

  // ── CSV / TXT file upload into textarea ──────────────────────────────────────
  function handleFileUpload(e) {
    const file = e.target.files[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (ev) => {
      const text = ev.target.result
      // Each line → take first comma-delimited value, strip quotes/whitespace
      const ids = text.split('\n')
        .map(line => line.split(',')[0].trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean)
      // Auto-skip a header row if it doesn't look like a patient code or B-number
      const first = ids[0] || ''
      const looksLikeId = /^[Bb]\.?\d{4}\./.test(first) || /^\d+$/.test(first)
      setIdText((looksLikeId ? ids : ids.slice(1)).join('\n'))
    }
    reader.readAsText(file)
    // Reset so the same file can be re-uploaded if needed
    e.target.value = ''
  }

  // ── Build clean payload for filter mode ──────────────────────────────────────
  function cleanFilter(f) {
    return Object.fromEntries(
      Object.entries(f).filter(([, v]) => {
        if (v === '' || v === null) return false
        if (Array.isArray(v) && v.length === 0) return false
        return true
      })
    )
  }

  // ── Build clean post-hoc filter payload for list mode ────────────────────────
  function cleanListFilter(lf) {
    return Object.fromEntries(
      Object.entries(lf).filter(([, v]) => {
        if (v === '' || v === null) return false
        if (Array.isArray(v) && v.length === 0) return false
        return true
      })
    )
  }

  async function runQuery() {
    setQuerying(true); setError(''); setResult(null)
    try {
      if (mode === 'filter') {
        setResult(await api.queryCohort(cleanFilter(filter)))
      } else {
        const ids = idText.split('\n').map(s => s.trim()).filter(Boolean)
        if (!ids.length) { setError('Paste at least one ID'); setQuerying(false); return }
        const extra = cleanListFilter(listFilter)
        setResult(await api.queryList({ id_type: idType, b_scope: bScope, ids, return_level: listLevel, ...extra }))
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
        filter_json = cleanFilter(filter)
      } else {
        const extra = cleanListFilter(listFilter)
        filter_json = {
          is_list_query: true,
          ids:           idText.split('\n').map(s => s.trim()).filter(Boolean),
          id_type:       idType,
          b_scope:       bScope,
          return_level:  listLevel,
          ...extra,
        }
      }
      await api.saveCohort({ name: saveName, description: saveDesc || undefined, filter_json })
      setSaveName(''); setSaveDesc('')
      setSaved(await api.getCohorts())
    } catch (e) { setError(e.message) }
    finally     { setSaving(false) }
  }

  async function deleteCohort(cohort) {
    if (!cohort) { setDeleteTarget(null); return }
    setDeleteBusy(true)
    try {
      await api.deleteCohort(cohort.id)
      setSaved(await api.getCohorts())
      setDeleteTarget(null)
    } catch (e) { setError(e.message) }
    finally     { setDeleteBusy(false) }
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
    : <Btn variant="ghost" small onClick={() => { setIdText(''); setListFilter(EMPTY_LIST_FILTER); setResult(null) }}>Clear</Btn>

  const RETURN_LEVEL_OPTS = ['patient','submission','probe','block','scan'].map(v => [v, v.charAt(0).toUpperCase() + v.slice(1)])

  // Shared select options
  const HAS_SCAN_OPTS = [['', 'Any'], ['true', 'Has scan'], ['false', 'No scan']]
  const MALIGNANCY_OPTS = [['', 'Any'], ['true', 'Positive'], ['false', 'Negative']]

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

            {/* ────────────────────── FILTER MODE ────────────────────────── */}
            {mode === 'filter' && (
              <Panel title="Filters">
                {/* Anatomy & Tissue */}
                <SectionLabel>Anatomy & Tissue</SectionLabel>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                  <MultiSelect label="Topology description" field="topo_description"
                    selected={filter.topo_description_search}
                    onChange={val => setF('topo_description_search', val)}
                    loadOptions={val => api.lookup('topo_description', val)}
                    placeholder="e.g. Colon, Lung…" />
                  <MultiSelect label="Submission type" field="submission_type"
                    selected={filter.submission_types}
                    onChange={val => setF('submission_types', val)}
                    loadOptions={val => api.lookup('submission_type', val)}
                    placeholder="e.g. Biopsy, Resection…" />
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginTop: 10 }}>
                  <MultiSelect label="SNOMED code" field="snomed_topo_code"
                    selected={filter.snomed_topo_codes}
                    onChange={val => setF('snomed_topo_codes', val)}
                    loadOptions={val => api.lookup('snomed_topo_code', val)}
                    placeholder="e.g. T59600…" />
                  <FormField label="Return level">
                    <FormSelect value={filter.return_level} onChange={e => setF('return_level', e.target.value)}>
                      {RETURN_LEVEL_OPTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </FormSelect>
                  </FormField>
                </div>

                {/* Clinical */}
                <SectionLabel>Clinical</SectionLabel>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
                  <FormField label="Report date from">
                    <FormInput type="date" onChange={e => setF('submission_date_from', e.target.value)} />
                  </FormField>
                  <FormField label="Report date to">
                    <FormInput type="date" onChange={e => setF('submission_date_to', e.target.value)} />
                  </FormField>
                  <FormField label="Malignancy">
                    <FormSelect onChange={e => setF('malignancy_flag', e.target.value === '' ? null : e.target.value === 'true')}>
                      {MALIGNANCY_OPTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </FormSelect>
                  </FormField>
                </div>

                {/* Block */}
                <SectionLabel>Block</SectionLabel>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <FormField label="Block info contains">
                    <FormInput
                      placeholder="e.g. Tumor, Core 1…"
                      onChange={e => setF('block_info_search', e.target.value)}
                    />
                  </FormField>
                  <FormField label="Has scan">
                    <FormSelect onChange={e => setF('has_scan', e.target.value === '' ? null : e.target.value === 'true')}>
                      {HAS_SCAN_OPTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </FormSelect>
                  </FormField>
                </div>

                {/* Stain & Scan */}
                <SectionLabel>Stain &amp; Scan</SectionLabel>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                  <MultiSelect label="Stain name" field="stain_name"
                    selected={filter.stain_names}
                    onChange={val => setF('stain_names', val)}
                    loadOptions={val => api.lookup('stain_name', val)}
                    placeholder="e.g. H&amp;E, CD3…" />
                  <MultiSelect label="Stain category" field="stain_category"
                    selected={filter.stain_categories}
                    onChange={val => setF('stain_categories', val)}
                    loadOptions={val => api.lookup('stain_category', val)}
                    placeholder="e.g. routine, IHC…" />
                </div>
                {isScanLevel && (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginTop: 10 }}>
                    <MultiSelect label="File format" field="file_format"
                      selected={filter.file_formats}
                      onChange={val => setF('file_formats', val)}
                      loadOptions={val => api.lookup('file_format', val)}
                      placeholder="e.g. SVS, NDPI…" />
                    <FormField label="Magnification ≥">
                      <FormInput
                        type="number" min={0} step={0.5}
                        placeholder="e.g. 20"
                        onChange={e => setF('magnification_min', e.target.value ? parseFloat(e.target.value) : null)}
                      />
                    </FormField>
                    <FormField label="Magnification ≤">
                      <FormInput
                        type="number" min={0} step={0.5}
                        placeholder="e.g. 40"
                        onChange={e => setF('magnification_max', e.target.value ? parseFloat(e.target.value) : null)}
                      />
                    </FormField>
                  </div>
                )}

                <Btn variant="primary" style={{ marginTop: 'var(--space-5)' }} onClick={runQuery} disabled={querying}>
                  {querying ? 'Running query…' : 'Run query'}
                </Btn>
              </Panel>
            )}

            {/* ────────────────────── LIST MODE ────────────────────────── */}
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
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 6 }}>
                    <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-3)' }}>
                      {idText.split('\n').filter(s => s.trim()).length} IDs entered
                      ({new Set(idText.split('\n').filter(s => s.trim())).size} unique)
                    </span>
                    <label style={{ cursor: 'pointer', fontSize: 12, color: 'var(--navy)', fontWeight: 500, display: 'flex', alignItems: 'center', gap: 4, marginLeft: 'auto' }}>
                      <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M.5 9.9a.5.5 0 01.5.5v2.5a1 1 0 001 1h12a1 1 0 001-1v-2.5a.5.5 0 011 0v2.5a2 2 0 01-2 2H2a2 2 0 01-2-2v-2.5a.5.5 0 01.5-.5z"/><path d="M7.646 1.146a.5.5 0 01.708 0l3 3a.5.5 0 01-.708.708L8.5 2.707V11.5a.5.5 0 01-1 0V2.707L5.354 4.854a.5.5 0 11-.708-.708l3-3z"/></svg>
                      Import CSV / TXT
                      <input type="file" accept=".csv,.txt" style={{ display: 'none' }} onChange={handleFileUpload} />
                    </label>
                  </div>
                </FormField>

                {/* ── Additional / post-hoc filters ── */}
                <div style={{ marginTop: 4 }}>
                  <button
                    onClick={() => setShowListFilters(v => !v)}
                    style={{
                      background: 'none', border: '1px solid var(--border-l)',
                      borderRadius: 'var(--radius-md)', padding: '5px 10px',
                      cursor: 'pointer', fontSize: 12, color: 'var(--text-2)',
                      display: 'flex', alignItems: 'center', gap: 5,
                    }}
                  >
                    <span style={{ transition: 'transform .15s', transform: showListFilters ? 'rotate(90deg)' : 'none', display: 'inline-block' }}>▶</span>
                    Additional filters
                    {activeListFilterCount > 0 && (
                      <span style={{
                        background: 'var(--navy)', color: '#fff',
                        fontSize: 10, fontWeight: 700,
                        borderRadius: '99px', padding: '1px 6px', marginLeft: 2,
                      }}>{activeListFilterCount}</span>
                    )}
                  </button>

                  {showListFilters && (
                    <div style={{ marginTop: 12, padding: '12px 14px', background: 'rgba(0,0,0,0.02)', borderRadius: 'var(--radius-lg)', border: '1px solid var(--border-l)' }}>

                      <SectionLabel>Anatomy &amp; Clinical</SectionLabel>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
                        <MultiSelect label="Topography" field="topo_description"
                          selected={listFilter.topo_description_search}
                          onChange={val => setLF('topo_description_search', val)}
                          loadOptions={val => api.lookup('topo_description', val)}
                          placeholder="e.g. Colon, Lung…" />
                        <MultiSelect label="Submission type" field="submission_type"
                          selected={listFilter.submission_types}
                          onChange={val => setLF('submission_types', val)}
                          loadOptions={val => api.lookup('submission_type', val)}
                          placeholder="e.g. Biopsy, Resection…" />
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginTop: 10 }}>
                        <MultiSelect label="SNOMED code" field="snomed_topo_code"
                          selected={listFilter.snomed_topo_codes}
                          onChange={val => setLF('snomed_topo_codes', val)}
                          loadOptions={val => api.lookup('snomed_topo_code', val)}
                          placeholder="e.g. T59600…" />
                        <FormField label="Malignancy">
                          <FormSelect
                            onChange={e => setLF('malignancy_flag', e.target.value === '' ? null : e.target.value === 'true')}
                          >
                            {MALIGNANCY_OPTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                          </FormSelect>
                        </FormField>
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginTop: 10 }}>
                        <FormField label="Report date from">
                          <FormInput type="date" onChange={e => setLF('submission_date_from', e.target.value)} />
                        </FormField>
                        <FormField label="Report date to">
                          <FormInput type="date" onChange={e => setLF('submission_date_to', e.target.value)} />
                        </FormField>
                        <FormField label="Has scan">
                          <FormSelect onChange={e => setLF('has_scan', e.target.value === '' ? null : e.target.value === 'true')}>
                            {HAS_SCAN_OPTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                          </FormSelect>
                        </FormField>
                      </div>
                      <div style={{ marginTop: 10 }}>
                        <FormField label="Block info contains">
                          <FormInput
                            placeholder="e.g. Tumor, Core 1…"
                            onChange={e => setLF('block_info_search', e.target.value)}
                          />
                        </FormField>
                      </div>

                      {listLevel === 'scan' && (
                        <>
                          <SectionLabel>Stain &amp; Scan</SectionLabel>
                          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
                            <MultiSelect label="Stain name" field="stain_name"
                              selected={listFilter.stain_names}
                              onChange={val => setLF('stain_names', val)}
                              loadOptions={val => api.lookup('stain_name', val)}
                              placeholder="e.g. H&amp;E, CD3…" />
                            <MultiSelect label="Stain category" field="stain_category"
                              selected={listFilter.stain_categories}
                              onChange={val => setLF('stain_categories', val)}
                              loadOptions={val => api.lookup('stain_category', val)}
                              placeholder="e.g. routine, IHC…" />
                          </div>
                          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginTop: 10 }}>
                            <MultiSelect label="File format" field="file_format"
                              selected={listFilter.file_formats}
                              onChange={val => setLF('file_formats', val)}
                              loadOptions={val => api.lookup('file_format', val)}
                              placeholder="e.g. SVS, NDPI…" />
                            <FormField label="Magnification ≥">
                              <FormInput
                                type="number" min={0} step={0.5} placeholder="e.g. 20"
                                onChange={e => setLF('magnification_min', e.target.value ? parseFloat(e.target.value) : null)}
                              />
                            </FormField>
                            <FormField label="Magnification ≤">
                              <FormInput
                                type="number" min={0} step={0.5} placeholder="e.g. 40"
                                onChange={e => setLF('magnification_max', e.target.value ? parseFloat(e.target.value) : null)}
                              />
                            </FormField>
                          </div>
                        </>
                      )}

                      <Btn
                        variant="ghost" small
                        style={{ marginTop: 12, fontSize: 11, color: 'var(--text-3)' }}
                        onClick={() => { setListFilter(EMPTY_LIST_FILTER) }}
                      >
                        Clear additional filters
                      </Btn>
                    </div>
                  )}
                </div>

                <Btn variant="primary" style={{ marginTop: 'var(--space-5)' }} onClick={runQuery} disabled={querying || !idText.trim()}>
                  {querying ? 'Running…' : 'Run query'}
                </Btn>
              </Panel>
            )}

            {/* ────────────────────── RESULTS ────────────────────────── */}
            {result && (
              <Panel title="Results">
                <div style={{ display: 'flex', alignItems: 'flex-end', gap: 'var(--space-4)', marginBottom: 'var(--space-3)' }}>
                  <div>
                    <div style={{ fontFamily: 'var(--font-serif)', fontSize: 36, color: 'var(--navy)', lineHeight: 1 }}>{result.count}</div>
                    <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 4 }}>{result.return_level}s matching</div>
                  </div>
                  <div style={{ display: 'flex', gap: 10, marginTop: 10 }}>
                    <Btn variant="ghost" small onClick={downloadCSV}>Export CSV</Btn>
                    <Btn variant="ghost" small onClick={downloadJSON}>Export JSON</Btn>
                  </div>
                </div>

                {/* Summary breakdown */}
                <ResultSummary result={result} />

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
                <div style={{ marginTop: 14, borderTop: '1px solid var(--border-l)', paddingTop: 12 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-2)', marginBottom: 8 }}>Save this cohort</div>
                  <div style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
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
                  <FormInput
                    placeholder="Optional description…"
                    value={saveDesc}
                    onChange={e => setSaveDesc(e.target.value)}
                    style={{ width: '100%' }}
                  />
                </div>
              </Panel>
            )}
          </div>

          {/* ────────────────────── SAVED COHORTS ────────────────────────── */}
          <Panel title="Saved cohorts">
            {saved.length === 0
              ? <div style={{ color: 'var(--text-3)', fontSize: 13 }}>No saved cohorts yet.</div>
              : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {saved.map(c => (
                    <SavedCohortCard
                      key={c.id}
                      c={c}
                      onOpen={id => window.open(`/saved-results/${id}`, '_blank')}
                      onExportCsv={c => api.exportCohort(c.id, 'csv', c.name).catch(e => setError(e.message))}
                      onExportJson={c => api.exportCohort(c.id, 'json', c.name).catch(e => setError(e.message))}
                      onDelete={setDeleteTarget}
                    />
                  ))}
                </div>
              )}
          </Panel>
        </div>
      </div>

      <ConfirmDialog
        isOpen={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => deleteCohort(deleteTarget)}
        title="Delete cohort?"
        message={`This will permanently delete the saved cohort "${deleteTarget?.name}".`}
        confirmLabel="Delete"
        loading={deleteBusy}
      />
    </Layout>
  )
}
