// frontend/src/pages/PatientDetail/index.jsx
import { useState, useEffect, useRef, useMemo } from 'react'
import { useParams, useNavigate, useLocation } from 'react-router-dom'
import Layout from '../../components/Layout'
import { Badge, Btn, Panel, SpinnerPage, ErrorMsg } from '../../components/ui'
import { api } from '../../api'
import { useQuery } from '@tanstack/react-query'
import { useAuth } from '../../context/AuthContext'

import RegisterScanModal from './RegisterScanModal'
import ScansDrawer from './ScansDrawer'
import SummaryPanel from './SummaryPanel'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractYearFromId(lisId) {
  const m = (lisId || '').match(/B(\d{4})\./i)
  return m ? parseInt(m[1]) : null
}

function dateToFractional(dateStr) {
  if (!dateStr) return null
  const d = new Date(dateStr)
  if (isNaN(d.getTime())) return null
  const yr = d.getFullYear()
  const start = new Date(yr, 0, 1).getTime()
  const end   = new Date(yr + 1, 0, 1).getTime()
  return yr + (d.getTime() - start) / (end - start)
}

// ─── Sub-components (unchanged) ───────────────────────────────────────────────

function ScannedIcon({ size = 16 }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 256 256"
      style={{ flexShrink: 0, display: 'inline-block' }} title="Has scanned blocks">
      <rect x="62" y="78" width="104" height="72" rx="12"
        style={{ stroke: '#1b998b', strokeWidth: 10, strokeLinecap: 'round', strokeLinejoin: 'round', fill: 'none' }} />
      <rect x="82"  y="96"  width="12" height="14" rx="3" style={{ fill: '#1b998b' }} />
      <rect x="103" y="96"  width="12" height="14" rx="3" style={{ fill: '#1b998b' }} />
      <rect x="124" y="96"  width="12" height="14" rx="3" style={{ fill: '#1b998b' }} />
      <line x1="76"  y1="160" x2="152" y2="160" style={{ stroke: '#1b998b', strokeWidth: 10, strokeLinecap: 'round' }} />
      <line x1="44"  y1="88"  x2="44"  y2="60"  style={{ stroke: '#1b998b', strokeWidth: 10, strokeLinecap: 'round' }} />
      <line x1="44"  y1="60"  x2="72"  y2="60"  style={{ stroke: '#1b998b', strokeWidth: 10, strokeLinecap: 'round' }} />
      <line x1="156" y1="60"  x2="184" y2="60"  style={{ stroke: '#1b998b', strokeWidth: 10, strokeLinecap: 'round' }} />
      <line x1="184" y1="60"  x2="184" y2="88"  style={{ stroke: '#1b998b', strokeWidth: 10, strokeLinecap: 'round' }} />
      <line x1="44"  y1="168" x2="44"  y2="196" style={{ stroke: '#1b998b', strokeWidth: 10, strokeLinecap: 'round' }} />
      <line x1="44"  y1="196" x2="72"  y2="196" style={{ stroke: '#1b998b', strokeWidth: 10, strokeLinecap: 'round' }} />
      <line x1="156" y1="196" x2="184" y2="196" style={{ stroke: '#1b998b', strokeWidth: 10, strokeLinecap: 'round' }} />
      <line x1="184" y1="168" x2="184" y2="196" style={{ stroke: '#1b998b', strokeWidth: 10, strokeLinecap: 'round' }} />
      <circle cx="186" cy="176" r="34" style={{ fill: '#1b998b' }} />
      <polyline points="170,176 182,188 203,164"
        style={{ stroke: 'white', strokeWidth: 10, strokeLinecap: 'round', strokeLinejoin: 'round', fill: 'none' }} />
    </svg>
  )
}

