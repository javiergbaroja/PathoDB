// frontend/src/pages/PatientDetail/index.jsx
import { useState, useEffect, useRef, useMemo } from 'react'
import { useParams, useNavigate, useLocation } from 'react-router-dom'
import Layout from '../../components/Layout'
import { Badge, Btn, Panel, StatCard, SpinnerPage, ErrorMsg, SegmentedControl, SlideThumbnail, SnomedTriad, CodeChip } from '../../components/ui'
import { api } from '../../api'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '../../context/AuthContext'

import { ProbeModal, BlockModal, ConfirmDeleteModal } from './EditModals'
import RegisterScanModal from './RegisterScanModal'
import ScansDrawer from './ScansDrawer'
import SummaryPanel, { usePatientSummaryExists } from './SummaryPanel'
import { ConsentIcon } from '../../components/ui/ConsentIcons'

// replace
function romanToInt(str) {
  if (!/^[IVXLCDM]+$/i.test(str)) return null
  const ROMAN = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 }
  const s = str.toUpperCase()
  let total = 0
  for (let i = 0; i < s.length; i++) {
    const cur  = ROMAN[s[i]]
    const next = ROMAN[s[i + 1]]
    total += (next && cur < next) ? -cur : cur
  }
  return total
}

// Era 1 (pre-2011) probe labels are roman numerals, with a "1" sentinel used
// when a submission has exactly one probe and no numeral was assigned.
// Era 2/3 probe labels are B-number-derived strings (e.g. "B2014.321",
// "B2014.321/001") that sort correctly with a numeric-aware string compare —
// same idiom already used for block labels in SlideViewer/Filmstrip.jsx.
function probeSortKey(probe) {
  const label = probe.lis_probe_id || ''
  if (label === '1') return { roman: 1, label }
  const roman = romanToInt(label)
  return roman !== null ? { roman, label } : { roman: null, label }
}

function compareProbes(a, b) {
  const ka = probeSortKey(a)
  const kb = probeSortKey(b)
  if (ka.roman !== null && kb.roman !== null) return ka.roman - kb.roman
  if (ka.roman !== null) return -1   // roman-numeral (era 1) probes sort first
  if (kb.roman !== null) return 1
  return ka.label.localeCompare(kb.label, undefined, { numeric: true, sensitivity: 'base' })
}

function compareBlocks(a, b) {
  return (a.block_label || '').localeCompare(b.block_label || '', undefined, { numeric: true, sensitivity: 'base' })
}

