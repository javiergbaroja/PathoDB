// frontend/src/pages/PatientDetail/index.jsx
import { useState, useEffect } from 'react'
import { useParams, useNavigate, useLocation } from 'react-router-dom'
import Layout from '../../components/Layout'
import { Badge, Btn, Panel, SpinnerPage, ErrorMsg } from '../../components/ui'
import { api } from '../../api'

import RegisterScanModal from './RegisterScanModal'
import ScansDrawer from './ScansDrawer'

function ScannedIcon({ size = 16 }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 256 256" style={{ flexShrink: 0, display: 'inline-block' }} title="Has scanned blocks">
      <rect x="62" y="78" width="104" height="72" rx="12" style={{ stroke: '#1b998b', strokeWidth: 10, strokeLinecap: 'round', strokeLinejoin: 'round', fill: 'none' }}/>
      <rect x="82" y="96" width="12" height="14" rx="3" style={{ fill: '#1b998b' }}/>
      <rect x="103" y="96" width="12" height="14" rx="3" style={{ fill: '#1b998b' }}/>
      <rect x="124" y="96" width="12" height="14" rx="3" style={{ fill: '#1b998b' }}/>
      <line x1="76" y1="160" x2="152" y2="160" style={{ stroke: '#1b998b', strokeWidth: 10, strokeLinecap: 'round' }}/>
      <line x1="44" y1="88" x2="44" y2="60" style={{ stroke: '#1b998b', strokeWidth: 10, strokeLinecap: 'round' }}/>
      <line x1="44" y1="60" x2="72" y2="60" style={{ stroke: '#1b998b', strokeWidth: 10, strokeLinecap: 'round' }}/>
      <line x1="156" y1="60" x2="184" y2="60" style={{ stroke: '#1b998b', strokeWidth: 10, strokeLinecap: 'round' }}/>
      <line x1="184" y1="60" x2="184" y2="88" style={{ stroke: '#1b998b', strokeWidth: 10, strokeLinecap: 'round' }}/>
      <line x1="44" y1="168" x2="44" y2="196" style={{ stroke: '#1b998b', strokeWidth: 10, strokeLinecap: 'round' }}/>
      <line x1="44" y1="196" x2="72" y2="196" style={{ stroke: '#1b998b', strokeWidth: 10, strokeLinecap: 'round' }}/>
      <line x1="156" y1="196" x2="184" y2="196" style={{ stroke: '#1b998b', strokeWidth: 10, strokeLinecap: 'round' }}/>
      <line x1="184" y1="168" x2="184" y2="196" style={{ stroke: '#1b998b', strokeWidth: 10, strokeLinecap: 'round' }}/>
      <circle cx="186" cy="176" r="34" style={{ fill: '#1b998b' }}/>
      <polyline points="170,176 182,188 203,164" style={{ stroke: 'white', strokeWidth: 10, strokeLinecap: 'round', strokeLinejoin: 'round', fill: 'none' }}/>
    </svg>
  )
}

