// frontend/src/pages/PatientDetail/index.jsx
import { useState, useEffect, useRef, useMemo } from 'react'
import { useParams, useNavigate, useLocation } from 'react-router-dom'
import Layout from '../../components/Layout'
import { Badge, Btn, Panel, SpinnerPage, ErrorMsg, SegmentedControl, SlideThumbnail, SnomedTriad, CodeChip } from '../../components/ui'
import { api } from '../../api'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '../../context/AuthContext'

import { ProbeModal, BlockModal, ConfirmDeleteModal } from './EditModals'
import RegisterScanModal from './RegisterScanModal'
import ScansDrawer from './ScansDrawer'
import SummaryPanel from './SummaryPanel'
import { ConsentIcon } from '../../components/ui/ConsentIcons'

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

function ReportBlock({ label, text, onSave, saving }) {
  const [expanded, setExpanded] = useState(false)
  const [editing,  setEditing]  = useState(false)
  const [draft,    setDraft]    = useState(text ?? '')
  const isLong    = !editing && text && text.length > 200
  const isDirty   = draft !== (text ?? '')

  function handleSave() {
    if (!isDirty) { setEditing(false); return }
    onSave(draft).then(() => setEditing(false))
  }

  function handleCancel() {
    setDraft(text ?? '')
    setEditing(false)
  }

  return (
    <div style={{ border: '1px solid var(--border-l)', borderRadius: 6, overflow: 'hidden', background: 'white' }}>
      {/* Header */}
      <div style={{
        padding: '6px 10px', background: 'var(--navy-05)', borderBottom: '1px solid var(--border-l)',
        fontSize: 11, fontWeight: 600, color: 'var(--text-2)', textTransform: 'uppercase',
        letterSpacing: '0.06em', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      }}>
        {label}
        <div style={{ display: 'flex', gap: 6 }}>
          {!editing && isLong && (
            <button onClick={() => setExpanded(e => !e)}
              style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 11, color: 'var(--navy)', fontFamily: 'var(--font-sans)' }}>
              {expanded ? 'Show less' : 'Show all'}
            </button>
          )}
          {/* Edit button — only rendered when onSave is provided (i.e. user is admin) */}
          {onSave && !editing && (
            <button onClick={() => { setDraft(text ?? ''); setEditing(true) }}
              style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 11, color: 'var(--navy)', fontFamily: 'var(--font-sans)' }}>
              Edit
            </button>
          )}
          {onSave && editing && (
            <>
              <button onClick={handleCancel}
                style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 11, color: 'var(--text-3)', fontFamily: 'var(--font-sans)' }}>
                Cancel
              </button>
              <button onClick={handleSave} disabled={saving || !isDirty}
                style={{ background: 'none', border: 'none', cursor: isDirty ? 'pointer' : 'default',
                  fontSize: 11, color: isDirty ? 'var(--teal)' : 'var(--text-3)',
                  fontFamily: 'var(--font-sans)', fontWeight: 600 }}>
                {saving ? 'Saving…' : 'Save'}
              </button>
            </>
          )}
        </div>
      </div>

      {/* Body */}
      {editing ? (
        <textarea
          value={draft}
          onChange={e => setDraft(e.target.value)}
          style={{
            width: '100%', boxSizing: 'border-box',
            minHeight: 160, padding: '10px',
            fontSize: 12, lineHeight: 1.6, fontFamily: 'var(--font-sans)',
            color: 'var(--text-1)', border: 'none', resize: 'vertical',
            outline: 'none', background: 'var(--navy-05)',
          }}
        />
      ) : (
        <div style={{
          padding: '10px', fontSize: 12, lineHeight: 1.6,
          color: text ? 'var(--text-1)' : 'var(--text-3)',
          fontStyle: text ? 'normal' : 'italic', whiteSpace: 'pre-wrap',
          maxHeight: expanded ? 'none' : 120, overflow: 'hidden',
        }}>
          {text ? (expanded || !isLong ? text : text.slice(0, 200) + '…') : 'Not available'}
        </div>
      )}
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
        fontSize: 16, fontFamily: 'var(--font-serif)',
        color: accent || 'var(--navy)', lineHeight: 1.15,
      }}>
        {value}
      </div>
      {sub && <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>{sub}</div>}
    </div>
  )
}