function extractYearFromId(lisId) {
  // Prefix-agnostic: B = histology, Z = cytology (both follow YYYY. numbering).
  const m = (lisId || '').match(/[A-Z](\d{4})\./i)
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
        style={{ stroke: 'var(--teal)', strokeWidth: 10, strokeLinecap: 'round', strokeLinejoin: 'round', fill: 'none' }} />
      <rect x="82"  y="96"  width="12" height="14" rx="3" style={{ fill: 'var(--teal)' }} />
      <rect x="103" y="96"  width="12" height="14" rx="3" style={{ fill: 'var(--teal)' }} />
      <rect x="124" y="96"  width="12" height="14" rx="3" style={{ fill: 'var(--teal)' }} />
      <line x1="76"  y1="160" x2="152" y2="160" style={{ stroke: 'var(--teal)', strokeWidth: 10, strokeLinecap: 'round' }} />
      <line x1="44"  y1="88"  x2="44"  y2="60"  style={{ stroke: 'var(--teal)', strokeWidth: 10, strokeLinecap: 'round' }} />
      <line x1="44"  y1="60"  x2="72"  y2="60"  style={{ stroke: 'var(--teal)', strokeWidth: 10, strokeLinecap: 'round' }} />
      <line x1="156" y1="60"  x2="184" y2="60"  style={{ stroke: 'var(--teal)', strokeWidth: 10, strokeLinecap: 'round' }} />
      <line x1="184" y1="60"  x2="184" y2="88"  style={{ stroke: 'var(--teal)', strokeWidth: 10, strokeLinecap: 'round' }} />
      <line x1="44"  y1="168" x2="44"  y2="196" style={{ stroke: 'var(--teal)', strokeWidth: 10, strokeLinecap: 'round' }} />
      <line x1="44"  y1="196" x2="72"  y2="196" style={{ stroke: 'var(--teal)', strokeWidth: 10, strokeLinecap: 'round' }} />
      <line x1="156" y1="196" x2="184" y2="196" style={{ stroke: 'var(--teal)', strokeWidth: 10, strokeLinecap: 'round' }} />
      <line x1="184" y1="168" x2="184" y2="196" style={{ stroke: 'var(--teal)', strokeWidth: 10, strokeLinecap: 'round' }} />
      <circle cx="186" cy="176" r="34" style={{ fill: 'var(--teal)' }} />
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

// ─── External source banner ────────────────────────────────────────────────────
// Rendered only for patients whose data came from a collaborator/public cohort
// (patients.source_id set) — internal (IGMP) patients, the overwhelming
// majority, show nothing here. See db/schema.sql `data_sources`.

function ExternalSourceBanner({ source }) {
  if (!source) return null
  const isPublic = (source.governance || '').toLowerCase().includes('public')
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10,
      padding: '8px 16px',
      background: isPublic ? 'var(--teal-10)' : 'var(--warning-bg)',
      borderBottom: '1px solid var(--border-l)',
      flexShrink: 0,
    }}>
      <Badge variant={isPublic ? 'teal' : 'warning'}>{source.code}</Badge>
      <span style={{ fontSize: 12, color: 'var(--text-2)' }}>
        External data &mdash; <strong>{source.name}</strong>
        {source.institution && <> &middot; {source.institution}</>}
        {source.governance && <> &middot; {source.governance}</>}
      </span>
    </div>
  )
}

// ─── Patient summary bar ──────────────────────────────────────────────────────

function PatientSummaryBar({ submissions }) {
  const years = submissions.map(s => extractYearFromId(s.lis_submission_id)).filter(Boolean)
  const yearMin = years.length ? Math.min(...years) : null
  const yearMax = years.length ? Math.max(...years) : null

  const malignantCount = submissions.filter(s => s.malignancy_flag === true).length

  const allBlocks      = submissions.flatMap(s => s.probes?.flatMap(p => p.blocks ?? []) ?? [])
  const totalBlocks    = allBlocks.length
  const scannedBlocks  = allBlocks.filter(b => (b.scans?.length ?? 0) > 0).length
  const scannedPct     = totalBlocks > 0 ? Math.round(scannedBlocks / totalBlocks * 100) : 0

  const yearLabel =
    yearMin === null    ? '—' :
    yearMin === yearMax ? String(yearMin) :
    `${yearMin} – ${yearMax}`

  return (
    <div style={{
      display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8,
      padding: '12px 16px',
      borderBottom: '1px solid var(--border-l)',
      flexShrink: 0,
    }}>
      <StatCard label="Submissions" value={submissions.length} />
      <StatCard label="Active years" value={yearLabel} />
      <StatCard
        label="Malignant"
        value={malignantCount > 0 ? malignantCount : '—'}
        accent={malignantCount > 0 ? 'var(--crimson)' : undefined}
      />
      <StatCard
        label="Blocks scanned"
        value={totalBlocks > 0 ? `${scannedBlocks} / ${totalBlocks}` : '—'}
        sub={totalBlocks > 0 ? `${scannedPct}% scanned` : undefined}
      />
    </div>
  )
}
// ─── Mini timeline ────────────────────────────────────────────────────────────

const TL_W          = 500
const TL_PAD         = 36          // horizontal padding inside the SVG canvas
const TL_AY          = 20          // y of the track centre-line
const TL_DOT_R       = 3.5         // base dot radius
const TL_CLUSTER_R   = 6.5         // radius for a "+N" cluster marker
const TL_TRACK       = 2           // track pill height
const TL_STEP        = 10          // vertical spacing between stacking levels
const MAX_DOTS_PER_YEAR = 3        // show up to this many markers per calendar year
                                    // before folding the rest into a cluster
const MAX_LEVEL      = 3           // final safety clamp on stacking height —
                                    // bounds viewH even if adjacent years collide

