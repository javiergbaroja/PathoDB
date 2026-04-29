// frontend/src/pages/SlideViewer/ModelsPanel.jsx
import { useState, useEffect } from 'react'
import { api } from '../../api'
import JobOutcomeDispatcher from '../../components/AnalysisOutcomes/JobOutcomeDispatcher'
import { CATEGORY_COLORS } from '../../constants/viewer'
import { ErrorBoundary } from '../../components/ErrorBoundary'
import { useViewerStore } from '../../store/viewerStore'

// ── GeoJSON serialisers ────────────────────────────────────────────────────────

function polygonsToGeoJSON(polygons) {
  return {
    type: 'FeatureCollection',
    features: polygons.map((ring, i) => ({
      type: 'Feature',
      properties: { name: `ROI ${i + 1}`, classification: { name: "user_roi"} },
      geometry: {
        type: 'Polygon',
        // GeoJSON requires the ring to be closed (first pt repeated at end)
        coordinates: [
          [...ring.map(pt => [Math.round(pt.x), Math.round(pt.y)]),
           [Math.round(ring[0].x), Math.round(ring[0].y)]],
        ],
      },
    })),
  }
}

/**
 * Convert the current OSD viewport to a rectangular GeoJSON polygon
 * (image-pixel coordinates, level-0).
 */
function viewportToGeoJSON(viewer) {
  if (!viewer?.viewport) return null
  try {
    const vp = viewer.viewport
    const b  = vp.getBounds(true)          // true = current animated value

    const corners = [
      vp.viewportToImageCoordinates(b.getTopLeft()),
      vp.viewportToImageCoordinates(b.getTopRight()),
      vp.viewportToImageCoordinates(b.getBottomRight()),
      vp.viewportToImageCoordinates(b.getBottomLeft()),
    ]

    const coords = corners.map(pt => [Math.round(pt.x), Math.round(pt.y)])
    coords.push(coords[0])  // close ring

    return {
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        properties: { name: 'Visible Region' , classification: { name: "user_roi"} },
        geometry: { type: 'Polygon', coordinates: [coords] },
      }],
    }
  } catch { return null }
}


// ── Main component ─────────────────────────────────────────────────────────────

