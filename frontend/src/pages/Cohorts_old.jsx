import { useState, useEffect } from 'react'
import Layout from '../components/Layout'
import { Btn, Panel, ErrorMsg, SpinnerPage } from '../components/ui'
import { api } from '../api'

const VIEWER_FORMATS = new Set(['SVS','NDPI','TIF','TIFF','MRXS','SCN','VSI','BIF'])

const EMPTY_FILTER = {
  snomed_topo_codes: null, topo_description_search: '',
  submission_types: null, stain_names: null, stain_categories: null,
  file_formats: null, magnification_min: null, magnification_max: null,
  submission_date_from: '', submission_date_to: '',
  malignancy_flag: null, has_scan: null, block_info_search: '',
  return_level: 'block',
}

export default function Cohorts() {
  const [mode, setMode]         = useState('filter')  // 'filter' | 'list'

  // Filter mode state
  const [filter, setFilter]     = useState(EMPTY_FILTER)
  const [stains, setStains]     = useState([])

  // List mode state
  const [idType, setIdType]     = useState('patient_code')   // 'patient_code' | 'b_number'
  const [bScope, setBScope]     = useState('all')            // 'all' | 'matched'
  const [idText, setIdText]     = useState('')
  const [listLevel, setListLevel] = useState('scan')

  // Shared state
  const [result, setResult]     = useState(null)
  const [querying, setQuerying] = useState(false)
  const [error, setError]       = useState('')
  const [saveName, setSaveName] = useState('')
  const [saving, setSaving]     = useState(false)
  const [saved, setSaved]       = useState([])

  useEffect(() => {
    api.getStains().then(setStains).catch(() => {})
    api.getCohorts().then(setSaved).catch(() => {})
  }, [])

  // ── Run query ──────────────────────────────────────────────────────────────
  async function runQuery() {
    setQuerying(true)
    setError('')
    setResult(null)
    try {
      if (mode === 'filter') {
        const clean = Object.fromEntries(
          Object.entries(filter).filter(([, v]) => v !== '' && v !== null)
        )
        setResult(await api.queryCohort(clean))
      } else {
        const ids = idText.split('\n').map(s => s.trim()).filter(Boolean)
        if (!ids.length) { setError('Paste at least one ID'); setQuerying(false); return }
        setResult(await api.queryList({
          id_type:      idType,
          b_scope:      bScope,
          ids,
          return_level: listLevel,
        }))
      }
    } catch (e) {
      setError(e.message)
    } finally {
      setQuerying(false)
    }
  }

  // ── Save cohort ────────────────────────────────────────────────────────────
  async function saveCohort() {
    if (!saveName.trim()) return
    setSaving(true)
    try {
      const clean = Object.fromEntries(
        Object.entries(filter).filter(([, v]) => v !== '' && v !== null)
      )
      await api.saveCohort({ name: saveName, filter_json: clean })
      setSaveName('')
      setSaved(await api.getCohorts())
    } catch (e) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  function setF(key, val) {
    setFilter(f => ({ ...f, [key]: val === '' ? null : val }))
  }

  const returnLevel = mode === 'filter' ? filter.return_level : listLevel
  const isScanLevel = returnLevel === 'scan'

  const actions = mode === 'filter'
    ? <Btn variant="ghost" small onClick={() => { setFilter(EMPTY_FILTER); setResult(null) }}>Reset filters</Btn>
    : <Btn variant="ghost" small onClick={() => { setIdText(''); setResult(null) }}>Clear</Btn>

  return (
    <Layout title="Cohort Builder" actions={actions}>
      <div style={{ height: '100%', overflowY: 'auto', padding: '20px 24px' }}>
        <ErrorMsg message={error} />

        {/* ── Mode toggle ── */}
        <div style={{ display: 'flex', gap: 0, marginBottom: 20, border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden', width: 'fit-content' }}>
          {[['filter', 'Filter mode'], ['list', 'List mode']].map(([val, label]) => (
            <button key={val} onClick={() => { setMode(val); setResult(null); setError('') }}
              style={{
                padding: '8px 20px', fontSize: 13, fontFamily: 'var(--font-sans)',
                fontWeight: mode === val ? 600 : 400,
                background: mode === val ? 'var(--navy)' : 'white',
                color: mode === val ? 'white' : 'var(--text-2)',
                border: 'none', cursor: 'pointer', transition: 'all 0.15s',
              }}>
              {label}
            </button>
          ))}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 16 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

            {/* ── Filter mode ── */}
            {mode === 'filter' && (
              <Panel title="Filters">
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginBottom: 12 }}>
                  <div>
                    <label style={lbl}>Topology (SNOMED)</label>
                    <input style={inp} placeholder="e.g. T-59600"
                      onChange={e => setF('snomed_topo_codes', e.target.value ? [e.target.value] : null)} />
                  </div>
                  <div>
                    <label style={lbl}>Topology description</label>
                    <input style={inp} placeholder="e.g. colon sigmoid"
                      onChange={e => setF('topo_description_search', e.target.value)} />
                  </div>
                  <div>
                    <label style={lbl}>Malignancy</label>
                    <select style={inp} onChange={e => setF('malignancy_flag', e.target.value === '' ? null : e.target.value === 'true')}>
                      <option value="">Any</option>
                      <option value="true">Positive</option>
                      <option value="false">Negative</option>
                    </select>
                  </div>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginBottom: 12 }}>
                  <div>
                    <label style={lbl}>Stain</label>
                    <select style={inp} onChange={e => setF('stain_names', e.target.value ? [e.target.value] : null)}>
                      <option value="">Any</option>
                      {stains.map(s => <option key={s.id} value={s.stain_name}>{s.stain_name}</option>)}
                    </select>
                  </div>
                  <div>
                    <label style={lbl}>Stain category</label>
                    <select style={inp} onChange={e => setF('stain_categories', e.target.value ? [e.target.value] : null)}>
                      <option value="">Any</option>
                      <option value="HE">HE</option>
                      <option value="IHC">IHC</option>
                      <option value="special_stain">Special stain</option>
                      <option value="FISH">FISH</option>
                    </select>
                  </div>
                  <div>
                    <label style={lbl}>Has scan</label>
                    <select style={inp} onChange={e => setF('has_scan', e.target.value === '' ? null : e.target.value === 'true')}>
                      <option value="">Any</option>
                      <option value="true">Yes — scanned</option>
                      <option value="false">No — unscanned</option>
                    </select>
                  </div>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginBottom: 16 }}>
                  <div>
                    <label style={lbl}>Report date from</label>
                    <input type="date" style={inp} onChange={e => setF('submission_date_from', e.target.value)} />
                  </div>
                  <div>
                    <label style={lbl}>Report date to</label>
                    <input type="date" style={inp} onChange={e => setF('submission_date_to', e.target.value)} />
                  </div>
                  <div>
                    <label style={lbl}>Return level</label>
                    <select style={inp} value={filter.return_level} onChange={e => setF('return_level', e.target.value)}>
                      <option value="patient">Patient</option>
                      <option value="submission">Submission</option>
                      <option value="probe">Probe</option>
                      <option value="block">Block</option>
                      <option value="scan">Scan</option>
                    </select>
                  </div>
                </div>
                <Btn variant="primary" onClick={runQuery} disabled={querying}>
                  {querying ? 'Running…' : 'Run query'}
                </Btn>
              </Panel>
            )}

            {/* ── List mode ── */}
            {mode === 'list' && (
              <Panel title="Query by list">
                {/* ID type toggle */}
                <div style={{ marginBottom: 14 }}>
                  <label style={lbl}>ID type</label>
                  <div style={{ display: 'flex', gap: 0, border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden', width: 'fit-content' }}>
                    {[['patient_code', 'Patient code'], ['b_number', 'B-number']].map(([val, label]) => (
                      <button key={val} onClick={() => setIdType(val)}
                        style={{
                          padding: '6px 16px', fontSize: 12.5, fontFamily: 'var(--font-sans)',
                          fontWeight: idType === val ? 600 : 400,
                          background: idType === val ? 'var(--navy)' : 'white',
                          color: idType === val ? 'white' : 'var(--text-2)',
                          border: 'none', cursor: 'pointer',
                        }}>
                        {label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* B-number scope — only shown when b_number is selected */}
                {idType === 'b_number' && (
                  <div style={{ marginBottom: 14 }}>
                    <label style={lbl}>Scope per B-number</label>
                    <div style={{ display: 'flex', gap: 0, border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden', width: 'fit-content' }}>
                      {[
                        ['all',     'All submissions from patient'],
                        ['matched', 'Only the matched submission'],
                      ].map(([val, label]) => (
                        <button key={val} onClick={() => setBScope(val)}
                          style={{
                            padding: '6px 16px', fontSize: 12.5, fontFamily: 'var(--font-sans)',
                            fontWeight: bScope === val ? 600 : 400,
                            background: bScope === val ? 'var(--navy-60)' : 'white',
                            color: bScope === val ? 'white' : 'var(--text-2)',
                            border: 'none', cursor: 'pointer',
                          }}>
                          {label}
                        </button>
                      ))}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 5 }}>
                      {bScope === 'all'
                        ? 'Returns all tissue from the patient, regardless of which submission the B-number matched.'
                        : 'Returns only the submission directly matched by this B-number.'}
                    </div>
                  </div>
                )}

                {/* Return level */}
                <div style={{ marginBottom: 14 }}>
                  <label style={lbl}>Return level</label>
                  <select style={{ ...inp, width: 200 }} value={listLevel} onChange={e => setListLevel(e.target.value)}>
                    <option value="patient">Patient</option>
                    <option value="submission">Submission</option>
                    <option value="probe">Probe</option>
                    <option value="block">Block</option>
                    <option value="scan">Scan</option>
                  </select>
                </div>

                {/* ID textarea */}
                <div style={{ marginBottom: 16 }}>
                  <label style={lbl}>
                    Paste {idType === 'b_number' ? 'B-numbers' : 'patient codes'} (one per line)
                  </label>
                  <textarea
                    value={idText}
                    onChange={e => setIdText(e.target.value)}
                    placeholder={idType === 'b_number'
                      ? 'B2019.14823\nB2015.00392\nB2008.11045'
                      : 'P-2019-00841\nP-2019-00392'}
                    rows={8}
                    style={{
                      width: '100%', padding: '8px 10px',
                      border: '1px solid var(--border)', borderRadius: 6,
                      fontSize: 13, fontFamily: 'var(--font-mono)', resize: 'vertical', outline: 'none',
                    }}
                  />
                  <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 4 }}>
                    {idText.split('\n').filter(s => s.trim()).length} IDs entered
                  </div>
                </div>

                <Btn variant="primary" onClick={runQuery} disabled={querying || !idText.trim()}>
                  {querying ? 'Running…' : 'Run query'}
                </Btn>
              </Panel>
            )}

            {/* ── Results ── */}
            {result && (
              <Panel title="Results">
                <div style={{ display: 'flex', alignItems: 'flex-end', gap: 16, marginBottom: 16 }}>
                  <div>
                    <div style={{ fontFamily: 'var(--font-serif)', fontSize: 36, color: 'var(--navy)', lineHeight: 1 }}>{result.count}</div>
                    <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 4 }}>{result.return_level}s matching</div>
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <Btn variant="ghost" small>Export CSV</Btn>
                    <Btn variant="ghost" small>Export JSON</Btn>
                  </div>
                </div>

                {/* Not found warning */}
                {result.not_found?.length > 0 && (
                  <div style={{ background: 'var(--warning-bg)', border: '1px solid #e8c84a', borderRadius: 6, padding: '8px 12px', fontSize: 12, color: 'var(--warning)', marginBottom: 12 }}>
                    <strong>{result.not_found.length} ID{result.not_found.length !== 1 ? 's' : ''} not found:</strong> {result.not_found.join(', ')}
                  </div>
                )}

                {result.results.length > 0 && (
                  isScanLevel
                    ? <ScanResultsTable rows={result.results} />
                    : <GenericResultsTable rows={result.results} />
                )}

                {/* Save cohort (filter mode only) */}
                {mode === 'filter' && (
                  <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                    <input style={{ ...inp, flex: 1 }} placeholder="Cohort name…"
                      value={saveName} onChange={e => setSaveName(e.target.value)} />
                    <Btn variant="primary" small onClick={saveCohort} disabled={saving || !saveName.trim()}>
                      {saving ? 'Saving…' : 'Save cohort'}
                    </Btn>
                  </div>
                )}
              </Panel>
            )}
          </div>

          {/* ── Saved cohorts ── */}
          <Panel title="Saved cohorts">
            {saved.length === 0 ? (
              <div style={{ color: 'var(--text-3)', fontSize: 13 }}>No saved cohorts yet.</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {saved.map(c => (
                  <div key={c.id} style={{ padding: '10px 12px', border: '1px solid var(--border-l)', borderRadius: 8, cursor: 'pointer' }}
                    onMouseEnter={e => e.currentTarget.style.borderColor = 'var(--navy-20)'}
                    onMouseLeave={e => e.currentTarget.style.borderColor = 'var(--border-l)'}
                  >
                    <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--navy)', marginBottom: 2 }}>{c.name}</div>
                    {c.description && <div style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 4 }}>{c.description}</div>}
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontSize: 11, color: 'var(--text-3)' }}>
                        {c.result_count != null ? `${c.result_count} results` : '—'}
                      </span>
                      <div style={{ display: 'flex', gap: 4 }}>
                        <Btn variant="ghost" small style={{ fontSize: 11 }}>CSV</Btn>
                        <Btn variant="ghost" small style={{ fontSize: 11 }}>JSON</Btn>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Panel>
        </div>
      </div>
    </Layout>
  )
}