function ReportBlock({ label, text }) {
  const [expanded, setExpanded] = useState(false)
  const isLong = text && text.length > 200
  return (
    <div style={{ border: '1px solid var(--border-l)', borderRadius: 6, overflow: 'hidden', background: 'white' }}>
      <div style={{ padding: '6px 10px', background: 'var(--navy-05)', borderBottom: '1px solid var(--border-l)', fontSize: 11, fontWeight: 600, color: 'var(--text-2)', textTransform: 'uppercase', letterSpacing: '0.06em', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        {label}
        {isLong && (
          <button onClick={() => setExpanded(e => !e)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 11, color: 'var(--navy)', fontFamily: 'var(--font-sans)' }}>
            {expanded ? 'Show less' : 'Show all'}
          </button>
        )}
      </div>
      <div style={{ padding: '10px', fontSize: 12, lineHeight: 1.6, color: text ? 'var(--text-1)' : 'var(--text-3)', fontStyle: text ? 'normal' : 'italic', whiteSpace: 'pre-wrap', maxHeight: expanded ? 'none' : 120, overflow: 'hidden' }}>
        {text ? (expanded || !isLong ? text : text.slice(0, 200) + '…') : 'Not available'}
      </div>
    </div>
  )
}

export default function PatientDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const location = useLocation()
  const [data, setData]           = useState(null)
  const [loading, setLoading]     = useState(true)
  const [error, setError]         = useState('')
  const [selected, setSelected]   = useState(null)
  const [scans, setScans]         = useState([])
  const [scansLoading, setScansLoading] = useState(false)
  const [expandedSubs, setExpandedSubs]       = useState({})
  const [expandedProbes, setExpandedProbes]   = useState({})
  const [expandedReports, setExpandedReports] = useState({})
  const [drawerOpen, setDrawerOpen]           = useState(false)
  const [registerOpen, setRegisterOpen]       = useState(false)

  useEffect(() => {
    const searchParams = new URLSearchParams(location.search)
    const highlightQuery = searchParams.get('q')?.toLowerCase()

    api.getHierarchy(id)
      .then(d => {
        setData(d)
        let newExpandedSubs = {}
        let newExpandedProbes = {}

        if (highlightQuery && d.submissions?.length > 0) {
          let foundSub = null
          let foundProbe = null

          for (const sub of d.submissions) {
            if (sub.lis_submission_id?.toLowerCase().includes(highlightQuery)) {
              foundSub = sub
              foundProbe = sub.probes?.find(p => p.lis_probe_id?.toLowerCase().includes(highlightQuery))
              break
            }
            const matchedProbe = sub.probes?.find(p => p.lis_probe_id?.toLowerCase().includes(highlightQuery))
            if (matchedProbe) {
              foundSub = sub
              foundProbe = matchedProbe
              break
            }
          }

          if (foundSub) {
            newExpandedSubs[foundSub.id] = true
            if (foundProbe) {
              newExpandedProbes[foundProbe.id] = true
            } else if (foundSub.probes?.length > 0) {
              newExpandedProbes[foundSub.probes[0].id] = true
            }
          }
        }

        setExpandedSubs(newExpandedSubs)
        setExpandedProbes(newExpandedProbes)
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [id, location.search])

  async function selectBlock(block, probe, sub) {
    setSelected({ block, probe, sub })
    setDrawerOpen(false)
    setRegisterOpen(false)
    setScansLoading(true)
    try {
      setScans(await api.getScansForBlock(block.id))
    } catch {
      setScans([])
    } finally {
      setScansLoading(false)
    }
  }

  async function refreshScans() {
    if (!selected) return
    try {
      setScans(await api.getScansForBlock(selected.block.id))
    } catch {}
  }

  const actions = (
    <Btn variant="ghost" small onClick={() => navigate('/patients')}>Back to patients</Btn>
  )

  if (loading) return <Layout title="Loading..." actions={actions}><SpinnerPage /></Layout>
  if (error)   return <Layout title="Error" actions={actions}><div style={{ padding: 24 }}><ErrorMsg message={error} /></div></Layout>
  if (!data)   return null

  const title = `${data.patient_code}  ·  ${data.sex || '?'}  ·  ${data.date_of_birth || 'DOB unknown'}`

  return (
    <Layout title={title} actions={actions}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', height: '100%', overflow: 'hidden', position: 'relative' }}>

        {/* ── Left: hierarchy ── */}
        <div style={{ overflowY: 'auto', padding: '16px 12px 16px 24px', borderRight: '1px solid var(--border-l)' }}>
          <Panel title="Submission hierarchy">
            {data.submissions.length === 0 && (
              <div style={{ color: 'var(--text-3)', fontSize: 13 }}>No submissions found.</div>
            )}
            {data.submissions.map(sub => {
              const subOpen    = !!expandedSubs[sub.id]
              const reportOpen = !!expandedReports[sub.id]
              const macro      = sub.reports?.find(r => r.report_type === 'macro')
              const micro      = sub.reports?.find(r => r.report_type === 'microscopy')
              const hasReports = macro || micro
              const hasScannedBlocks = sub.probes?.some(probe =>
                probe.blocks?.some(block => (block.scans?.length ?? 0) > 0)
              ) ?? false

              return (
                <div key={sub.id} style={{ marginBottom: 8 }}>
                  <div
                    onClick={() => setExpandedSubs(s => ({ ...s, [sub.id]: !s[sub.id] }))}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 8,
                      padding: '8px 10px', borderRadius: 6, cursor: 'pointer',
                      border: '1px solid var(--border-l)',
                      background: subOpen ? 'var(--navy-05)' : 'white',
                    }}
                  >
                    <span style={{ color: 'var(--text-3)', fontSize: 11, width: 12 }}>{subOpen ? '▾' : '▸'}</span>
                    <div style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--navy)', flexShrink: 0 }} />
                    <span style={{ flex: 1, fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 500, color: 'var(--navy)' }}>
                      {sub.lis_submission_id}
                    </span>
                    <span style={{ fontSize: 11, color: 'var(--text-3)' }}>{sub.report_date || '—'}</span>
                    {hasScannedBlocks && <ScannedIcon size={18} />}
                    {sub.malignancy_flag && <Badge variant="red">Malignant</Badge>}
                  </div>

                  {subOpen && (
                    <div style={{ paddingLeft: 16, marginTop: 4, display: 'flex', flexDirection: 'column', gap: 4 }}>
                      {hasReports && (
                        <div>
                          <button
                            onClick={() => setExpandedReports(r => ({ ...r, [sub.id]: !r[sub.id] }))}
                            style={{
                              display: 'flex', alignItems: 'center', gap: 6,
                              padding: '6px 10px', borderRadius: 6, width: '100%', textAlign: 'left',
                              border: '1px solid var(--border-l)',
                              background: reportOpen ? 'var(--crimson-10)' : 'white',
                              cursor: 'pointer', fontFamily: 'var(--font-sans)', marginBottom: 4,
                            }}
                          >
                            <span style={{ fontSize: 11, color: 'var(--text-3)', width: 12 }}>{reportOpen ? '▾' : '▸'}</span>
                            <svg width="12" height="12" viewBox="0 0 16 16" fill="var(--text-2)">
                              <path d="M5 4a.5.5 0 000 1h6a.5.5 0 000-1H5zm-.5 2.5A.5.5 0 015 6h6a.5.5 0 010 1H5a.5.5 0 01-.5-.5zM5 8a.5.5 0 000 1h6a.5.5 0 000-1H5zm0 2a.5.5 0 000 1h3a.5.5 0 000-1H5z"/>
                              <path d="M2 2a2 2 0 012-2h8a2 2 0 012 2v12a2 2 0 01-2 2H4a2 2 0 01-2-2V2zm10-1H4a1 1 0 00-1 1v12a1 1 0 001 1h8a1 1 0 001-1V2a1 1 0 00-1-1z"/>
                            </svg>
                            <span style={{ fontSize: 12, color: 'var(--text-2)', fontWeight: 500 }}>
                              Reports {macro && micro ? '(macro + microscopy)' : macro ? '(macro)' : '(microscopy)'}
                            </span>
                          </button>
                          {reportOpen && (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 8 }}>
                              {macro && <ReportBlock label="Macroscopy"  text={macro.report_text} />}
                              {micro && <ReportBlock label="Microscopy"  text={micro.report_text} />}
                            </div>
                          )}
                        </div>
                      )}

                      {sub.probes?.map(probe => (
                        <div key={probe.id}>
                          <div
                            onClick={() => setExpandedProbes(s => ({ ...s, [probe.id]: !s[probe.id] }))}
                            style={{
                              display: 'flex', alignItems: 'center', gap: 8,
                              padding: '7px 10px', borderRadius: 6, cursor: 'pointer',
                              border: '1px solid var(--border-l)',
                              background: expandedProbes[probe.id] ? 'var(--navy-05)' : 'white',
                              marginBottom: 3,
                            }}
                          >
                            <span style={{ color: 'var(--text-3)', fontSize: 11, width: 12 }}>{expandedProbes[probe.id] ? '▾' : '▸'}</span>
                            <div style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--navy-60)', flexShrink: 0 }} />
                            <span style={{ flex: 1, fontSize: 12.5, color: 'var(--text-1)', fontWeight: 500 }}>
                              {probe.lis_probe_id} — {probe.topo_description || probe.snomed_topo_code || 'Unknown site'}
                            </span>
                            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-3)' }}>
                              {probe.snomed_topo_code}
                            </span>
                          </div>

                          {expandedProbes[probe.id] && (
                            <div style={{ paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 3, marginBottom: 4 }}>
                              {probe.blocks?.map(block => {
                                const isSelected = selected?.block?.id === block.id
                                const scanCount  = block.scans?.length ?? 0
                                const noScans    = scanCount === 0
                                return (
                                  <div
                                    key={block.id}
                                    onClick={() => selectBlock(block, probe, sub)}
                                    style={{
                                      display: 'flex', alignItems: 'center', gap: 8,
                                      padding: '7px 10px', borderRadius: 6, cursor: 'pointer',
                                      border: isSelected ? '1px solid var(--navy-20)' : '1px solid var(--border-l)',
                                      background: isSelected ? 'var(--navy-10)' : 'white',
                                    }}
                                  >
                                    <div style={{ width: 6, height: 6, borderRadius: '50%', background: noScans ? 'var(--crimson)' : '#1b998b', flexShrink: 0 }} />
                                    <span style={{ flex: 1, fontSize: 12.5, color: isSelected ? 'var(--navy)' : 'var(--text-1)', fontWeight: isSelected ? 600 : 400 }}>
                                      Block {block.block_label}
                                    </span>
                                    <span style={{ fontSize: 11, color: noScans ? 'var(--crimson)' : '#1b998b', fontWeight: noScans ? 600 : 400 }}>
                                      {noScans ? 'no scans' : `${scanCount} scan${scanCount !== 1 ? 's' : ''}`}
                                    </span>
                                  </div>
                                )
                              })}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </Panel>
        </div>

        {/* ── Right: scan detail ── */}
        <div style={{ overflowY: 'auto', padding: '16px 24px 16px 12px' }}>
          {!selected ? (
            <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 8, color: 'var(--text-3)', fontSize: 13 }}>
              <svg width="32" height="32" viewBox="0 0 16 16" fill="var(--navy-20)">
                <path d="M2 2h4v4H2V2zm0 5h4v4H2V7zm5-5h4v4H7V2zm0 5h4v4H7V7zm5-5h2v4h-2V2zm0 5h2v4h-2V7zM2 13h12v1H2v-1z"/>
              </svg>
              Select a block to view scan coverage
            </div>
          ) : (
            <Panel title={`Block ${selected.block.block_label} — scan coverage`}>
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 11, color: 'var(--text-3)', fontFamily: 'var(--font-mono)', marginBottom: 6 }}>
                  {selected.sub.lis_submission_id} / {selected.probe.lis_probe_id} / {selected.block.block_label}
                  {selected.block.tissue_count ? `  ·  Tissue ×${selected.block.tissue_count}` : ''}
                </div>
                <div style={{ padding: '8px 10px', borderRadius: 6, fontSize: 12, background: 'var(--navy-05)', border: '1px solid var(--border-l)', color: selected.block.block_info ? 'var(--text-2)' : 'var(--text-3)', fontStyle: selected.block.block_info ? 'normal' : 'italic' }}>
                  {selected.block.block_info || 'Block info not available'}
                </div>
                {(selected.probe.topo_description || selected.probe.location_additional) && (
                  <div style={{ marginTop: 6, fontSize: 11, color: 'var(--text-3)' }}>
                    {[selected.probe.topo_description, selected.probe.location_additional].filter(Boolean).join(' · ')}
                  </div>
                )}
              </div>

              {scansLoading ? (
                <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-3)' }}>Loading scans…</div>
              ) : scans.length === 0 ? (
                <div style={{ padding: '14px', background: 'var(--crimson-10)', borderRadius: 8, border: '1px solid var(--crimson)', marginBottom: 12 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--crimson)', marginBottom: 3 }}>No scans registered</div>
                  <div style={{ fontSize: 12, color: 'var(--crimson)' }}>Consider sectioning before re-embedding.</div>
                </div>
              ) : (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 8, marginBottom: 12 }}>
                  {scans.map(sc => (
                    <div key={sc.id} style={{ border: '1px solid #1b998b33', borderRadius: 6, padding: '10px', display: 'flex', flexDirection: 'column', gap: 4 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                        <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#1b998b', flexShrink: 0 }} />
                        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 500, color: 'var(--navy)' }}>{sc.stain_name || '—'}</span>
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--text-3)' }}>{sc.file_format}{sc.magnification ? ` · ${sc.magnification}×` : ''}</div>
                      <div style={{ fontSize: 10, color: 'var(--text-3)', fontFamily: 'var(--font-mono)' }}>{sc.stain_category}</div>
                      <button
                        onClick={e => { e.stopPropagation(); window.open(`/viewer/${sc.id}`, '_blank') }}
                        style={{ marginTop: 4, padding: '3px 0', fontSize: 11, background: 'var(--navy-05)', border: '1px solid var(--navy-20)', borderRadius: 4, cursor: 'pointer', color: 'var(--navy)', fontFamily: 'var(--font-sans)', fontWeight: 500, width: '100%' }}
                        onMouseEnter={e => { e.currentTarget.style.background = 'var(--navy-10)' }}
                        onMouseLeave={e => { e.currentTarget.style.background = 'var(--navy-05)' }}
                      >
                        Open viewer ↗
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <div style={{ display: 'flex', gap: 8 }}>
                <Btn variant="primary" small onClick={() => setRegisterOpen(true)}>Register scan</Btn>
                {scans.length > 0 && <Btn variant="ghost" small onClick={() => setDrawerOpen(true)}>View all scans ({scans.length})</Btn>}
              </div>
            </Panel>
          )}
        </div>

        {/* ── Scan detail drawer ── */}
        {drawerOpen && selected && (
          <ScansDrawer scans={scans} block={selected.block} probe={selected.probe} sub={selected.sub} onClose={() => setDrawerOpen(false)} />
        )}
      </div>

      {/* ── Register scan modal ── */}
      {registerOpen && selected && (
        <RegisterScanModal block={selected.block} probe={selected.probe} sub={selected.sub} existingScans={scans} onClose={() => setRegisterOpen(false)} onSuccess={() => { setRegisterOpen(false); refreshScans() }} />
      )}
    </Layout>
  )
}