export default function ModelsPanel({
  catalog, scanId, scanInfo,
  jobs, activeOverlays, setActiveOverlays,
  onJobsChange, onToggleOverlay,
  viewer,   // osdLeftRef.current — needed for viewport → GeoJSON
}) {
  const { polygons, clearPolygons, setIsPolygonActive } = useViewerStore()

  const [expandedId,  setExpandedId]  = useState(null)
  const [categoryTab, setCategoryTab] = useState('All')
  const [submitting,  setSubmitting]  = useState(false)
  const [submitError, setSubmitError] = useState('')

  // Per-model scope and params stored locally (not in zustand — no cross-panel need)
  const [modelScope,  setModelScope]  = useState({})
  const [modelParams, setModelParams] = useState({})

  const categories = ['All', ...Array.from(new Set(catalog.map(m => m.category)))]
  const visible    = categoryTab === 'All' ? catalog : catalog.filter(m => m.category === categoryTab)

  function scopeFor(id)      { return modelScope[id]  || 'whole_slide' }
  function paramsFor(id)     { return modelParams[id]  || {} }
  function setScope(id, val) { setModelScope(s  => ({ ...s, [id]: val })) }
  function setParam(id, k, v){ setModelParams(p => ({ ...p, [id]: { ...paramsFor(id), [k]: v } })) }

  function jobsForModel(modelId) {
    return jobs.filter(j => j.model_id === modelId).sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
  }
  function latestJob(modelId) { return jobsForModel(modelId)[0] || null }

  // ── Submit ───────────────────────────────────────────────────────────────────
  async function handleRun(model) {
    if (!scanId) return
    setSubmitting(true)
    setSubmitError('')
    try {
      const scope = scopeFor(model.id)

      // Build per-model params
      const params = {}
      ;(model.params || []).forEach(p => {
        params[p.key] = paramsFor(model.id)[p.key] ?? p.default
      })

      // Build ROI GeoJSON depending on scope
      let roi_json = null
      if (scope === 'roi') {
        roi_json = polygonsToGeoJSON(polygons)
      } else if (scope === 'visible_region') {
        roi_json = viewportToGeoJSON(viewer)
        if (!roi_json) throw new Error('Could not read viewport bounds — try again')
      }

      const job = await api.submitAnalysis(scanId, {
        model_id: model.id,
        scope,
        params,
        roi_json,
      })

      onJobsChange(prev => [job, ...prev])

      // After a successful ROI submission, clear the drawn polygons and
      // exit drawing mode so the overlay disappears as specified.
      if (scope === 'roi') {
        clearPolygons()
        setIsPolygonActive(false)
      }
    } catch (e) {
      setSubmitError(e.message || 'Submission failed')
    } finally {
      setSubmitting(false)
    }
  }

  async function handleCancel(job) {
    try {
      await api.cancelAnalysis(job.id)
      onJobsChange(prev => prev.map(j => j.id === job.id ? { ...j, status: 'cancelled' } : j))
    } catch (_) {}
  }

  async function handleDelete(job) {
    if (!window.confirm('Permanently delete this run and all its files?')) return
    try {
      if (activeOverlays[job.id]) onToggleOverlay(job.id, job.model_id)
      await api.deleteAnalysis(job.id)
      onJobsChange(prev => prev.filter(j => j.id !== job.id))
    } catch (e) { alert(`Failed to delete job: ${e.message}`) }
  }

  const runningCount = jobs.filter(j => j.status === 'queued' || j.status === 'running').length
  const hasPolygons  = polygons.length > 0

  return (
    <div style={{ width: 296, flexShrink: 0, background: 'rgba(2,5,18,0.98)', borderLeft: '1px solid rgba(255,255,255,0.07)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

      {/* Header */}
      <div style={{ padding: '9px 12px', borderBottom: '1px solid rgba(255,255,255,0.05)', display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.50)', textTransform: 'uppercase', letterSpacing: '0.1em', fontWeight: 600, flex: 1 }}>Analysis models</span>
        {runningCount > 0 && (
          <span style={{ fontSize: 9, color: '#fbbf24', background: 'rgba(251,191,36,0.12)', padding: '2px 7px', borderRadius: 3, fontWeight: 600 }}>
            {runningCount} running
          </span>
        )}
      </div>

      {/* Category tabs */}
      <div style={{ display: 'flex', gap: 4, padding: '6px 10px', flexShrink: 0, overflowX: 'auto' }}>
        {categories.map(cat => (
          <button key={cat} onClick={() => setCategoryTab(cat)} style={{ fontSize: 10, padding: '3px 9px', borderRadius: 20, cursor: 'pointer', whiteSpace: 'nowrap', background: categoryTab === cat ? 'rgba(27,153,139,0.18)' : 'rgba(255,255,255,0.04)', border: `1px solid ${categoryTab === cat ? 'rgba(27,153,139,0.4)' : 'rgba(255,255,255,0.08)'}`, color: categoryTab === cat ? '#6ee7b7' : 'rgba(255,255,255,0.40)' }}>
            {cat}
          </button>
        ))}
      </div>

      {/* Model list */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '0 8px' }}>
        {submitError && (
          <div style={{ margin: '4px 2px 6px', padding: '6px 8px', background: 'rgba(230,0,46,0.12)', border: '1px solid rgba(230,0,46,0.25)', borderRadius: 5, fontSize: 10, color: '#ff8099' }}>
            {submitError}
          </div>
        )}

        {visible.map(model => {
          const latest   = latestJob(model.id)
          const isOpen   = expandedId === model.id
          const catColor = CATEGORY_COLORS[model.category] || CATEGORY_COLORS.other

          return (
            <div key={model.id} style={{ border: `1px solid ${isOpen ? 'rgba(27,153,139,0.35)' : 'rgba(255,255,255,0.07)'}`, borderRadius: 7, marginBottom: 6, overflow: 'hidden', transition: 'border-color 0.15s' }}>

              {/* Model header row */}
              <div onClick={() => setExpandedId(isOpen ? null : model.id)} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', cursor: 'pointer' }}>
                <div style={{ width: 6, height: 6, borderRadius: '50%', background: catColor, flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, fontWeight: 500, color: 'rgba(255,255,255,0.82)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{model.name}</div>
                  <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.40)', marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{model.description}</div>
                </div>
                <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexShrink: 0 }}>
                  <StatusBadge job={latest} />
                  <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.30)', background: 'rgba(255,255,255,0.05)', padding: '2px 5px', borderRadius: 3 }}>~{model.estimated_minutes}m</span>
                </div>
              </div>

              {/* Expanded model body */}
              {isOpen && (
                <div style={{ borderTop: '1px solid rgba(255,255,255,0.05)', padding: '10px 10px 12px' }}>
                  <p style={{ fontSize: 11, color: 'rgba(255,255,255,0.55)', lineHeight: 1.55, margin: '0 0 10px' }}>{model.description}</p>

                  {/* Stain compat badges */}
                  <div style={{ display: 'flex', gap: 4, marginBottom: 10 }}>
                    {(model.stain_compatibility || []).map(s => (
                      <span key={s} style={{ fontSize: 9, padding: '2px 6px', borderRadius: 3, background: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.50)', border: '1px solid rgba(255,255,255,0.1)' }}>{s}</span>
                    ))}
                  </div>

                  {/* Model-specific params */}
                  {(model.params || []).map(param => (
                    <ParamRow key={param.key} param={param} value={paramsFor(model.id)[param.key] ?? param.default} onChange={val => setParam(model.id, param.key, val)} />
                  ))}

                  {/* ── Scope selector ─────────────────────────────────────── */}
                  <ScopeSelector
                    modelId={model.id}
                    scope={scopeFor(model.id)}
                    hasPolygons={hasPolygons}
                    polygonCount={polygons.length}
                    onScopeChange={(id, val) => setScope(id, val)}
                  />

                  {/* ── Run / cancel area ──────────────────────────────────── */}
                  <ModelRunArea
                    latest={latest}
                    model={model}
                    submitting={submitting}
                    scanInfo={scanInfo}
                    onRun={() => handleRun(model)}
                    onCancel={() => handleCancel(latest)}
                  />

                  {/* ── Past runs ──────────────────────────────────────────── */}
                  <PastJobsList
                    jobs={jobsForModel(model.id)}
                    catalog={catalog}
                    activeOverlays={activeOverlays}
                    onToggleOverlay={onToggleOverlay}
                    onDeleteJob={handleDelete}
                  />
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}


// ── Scope selector ─────────────────────────────────────────────────────────────

function ScopeSelector({ modelId, scope, hasPolygons, polygonCount, onScopeChange }) {
  const SCOPES = [
    { value: 'whole_slide',    label: 'Whole slide',    alwaysEnabled: true },
    { value: 'visible_region', label: 'Visible region', alwaysEnabled: true },
    { value: 'roi',            label: 'Drawn ROI',      alwaysEnabled: false },
  ]

  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.45)', marginBottom: 5 }}>
        Analysis scope
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {SCOPES.map(({ value, label, alwaysEnabled }) => {
          const enabled  = alwaysEnabled || hasPolygons
          const isActive = scope === value

          // Visual states
          let bg, border, color, cursor
          if (!enabled) {
            bg = 'rgba(255,255,255,0.02)'
            border = '1px solid rgba(255,255,255,0.06)'
            color = 'rgba(255,255,255,0.20)'
            cursor = 'not-allowed'
          } else if (isActive) {
            bg = 'rgba(27,153,139,0.15)'
            border = '1px solid rgba(27,153,139,0.4)'
            color = '#6ee7b7'
            cursor = 'pointer'
          } else {
            bg = 'rgba(255,255,255,0.04)'
            border = '1px solid rgba(255,255,255,0.1)'
            color = 'rgba(255,255,255,0.55)'
            cursor = 'pointer'
          }

          return (
            <button
              key={value}
              disabled={!enabled}
              onClick={() => enabled && onScopeChange(modelId, value)}
              title={!enabled ? 'Draw at least one polygon on the slide first (P key)' : undefined}
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '6px 10px', borderRadius: 5,
                background: bg, border, color, cursor,
                fontSize: 11, fontFamily: 'sans-serif', textAlign: 'left',
                transition: 'all 0.15s',
              }}
            >
              {/* Active indicator dot */}
              <div style={{
                width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
                background: isActive ? '#6ee7b7' : enabled ? 'rgba(255,255,255,0.2)' : 'rgba(255,255,255,0.08)',
                transition: 'background 0.15s',
              }} />

              <span style={{ flex: 1 }}>{label}</span>

              {/* ROI badge when drawn_roi is active */}
              {value === 'roi' && hasPolygons && (
                <span style={{
                  fontSize: 9, fontWeight: 600,
                  color: isActive ? '#ffd700' : 'rgba(255,215,0,0.45)',
                  background: isActive ? 'rgba(255,215,0,0.15)' : 'rgba(255,215,0,0.06)',
                  border: `1px solid ${isActive ? 'rgba(255,215,0,0.35)' : 'rgba(255,215,0,0.12)'}`,
                  padding: '1px 5px', borderRadius: 3,
                }}>
                  {polygonCount} polygon{polygonCount > 1 ? 's' : ''}
                </span>
              )}

              {/* Lock icon when disabled */}
              {!enabled && (
                <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" style={{ opacity: 0.4, flexShrink: 0 }}>
                  <path d="M8 1a2 2 0 012 2v4H6V3a2 2 0 012-2zm3 6V3a3 3 0 00-6 0v4a2 2 0 00-2 2v5a2 2 0 002 2h6a2 2 0 002-2V9a2 2 0 00-2-2z"/>
                </svg>
              )}
            </button>
          )
        })}
      </div>

      {/* Helper text when drawn_roi is selected */}
      {scope === 'roi' && hasPolygons && (
        <div style={{ marginTop: 5, fontSize: 9, color: 'rgba(255,215,0,0.55)', lineHeight: 1.5 }}>
          Polygons will be cleared after the job is submitted.
        </div>
      )}
    </div>
  )
}


// ── Status badge ───────────────────────────────────────────────────────────────

function StatusBadge({ job }) {
  if (!job) return null
  const map = {
    queued:    { label: 'Queued',    bg: 'rgba(148,163,184,0.15)', color: '#94a3b8' },
    running:   { label: 'Running',   bg: 'rgba(251,191,36,0.15)',  color: '#fbbf24' },
    done:      { label: 'Done',      bg: 'rgba(27,153,139,0.18)',  color: '#6ee7b7' },
    failed:    { label: 'Failed',    bg: 'rgba(230,0,46,0.15)',    color: '#ff8099' },
    cancelled: { label: 'Cancelled', bg: 'rgba(148,163,184,0.12)', color: '#64748b' },
  }
  const s = map[job.status] || map.queued
  return (
    <span style={{ fontSize: 9, padding: '2px 6px', borderRadius: 3, fontWeight: 500, background: s.bg, color: s.color }}>
      {s.label}
    </span>
  )
}


// ── Param row ──────────────────────────────────────────────────────────────────

function ParamRow({ param, value, onChange }) {
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
        <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.45)' }}>{param.label}</span>
        <span style={{ fontSize: 10, fontFamily: 'monospace', color: 'rgba(255,255,255,0.65)' }}>
          {param.type === 'float' ? parseFloat(value).toFixed(2) : value}
        </span>
      </div>
      {param.options ? (
        <div style={{ display: 'flex', gap: 4 }}>
          {param.options.map(opt => (
            <button key={opt} onClick={() => onChange(opt)} style={{ flex: 1, fontSize: 10, padding: '3px 0', borderRadius: 3, cursor: 'pointer', border: `1px solid ${value === opt ? 'rgba(27,153,139,0.4)' : 'rgba(255,255,255,0.1)'}`, background: value === opt ? 'rgba(27,153,139,0.15)' : 'transparent', color: value === opt ? '#6ee7b7' : 'rgba(255,255,255,0.40)' }}>
              {opt}
            </button>
          ))}
        </div>
      ) : (
        <input type="range" min={param.min} max={param.max} step={param.step || 1} value={value}
          onChange={e => onChange(param.type === 'float' ? parseFloat(e.target.value) : parseInt(e.target.value))}
          style={{ width: '100%', accentColor: '#1b998b', cursor: 'pointer' }} />
      )}
    </div>
  )
}


// ── Model run area ─────────────────────────────────────────────────────────────

function ModelRunArea({ latest, model, submitting, scanInfo, onRun, onCancel }) {
  const stainOk = !model.stain_compatibility?.length || model.stain_compatibility.includes(scanInfo?.stain_category)

  if (latest && (latest.status === 'queued' || latest.status === 'running')) {
    return (
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'rgba(255,255,255,0.50)', marginBottom: 4 }}>
          <span>SLURM #{latest.slurm_job_id || '—'}</span>
          <ElapsedTimer since={latest.created_at} />
        </div>
        <div style={{ height: 2, background: 'rgba(255,255,255,0.06)', borderRadius: 1, marginBottom: 5, overflow: 'hidden' }}>
          <div style={{ height: '100%', background: '#1b998b', borderRadius: 1, width: `${latest.progress || 0}%`, transition: 'width 0.5s' }} />
        </div>
        <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.35)', marginBottom: 8 }}>
          {latest.status === 'queued' ? 'Waiting in queue…' : `Processing… ${latest.progress || 0}%`}
        </div>
        <button onClick={onCancel} style={{ width: '100%', padding: '6px 0', borderRadius: 5, border: '1px solid rgba(255,255,255,0.12)', background: 'rgba(255,255,255,0.04)', color: 'rgba(255,255,255,0.40)', fontSize: 11, cursor: 'pointer' }}>
          Cancel job
        </button>
      </div>
    )
  }

  if (latest?.status === 'done') {
    return (
      <div>
        <div style={{ fontSize: 10, color: '#6ee7b7', marginBottom: 8 }}>✓ Analysis complete</div>
        <button onClick={onRun} disabled={submitting} style={{ width: '100%', padding: '6px 0', borderRadius: 5, border: 'none', background: 'rgba(27,153,139,0.15)', color: '#6ee7b7', fontSize: 11, cursor: 'pointer', marginBottom: 4 }}>
          Run again →
        </button>
      </div>
    )
  }

  return (
    <div>
      {!stainOk && (
        <div style={{ fontSize: 10, color: '#fbbf24', marginBottom: 6 }}>
          ⚠ Current stain may not match — expects {model.stain_compatibility?.join(', ')}
        </div>
      )}
      <button onClick={onRun} disabled={submitting} style={{ width: '100%', padding: '7px 0', borderRadius: 5, border: 'none', background: submitting ? 'rgba(255,255,255,0.06)' : '#1b998b', color: submitting ? 'rgba(255,255,255,0.30)' : 'white', fontSize: 12, fontWeight: 500, cursor: submitting ? 'default' : 'pointer' }}>
        {submitting ? 'Submitting…' : 'Run on GPU →'}
      </button>
    </div>
  )
}