// ── Scan-level results table ──────────────────────────────────────────────────
function ScanResultsTable({ rows }) {
  const LIMIT = 50
  const shown = rows.slice(0, LIMIT)
  const cols  = ['patient_code','lis_submission_id','lis_probe_id','snomed_topo_code',
                  'topo_description','submission_type','block_label','block_info',
                  'stain_name','stain_category','file_path']

  return (
    <div style={{ overflowX: 'auto', marginBottom: 4 }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead>
          <tr style={{ background: 'var(--navy-05)' }}>
            {cols.map(h => (
              <th key={h} style={th}>{h.replace(/_/g, ' ')}</th>
            ))}
            <th style={th}>viewer</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((row, i) => (
            <tr key={i} onMouseEnter={e => e.currentTarget.style.background = 'var(--navy-05)'}
              onMouseLeave={e => e.currentTarget.style.background = 'white'}>
              {cols.map(col => (
                <td key={col} style={td}>
                  {col === 'file_path'
                    ? <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-2)' }} title={row[col]}>
                        {row[col] ? '…' + row[col].slice(-30) : '—'}
                      </span>
                    : <span style={{ fontFamily: ['lis_submission_id','lis_probe_id','snomed_topo_code'].includes(col) ? 'var(--font-mono)' : 'inherit', fontSize: 12 }}>
                        {row[col] ?? '—'}
                      </span>
                  }
                </td>
              ))}
              <td style={td}>
                {row.viewer_available
                  ? <button
                      onClick={() => window.open(`/viewer/${row.scan_id}`, '_blank')}
                      style={{ fontSize: 11, padding: '2px 8px', background: 'var(--navy-05)', border: '1px solid var(--navy-20)', borderRadius: 4, cursor: 'pointer', color: 'var(--navy)', fontFamily: 'var(--font-sans)', fontWeight: 500, whiteSpace: 'nowrap' }}
                      onMouseEnter={e => e.currentTarget.style.background = 'var(--navy-10)'}
                      onMouseLeave={e => e.currentTarget.style.background = 'var(--navy-05)'}
                    >
                      View ↗
                    </button>
                  : <span style={{ fontSize: 11, color: 'var(--text-3)' }}>—</span>
                }
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > LIMIT && (
        <div style={{ padding: '8px 10px', fontSize: 11, color: 'var(--text-3)', borderTop: '1px solid var(--border-l)' }}>
          Showing {LIMIT} of {rows.length} — export CSV/JSON for full results
        </div>
      )}
    </div>
  )
}

// ── Generic results table (non-scan levels) ───────────────────────────────────
function GenericResultsTable({ rows }) {
  const LIMIT = 50
  const shown = rows.slice(0, LIMIT)
  if (!shown.length) return null
  const cols = Object.keys(shown[0])

  return (
    <div style={{ background: 'var(--navy-05)', border: '1px solid var(--navy-20)', borderRadius: 8, overflow: 'hidden', marginBottom: 4 }}>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr>
              {cols.map(h => <th key={h} style={th}>{h.replace(/_/g, ' ')}</th>)}
            </tr>
          </thead>
          <tbody>
            {shown.map((row, i) => (
              <tr key={i}>
                {cols.map((col, j) => (
                  <td key={j} style={{ padding: '7px 10px', borderBottom: '1px solid var(--border-l)', color: 'var(--text-2)', fontFamily: typeof row[col] === 'string' && row[col].includes('-') ? 'var(--font-mono)' : 'inherit' }}>
                    {row[col] == null ? '—' : String(row[col])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > LIMIT && (
        <div style={{ padding: '8px 10px', fontSize: 11, color: 'var(--text-3)' }}>
          Showing {LIMIT} of {rows.length} — export for full results
        </div>
      )}
    </div>
  )
}

const lbl = { display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 5 }
const inp = { width: '100%', padding: '7px 10px', border: '1px solid var(--border)', borderRadius: 6, fontSize: 13, outline: 'none', background: 'white' }
const th  = { padding: '9px 10px', textAlign: 'left', fontSize: 10, fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.06em', borderBottom: '1px solid var(--border-l)', whiteSpace: 'nowrap', background: 'var(--navy-05)' }
const td  = { padding: '8px 10px', borderBottom: '1px solid var(--border-l)', verticalAlign: 'middle', color: 'var(--text-2)' }