function ReportBlock({ label, text }) {
  const [expanded, setExpanded] = useState(false)
  const isLong = text && text.length > 200
  return (
    <div style={{ border: '1px solid var(--border-l)', borderRadius: 6, overflow: 'hidden', background: 'white' }}>
      <div style={{
        padding: '6px 10px', background: 'var(--navy-05)', borderBottom: '1px solid var(--border-l)',
        fontSize: 11, fontWeight: 600, color: 'var(--text-2)', textTransform: 'uppercase',
        letterSpacing: '0.06em', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      }}>
        {label}
        {isLong && (
          <button onClick={() => setExpanded(e => !e)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 11, color: 'var(--navy)', fontFamily: 'var(--font-sans)' }}>
            {expanded ? 'Show less' : 'Show all'}
          </button>
        )}
      </div>
      <div style={{
        padding: '10px', fontSize: 12, lineHeight: 1.6,
        color: text ? 'var(--text-1)' : 'var(--text-3)',
        fontStyle: text ? 'normal' : 'italic', whiteSpace: 'pre-wrap',
        maxHeight: expanded ? 'none' : 120, overflow: 'hidden',
      }}>
        {text ? (expanded || !isLong ? text : text.slice(0, 200) + '…') : 'Not available'}
      </div>
    </div>
  )
}

// ─── Patient summary bar ──────────────────────────────────────────────────────

function PatientSummaryBar({ submissions }) {
  const years = submissions.map(s => extractYearFromId(s.lis_submission_id)).filter(Boolean)
  const yearMin = years.length ? Math.min(...years) : null
  const yearMax = years.length ? Math.max(...years) : null

  const malignantCount = submissions.filter(s => s.malignancy_flag === true).length

  const allBlocks    = submissions.flatMap(s => s.probes?.flatMap(p => p.blocks ?? []) ?? [])
  const totalBlocks  = allBlocks.length
  const scannedBlocks = allBlocks.filter(b => (b.scans?.length ?? 0) > 0).length
  const scannedPct   = totalBlocks > 0 ? Math.round(scannedBlocks / totalBlocks * 100) : 0

  const yearLabel =
    yearMin === null    ? '—' :
    yearMin === yearMax ? String(yearMin) :
    `${yearMin} – ${yearMax}`

  return (
    <div style={{
      display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)',
      padding: '12px 16px',
      background: 'var(--navy-05)',
      borderBottom: '1px solid var(--border-l)',
      flexShrink: 0,
    }}>
      <SummaryStat label="Submissions" value={submissions.length} />
      <SummaryStat label="Active years"   value={yearLabel} />
      <SummaryStat
        label="Malignant"
        value={malignantCount > 0 ? malignantCount : '—'}
        accent={malignantCount > 0 ? 'var(--crimson)' : undefined}
      />
      <SummaryStat
        label="Blocks scanned"
        value={totalBlocks > 0 ? `${scannedBlocks} / ${totalBlocks}` : '—'}
        sub={totalBlocks > 0 ? `${scannedPct}%` : undefined}
      />
    </div>
  )
}

function SummaryStat({ label, value, sub, accent }) {
  return (
    <div style={{ padding: '2px 0' }}>
      <div style={{
        fontSize: 10, color: 'var(--text-3)', textTransform: 'uppercase',
        letterSpacing: '0.07em', fontWeight: 600, marginBottom: 3,
      }}>
        {label}
      </div>
      <div style={{
        fontSize: 18, fontFamily: 'var(--font-serif)',
        color: accent || 'var(--navy)', lineHeight: 1.1,
      }}>
        {value}
      </div>
      {sub && <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>{sub}</div>}
    </div>
  )
}

// ─── Mini timeline ────────────────────────────────────────────────────────────

const TL_W     = 500
const TL_PAD   = 32
const TL_AY    = 30   // y of the axis line
const TL_DOT_R = 5