// ─── Mini timeline ────────────────────────────────────────────────────────────

const TL_W     = 500
const TL_PAD   = 36          // horizontal padding inside the SVG canvas
const TL_AY    = 20          // y of the track centre-line
const TL_DOT_R = 3.5         // base dot radius
const TL_TRACK = 2           // track pill height
const TL_STEP  = TL_DOT_R * 2 + 4   // vertical spacing between stacking levels

function MiniTimeline({ submissions, onDotClick }) {
  const [tooltip,   setTooltip]   = useState(null)   // { sub, clientX, clientY }
  const [hoveredId, setHoveredId] = useState(null)

  const { points, yearLabels, viewH, spanX0, spanX1, trackY } = useMemo(() => {
    const mapped = submissions
      .map(s => ({
        sub:  s,
        frac: dateToFractional(s.report_date) ?? extractYearFromId(s.lis_submission_id) ?? 0,
      }))
      .filter(p => p.frac > 0)

    if (!mapped.length) return { points: [], yearLabels: [], viewH: 60, spanX0: 0, spanX1: 0, trackY: TL_AY }

    const sorted = [...mapped].sort((a, b) => a.frac - b.frac)
    const actualMinF = sorted[0].frac
    const actualMaxF = sorted[sorted.length - 1].frac

    // ── Fix 1: expand domain to cover complete integer years so that integer
    //    year positions always land inside [TL_PAD, TL_W-TL_PAD].
    //    Previously the domain was [actualMinF, actualMaxF], so toX(floor(actualMinF))
    //    produced a negative x whenever the first submission fell mid-year.
    const domainMin  = Math.floor(actualMinF)          // Jan 1 of first year
    const domainMax  = Math.floor(actualMaxF) + 1      // Jan 1 of year after last
    const domainSpan = domainMax - domainMin            // always ≥ 1

    const toX = frac => TL_PAD + ((frac - domainMin) / domainSpan) * (TL_W - 2 * TL_PAD)

    // Vertical stacking for overlapping dots
    const THRESH = TL_DOT_R * 2 + 3
    const stacked = []
    for (const p of sorted) {
      let level = 0
      for (const prev of stacked) {
        if (Math.abs(prev.x - toX(p.frac)) < THRESH)
          level = Math.max(level, prev.level + 1)
      }
      stacked.push({ ...p, x: toX(p.frac), level })
    }

    // ── Fix 2: compute maxLevel BEFORE assigning y-positions so we can push
    //    the track down enough to keep stacked dots inside the viewBox.
    //    Previously viewH added extra height at the *bottom* while dots stacked
    //    *upward*, causing level-3+ dots to overflow above y=0 (off-screen top).
    const maxLevel = Math.max(...stacked.map(p => p.level), 0)
    const TOP_PAD  = 10                                                   // min gap above highest dot
    const trackY   = Math.max(TL_AY, TOP_PAD + TL_DOT_R + maxLevel * TL_STEP)

    const points = stacked.map(p => ({
      ...p,
      // dots sit ON the track at level 0, then rise in discrete steps
      y: trackY - p.level * TL_STEP,
    }))

    // Year labels — integer years within the domain, spaced to avoid crowding
    const minY  = domainMin
    const maxY  = Math.floor(actualMaxF)   // last year that has actual data
    const ySpan = maxY - minY
    const step  = ySpan === 0 ? 1 : ySpan <= 4 ? 1 : ySpan <= 8 ? 2 : ySpan <= 15 ? 3 : ySpan <= 30 ? 5 : 10

    const yearLabels = []
    for (let y = minY; y <= maxY; y += step) {
      yearLabels.push({ year: y, x: toX(y) })
    }

    // viewH: track centre + half track height + room for tick + label below
    const viewH = trackY + TL_TRACK / 2 + 24

    // x-extent of the active span highlight (actual first → last submission)
    const spanX0 = toX(actualMinF)
    const spanX1 = toX(actualMaxF)

    return { points, yearLabels, viewH, spanX0, spanX1, trackY }
  }, [submissions])

  if (!points.length) return null

  const trackX0 = TL_PAD - 12
  const trackW  = TL_W - 2 * (TL_PAD - 12)

  return (
    <div style={{
      padding: '10px 16px 14px',
      borderBottom: '1px solid var(--border-l)',
      flexShrink: 0,
    }}>
      <div style={{
        fontSize: 10, fontWeight: 600, color: 'var(--text-3)',
        textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 8,
      }}>
        Submission timeline
      </div>

      <div style={{ maxHeight: 130, overflowX: 'auto', overflowY: 'auto' }}>
      <svg width="100%" viewBox={`0 0 ${TL_W} ${viewH}`} style={{ overflow: 'visible', display: 'block', minWidth: viewH > 70 ? 500 : undefined }}>

        {/* ── Track: full background pill ── */}
        <rect
          x={trackX0} y={trackY - TL_TRACK / 2}
          width={trackW} height={TL_TRACK}
          rx={TL_TRACK / 2}
          fill="var(--navy)" opacity={0.10}
        />

        {/* ── Track: active-span highlight (first → last submission) ── */}
        {spanX1 > spanX0 && (
          <rect
            x={spanX0} y={trackY - TL_TRACK / 2}
            width={spanX1 - spanX0} height={TL_TRACK}
            rx={TL_TRACK / 2}
            fill="var(--navy)" opacity={0.28}
          />
        )}

        {/* ── Year ticks + labels (below track) ── */}
        {yearLabels.map(({ year, x }) => (
          <g key={year}>
            <line
              x1={x} y1={trackY + TL_TRACK / 2 + 2}
              x2={x} y2={trackY + TL_TRACK / 2 + 8}
              stroke="var(--navy)" strokeWidth={0.75} opacity={0.3}
            />
            <text
              x={x} y={trackY + TL_TRACK / 2 + 17}
              textAnchor="middle"
              fontSize={9} fill="var(--text-3)" fontFamily="var(--font-mono)"
            >
              {year}
            </text>
          </g>
        ))}

        {/* ── Dots ── */}
        {points.map(({ sub, x, y }) => {
          const hasScans = sub.probes?.some(p =>
            p.blocks?.some(b => (b.scans?.length ?? 0) > 0)
          )
          const isHovered = sub.id === hoveredId
          const r = isHovered ? TL_DOT_R + 1 : TL_DOT_R
          const fill =
            sub.malignancy_flag === true  ? 'var(--crimson)' :
            sub.malignancy_flag === false ? 'var(--navy)'    :
            'var(--text-3)'

          return (
            <g
              key={sub.id}
              style={{ cursor: 'pointer' }}
              onMouseEnter={e => { setHoveredId(sub.id); setTooltip({ sub, clientX: e.clientX, clientY: e.clientY }) }}
              onMouseMove={e  => setTooltip(t => t ? { ...t, clientX: e.clientX, clientY: e.clientY } : null)}
              onMouseLeave={()  => { setHoveredId(null); setTooltip(null) }}
              onClick={() => onDotClick(sub.id)}
            >
              {/* Teal scan ring — drawn first so it sits behind the halo */}
              {hasScans && (
                <circle
                  cx={x} cy={y} r={r + 3}
                  fill="none" stroke="#1b998b" strokeWidth={1.5} opacity={0.7}
                />
              )}
              {/* White halo — separates the dot from the track and other dots */}
              <circle cx={x} cy={y} r={r + 1} fill="white" opacity={0.9} />
              {/* Main dot */}
              <circle
                cx={x} cy={y} r={r} fill={fill}
                style={{ transition: 'r 0.1s' }}
              />
              {/* Hover glow ring */}
              {isHovered && (
                <circle
                  cx={x} cy={y} r={r + 2.5}
                  fill="none" stroke={fill} strokeWidth={0.75} opacity={0.3}
                />
              )}
            </g>
          )
        })}
      </svg>
      </div>

      {/* Legend */}
      <div style={{ display: 'flex', gap: 18, marginTop: 6 }}>
        {[
          { type: 'dot',  fill: 'var(--crimson)', label: 'Malignant'       },
          { type: 'dot',  fill: 'var(--navy)',    label: 'Benign / unknown' },
          { type: 'ring',                          label: 'Has scans'       },
        ].map(({ type, fill, label }) => (
          <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <svg width={16} height={16} viewBox="0 0 16 16">
              {type === 'ring' ? (
                <>
                  {/* white halo */}
                  <circle cx={8} cy={8} r={5}    fill="white" />
                  <circle cx={8} cy={8} r={4}    fill="var(--navy)" />
                  <circle cx={8} cy={8} r={7.5}  fill="none" stroke="#1b998b" strokeWidth={1.5} opacity={0.7} />
                </>
              ) : (
                <>
                  <circle cx={8} cy={8} r={6.5} fill="white" opacity={0.9} />
                  <circle cx={8} cy={8} r={5}   fill={fill} />
                </>
              )}
            </svg>
            <span style={{ fontSize: 10, color: 'var(--text-3)' }}>{label}</span>
          </div>
        ))}
      </div>

      {/* Tooltip — fixed-position so it's never clipped by panel overflow */}
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
            borderRadius: 7,
            padding: '9px 12px',
            fontSize: 11,
            lineHeight: 1.8,
            pointerEvents: 'none',
            boxShadow: '0 6px 20px rgba(0,20,100,0.3)',
            minWidth: 175,
            borderLeft: `3px solid ${sub.malignancy_flag === true ? 'var(--crimson)' : sub.malignancy_flag === false ? '#5b9cf6' : 'rgba(255,255,255,0.2)'}`,
          }}>
            <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, marginBottom: 2, fontSize: 12 }}>
              {sub.lis_submission_id}
            </div>
            <div style={{ color: 'rgba(255,255,255,0.55)', fontSize: 10 }}>{sub.report_date || '—'}</div>
            <div style={{ color: sub.malignancy_flag === true ? '#ff8099' : 'rgba(255,255,255,0.55)', fontSize: 10 }}>
              {status}
            </div>
            <div style={{ color: 'rgba(255,255,255,0.55)', fontSize: 10, marginTop: 2 }}>
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
  const { token, isAdmin } = useAuth();

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
  const [editScan,        setEditScan]        = useState(null)   // scan object being edited
  const [addProbeForSub,  setAddProbeForSub]  = useState(null)   // sub object
  const [editProbeTarget, setEditProbeTarget] = useState(null)   // { probe, sub }
  const [deleteProbeTarget, setDeleteProbeTarget] = useState(null) // { probe, sub }
  const [addBlockForProbe,  setAddBlockForProbe]  = useState(null) // { probe, sub }
  const [editBlockTarget,   setEditBlockTarget]   = useState(null) // { block, probe, sub }
  const [deleteBlockTarget, setDeleteBlockTarget] = useState(null) // { block, probe, sub }
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

  const queryClient = useQueryClient()
  const invalidate  = () => queryClient.invalidateQueries({ queryKey: ['patient', id] })

  const patchSubmission = useMutation({
    mutationFn: ({ subId, data }) => api.updateSubmission(id, subId, data),
    onSuccess:  invalidate,
  })

  const patchReport = useMutation({
    mutationFn: ({ patientId, subId, reportId, data }) =>
      api.updateReport(patientId, subId, reportId, data),
    onSuccess: invalidate,
  })

  const addProbe    = useMutation({ mutationFn: ({ subId, data })                   => api.createProbe(id, subId, data),              onSuccess: invalidate })
  const patchProbe  = useMutation({ mutationFn: ({ subId, probeId, data })          => api.updateProbe(id, subId, probeId, data),      onSuccess: invalidate })
  const removeProbe = useMutation({ mutationFn: ({ subId, probeId })                => api.deleteProbe(id, subId, probeId),            onSuccess: invalidate })

  const addBlock    = useMutation({ mutationFn: ({ subId, probeId, data })          => api.createBlock(id, subId, probeId, data),      onSuccess: invalidate })
  const patchBlock  = useMutation({ mutationFn: ({ subId, probeId, blockId, data }) => api.updateBlock(id, subId, probeId, blockId, data), onSuccess: invalidate })
  const removeBlock = useMutation({ mutationFn: ({ subId, probeId, blockId })       => api.deleteBlock(id, subId, probeId, blockId),   onSuccess: () => { invalidate(); setSelected(null) } })

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

  if (loading) return (
    <Layout title="Loading…" actions={actions}>
      <div style={{
        display: 'grid', gridTemplateColumns: '1fr 340px',
        height: '100%', overflow: 'hidden',
      }}>
        <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ height: 80, background: 'var(--navy-05)', borderRadius: 'var(--radius-lg)', animation: 'pulse 1.5s infinite' }} />
          <div style={{ height: 60, background: 'var(--navy-05)', borderRadius: 'var(--radius-lg)', animation: 'pulse 1.5s infinite' }} />
          {[1,2,3].map(i => (
            <div key={i} style={{ height: 44, background: 'var(--navy-05)', borderRadius: 'var(--radius-md)', animation: 'pulse 1.5s infinite', animationDelay: `${i * 0.1}s` }} />
          ))}
        </div>
        <div style={{ padding: '16px', borderLeft: '1px solid var(--border-l)' }}>
          <div style={{ height: 200, background: 'var(--navy-05)', borderRadius: 'var(--radius-lg)', animation: 'pulse 1.5s infinite' }} />
        </div>
      </div>
    </Layout>
  )
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
        display: 'grid', gridTemplateColumns: selected ? '3fr 2fr' : '1fr 340px',
        height: '100%', overflow: 'hidden', position: 'relative',
        transition: 'grid-template-columns 0.2s ease',
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
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div style={{
                  fontSize: 11, fontWeight: 600, color: 'var(--text-3)',
                  textTransform: 'uppercase', letterSpacing: '0.06em',
                }}>
                  Submissions
                </div>
                <button
                  onClick={() => {
                    const allExpanded = filteredSubmissions.every(s => expandedSubs[s.id])
                    if (allExpanded) {
                      setExpandedSubs({})
                      setExpandedProbes({})
                    } else {
                      const newSubs = {}
                      const newProbes = {}
                      filteredSubmissions.forEach(s => {
                        newSubs[s.id] = true
                        s.probes?.forEach(p => { newProbes[p.id] = true })
                      })
                      setExpandedSubs(newSubs)
                      setExpandedProbes(newProbes)
                    }
                  }}
                  style={{
                    background: 'none', border: 'none', cursor: 'pointer',
                    fontSize: 11, color: 'var(--navy)', fontFamily: 'var(--font-sans)',
                    padding: '2px 6px',
                  }}
                >
                  {filteredSubmissions.every(s => expandedSubs[s.id]) ? 'Collapse all' : 'Expand all'}
                </button>
              </div>
              <SegmentedControl
                small
                value={filterTab}
                onChange={setFilterTab}
                options={[
                  ['all',       `All (${data.submissions.length})`],
                  ['malignant', `Malignant (${malignantCount})`],
                  ['scanned',   `Has scans (${scannedCount})`],
                ]}
              />
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
              const reportOpen = expandedReports[sub.id] !== false
              const macro      = sub.reports?.find(r => r.report_type === 'macro')
              const micro      = sub.reports?.find(r => r.report_type === 'microscopy')
              const hasReports = macro || micro

              const hasScannedBlocks = sub.probes?.some(probe =>
                probe.blocks?.some(block => (block.scans?.length ?? 0) > 0)
              ) ?? false

              // Unique SNOMED descriptions across all probes in this submission
              const topos = [...new Set((sub.probes ?? []).map(p => p.topo_description).filter(Boolean))]
              const morphs = [...new Set((sub.probes ?? []).flatMap(p => (p.snomed_morph_codes ?? []).map(c => c.description)).filter(Boolean))]
              const etios = [...new Set((sub.probes ?? []).flatMap(p => (p.snomed_etio_codes ?? []).map(c => c.description)).filter(Boolean))]

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
                      <ConsentIcon status={sub.consent} size={14} style={{ flexShrink: 0 }} />
                      {hasScannedBlocks && <ScannedIcon size={18} />}
                      {sub.malignancy_flag && <Badge variant="red">Malignant</Badge>}
                    </div>

                    {/* SNOMED chips row */}
                    {(topos.length > 0 || morphs.length > 0 || etios.length > 0) && (
                      <div style={{
                        paddingLeft: 28, marginTop: 4,
                        display: 'flex', flexWrap: 'wrap', gap: 3,
                      }}>
                        {topos.map(t => <CodeChip key={`t-${t}`} code="" description={t} axis="T" />)}
                        {morphs.map(m => <CodeChip key={`m-${m}`} code="" description={m} axis="M" />)}
                        {etios.map(e => <CodeChip key={`e-${e}`} code="" description={e} axis="E" />)}
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
                            onClick={() => setExpandedReports(r => ({ ...r, [sub.id]: r[sub.id] !== false ? false : true }))}
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
                              {macro && (
                                <ReportBlock
                                  label="Macroscopy"
                                  text={macro.report_text}
                                  onSave={isAdmin
                                    ? (text) => patchReport.mutateAsync({ patientId: id, subId: sub.id, reportId: macro.id, data: { report_text: text } })
                                    : undefined}
                                  saving={patchReport.isPending}
                                />
                              )}
                              {micro && (
                                <ReportBlock
                                  label="Microscopy"
                                  text={micro.report_text}
                                  onSave={isAdmin
                                    ? (text) => patchReport.mutateAsync({ patientId: id, subId: sub.id, reportId: micro.id, data: { report_text: text } })
                                    : undefined}
                                  saving={patchReport.isPending}
                                />
                              )}
                            </div>
                          )}
                        </div>
                      )}

                      {/* Probes */}
                      {sub.probes?.map(probe => (
                        <div key={probe.id}>
                          <div
                            onClick={() => {
                              const willExpand = !expandedProbes[probe.id]
                              setExpandedProbes(s => ({ ...s, [probe.id]: willExpand }))
                              if (willExpand && probe.blocks?.length === 1) {
                                selectBlock(probe.blocks[0], probe, sub)
                              }
                            }}
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
                              {probe.lis_probe_id} — {probe.topo_description || 'Unknown site'}
                              {probe.snomed_morph_codes?.[0]?.description && (
                                <span style={{ color: 'var(--text-3)', fontWeight: 400 }}> · {probe.snomed_morph_codes[0].description}</span>
                              )}
                            </span>
                            <span style={{ fontSize: 10.5, color: 'var(--text-3)', whiteSpace: 'nowrap' }}>
                              {probe.blocks?.length ?? 0} block{(probe.blocks?.length ?? 0) !== 1 ? 's' : ''}
                              {' · '}
                              <span style={{ color: '#1b998b' }}>
                                {(probe.blocks ?? []).reduce((n, b) => n + (b.scans?.length ?? 0), 0)} scan{(probe.blocks ?? []).reduce((n, b) => n + (b.scans?.length ?? 0), 0) !== 1 ? 's' : ''}
                              </span>
                            </span>
                            {isAdmin && (
                              <div onClick={e => e.stopPropagation()} style={{ display: 'flex', gap: 4 }}>
                                <button onClick={() => setEditProbeTarget({ probe, sub })}
                                  style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 11, color: 'var(--navy)', fontFamily: 'var(--font-sans)', padding: '0 4px' }}>
                                  Edit
                                </button>
                                <button onClick={() => setDeleteProbeTarget({ probe, sub })}
                                  style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 11, color: 'var(--crimson)', fontFamily: 'var(--font-sans)', padding: '0 4px' }}>
                                  Delete
                                </button>
                              </div>
                            )}
                          </div>

                          {expandedProbes[probe.id] && (
                            <div style={{ paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 3, marginBottom: 4 }}>
                              <SnomedTriad
                                topoCode={probe.snomed_topo_code}
                                topoDescription={probe.topo_description}
                                morphCodes={probe.snomed_morph_codes}
                                etioCodes={probe.snomed_etio_codes}
                                style={{ marginBottom: 6 }}
                              />
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
                                    {isAdmin && (
                                      <div onClick={e => e.stopPropagation()} style={{ display: 'flex', gap: 4 }}>
                                        <button onClick={() => setEditBlockTarget({ block, probe, sub })}
                                          style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 11, color: 'var(--navy)', fontFamily: 'var(--font-sans)', padding: '0 4px' }}>
                                          Edit
                                        </button>
                                        <button onClick={() => setDeleteBlockTarget({ block, probe, sub })}
                                          style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 11, color: 'var(--crimson)', fontFamily: 'var(--font-sans)', padding: '0 4px' }}>
                                          Delete
                                        </button>
                                      </div>
                                    )}
                                  </div>
                                )
                              })}
                              {isAdmin && (
                              <button
                                onClick={() => setAddBlockForProbe({ probe, sub })}
                                style={{
                                  marginTop: 2, padding: '4px 10px', borderRadius: 6, fontSize: 11,
                                  border: '1px dashed var(--navy-20)', background: 'none',
                                  cursor: 'pointer', color: 'var(--navy)', fontFamily: 'var(--font-sans)',
                                  width: '100%', textAlign: 'left',
                                }}
                              >
                                + Add block
                              </button>
                            )}
                            </div>
                          )}
                        </div>
                      ))}
                    {isAdmin && (
                        <button
                          onClick={() => setAddProbeForSub(sub)}
                          style={{
                            marginTop: 4, padding: '5px 10px', borderRadius: 6, fontSize: 11,
                            border: '1px dashed var(--navy-20)', background: 'none',
                            cursor: 'pointer', color: 'var(--navy)', fontFamily: 'var(--font-sans)',
                            width: '100%', textAlign: 'left',
                          }}
                        >
                          + Add probe
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>

        {/* ── Right: scan detail ────────────────────────────────────────────── */}
        <div style={{ overflowY: 'auto', padding: '16px 20px' }}>
          <SummaryPanel patientId={parseInt(id)} />
          {selected && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 6, marginBottom: 12,
              fontSize: 11, color: 'var(--text-3)', fontFamily: 'var(--font-mono)',
            }}>
              <span>{selected.sub.lis_submission_id}</span>
              <span style={{ color: 'var(--navy-20)' }}>▸</span>
              <span>{selected.probe.lis_probe_id}</span>
              <span style={{ color: 'var(--navy-20)' }}>▸</span>
              <span style={{ color: 'var(--navy)', fontWeight: 600 }}>Block {selected.block.block_label}</span>
            </div>
          )}
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
                    Consider re-syncing from storage.
                  </div>
                </div>
              ) : (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: 10, marginBottom: 12 }}>
                  {scans.map(sc => (
                    <div key={sc.id} style={{ 
                      border: '1px solid #1b998b33', 
                      borderRadius: 6, 
                      overflow: 'hidden', // Crucial: clips the image to the border radius
                      display: 'flex', 
                      flexDirection: 'column',
                      background: 'white'
                      }}>
                      
                      <SlideThumbnail scanId={sc.id} token={token} width={256} height={110} alt={`${sc.stain_name} preview`} />

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
                        {isAdmin && (
                          <button
                            onClick={e => { e.stopPropagation(); setEditScan(sc) }}
                            style={{
                              marginTop: 4, padding: '3px 0', fontSize: 11,
                              background: 'none', border: '1px solid var(--navy-20)',
                              borderRadius: 4, cursor: 'pointer', color: 'var(--navy)',
                              fontFamily: 'var(--font-sans)', fontWeight: 500, width: '100%',
                            }}
                            onMouseEnter={e => { e.currentTarget.style.background = 'var(--navy-05)' }}
                            onMouseLeave={e => { e.currentTarget.style.background = 'none' }}
                          >
                            Edit scan
                          </button>
                        )}
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

      {editScan && selected && (
        <RegisterScanModal
          block={selected.block}
          probe={selected.probe}
          sub={selected.sub}
          existingScans={scans}
          existingScan={editScan}
          onClose={() => setEditScan(null)}
          onSuccess={() => { setEditScan(null); refreshScans() }}
        />
      )}

      {addProbeForSub && (
        <ProbeModal
          sub={addProbeForSub}
          onClose={() => setAddProbeForSub(null)}
          onSave={data => addProbe.mutateAsync({ subId: addProbeForSub.id, data }).then(() => setAddProbeForSub(null))}
          saving={addProbe.isPending}
        />
      )}

      {editProbeTarget && (
        <ProbeModal
          sub={editProbeTarget.sub}
          existing={editProbeTarget.probe}
          onClose={() => setEditProbeTarget(null)}
          onSave={data => patchProbe.mutateAsync({ subId: editProbeTarget.sub.id, probeId: editProbeTarget.probe.id, data }).then(() => setEditProbeTarget(null))}
          saving={patchProbe.isPending}
        />
      )}

      {deleteProbeTarget && (
        <ConfirmDeleteModal
          title="Delete probe"
          message={`Delete probe "${deleteProbeTarget.probe.lis_probe_id}" and all its blocks and scan records? This cannot be undone.`}
          onClose={() => setDeleteProbeTarget(null)}
          onConfirm={() => removeProbe.mutateAsync({ subId: deleteProbeTarget.sub.id, probeId: deleteProbeTarget.probe.id }).then(() => setDeleteProbeTarget(null))}
          saving={removeProbe.isPending}
        />
      )}

      {addBlockForProbe && (
        <BlockModal
          probe={addBlockForProbe.probe}
          onClose={() => setAddBlockForProbe(null)}
          onSave={data => addBlock.mutateAsync({ subId: addBlockForProbe.sub.id, probeId: addBlockForProbe.probe.id, data }).then(() => setAddBlockForProbe(null))}
          saving={addBlock.isPending}
        />
      )}

      {editBlockTarget && (
        <BlockModal
          probe={editBlockTarget.probe}
          existing={editBlockTarget.block}
          onClose={() => setEditBlockTarget(null)}
          onSave={data => patchBlock.mutateAsync({ subId: editBlockTarget.sub.id, probeId: editBlockTarget.probe.id, blockId: editBlockTarget.block.id, data }).then(() => setEditBlockTarget(null))}
          saving={patchBlock.isPending}
        />
      )}

      {deleteBlockTarget && (
        <ConfirmDeleteModal
          title="Delete block"
          message={`Delete block "${deleteBlockTarget.block.block_label}" and its ${deleteBlockTarget.block.scans?.length ?? 0} scan record(s)? This cannot be undone.`}
          onClose={() => setDeleteBlockTarget(null)}
          onConfirm={() => removeBlock.mutateAsync({ subId: deleteBlockTarget.sub.id, probeId: deleteBlockTarget.probe.id, blockId: deleteBlockTarget.block.id }).then(() => setDeleteBlockTarget(null))}
          saving={removeBlock.isPending}
        />
      )}
    </Layout>
  )
}