// ── Past jobs list ─────────────────────────────────────────────────────────────

function PastJobsList({ jobs, catalog, activeOverlays, onToggleOverlay, onDeleteJob }) {
  const past = jobs.filter(j => j.status === 'done' || j.status === 'failed' || j.status === 'cancelled')
  if (!past.length) return null

  return (
    <div style={{ marginTop: 10, borderTop: '1px solid rgba(255,255,255,0.05)', paddingTop: 8 }}>
      <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.35)', textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 600, marginBottom: 5 }}>
        Previous runs
      </div>
      {past.map(job => {
        const model = catalog.find(m => m.id === job.model_id)
        const scopeLabel = job.scope === 'roi' ? ' · ROI' : job.scope === 'visible_region' ? ' · Visible' : ''
        return (
          <div key={job.id} style={{ marginBottom: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
              <StatusBadge job={job} />
              <span style={{ flex: 1, fontSize: 10, color: 'rgba(255,255,255,0.40)' }}>
                {new Date(job.created_at).toLocaleDateString()}{scopeLabel}
              </span>
              <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                {job.status === 'done' && (
                  <button onClick={() => onToggleOverlay(job.id)} style={{ fontSize: 10, padding: '2px 8px', borderRadius: 3, cursor: 'pointer', border: `1px solid ${activeOverlays[job.id] ? 'rgba(230,0,46,0.25)' : 'rgba(27,153,139,0.25)'}`, background: activeOverlays[job.id] ? 'rgba(230,0,46,0.1)' : 'rgba(27,153,139,0.1)', color: activeOverlays[job.id] ? '#ff8099' : '#6ee7b7' }}>
                    {activeOverlays[job.id] ? 'Hide' : 'View'}
                  </button>
                )}
                {job.status === 'failed' && job.error_message && (
                  <span title={job.error_message} style={{ fontSize: 10, color: '#ff8099', cursor: 'help', padding: '0 4px' }}>ⓘ</span>
                )}
                <button onClick={() => onDeleteJob(job)} title="Delete run and files" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 22, height: 22, borderRadius: 3, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.4)', cursor: 'pointer' }}>
                  ✕
                </button>
              </div>
            </div>
            {job.status === 'done' && (
              <ErrorBoundary
                fallback={
                  <div style={{ padding: '8px', border: '1px dashed rgba(230,0,46,0.3)', borderRadius: '4px', color: '#ff8099', fontSize: '10px', background: 'rgba(230,0,46,0.05)', marginTop: '6px' }}>
                    ⚠ Failed to load analysis visualization.
                  </div>
                }
              >
                <JobOutcomeDispatcher jobId={job.id} model={model} />
              </ErrorBoundary>
            )}
          </div>
        )
      })}
    </div>
  )
}


// ── Elapsed timer ──────────────────────────────────────────────────────────────

function ElapsedTimer({ since }) {
  const [elapsed, setElapsed] = useState(0)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    const start = new Date(since).getTime()
    const tick  = () => setElapsed(Math.floor((Date.now() - start) / 1000))
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [since])
  return <span>{Math.floor(elapsed / 60)}m {String(elapsed % 60).padStart(2, '0')}s</span>
}