function MiniTimeline({ submissions, onDotClick }) {
  const [tooltip,   setTooltip]   = useState(null)   // { sub | cluster, clientX, clientY }
  const [hoveredId, setHoveredId] = useState(null)

  const clusterKey = p => `cluster-${p.subs[0]?.id}`

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

    const domainMin  = Math.floor(actualMinF)
    const domainMax  = Math.floor(actualMaxF) + 1
    const domainSpan = domainMax - domainMin

    const toX = frac => TL_PAD + ((frac - domainMin) / domainSpan) * (TL_W - 2 * TL_PAD)

    // ── Group by calendar year, cap markers per year ──────────────────────
    // Malignant submissions are kept individually visible first — a cluster
    // can only ever absorb non-malignant overflow, or malignant overflow once
    // every visible slot for that year is already a malignant case.
    const byYear = new Map()
    for (const p of sorted) {
      const y = Math.floor(p.frac)
      if (!byYear.has(y)) byYear.set(y, [])
      byYear.get(y).push(p)
    }

    const markers = []
    for (const [, yearPoints] of byYear) {
      const ranked = [...yearPoints].sort((a, b) => {
        const aM = a.sub.malignancy_flag === true ? 0 : 1
        const bM = b.sub.malignancy_flag === true ? 0 : 1
        return aM - bM || a.frac - b.frac
      })

      if (ranked.length <= MAX_DOTS_PER_YEAR) {
        ranked.forEach(p => markers.push({ kind: 'single', sub: p.sub, frac: p.frac }))
        continue
      }

      const visible  = ranked.slice(0, MAX_DOTS_PER_YEAR - 1)
      const overflow = ranked.slice(MAX_DOTS_PER_YEAR - 1)
      visible.forEach(p => markers.push({ kind: 'single', sub: p.sub, frac: p.frac }))

      const overflowFrac = overflow.reduce((sum, p) => sum + p.frac, 0) / overflow.length
      markers.push({
        kind: 'cluster',
        subs: overflow.map(p => p.sub),
        frac: overflowFrac,
        hasMalignant: overflow.some(p => p.sub.malignancy_flag === true),
        hasScans: overflow.some(p =>
          p.sub.probes?.some(pr => pr.blocks?.some(b => (b.scans?.length ?? 0) > 0))
        ),
      })
    }
    markers.sort((a, b) => a.frac - b.frac)

    // ── Stacking: proximity-based levels, clamped as a final safety net ───
    const THRESH = TL_DOT_R * 2 + 3
    const stacked = []
    for (const m of markers) {
      const x = toX(m.frac)
      let level = 0
      for (const prev of stacked) {
        if (Math.abs(prev.x - x) < THRESH)
          level = Math.max(level, prev.level + 1)
      }
      stacked.push({ ...m, x, level: Math.min(level, MAX_LEVEL) })
    }

    const maxLevel = Math.max(...stacked.map(p => p.level), 0)
    const TOP_PAD  = 10
    const trackY   = Math.max(TL_AY, TOP_PAD + TL_DOT_R + maxLevel * TL_STEP)

    const points = stacked.map(p => ({ ...p, y: trackY - p.level * TL_STEP }))

    const minY  = domainMin
    const maxY  = Math.floor(actualMaxF)
    const ySpan = maxY - minY
    const step  = ySpan === 0 ? 1 : ySpan <= 4 ? 1 : ySpan <= 8 ? 2 : ySpan <= 15 ? 3 : ySpan <= 30 ? 5 : 10

    const yearLabels = []
    for (let y = minY; y <= maxY; y += step) {
      yearLabels.push({ year: y, x: toX(y) })
    }

    const viewH  = trackY + TL_TRACK / 2 + 24
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

      <svg width="100%" viewBox={`0 0 ${TL_W} ${viewH}`} style={{ overflow: 'visible', display: 'block' }}>

        <rect
          x={trackX0} y={trackY - TL_TRACK / 2}
          width={trackW} height={TL_TRACK}
          rx={TL_TRACK / 2}
          fill="var(--navy)" opacity={0.10}
        />

        {spanX1 > spanX0 && (
          <rect
            x={spanX0} y={trackY - TL_TRACK / 2}
            width={spanX1 - spanX0} height={TL_TRACK}
            rx={TL_TRACK / 2}
            fill="var(--navy)" opacity={0.28}
          />
        )}

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

        {points.map(p => {
          if (p.kind === 'cluster') {
            const key       = clusterKey(p)
            const isHovered = hoveredId === key
            const r         = isHovered ? TL_CLUSTER_R + 1 : TL_CLUSTER_R
            const fill      = p.hasMalignant ? 'var(--crimson)' : 'var(--navy-60)'
            return (
              <g
                key={key}
                style={{ cursor: 'pointer' }}
                onMouseEnter={e => { setHoveredId(key); setTooltip({ cluster: p, clientX: e.clientX, clientY: e.clientY }) }}
                onMouseMove={e  => setTooltip(t => t ? { ...t, clientX: e.clientX, clientY: e.clientY } : null)}
                onMouseLeave={() => { setHoveredId(null); setTooltip(null) }}
                onClick={() => onDotClick(p.subs.map(s => s.id))}
              >
                {p.hasScans && (
                  <circle cx={p.x} cy={p.y} r={r + 3} fill="none" stroke="var(--teal)" strokeWidth={1.5} opacity={0.7} />
                )}
                <circle cx={p.x} cy={p.y} r={r + 1} fill="white" opacity={0.9} />
                <circle cx={p.x} cy={p.y} r={r} fill={fill} style={{ transition: 'r 0.1s' }} />
                <text x={p.x} y={p.y + 3} textAnchor="middle" fontSize={8} fontWeight={700} fill="white" style={{ pointerEvents: 'none' }}>
                  +{p.subs.length}
                </text>
                {isHovered && (
                  <circle cx={p.x} cy={p.y} r={r + 2.5} fill="none" stroke={fill} strokeWidth={0.75} opacity={0.3} />
                )}
              </g>
            )
          }

          const { sub, x, y } = p
          const hasScans = sub.probes?.some(pr => pr.blocks?.some(b => (b.scans?.length ?? 0) > 0))
          const isHovered = hoveredId === sub.id
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
              onMouseLeave={() => { setHoveredId(null); setTooltip(null) }}
              onClick={() => onDotClick([sub.id])}
            >
              {hasScans && (
                <circle cx={x} cy={y} r={r + 3} fill="none" stroke="var(--teal)" strokeWidth={1.5} opacity={0.7} />
              )}
              <circle cx={x} cy={y} r={r + 1} fill="white" opacity={0.9} />
              <circle cx={x} cy={y} r={r} fill={fill} style={{ transition: 'r 0.1s' }} />
              {isHovered && (
                <circle cx={x} cy={y} r={r + 2.5} fill="none" stroke={fill} strokeWidth={0.75} opacity={0.3} />
              )}
            </g>
          )
        })}
      </svg>

      <div style={{ display: 'flex', gap: 18, marginTop: 6, flexWrap: 'wrap' }}>
        {[
          { type: 'dot',  fill: 'var(--crimson)', label: 'Malignant'       },
          { type: 'dot',  fill: 'var(--navy)',    label: 'Benign / unknown' },
          { type: 'ring',                          label: 'Has scans'       },
          { type: 'count',                         label: 'Clustered years' },
        ].map(({ type, fill, label }) => (
          <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <svg width={16} height={16} viewBox="0 0 16 16">
              {type === 'ring' ? (
                <>
                  <circle cx={8} cy={8} r={5}    fill="white" />
                  <circle cx={8} cy={8} r={4}    fill="var(--navy)" />
                  <circle cx={8} cy={8} r={7.5}  fill="none" stroke="var(--teal)" strokeWidth={1.5} opacity={0.7} />
                </>
              ) : type === 'count' ? (
                <>
                  <circle cx={8} cy={8} r={6.5} fill="var(--navy-60)" />
                  <text x={8} y={11} textAnchor="middle" fontSize={7} fontWeight={700} fill="white">+N</text>
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

      {tooltip && (() => {
        const { clientX, clientY } = tooltip

        if (tooltip.cluster) {
          const { subs } = tooltip.cluster
          const malignantCount = subs.filter(s => s.malignancy_flag === true).length
          const shown = subs.slice(0, 6)
          return (
            <div style={{
              position: 'fixed', left: clientX + 14, top: clientY - 16, zIndex: 1000,
              background: 'var(--navy)', color: 'white', borderRadius: 7,
              padding: '9px 12px', fontSize: 11, lineHeight: 1.7, pointerEvents: 'none',
              boxShadow: '0 6px 20px rgba(0,20,100,0.3)', minWidth: 190,
              borderLeft: `3px solid ${malignantCount > 0 ? 'var(--crimson)' : 'rgba(255,255,255,0.2)'}`,
            }}>
              <div style={{ fontWeight: 600, marginBottom: 4, fontSize: 12 }}>
                {subs.length} submissions
              </div>
              {shown.map(s => (
                <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, color: 'rgba(255,255,255,0.75)' }}>
                  <span style={{
                    width: 5, height: 5, borderRadius: '50%', flexShrink: 0,
                    background: s.malignancy_flag === true ? '#ff8099' : 'rgba(255,255,255,0.5)',
                  }} />
                  <span style={{ fontFamily: 'var(--font-mono)' }}>{s.lis_submission_id}</span>
                </div>
              ))}
              {subs.length > shown.length && (
                <div style={{ color: 'rgba(255,255,255,0.5)', fontSize: 10, marginTop: 2 }}>
                  +{subs.length - shown.length} more — click to expand all
                </div>
              )}
            </div>
          )
        }

        const { sub } = tooltip
        const allBlocks = sub.probes?.flatMap(p => p.blocks ?? []) ?? []
        const scanned   = allBlocks.filter(b => (b.scans?.length ?? 0) > 0).length
        const status    =
          sub.malignancy_flag === true  ? 'Malignant' :
          sub.malignancy_flag === false ? 'Benign'    :
          'Malignancy unknown'

        return (
          <div style={{
            position: 'fixed', left: clientX + 14, top: clientY - 16, zIndex: 1000,
            background: 'var(--navy)', color: 'white', borderRadius: 7,
            padding: '9px 12px', fontSize: 11, lineHeight: 1.8, pointerEvents: 'none',
            boxShadow: '0 6px 20px rgba(0,20,100,0.3)', minWidth: 175,
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
  const summaryExists = usePatientSummaryExists(id)
  const [panelOpenedByUser, setPanelOpenedByUser] = useState(false)
  const panelOpen = summaryExists || !!selected || panelOpenedByUser

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
  const sortedSubmissions = useMemo(() => {
    if (!data) return []
    return data.submissions.map(sub => ({
      ...sub,
      probes: [...(sub.probes ?? [])]
        .sort(compareProbes)
        .map(probe => ({
          ...probe,
          blocks: [...(probe.blocks ?? [])].sort(compareBlocks),
        })),
    }))
  }, [data])

  const filteredSubmissions = useMemo(() => {
    if (!data) return []
    switch (filterTab) {
      case 'malignant':
        return sortedSubmissions.filter(s => s.malignancy_flag === true)
      case 'scanned':
        return sortedSubmissions.filter(s =>
          s.probes?.some(p => p.blocks?.some(b => (b.scans?.length ?? 0) > 0))
        )
      default:
        return sortedSubmissions
    }
  }, [data, sortedSubmissions, filterTab])

  // ── Timeline dot click → expand + scroll ─────────────────────────────────
  function handleDotClick(subIds) {
    const ids = Array.isArray(subIds) ? subIds : [subIds]
    setExpandedSubs(s => {
      const next = { ...s }
      ids.forEach(id => { next[id] = true })
      return next
    })
    // Small delay so the accordion has time to expand before scroll
    setTimeout(() => {
      subRefs.current[ids[0]]?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }, 60)
    // If a clustered submission is filtered out, reset to 'all'
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
        display: 'flex',
        height: '100%', overflow: 'hidden', position: 'relative',
      }}>

        {/* ── Left: hierarchy ───────────────────────────────────────────────── */}
        <div style={{
          flex: 1, minWidth: 0,
          display: 'flex', flexDirection: 'column',
          borderRight: '1px solid var(--border-l)',
          overflow: 'hidden',
        }}>

          {/* Fixed header: source banner (external only) + summary bar + timeline */}
          <ExternalSourceBanner source={data.source} />
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
                    role="button"
                    tabIndex={0}
                    aria-expanded={subOpen}
                    onClick={() => setExpandedSubs(s => ({ ...s, [sub.id]: !s[sub.id] }))}
                    onKeyDown={e => {
                      if (e.key !== 'Enter' && e.key !== ' ') return
                      e.preventDefault()
                      setExpandedSubs(s => ({ ...s, [sub.id]: !s[sub.id] }))
                    }}
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
                            role="button"
                            tabIndex={0}
                            aria-expanded={!!expandedProbes[probe.id]}
                            onClick={() => {
                              const willExpand = !expandedProbes[probe.id]
                              setExpandedProbes(s => ({ ...s, [probe.id]: willExpand }))
                              if (willExpand && probe.blocks?.length === 1) {
                                selectBlock(probe.blocks[0], probe, sub)
                              }
                            }}
                            onKeyDown={e => {
                              if (e.target.closest('button')) return   // don't double-fire under nested Edit/Delete
                              if (e.key !== 'Enter' && e.key !== ' ') return
                              e.preventDefault()
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
                                <span style={{ color: 'var(--text-2)', fontWeight: 500 }}> · {probe.snomed_morph_codes[0].description}</span>
                              )}
                            </span>
                            <span style={{ fontSize: 10.5, color: 'var(--text-3)', whiteSpace: 'nowrap' }}>
                              {probe.blocks?.length ?? 0} block{(probe.blocks?.length ?? 0) !== 1 ? 's' : ''}
                              {' · '}
                              <span style={{ color: 'var(--teal)' }}>
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
                                    role="button"
                                    tabIndex={0}
                                    aria-pressed={isSelected}
                                    onClick={() => selectBlock(block, probe, sub)}
                                    onKeyDown={e => {
                                      if (e.target.closest('button')) return
                                      if (e.key !== 'Enter' && e.key !== ' ') return
                                      e.preventDefault()
                                      selectBlock(block, probe, sub)
                                    }}
                                    style={{
                                      display: 'flex', alignItems: 'center', gap: 8,
                                      padding: '7px 10px', borderRadius: 6, cursor: 'pointer',
                                      border: isSelected ? '1px solid var(--navy-20)' : '1px solid var(--border-l)',
                                      background: isSelected ? 'var(--navy-10)' : 'white',
                                    }}
                                  >
                                    <div style={{
                                      width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
                                      background: noScans ? 'var(--crimson)' : 'var(--teal)',
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
                                      color: noScans ? 'var(--crimson)' : 'var(--teal)',
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

        {/* ── Right: summary (persistent) + scan detail ─────────────────────── */}
        <div style={{
          width: panelOpen ? 400 : 0,
          flexShrink: 0,
          borderLeft: panelOpen ? '1px solid var(--border-l)' : '1px solid transparent',
          overflow: 'hidden',
          transition: 'width 0.24s ease, border-color 0.24s ease',
        }}>
          {/* Inner fixed-width track: stays 400px wide while the outer width
              animates, so content never reflows during the open/close tween. */}
          <div style={{ width: 400, height: '100%', overflowY: 'auto', padding: '16px 20px' }}>

            {/* Summary panel is ALWAYS mounted here — never gated on `selected`,
                so the Generate button can't disappear when a block is clicked. */}
            <SummaryPanel patientId={parseInt(id)} />

            {/* Scan-detail body. Cross-fades between the hint and the real detail
                so selecting a block doesn't pop. */}
            <div style={{ transition: 'opacity 0.18s ease' }}>
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
                          <div style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--teal)', flexShrink: 0 }} />
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
            </div>{/* cross-fade body */}
          </div>{/* inner 400px track */}
        </div>{/* right column */}

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
          submissionProbes={sortedSubmissions.find(s => s.id === selected.sub.id)?.probes ?? []}
          onClose={() => setEditScan(null)}
          onSuccess={() => { setEditScan(null); refreshScans(); invalidate() }}
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