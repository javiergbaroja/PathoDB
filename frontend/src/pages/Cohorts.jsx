import { useState, useEffect, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import Layout from '../components/Layout'
import {
  Btn, Panel, ErrorMsg,
  Table, Th, Td, Tr,
  FormInput,
  ConfirmDialog,
  useSortState, sortRows, SortIcon,
  useToast,
} from '../components/ui'
import CohortFilterForm, {
  EMPTY_FILTER,
  EMPTY_LIST_STATE,
  buildQueryPayload,
  cleanFilter,
} from '../components/CohortFilterForm'
import { api } from '../api'

// ─── Column label map ────────────────────────────────────────────────────────

const COLUMN_LABELS = {
  patient_code: 'Patient',
  lis_submission_id: 'Submission ID',
  lis_probe_id: 'Probe ID',
  snomed_topo_code: 'SNOMED Topo',
  snomed_topo_codes: 'SNOMED Topo',
  topo_description: 'Topography',
  topo_descriptions: 'Topographies',
  snomed_morph_codes: 'Morphology Codes',
  morph_descriptions: 'Morphology',
  snomed_etio_codes: 'Etiology Codes',
  etio_descriptions: 'Etiology',
  submission_type: 'Type',
  block_label: 'Block',
  block_info: 'Block Info',
  consent: 'Consent',
  stain_name: 'Stain',
  stain_category: 'Stain Category',
  stains: 'Stains',
  file_path: 'File Path',
  malignancy_flag: 'Malignancy',
  malignant_count: 'Malignant',
  report_date: 'Report Date',
  report_macro: 'Macro Report',
  report_microscopy: 'Micro Report',
  sex: 'Sex',
  date_of_birth: 'DOB',
  magnification: 'Magnification',
  file_format: 'Format',
  submission_count: 'Submissions',
  probe_count: 'Probes',
  block_count: 'Blocks',
  scan_count: 'Scans',
  tissue_count: 'Tissue',
  location_additional: 'Location',
}

function humanizeHeader(key) {
  return COLUMN_LABELS[key] || key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

// ─── Result summary helpers ───────────────────────────────────────────────────

function computeSummary(rows, returnLevel) {
  if (!rows?.length) return null

  const uniquePatients    = new Set(rows.map(r => r.patient_code)).size
  const uniqueSubmissions = new Set(rows.map(r => r.lis_submission_id).filter(Boolean)).size

  const topoCounts = {}
  rows.forEach(r => { if (r.topo_description) topoCounts[r.topo_description] = (topoCounts[r.topo_description] || 0) + 1 })
  const allTopos = Object.entries(topoCounts).sort((a, b) => b[1] - a[1])

  let allStains = null
  if (returnLevel === 'scan') {
    const stainCounts = {}
    rows.forEach(r => { if (r.stain_name) stainCounts[r.stain_name] = (stainCounts[r.stain_name] || 0) + 1 })
    allStains = Object.entries(stainCounts).sort((a, b) => b[1] - a[1])
  }

  return { uniquePatients, uniqueSubmissions, allTopos, allStains }
}

function MiniBar({ label, count, max, excluded, onToggle }) {
  const pct = max > 0 ? Math.round((count / max) * 100) : 0
  return (
    <div
      onClick={onToggle}
      title={excluded ? `Click to re-include "${label}"` : `Click to exclude "${label}"`}
      style={{
        display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, marginBottom: 3,
        cursor: 'pointer', opacity: excluded ? 0.45 : 1,
        borderRadius: 3, padding: '1px 2px',
        transition: 'opacity .15s',
      }}
      onMouseEnter={e => { if (!excluded) e.currentTarget.style.background = 'rgba(0,0,0,0.03)' }}
      onMouseLeave={e => { e.currentTarget.style.background = '' }}
    >
      <div style={{
        width: 120, color: excluded ? 'var(--text-3)' : 'var(--text-2)',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flexShrink: 0,
        textDecoration: excluded ? 'line-through' : 'none',
      }} title={label}>{label}</div>
      <div style={{ flex: 1, background: 'var(--border-l)', borderRadius: 3, overflow: 'hidden', height: 7 }}>
        <div style={{ width: `${pct}%`, height: '100%', borderRadius: 3, background: excluded ? '#ccc' : 'var(--navy-20)', transition: 'background .15s' }} />
      </div>
      <div style={{ width: 30, textAlign: 'right', color: 'var(--text-3)', fontFamily: 'var(--font-mono)', fontSize: 10 }}>{count}</div>
      {excluded
        ? <span style={{ fontSize: 10, color: 'var(--crimson)', width: 14, textAlign: 'center' }}>✕</span>
        : <span style={{ fontSize: 10, color: 'transparent', width: 14 }}>✕</span>}
    </div>
  )
}

function ResultSummary({ rows, returnLevel, excludedTopos, excludedStains, onToggleTopo, onToggleStain, onePerBlock, setOnePerBlock }) {
  const s = computeSummary(rows, returnLevel)
  if (!s) return null
  const exclusionCount = (excludedTopos?.size ?? 0) + (excludedStains?.size ?? 0)

  return (
    <div style={{ background: 'rgba(0,0,0,0.02)', border: '1px solid var(--border-l)', borderRadius: 'var(--radius-md)', padding: '10px 14px', marginBottom: 12 }}>
      <div style={{ display: 'flex', gap: 20, marginBottom: s.allTopos.length ? 10 : 0, flexWrap: 'wrap', alignItems: 'center' }}>
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
        {exclusionCount > 0 && (
          <div style={{ fontSize: 11, color: 'var(--crimson)', marginLeft: 'auto' }}>
            {exclusionCount} categor{exclusionCount !== 1 ? 'ies' : 'y'} excluded
          </div>
        )}
      </div>

      {(s.allTopos.length > 0 || s.allStains?.length > 0) && (
        <div style={{ fontSize: 10, color: 'var(--text-3)', marginBottom: 8 }}>
          Click a row to exclude / re-include that category from the results.
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: s.allStains ? '1fr 1fr' : '1fr', gap: 14 }}>
        {s.allTopos.length > 0 && (
          <div>
            <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
              Topographies
            </div>
            <div style={{ maxHeight: 200, overflowY: 'auto' }}>
              {s.allTopos.map(([label, count]) => (
                <MiniBar key={label} label={label} count={count} max={s.allTopos[0][1]} excluded={excludedTopos?.has(label)} onToggle={() => onToggleTopo?.(label)} />
              ))}
            </div>
          </div>
        )}
        {s.allStains?.length > 0 && (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
              <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                Stains
              </div>
              {setOnePerBlock && (
                <label title="Keep only one scan per (block, stain) pair — removes re-scans" style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer', userSelect: 'none' }}>
                  <input type="checkbox" checked={!!onePerBlock} onChange={e => setOnePerBlock(e.target.checked)} style={{ accentColor: 'var(--navy)', cursor: 'pointer', width: 12, height: 12, flexShrink: 0 }} />
                  <span style={{ fontSize: 10, color: onePerBlock ? 'var(--navy)' : 'var(--text-2)', fontWeight: onePerBlock ? 600 : 400 }}>Dedup re-scans</span>
                </label>
              )}
            </div>
            <div style={{ maxHeight: 200, overflowY: 'auto' }}>
              {s.allStains.map(([label, count]) => (
                <MiniBar key={label} label={label} count={count} max={s.allStains[0][1]} excluded={excludedStains?.has(label)} onToggle={() => onToggleStain?.(label)} />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Results table ────────────────────────────────────────────────────────────

const SCAN_COLS = ['patient_code','lis_submission_id','lis_probe_id','snomed_topo_code',
                   'topo_description','submission_type','block_label','block_info',
                   'consent','stain_name','stain_category','file_path']
const MONO_COLS = new Set(['lis_submission_id','lis_probe_id','snomed_topo_code'])
const PAGE_SIZE = 50

function ScanResultsTable({ rows }) {
  const { sortCol, sortDir, toggleSort } = useSortState()
  const [page, setPage] = useState(0)
  const sorted = useMemo(() => sortRows(rows, sortCol, sortDir), [rows, sortCol, sortDir])
  const totalPages = Math.ceil(sorted.length / PAGE_SIZE)
  const shown = sorted.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)

  // Reset page when rows change
  useEffect(() => { setPage(0) }, [rows])

  return (
    <div style={{ overflowX: 'auto', marginBottom: 4 }}>
      <Table>
        <thead>
          <tr>
            {SCAN_COLS.map(h => (
              <Th key={h} onClick={() => toggleSort(h)}>
                {humanizeHeader(h)}<SortIcon col={h} sortCol={sortCol} sortDir={sortDir} />
              </Th>
            ))}
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
      {sorted.length > PAGE_SIZE && (
        <div style={{
          padding: '8px 14px', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          borderTop: '1px solid var(--border-l)', fontSize: 'var(--text-sm)', color: 'var(--text-3)'
        }}>
          <span>Showing {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, sorted.length)} of {sorted.length}</span>
          <div style={{ display: 'flex', gap: 4 }}>
            <Btn variant="ghost" small disabled={page === 0} onClick={() => setPage(0)}>« First</Btn>
            <Btn variant="ghost" small disabled={page === 0} onClick={() => setPage(p => p - 1)}>‹ Prev</Btn>
            <span style={{ padding: '4px 8px', fontSize: 12 }}>Page {page + 1} of {totalPages}</span>
            <Btn variant="ghost" small disabled={page >= totalPages - 1} onClick={() => setPage(p => p + 1)}>Next ›</Btn>
            <Btn variant="ghost" small disabled={page >= totalPages - 1} onClick={() => setPage(totalPages - 1)}>Last »</Btn>
          </div>
        </div>
      )}
    </div>
  )
}

function GenericResultsTable({ rows }) {
  const { sortCol, sortDir, toggleSort } = useSortState()
  const [page, setPage] = useState(0)
  if (!rows.length) return null
  const cols   = Object.keys(rows[0])
  const sorted = useMemo(() => sortRows(rows, sortCol, sortDir), [rows, sortCol, sortDir])
  const totalPages = Math.ceil(sorted.length / PAGE_SIZE)
  const shown = sorted.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)

  // Reset page when rows change
  useEffect(() => { setPage(0) }, [rows])

  return (
    <div style={{ overflowX: 'auto', marginBottom: 4 }}>
      <Table>
        <thead>
          <tr>
            {cols.map(h => (
              <Th key={h} onClick={() => toggleSort(h)}>
                {humanizeHeader(h)}<SortIcon col={h} sortCol={sortCol} sortDir={sortDir} />
              </Th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown.map((row, i) => (
            <Tr key={i}>
              {cols.map((col, j) => {
                const val = row[col]
                let display
                if (val == null) display = '—'
                else if (col === 'malignancy_flag') display = val === true ? 'Yes' : val === false ? 'No' : '—'
                else if ((col === 'report_macro' || col === 'report_microscopy') && typeof val === 'string' && val.length > 80)
                  display = <span title={val}>{val.slice(0, 80)}…</span>
                else if (typeof val === 'object') display = JSON.stringify(val)
                else display = String(val)
                return <Td key={j}>{display}</Td>
              })}
            </Tr>
          ))}
        </tbody>
      </Table>
      {sorted.length > PAGE_SIZE && (
        <div style={{
          padding: '8px 14px', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          borderTop: '1px solid var(--border-l)', fontSize: 'var(--text-sm)', color: 'var(--text-3)'
        }}>
          <span>Showing {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, sorted.length)} of {sorted.length}</span>
          <div style={{ display: 'flex', gap: 4 }}>
            <Btn variant="ghost" small disabled={page === 0} onClick={() => setPage(0)}>« First</Btn>
            <Btn variant="ghost" small disabled={page === 0} onClick={() => setPage(p => p - 1)}>‹ Prev</Btn>
            <span style={{ padding: '4px 8px', fontSize: 12 }}>Page {page + 1} of {totalPages}</span>
            <Btn variant="ghost" small disabled={page >= totalPages - 1} onClick={() => setPage(p => p + 1)}>Next ›</Btn>
            <Btn variant="ghost" small disabled={page >= totalPages - 1} onClick={() => setPage(totalPages - 1)}>Last »</Btn>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Active filter chips ─────────────────────────────────────────────────────

function ActiveFilterChips({ filter, mode, listState, onRemove }) {
  const chips = []
  const f = mode === 'filter' ? filter : listState.listFilter

  if (f.topo_description_search?.length > 0)
    f.topo_description_search.forEach(v => chips.push({ key: 'topo_description_search', value: v, label: `Topography: ${v}` }))
  if (f.snomed_topo_codes?.length > 0)
    f.snomed_topo_codes.forEach(v => chips.push({ key: 'snomed_topo_codes', value: v, label: `SNOMED topo: ${v}` }))
  if (f.morph_description_search?.length > 0)
    f.morph_description_search.forEach(v => chips.push({ key: 'morph_description_search', value: v, label: `Morphology: ${v}` }))
  if (f.snomed_morph_codes?.length > 0)
    f.snomed_morph_codes.forEach(v => chips.push({ key: 'snomed_morph_codes', value: v, label: `SNOMED morph: ${v}` }))
  if (f.etio_description_search?.length > 0)
    f.etio_description_search.forEach(v => chips.push({ key: 'etio_description_search', value: v, label: `Etiology: ${v}` }))
  if (f.snomed_etio_codes?.length > 0)
    f.snomed_etio_codes.forEach(v => chips.push({ key: 'snomed_etio_codes', value: v, label: `SNOMED etio: ${v}` }))
  if (f.submission_types?.length > 0)
    f.submission_types.forEach(v => chips.push({ key: 'submission_types', value: v, label: `Type: ${v}` }))
  if (f.stain_names?.length > 0)
    f.stain_names.forEach(v => chips.push({ key: 'stain_names', value: v, label: `Stain: ${v}` }))
  if (f.stain_categories?.length > 0)
    f.stain_categories.forEach(v => chips.push({ key: 'stain_categories', value: v, label: `Stain cat: ${v}` }))
  if (f.file_formats?.length > 0)
    f.file_formats.forEach(v => chips.push({ key: 'file_formats', value: v, label: `Format: ${v}` }))
  if (f.consent_statuses?.length > 0)
    f.consent_statuses.forEach(v => chips.push({ key: 'consent_statuses', value: v, label: `Consent: ${v}` }))
  if (f.submission_date_from) chips.push({ key: 'submission_date_from', label: `From: ${f.submission_date_from}` })
  if (f.submission_date_to) chips.push({ key: 'submission_date_to', label: `To: ${f.submission_date_to}` })
  if (f.malignancy_flag !== null && f.malignancy_flag !== undefined)
    chips.push({ key: 'malignancy_flag', label: `Malignancy: ${f.malignancy_flag ? 'Positive' : 'Negative'}` })
  if (f.has_scan !== null && f.has_scan !== undefined)
    chips.push({ key: 'has_scan', label: f.has_scan ? 'Has scan' : 'No scan' })
  if (f.magnification_min != null) chips.push({ key: 'magnification_min', label: `Mag ≥ ${f.magnification_min}` })
  if (f.magnification_max != null) chips.push({ key: 'magnification_max', label: `Mag ≤ ${f.magnification_max}` })
  if (f.block_info_search) chips.push({ key: 'block_info_search', label: `Block: "${f.block_info_search}"` })

  if (mode === 'list' && listState.idText.trim()) {
    const count = listState.idText.split('\n').filter(s => s.trim()).length
    chips.push({ key: '_ids', label: `${count} ${listState.idType === 'b_number' ? 'B-numbers' : 'patient codes'}` })
  }

  if (chips.length === 0) return null

  return (
    <div style={{
      display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12,
      padding: '8px 12px', background: 'var(--navy-05)', borderRadius: 'var(--radius-md)',
      border: '1px solid var(--border-l)',
    }}>
      <span style={{ fontSize: 11, color: 'var(--text-3)', fontWeight: 600, alignSelf: 'center', marginRight: 4 }}>
        {chips.length} filter{chips.length !== 1 ? 's' : ''}
      </span>
      {chips.map((chip, i) => (
        <span key={`${chip.key}-${chip.value || i}`} style={{
          display: 'inline-flex', alignItems: 'center', gap: 4,
          padding: '2px 8px', borderRadius: 'var(--radius-full)',
          fontSize: 11, background: 'var(--navy-10)', color: 'var(--navy)',
          fontFamily: 'var(--font-sans)',
        }}>
          {chip.label}
          {chip.key !== '_ids' && onRemove && (
            <button
              onClick={() => onRemove(chip.key, chip.value)}
              style={{
                background: 'none', border: 'none', cursor: 'pointer',
                color: 'var(--navy-40)', fontSize: 13, lineHeight: 1, padding: 0,
                fontWeight: 700,
              }}
              aria-label={`Remove ${chip.label}`}
            >&times;</button>
          )}
        </span>
      ))}
    </div>
  )
}

// ─── Saved cohort card ────────────────────────────────────────────────────────

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
        <Btn variant="ghost"   small style={{ fontSize: 'var(--text-sm)', color: 'var(--crimson)', marginLeft: 'auto' }} onClick={() => onDelete(c)}>Delete</Btn>
      </div>
    </div>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function Cohorts() {
  const navigate = useNavigate()
  const toast = useToast()

  // ── Filter-mode state ──────────────────────────────────────────────────────
  const [mode,   setMode]   = useState('filter')
  const [filter, setFilter] = useState(EMPTY_FILTER)

  // ── List-mode state (flat object passed to CohortFilterForm) ───────────────
  const [listState, setListState] = useState(EMPTY_LIST_STATE)

  // ── Results ────────────────────────────────────────────────────────────────
  const [result,   setResult]   = useState(null)
  const [querying, setQuerying] = useState(false)
  const [error,    setError]    = useState('')

  // ── Post-processing ────────────────────────────────────────────────────────
  const [onePerBlock,    setOnePerBlock]    = useState(false)
  const [excludedTopos,  setExcludedTopos]  = useState(new Set())
  const [excludedStains, setExcludedStains] = useState(new Set())

  // ── Save ───────────────────────────────────────────────────────────────────
  const [saveName, setSaveName] = useState('')
  const [saveDesc, setSaveDesc] = useState('')
  const [saving,   setSaving]   = useState(false)
  const [saved,    setSaved]    = useState([])

  // ── Delete ─────────────────────────────────────────────────────────────────
  const [deleteTarget, setDeleteTarget] = useState(null)
  const [deleteBusy,   setDeleteBusy]   = useState(false)

  useEffect(() => {
    api.getCohorts().then(setSaved).catch(() => {})
  }, [])

  // ── Filter change callbacks ────────────────────────────────────────────────
  function handleFilterChange(key, val) {
    setFilter(prev => ({ ...prev, [key]: val === '' ? null : val }))
    setResult(null)
  }

  function handleListStateChange(key, val) {
    setListState(prev => ({ ...prev, [key]: val }))
    setResult(null)
  }

  function handleModeChange(newMode) {
    setMode(newMode)
    setResult(null)
    setError('')
  }

  // ── Toggle helpers for interactive summary ─────────────────────────────────
  function toggleTopo(topo) {
    setExcludedTopos(prev => { const n = new Set(prev); n.has(topo) ? n.delete(topo) : n.add(topo); return n })
  }
  function toggleStain(stain) {
    setExcludedStains(prev => { const n = new Set(prev); n.has(stain) ? n.delete(stain) : n.add(stain); return n })
  }

  // ── Remove filter chip ────────────────────────────────────────────────────
  function handleRemoveChip(key, value) {
    if (mode === 'filter') {
      setFilter(prev => {
        const cur = prev[key]
        if (Array.isArray(cur)) return { ...prev, [key]: cur.filter(v => v !== value) }
        return { ...prev, [key]: EMPTY_FILTER[key] }
      })
    } else {
      setListState(prev => {
        const cur = prev.listFilter[key]
        if (Array.isArray(cur)) return { ...prev, listFilter: { ...prev.listFilter, [key]: cur.filter(v => v !== value) } }
        return { ...prev, listFilter: { ...prev.listFilter, [key]: EMPTY_LIST_STATE.listFilter[key] } }
      })
    }
  }

  // ── Query ──────────────────────────────────────────────────────────────────
  async function runQuery() {
    setQuerying(true)
    setError('')
    setResult(null)
    setExcludedTopos(new Set())
    setExcludedStains(new Set())
    try {
      const { type, payload } = buildQueryPayload(mode, filter, listState)
      if (type === 'list' && !listState.idText.trim()) {
        setError('Paste at least one ID')
        return
      }
      const res = type === 'filter'
        ? await api.queryCohort(payload)
        : await api.queryList(payload)
      setResult(res)
    } catch (e) {
      setError(e.message)
    } finally {
      setQuerying(false)
    }
  }

  // ── Post-processed results ─────────────────────────────────────────────────
  const dedupedResults = useMemo(() => {
    const rows = result?.results
    if (!rows?.length || result.return_level !== 'scan' || !onePerBlock) return rows || []
    const seen = new Set()
    return rows.filter(r => {
      const key = `${r.block_id ?? r.scan_id}__${r.stain_name ?? ''}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }, [result, onePerBlock])

  const effectiveResults = useMemo(() => {
    let rows = dedupedResults
    if (excludedTopos.size > 0)  rows = rows.filter(r => !excludedTopos.has(r.topo_description))
    if (excludedStains.size > 0) rows = rows.filter(r => !excludedStains.has(r.stain_name))
    return rows
  }, [dedupedResults, excludedTopos, excludedStains])

  // ── Export ─────────────────────────────────────────────────────────────────
  function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob)
    const a   = document.createElement('a')
    a.href = url; a.download = filename
    document.body.appendChild(a); a.click()
    document.body.removeChild(a)
    setTimeout(() => URL.revokeObjectURL(url), 5000)
  }

  function downloadCSV() {
    if (!effectiveResults.length) return
    const isScan  = result.return_level === 'scan'
    const headers = isScan ? SCAN_COLS : Object.keys(effectiveResults[0])
    const csvRows = [headers.join(',')]
    for (const row of effectiveResults) {
      csvRows.push(headers.map(h => `"${(row[h] ?? '').toString().replace(/"/g, '""')}"`).join(','))
    }
    triggerDownload(new Blob([csvRows.join('\n')], { type: 'text/csv;charset=utf-8;' }), 'cohort_export.csv')
  }

  function downloadJSON() {
    if (!effectiveResults.length) return
    triggerDownload(new Blob([JSON.stringify(effectiveResults, null, 2)], { type: 'application/json' }), 'cohort_export.json')
  }

  // ── Save cohort ────────────────────────────────────────────────────────────
  async function saveCohort() {
    if (!saveName.trim()) return
    setSaving(true)
    try {
      const clientTransforms = {
        ...(onePerBlock             ? { dedup_one_per_block: true }             : {}),
        ...(excludedTopos.size > 0  ? { excluded_topos:  [...excludedTopos]  } : {}),
        ...(excludedStains.size > 0 ? { excluded_stains: [...excludedStains] } : {}),
      }
      const { type, payload } = buildQueryPayload(mode, filter, listState)
      const filter_json = type === 'filter'
        ? { ...payload, ...clientTransforms }
        : { is_list_query: true, ...payload, ...clientTransforms }
      await api.saveCohort({ name: saveName, description: saveDesc || undefined, filter_json })
      const savedName = saveName
      setSaveName('')
      setSaveDesc('')
      setSaved(await api.getCohorts())
      toast.success(`Cohort "${savedName}" saved`)
    } catch (e) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  // ── Delete cohort ──────────────────────────────────────────────────────────
  async function deleteCohort(cohort) {
    if (!cohort) { setDeleteTarget(null); return }
    setDeleteBusy(true)
    try {
      await api.deleteCohort(cohort.id)
      setSaved(await api.getCohorts())
      setDeleteTarget(null)
      toast.success('Cohort deleted')
    } catch (e) {
      setError(e.message)
    } finally {
      setDeleteBusy(false)
    }
  }

  const isScanLevel = (mode === 'filter' ? filter.return_level : listState.listLevel) === 'scan'

  const actions = (
    <Btn variant="ghost" small onClick={() => {
      if (mode === 'filter') { setFilter(EMPTY_FILTER); }
      else { setListState(EMPTY_LIST_STATE); }
      setResult(null)
    }}>
      Reset
    </Btn>
  )

  return (
    <Layout title="Cohorts" actions={actions}>
      <div style={{ height: '100%', overflowY: 'auto', padding: 'var(--space-5) var(--space-6)' }}>
        <ErrorMsg message={error} onDismiss={() => setError('')} />

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 260px', gap: 'var(--space-4)', alignItems: 'start' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)', minWidth: 0 }}>

            {/* Filter form — full-featured, return level exposed */}
            <CohortFilterForm
              mode={mode}
              onModeChange={handleModeChange}
              filter={filter}
              onFilterChange={handleFilterChange}
              listState={listState}
              onListStateChange={handleListStateChange}
              onRun={runQuery}
              loading={querying}
              lockReturnLevel={false}
              compact={false}
            />

            {/* Results */}
            {result && (
              <Panel title="Results">
                <div style={{ display: 'flex', alignItems: 'flex-end', gap: 'var(--space-4)', marginBottom: 'var(--space-3)' }}>
                  <div>
                    <div style={{ fontFamily: 'var(--font-serif)', fontSize: 36, color: 'var(--navy)', lineHeight: 1 }}>
                      {effectiveResults.length}
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 4 }}>
                      {result.return_level}s matching
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 10, marginTop: 10 }}>
                    <Btn variant="ghost" small onClick={downloadCSV}>Export CSV</Btn>
                    <Btn variant="ghost" small onClick={downloadJSON}>Export JSON</Btn>
                  </div>
                </div>

                <ActiveFilterChips
                  filter={filter}
                  mode={mode}
                  listState={listState}
                  onRemove={handleRemoveChip}
                />

                <ResultSummary
                  rows={dedupedResults}
                  returnLevel={result.return_level}
                  excludedTopos={excludedTopos}
                  excludedStains={excludedStains}
                  onToggleTopo={toggleTopo}
                  onToggleStain={toggleStain}
                  onePerBlock={isScanLevel ? onePerBlock : undefined}
                  setOnePerBlock={isScanLevel ? setOnePerBlock : undefined}
                />

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

                {effectiveResults.length > 0 && (
                  isScanLevel
                    ? <ScanResultsTable rows={effectiveResults} />
                    : <GenericResultsTable rows={effectiveResults} />
                )}

                {/* Save */}
                <div style={{ marginTop: 14, borderTop: '1px solid var(--border-l)', paddingTop: 12 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-2)', marginBottom: 8 }}>Save this cohort</div>
                  <div style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
                    <FormInput placeholder="Cohort name…" value={saveName} onChange={e => setSaveName(e.target.value)} style={{ flex: 1 }} />
                    <Btn variant="primary" small onClick={saveCohort} disabled={saving || !saveName.trim()}>
                      {saving ? 'Saving…' : 'Save cohort'}
                    </Btn>
                  </div>
                  <FormInput placeholder="Optional description…" value={saveDesc} onChange={e => setSaveDesc(e.target.value)} style={{ width: '100%' }} />
                </div>
              </Panel>
            )}
          </div>

          {/* Saved cohorts sidebar */}
          <Panel title="Saved cohorts">
            {saved.length === 0
              ? <div style={{ color: 'var(--text-3)', fontSize: 13 }}>No saved cohorts yet.</div>
              : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {saved.map(c => (
                    <SavedCohortCard
                      key={c.id}
                      c={c}
                      onOpen={id => navigate(`/saved-results/${id}`)}
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