function MiniTimeline({ submissions, onDotClick }) {
  const [tooltip, setTooltip] = useState(null)  // { sub, clientX, clientY }

  const { points, yearLabels, viewH } = useMemo(() => {
    const mapped = submissions
      .map(s => ({
        sub:  s,
        frac: dateToFractional(s.report_date) ?? extractYearFromId(s.lis_submission_id) ?? 0,
      }))
      .filter(p => p.frac > 0)

    if (!mapped.length) return { points: [], yearLabels: [], viewH: 50 }

    const sorted = [...mapped].sort((a, b) => a.frac - b.frac)
    const minF   = sorted[0].frac
    const maxF   = sorted[sorted.length - 1].frac
    const span   = maxF === minF ? 1 : maxF - minF

    const toX = frac =>
      sorted.length === 1
        ? TL_W / 2
        : TL_PAD + ((frac - minF) / span) * (TL_W - 2 * TL_PAD)

    // Vertical stacking for overlapping dots
    const THRESH = TL_DOT_R * 2 + 4
    const stacked = []
    for (const p of sorted) {
      let level = 0
      for (const prev of stacked) {
        if (Math.abs(prev.x - toX(p.frac)) < THRESH)
          level = Math.max(level, prev.level + 1)
      }
      stacked.push({ ...p, x: toX(p.frac), level })
    }

    const points = stacked.map(p => ({
      ...p,
      y: TL_AY - TL_DOT_R - 2 - p.level * (TL_DOT_R * 2 + 4),
    }))

    // Year labels — derived from integer year positions using same scale
    const years  = sorted.map(p => Math.floor(p.frac))
    const minY   = Math.min(...years)
    const maxY   = Math.max(...years)
    const ySpan  = maxY - minY
    const step   = ySpan === 0 ? 1 : ySpan <= 4 ? 1 : ySpan <= 8 ? 2 : ySpan <= 15 ? 3 : 5

    const yearLabels = []
    for (let y = minY; y <= maxY; y += step) {
      yearLabels.push({ year: y, x: toX(y) })
    }

    const maxLevel = Math.max(...points.map(p => p.level), 0)
    const viewH    = TL_AY + 18 + maxLevel * (TL_DOT_R * 2 + 4)

    return { points, yearLabels, viewH }
  }, [submissions])

  if (!points.length) return null

  return (
    <div style={{
      padding: '10px 16px 12px',
      borderBottom: '1px solid var(--border-l)',
      flexShrink: 0,
    }}>
      <div style={{
        fontSize: 10, fontWeight: 600, color: 'var(--text-3)',
        textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 6,
      }}>
        Submission timeline
      </div>

      <svg width="100%" viewBox={`0 0 ${TL_W} ${viewH}`} style={{ overflow: 'visible', display: 'block' }}>

        {/* Axis line */}
        <line
          x1={TL_PAD - 10} y1={TL_AY}
          x2={TL_W - TL_PAD + 10} y2={TL_AY}
          stroke="var(--navy-20)" strokeWidth={1}
        />

        {/* Year ticks + labels */}
        {yearLabels.map(({ year, x }) => (
          <g key={year}>
            <line x1={x} y1={TL_AY} x2={x} y2={TL_AY + 5}
              stroke="var(--navy-20)" strokeWidth={1} />
            <text x={x} y={TL_AY + 14} textAnchor="middle"
              fontSize={9} fill="var(--text-3)" fontFamily="var(--font-mono)">
              {year}
            </text>
          </g>
        ))}

        {/* Dots */}
        {points.map(({ sub, x, y }) => {
          const hasScans = sub.probes?.some(p =>
            p.blocks?.some(b => (b.scans?.length ?? 0) > 0)
          )
          const fill =
            sub.malignancy_flag === true  ? 'var(--crimson)' :
            sub.malignancy_flag === false ? 'var(--navy)'    :
            'var(--text-3)'

          return (
            <g
              key={sub.id}
              style={{ cursor: 'pointer' }}
              onMouseEnter={e => setTooltip({ sub, clientX: e.clientX, clientY: e.clientY })}
              onMouseMove={e  => setTooltip(t => t ? { ...t, clientX: e.clientX, clientY: e.clientY } : null)}
              onMouseLeave={() => setTooltip(null)}
              onClick={() => onDotClick(sub.id)}
            >
              {/* Teal scan ring */}
              {hasScans && (
                <circle cx={x} cy={y} r={TL_DOT_R + 3.5}
                  fill="none" stroke="#1b998b" strokeWidth={1.5} opacity={0.85} />
              )}
              {/* Main dot */}
              <circle cx={x} cy={y} r={TL_DOT_R} fill={fill} />
            </g>
          )
        })}
      </svg>

      {/* Legend */}
      <div style={{ display: 'flex', gap: 16, marginTop: 4 }}>
        {[
          { type: 'dot', fill: 'var(--crimson)', label: 'Malignant' },
          { type: 'dot', fill: 'var(--navy)',    label: 'Benign / unknown' },
          { type: 'ring',                         label: 'Has scans' },
        ].map(({ type, fill, label }) => (
          <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <svg width={14} height={14} viewBox="0 0 14 14">
              {type === 'ring' ? (
                <>
                  <circle cx={7} cy={7} r={3.5} fill="var(--navy)" />
                  <circle cx={7} cy={7} r={6}   fill="none" stroke="#1b998b" strokeWidth={1.5} />
                </>
              ) : (
                <circle cx={7} cy={7} r={4.5} fill={fill} />
              )}
            </svg>
            <span style={{ fontSize: 10, color: 'var(--text-3)' }}>{label}</span>
          </div>
        ))}
      </div>

      {/* Tooltip — fixed-position so it's never clipped */}
      {tooltip && (() => {
        const { sub, clientX, clientY } = tooltip
        const allBlocks = sub.probes?.flatMap(p => p.blocks ?? []) ?? []
        const scanned   = allBlocks.filter(b => (b.scans?.length ?? 0) > 0).length
        const status    =
          sub.malignancy_flag === true  ? 'Malignant' :
          sub.malignancy_flag === false ? 'Benign'    :
          'Malignancy unknown'

        return (
          <div style={{
            position: 'fixed',
            left: clientX + 14,
            top:  clientY - 16,
            zIndex: 1000,
            background: 'var(--navy)',
            color: 'white',
            borderRadius: 6,
            padding: '8px 11px',
            fontSize: 11,
            lineHeight: 1.75,
            pointerEvents: 'none',
            boxShadow: '0 4px 16px rgba(0,20,100,0.25)',
            minWidth: 170,
          }}>
            <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, marginBottom: 1 }}>
              {sub.lis_submission_id}
            </div>
            <div style={{ color: 'rgba(255,255,255,0.6)' }}>{sub.report_date || '—'}</div>
            <div style={{ color: sub.malignancy_flag === true ? '#ff8099' : 'rgba(255,255,255,0.6)' }}>
              {status}
            </div>
            <div style={{ color: 'rgba(255,255,255,0.6)' }}>
              {allBlocks.length} block{allBlocks.length !== 1 ? 's' : ''} · {scanned} scanned
            </div>
          </div>
        )
      })()}
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function PatientDetail() {
  const { id }   = useParams()
  const navigate = useNavigate()
  const location = useLocation()
  const { token } = useAuth();

  // ── React Query: patient hierarchy ────────────────────────────────────────
  const { data, isLoading: loading, error: queryError } = useQuery({
    queryKey: ['patient', id],
    queryFn:  () => api.getHierarchy(id),
  })
  const error = queryError?.message || ''

  // ── UI state ──────────────────────────────────────────────────────────────
  const [selected,        setSelected]        = useState(null)
  const [expandedSubs,    setExpandedSubs]    = useState({})
  const [expandedProbes,  setExpandedProbes]  = useState({})
  const [expandedReports, setExpandedReports] = useState({})
  const [drawerOpen,      setDrawerOpen]      = useState(false)
  const [registerOpen,    setRegisterOpen]    = useState(false)
  const [filterTab,       setFilterTab]       = useState('all')  // 'all' | 'malignant' | 'scanned'

  // Ref map: sub.id → DOM element (for scroll-to from timeline)
  const subRefs = useRef({})

  // ── Scans for selected block ───────────────────────────────────────────────
  const {
    data: scans = [],
    isFetching: scansLoading,
    refetch: refreshScans,
  } = useQuery({
    queryKey: ['scans', selected?.block?.id],
    queryFn:  () => api.getScansForBlock(selected.block.id),
    enabled:  !!selected?.block?.id,
  })

  // ── Filtered submissions ───────────────────────────────────────────────────
  const filteredSubmissions = useMemo(() => {
    if (!data) return []
    switch (filterTab) {
      case 'malignant':
        return data.submissions.filter(s => s.malignancy_flag === true)
      case 'scanned':
        return data.submissions.filter(s =>
          s.probes?.some(p => p.blocks?.some(b => (b.scans?.length ?? 0) > 0))
        )
      default:
        return data.submissions
    }
  }, [data, filterTab])

  // ── Timeline dot click → expand + scroll ─────────────────────────────────
  function handleDotClick(subId) {
    setExpandedSubs(s => ({ ...s, [subId]: true }))
    // Small delay so the accordion has time to expand before scroll
    setTimeout(() => {
      subRefs.current[subId]?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }, 60)
    // If the submission is filtered out, reset to 'all'
    if (filterTab !== 'all') setFilterTab('all')
  }

  // ── URL search highlighting (unchanged logic) ─────────────────────────────
  useEffect(() => {
    if (!data) return

    const searchParams   = new URLSearchParams(location.search)
    const highlightQuery = searchParams.get('q')?.toLowerCase()

    let newExpandedSubs   = {}
    let newExpandedProbes = {}

    if (highlightQuery && data.submissions?.length > 0) {
      let foundSub   = null
      let foundProbe = null

      for (const sub of data.submissions) {
        if (sub.lis_submission_id?.toLowerCase().includes(highlightQuery)) {
          foundSub   = sub
          foundProbe = sub.probes?.find(p =>
            p.lis_probe_id?.toLowerCase().includes(highlightQuery)
          )
          break
        }
        const matchedProbe = sub.probes?.find(p =>
          p.lis_probe_id?.toLowerCase().includes(highlightQuery)
        )
        if (matchedProbe) { foundSub = sub; foundProbe = matchedProbe; break }
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
  }, [data, location.search])

  // ── Block selection ───────────────────────────────────────────────────────
  function selectBlock(block, probe, sub) {
    setSelected({ block, probe, sub })
    setDrawerOpen(false)
    setRegisterOpen(false)
  }

  const actions = (
    <Btn variant="ghost" small onClick={() => navigate('/patients')}>Back to patients</Btn>
  )

  if (loading) return <Layout title="Loading…" actions={actions}><SpinnerPage /></Layout>
  if (error)   return <Layout title="Error"    actions={actions}><div style={{ padding: 24 }}><ErrorMsg message={error} /></div></Layout>
  if (!data)   return null

  const title = `${data.patient_code}  ·  ${data.sex || '?'}  ·  ${data.date_of_birth || 'DOB unknown'}`

  // ── Filter tab counts ─────────────────────────────────────────────────────
  const malignantCount = data.submissions.filter(s => s.malignancy_flag === true).length
  const scannedCount   = data.submissions.filter(s =>
    s.probes?.some(p => p.blocks?.some(b => (b.scans?.length ?? 0) > 0))
  ).length

  return (
    <Layout title={title} actions={actions}>
      <div style={{
        display: 'grid', gridTemplateColumns: '1fr 1fr',
        height: '100%', overflow: 'hidden', position: 'relative',
      }}>

        {/* ── Left: hierarchy ───────────────────────────────────────────────── */}
        <div style={{
          display: 'flex', flexDirection: 'column',
          borderRight: '1px solid var(--border-l)',
          overflow: 'hidden',
        }}>

          {/* Fixed header: summary bar + timeline */}
          <PatientSummaryBar submissions={data.submissions} />
          <MiniTimeline submissions={data.submissions} onDotClick={handleDotClick} />

          {/* Scrollable accordion section */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '12px 12px 16px 16px' }}>

            {/* Section header + filter tabs */}
            <div style={{
              display: 'flex', alignItems: 'center',
              justifyContent: 'space-between', marginBottom: 12,
            }}>
              <div style={{
                fontSize: 11, fontWeight: 600, color: 'var(--text-3)',
                textTransform: 'uppercase', letterSpacing: '0.06em',
              }}>
                Submissions
              </div>
              <div style={{
                display: 'flex', gap: 0,
                border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden',
              }}>
                {[
                  ['all',       `All (${data.submissions.length})`],
                  ['malignant', `Malignant (${malignantCount})`],
                  ['scanned',   `Has scans (${scannedCount})`],
                ].map(([val, label]) => (
                  <button
                    key={val}
                    onClick={() => setFilterTab(val)}
                    style={{
                      padding: '4px 12px', fontSize: 11.5,
                      fontFamily: 'var(--font-sans)',
                      fontWeight: filterTab === val ? 600 : 400,
                      background: filterTab === val ? 'var(--navy)' : 'white',
                      color:      filterTab === val ? 'white' : 'var(--text-2)',
                      border: 'none', cursor: 'pointer', transition: 'all 0.12s',
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {/* Empty state for filtered view */}
            {filteredSubmissions.length === 0 && (
              <div style={{
                padding: '24px', textAlign: 'center',
                color: 'var(--text-3)', fontSize: 13,
              }}>
                No {filterTab === 'malignant' ? 'malignant' : 'scanned'} submissions found.
              </div>
            )}

            {/* Submission accordion */}
            {filteredSubmissions.map(sub => {
              const subOpen    = !!expandedSubs[sub.id]
              const reportOpen = !!expandedReports[sub.id]
              const macro      = sub.reports?.find(r => r.report_type === 'macro')
              const micro      = sub.reports?.find(r => r.report_type === 'microscopy')
              const hasReports = macro || micro

              const hasScannedBlocks = sub.probes?.some(probe =>
                probe.blocks?.some(block => (block.scans?.length ?? 0) > 0)
              ) ?? false

              // Unique topology descriptions for this submission
              const topos = [
                ...new Set(
                  (sub.probes ?? [])
                    .map(p => p.topo_description)
                    .filter(Boolean)
                ),
              ]

              return (
                <div
                  key={sub.id}
                  ref={el => { subRefs.current[sub.id] = el }}
                  style={{ marginBottom: 8 }}
                >
                  {/* Submission header row */}
                  <div
                    onClick={() => setExpandedSubs(s => ({ ...s, [sub.id]: !s[sub.id] }))}
                    style={{
                      display: 'flex', flexDirection: 'column',
                      padding: '8px 10px', borderRadius: 6, cursor: 'pointer',
                      border: '1px solid var(--border-l)',
                      background: subOpen ? 'var(--navy-05)' : 'white',
                    }}
                  >
                    {/* Main row */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ color: 'var(--text-3)', fontSize: 11, width: 12, flexShrink: 0 }}>
                        {subOpen ? '▾' : '▸'}
                      </span>
                      <div style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--navy)', flexShrink: 0 }} />
                      <span style={{
                        flex: 1, fontFamily: 'var(--font-mono)', fontSize: 12,
                        fontWeight: 500, color: 'var(--navy)',
                      }}>
                        {sub.lis_submission_id}
                      </span>
                      <span style={{ fontSize: 11, color: 'var(--text-3)', flexShrink: 0 }}>
                        {sub.report_date || '—'}
                      </span>
                      {hasScannedBlocks && <ScannedIcon size={18} />}
                      {sub.malignancy_flag && <Badge variant="red">Malignant</Badge>}
                    </div>

                    {/* Topology descriptions row */}
                    {topos.length > 0 && (
                      <div style={{
                        paddingLeft: 28, marginTop: 3,
                        fontSize: 11, color: 'var(--text-3)',
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}>
                        {topos.slice(0, 3).join(' · ')}
                        {topos.length > 3 && (
                          <span style={{ color: 'var(--navy-40)', fontStyle: 'italic' }}>
                            {' '}+{topos.length - 3} more
                          </span>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Expanded content */}
                  {subOpen && (
                    <div style={{ paddingLeft: 16, marginTop: 4, display: 'flex', flexDirection: 'column', gap: 4 }}>

                      {/* Reports toggle */}
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
                              <path d="M5 4a.5.5 0 000 1h6a.5.5 0 000-1H5zm-.5 2.5A.5.5 0 015 6h6a.5.5 0 010 1H5a.5.5 0 01-.5-.5zM5 8a.5.5 0 000 1h6a.5.5 0 000-1H5zm0 2a.5.5 0 000 1h3a.5.5 0 000-1H5z" />
                              <path d="M2 2a2 2 0 012-2h8a2 2 0 012 2v12a2 2 0 01-2 2H4a2 2 0 01-2-2V2zm10-1H4a1 1 0 00-1 1v12a1 1 0 001 1h8a1 1 0 001-1V2a1 1 0 00-1-1z" />
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

                      {/* Probes */}
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
                            <span style={{ color: 'var(--text-3)', fontSize: 11, width: 12 }}>
                              {expandedProbes[probe.id] ? '▾' : '▸'}
                            </span>
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
                                    <div style={{
                                      width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
                                      background: noScans ? 'var(--crimson)' : '#1b998b',
                                    }} />
                                    <span style={{
                                      flex: 1, fontSize: 12.5,
                                      color: isSelected ? 'var(--navy)' : 'var(--text-1)',
                                      fontWeight: isSelected ? 600 : 400,
                                    }}>
                                      Block {block.block_label}
                                    </span>
                                    <span style={{
                                      fontSize: 11,
                                      color: noScans ? 'var(--crimson)' : '#1b998b',
                                      fontWeight: noScans ? 600 : 400,
                                    }}>
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
          </div>
        </div>

        {/* ── Right: scan detail ────────────────────────────────────────────── */}
        <div style={{ overflowY: 'auto', padding: '16px 24px 16px 12px' }}>
          <SummaryPanel patientId={parseInt(id)} />
          {!selected ? (
            <div style={{
              height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center',
              flexDirection: 'column', gap: 8, color: 'var(--text-3)', fontSize: 13,
            }}>
              <svg width="32" height="32" viewBox="0 0 16 16" fill="var(--navy-20)">
                <path d="M2 2h4v4H2V2zm0 5h4v4H2V7zm5-5h4v4H7V2zm0 5h4v4H7V7zm5-5h2v4h-2V2zm0 5h2v4h-2V7zM2 13h12v1H2v-1z" />
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
                <div style={{
                  padding: '8px 10px', borderRadius: 6, fontSize: 12,
                  background: 'var(--navy-05)', border: '1px solid var(--border-l)',
                  color: selected.block.block_info ? 'var(--text-2)' : 'var(--text-3)',
                  fontStyle: selected.block.block_info ? 'normal' : 'italic',
                }}>
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
                <div style={{
                  padding: '14px', background: 'var(--crimson-10)', borderRadius: 8,
                  border: '1px solid var(--crimson)', marginBottom: 12,
                }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--crimson)', marginBottom: 3 }}>
                    No scans registered
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--crimson)' }}>
                    Consider sectioning before re-embedding.
                  </div>
                </div>
              ) : (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 8, marginBottom: 12 }}>
                  {scans.map(sc => (
                    <div key={sc.id} style={{ 
                      border: '1px solid #1b998b33', 
                      borderRadius: 6, 
                      overflow: 'hidden', // Crucial: clips the image to the border radius
                      display: 'flex', 
                      flexDirection: 'column',
                      background: 'white'
                      }}>
                      
                      {/* ── NEW THUMBNAIL CONTAINER ── */}
                      <div style={{ 
                        height: 110, // Fixed height keeps the grid uniform
                        background: '#0d1623', // Using the dark background from Filmstrip.jsx
                        position: 'relative',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        borderBottom: '1px solid #1b998b33'
                        }}>
                        <img 
                          src={`/api/slides/${sc.id}/thumbnail?width=256&token=${token}`} 
                          alt={`${sc.stain_name} preview`} 
                          loading="lazy" 
                          style={{ width: '100%', height: '100%', objectFit: 'contain' }}
                          // Fallback if the thumbnail generation failed or hasn't finished in the ETL
                          onError={(e) => {
                            e.target.style.display = 'none';
                            e.target.parentElement.innerHTML = '<span style="color:rgba(255,255,255,0.4); font-size: 10px; font-family: var(--font-mono);">No Thumbnail</span>';
                          }}
                        />
                      </div>

                      {/* ── EXISTING METADATA ── */}
                      <div style={{ padding: '10px', display: 'flex', flexDirection: 'column', gap: 4 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                          <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#1b998b', flexShrink: 0 }} />
                          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 500, color: 'var(--navy)' }}>
                            {sc.stain_name || '—'}
                          </span>
                        </div>
                        <div style={{ fontSize: 11, color: 'var(--text-3)' }}>
                          {sc.file_format}{sc.magnification ? ` · ${sc.magnification}×` : ''}
                        </div>
                        <div style={{ fontSize: 10, color: 'var(--text-3)', fontFamily: 'var(--font-mono)' }}>
                          {sc.stain_category}
                        </div>
                        <button
                          onClick={e => { e.stopPropagation(); window.open(`/viewer/${sc.id}`, '_blank') }}
                          style={{
                            marginTop: 4, padding: '3px 0', fontSize: 11,
                            background: 'var(--navy-05)', border: '1px solid var(--navy-20)',
                            borderRadius: 4, cursor: 'pointer', color: 'var(--navy)',
                            fontFamily: 'var(--font-sans)', fontWeight: 500, width: '100%',
                          }}
                          onMouseEnter={e => { e.currentTarget.style.background = 'var(--navy-10)' }}
                          onMouseLeave={e => { e.currentTarget.style.background = 'var(--navy-05)' }}
                        >
                          Open viewer ↗
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <div style={{ display: 'flex', gap: 8 }}>
                <Btn variant="primary" small onClick={() => setRegisterOpen(true)}>Register scan</Btn>
                {scans.length > 0 && (
                  <Btn variant="ghost" small onClick={() => setDrawerOpen(true)}>
                    View all scans ({scans.length})
                  </Btn>
                )}
              </div>
            </Panel>
          )}
        </div>

        {/* ── Drawers / modals ──────────────────────────────────────────────── */}
        {drawerOpen && selected && (
          <ScansDrawer
            scans={scans}
            block={selected.block}
            probe={selected.probe}
            sub={selected.sub}
            onClose={() => setDrawerOpen(false)}
          />
        )}
      </div>

      {registerOpen && selected && (
        <RegisterScanModal
          block={selected.block}
          probe={selected.probe}
          sub={selected.sub}
          existingScans={scans}
          onClose={() => setRegisterOpen(false)}
          onSuccess={() => { setRegisterOpen(false); refreshScans() }}
        />
      )}
    </Layout>
  )
}