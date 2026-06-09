// frontend/src/pages/SlideViewer/ModelsPanel.jsx
import { useState, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../api'
import JobOutcomeDispatcher from '../../components/AnalysisOutcomes/JobOutcomeDispatcher'
import { CATEGORY_COLORS } from '../../constants/viewer'
import { ErrorBoundary } from '../../components/ErrorBoundary'
import { useViewerStore } from '../../store/viewerStore'
import { roiFeature, roiFeatureCollection } from '../../lib/roiGeoJSON'
import {
  Btn, JobStatusBadge, ElapsedTimer, SliderRow,
  ProgressBar, SectionLabel, FormLabel, SegmentedControl,
} from '../../components/ui'

// ── GeoJSON serialisers ────────────────────────────────────────────────────────

function polygonsToGeoJSON(polygons) {
  return roiFeatureCollection(polygons.map((ring, i) => roiFeature(ring, `ROI ${i + 1}`)))
}

function viewportToGeoJSON(viewer) {
  if (!viewer?.viewport) return null
  try {
    const vp      = viewer.viewport
    const b       = vp.getBounds(true)
    const corners = [
      vp.viewportToImageCoordinates(b.getTopLeft()),
      vp.viewportToImageCoordinates(b.getTopRight()),
      vp.viewportToImageCoordinates(b.getBottomRight()),
      vp.viewportToImageCoordinates(b.getBottomLeft()),
    ]
    return roiFeatureCollection([roiFeature(corners, 'Visible Region')])
  } catch { return null }
}

// ── Param row (model-specific parameter control) ───────────────────────────────

function ParamRow({ param, value, onChange }) {
  if (param.options) {
    return (
      <div style={{ marginBottom: 8 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
          <span style={{ fontSize: 10, color: 'var(--text-dark-2)' }}>{param.label}</span>
          <span style={{ fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--text-dark-1)' }}>
            {param.type === 'float' ? parseFloat(value).toFixed(2) : value}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          {param.options.map(opt => (
            <button
              key={opt}
              onClick={() => onChange(opt)}
              style={{
                flex: 1, fontSize: 10, padding: '3px 0', borderRadius: 3, cursor: 'pointer',
                border: `1px solid ${value === opt ? 'rgba(27,153,139,0.4)' : 'rgba(255,255,255,0.1)'}`,
                background: value === opt ? 'rgba(27,153,139,0.15)' : 'transparent',
                color: value === opt ? 'var(--viewer-teal-light)' : 'var(--text-dark-2)',
              }}
            >
              {opt}
            </button>
          ))}
        </div>
      </div>
    )
  }

  // Range slider — reuses SliderRow but adapted for dark viewer theme
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
        <span style={{ fontSize: 10, color: 'var(--text-dark-2)' }}>{param.label}</span>
        <span style={{ fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--text-dark-1)' }}>
          {param.type === 'float' ? parseFloat(value).toFixed(2) : value}
        </span>
      </div>
      <input
        type="range"
        min={param.min}
        max={param.max}
        step={param.step || 1}
        value={value}
        onChange={e => onChange(param.type === 'float' ? parseFloat(e.target.value) : parseInt(e.target.value))}
        style={{ width: '100%', accentColor: 'var(--viewer-teal)', cursor: 'pointer' }}
      />
    </div>
  )
}

// ── Scope selector ─────────────────────────────────────────────────────────────

const SCOPES = [
  { value: 'whole_slide',    label: 'Whole slide',    alwaysEnabled: true },
  { value: 'visible_region', label: 'Visible region', alwaysEnabled: true },
  { value: 'roi',            label: 'Drawn ROI',      alwaysEnabled: false },
]

function ScopeSelector({ modelId, scope, hasPolygons, polygonCount, onScopeChange }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 10, color: 'var(--text-dark-2)', marginBottom: 5 }}>Analysis scope</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {SCOPES.map(({ value, label, alwaysEnabled }) => {
          const enabled  = alwaysEnabled || hasPolygons
          const isActive = scope === value

          let bg, border, color, cursor
          if (!enabled) {
            bg = 'rgba(255,255,255,0.02)'; border = '1px solid rgba(255,255,255,0.06)'
            color = 'rgba(255,255,255,0.20)'; cursor = 'not-allowed'
          } else if (isActive) {
            bg = 'rgba(27,153,139,0.15)'; border = '1px solid rgba(27,153,139,0.4)'
            color = 'var(--viewer-teal-light)'; cursor = 'pointer'
          } else {
            bg = 'rgba(255,255,255,0.04)'; border = '1px solid rgba(255,255,255,0.1)'
            color = 'var(--text-dark-2)'; cursor = 'pointer'
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
                fontSize: 11, fontFamily: 'var(--font-sans)', textAlign: 'left',
                transition: 'var(--transition-base)',
              }}
            >
              <div style={{
                width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
                background: isActive ? 'var(--viewer-teal-light)' : enabled ? 'rgba(255,255,255,0.2)' : 'rgba(255,255,255,0.08)',
              }} />
              <span style={{ flex: 1 }}>{label}</span>

              {value === 'roi' && hasPolygons && (
                <span style={{
                  fontSize: 9, fontWeight: 600,
                  color: isActive ? 'var(--viewer-gold)' : 'rgba(255,215,0,0.45)',
                  background: isActive ? 'var(--viewer-gold-bg)' : 'rgba(255,215,0,0.06)',
                  border: `1px solid ${isActive ? 'rgba(255,215,0,0.35)' : 'rgba(255,215,0,0.12)'}`,
                  padding: '1px 5px', borderRadius: 3,
                }}>
                  {polygonCount} polygon{polygonCount > 1 ? 's' : ''}
                </span>
              )}

              {!enabled && (
                <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" style={{ opacity: 0.4, flexShrink: 0 }}>
                  <path d="M8 1a2 2 0 012 2v4H6V3a2 2 0 012-2zm3 6V3a3 3 0 00-6 0v4a2 2 0 00-2 2v5a2 2 0 002 2h6a2 2 0 002-2V9a2 2 0 00-2-2z"/>
                </svg>
              )}
            </button>
          )
        })}
      </div>

      {scope === 'roi' && hasPolygons && (
        <div style={{ marginTop: 5, fontSize: 9, color: 'rgba(255,215,0,0.55)', lineHeight: 1.5 }}>
          Polygons will be cleared after the job is submitted.
        </div>
      )}
    </div>
  )
}

// ── Download icon (shared) ─────────────────────────────────────────────────────

const DownloadIcon = () => (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
    <polyline points="7 10 12 15 17 10"/>
    <line x1="12" y1="15" x2="12" y2="3"/>
  </svg>
)

// ── Model run area ─────────────────────────────────────────────────────────────

function ModelRunArea({ latest, model, submitting, scanInfo, scanId, onRun, onCancel, onToggleOverlay, activeOverlays }) {
  const stainOk = !model.stain_compatibility?.length ||
    model.stain_compatibility.includes(scanInfo?.stain_category)

  const isBatch    = !!latest?.params_json?.is_batch
  const isBatchViz = isBatch && !!latest?.params_json?.save_visualization

  // For any running batch job: poll live state to get THIS scan's per-slide status.
  // Viz-only batches also use this for the "this slide complete" overlay state.
  const { data: liveState } = useQuery({
    queryKey: ['job-live-viewer', latest?.id],
    queryFn:  () => api.getLiveJobState(latest?.id),
    enabled:  !!latest?.id && isBatch && latest?.status === 'running',
    refetchInterval: 3000,
    staleTime: 0,
  })

  const thisScan    = liveState?.slides?.[String(scanId)]
  const thisScanDone = thisScan?.status === 'success'

  if (latest && (latest.status === 'queued' || latest.status === 'running')) {

    // ── Batch + viz: this scan already processed ──────────────────────────────
    if (isBatchViz && thisScanDone) {
      const isActive = !!activeOverlays?.[latest.id]
      return (
        <div>
          <div style={{ fontSize: 10, color: 'var(--viewer-teal-light)', marginBottom: 2 }}>✓ This slide complete</div>
          <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.3)', marginBottom: 8 }}>
            Batch still running…
          </div>
          <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
            <button
              onClick={() => onToggleOverlay(latest.id)}
              style={{
                flex: 1, fontSize: 10, padding: '5px 0', borderRadius: 4, cursor: 'pointer',
                border: `1px solid ${isActive ? 'rgba(230,0,46,0.25)' : 'rgba(27,153,139,0.25)'}`,
                background: isActive ? 'rgba(230,0,46,0.1)' : 'rgba(27,153,139,0.1)',
                color: isActive ? 'var(--viewer-red)' : 'var(--viewer-teal-light)',
              }}
            >
              {isActive ? 'Hide' : 'View'}
            </button>
            <button
              onClick={() => api.downloadAnalysisFile(latest.id, 'download_file', scanId).catch(e => alert(e.message))}
              title="Download result for this slide"
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                width: 28, height: 28, borderRadius: 4,
                background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.1)',
                color: 'var(--viewer-teal-light)', cursor: 'pointer', flexShrink: 0,
              }}
            >
              <DownloadIcon />
            </button>
          </div>
          <ErrorBoundary fallback={null}>
            <JobOutcomeDispatcher jobId={latest.id} model={model} scanId={scanId} />
          </ErrorBoundary>
          <button
            onClick={onCancel}
            style={{
              width: '100%', padding: '5px 0', borderRadius: 5,
              border: '1px solid rgba(255,255,255,0.12)',
              background: 'rgba(255,255,255,0.04)',
              color: 'var(--text-dark-2)', fontSize: 10, cursor: 'pointer',
            }}
          >
            Cancel batch
          </button>
        </div>
      )
    }

    // ── Normal queued / running ────────────────────────────────────────────────
    return (
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--text-dark-2)', marginBottom: 4 }}>
          <span>SLURM #{latest.slurm_job_id || '—'}</span>
          <ElapsedTimer since={latest.created_at} status={latest.status} />
        </div>

        {/* Progress: for batch+viz show THIS slide's bar; otherwise the global one */}
        {isBatchViz && thisScan ? (
          <>
            <ProgressBar value={thisScan.progress || 0} height={2} style={{ marginBottom: 4 }} />
            <div style={{ fontSize: 10, color: 'var(--text-dark-2)', marginBottom: 8 }}>
              {thisScan.status === 'pending'
                ? 'Waiting to process this slide…'
                : `${thisScan.progress || 0}% — ${thisScan.message || 'Processing…'}`}
            </div>
          </>
        ) : (
          <>
            <ProgressBar value={latest.progress || 0} height={2} style={{ marginBottom: 5 }} />
            <div style={{ fontSize: 10, color: 'var(--text-dark-2)', marginBottom: 8 }}>
              {latest.status === 'queued' ? 'Waiting in queue…' : `Processing… ${latest.progress || 0}%`}
            </div>
          </>
        )}

        <button
          onClick={onCancel}
          style={{
            width: '100%', padding: '6px 0', borderRadius: 5,
            border: '1px solid rgba(255,255,255,0.12)',
            background: 'rgba(255,255,255,0.04)',
            color: 'var(--text-dark-2)', fontSize: 11, cursor: 'pointer',
          }}
        >
          Cancel job
        </button>
      </div>
    )
  }

  if (latest?.status === 'done') {
    return (
      <div>
        <div style={{ fontSize: 10, color: 'var(--viewer-teal-light)', marginBottom: 8 }}>✓ Analysis complete</div>
        <button
          onClick={onRun}
          disabled={submitting}
          style={{
            width: '100%', padding: '6px 0', borderRadius: 5, border: 'none',
            background: 'rgba(27,153,139,0.15)', color: 'var(--viewer-teal-light)',
            fontSize: 11, cursor: 'pointer', marginBottom: 4,
          }}
        >
          Run again →
        </button>
      </div>
    )
  }

  return (
    <div>
      {!stainOk && (
        <div style={{ fontSize: 10, color: 'var(--viewer-amber)', marginBottom: 6 }}>
          ⚠ Current stain may not match — expects {model.stain_compatibility?.join(', ')}
        </div>
      )}
      <button
        onClick={onRun}
        disabled={submitting}
        style={{
          width: '100%', padding: '7px 0', borderRadius: 5, border: 'none',
          background: submitting ? 'rgba(255,255,255,0.06)' : 'var(--viewer-teal)',
          color: submitting ? 'rgba(255,255,255,0.30)' : 'var(--white)',
          fontSize: 12, fontWeight: 500, cursor: submitting ? 'default' : 'pointer',
        }}
      >
        {submitting ? 'Submitting…' : 'Run on GPU →'}
      </button>
    </div>
  )
}

// ── Past jobs list ─────────────────────────────────────────────────────────────

function PastJobsList({ jobs, catalog, activeOverlays, onToggleOverlay, onDeleteJob, scanId }) {
  const past = jobs.filter(j => ['done', 'failed', 'cancelled'].includes(j.status))
  if (!past.length) return null

  const handleDownload = async (jobId, isBatchViz) => {
    try { await api.downloadAnalysisFile(jobId, 'download_file', isBatchViz ? scanId : null) }
    catch (e) { alert(`Download failed: ${e.message}`) }
  }

  return (
    <div style={{ marginTop: 10, borderTop: '1px solid rgba(255,255,255,0.05)', paddingTop: 8 }}>
      <div style={{ fontSize: 9, color: 'var(--text-dark-2)', textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 600, marginBottom: 5 }}>
        Previous runs
      </div>

      {past.map(job => {
        const model       = catalog.find(m => m.id === job.model_id)
        const scopeLabel  = job.scope === 'roi' ? ' · ROI' : job.scope === 'visible_region' ? ' · Visible' : ''
        const isActive    = activeOverlays[job.id]

        // Batch jobs without visualization: annotation-only, no overlay in the viewer.
        // Batch jobs WITH visualization: treat like single-slide (overlay is viewable).
        const isBatchAnnotation = !!job.params_json?.is_batch && !job.params_json?.save_visualization
        const isBatchViz        = !!job.params_json?.is_batch && !!job.params_json?.save_visualization

        return (
          <div key={job.id} style={{ marginBottom: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>

              {/* Status badge — distinguish annotation-only batch runs */}
              {job.status === 'done' && isBatchAnnotation ? (
                <span style={{
                  display: 'inline-flex', alignItems: 'center',
                  padding: '2px 8px', borderRadius: 'var(--radius-full)',
                  fontSize: 'var(--text-xs)', fontWeight: 500, whiteSpace: 'nowrap',
                  background: 'rgba(167,139,250,0.15)', color: '#a78bfa',
                }}>
                  Annotations
                </span>
              ) : (
                <JobStatusBadge status={job.status} />
              )}

              <span style={{ flex: 1, fontSize: 10, color: 'var(--text-dark-2)' }}>
                {new Date(job.created_at).toLocaleDateString()}{scopeLabel}
              </span>

              <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                {job.status === 'done' && (
                  <>
                    {/* View overlay — only for single-slide jobs that produce a tiled overlay */}
                    {!isBatchAnnotation && (
                      <button
                        onClick={() => onToggleOverlay(job.id)}
                        style={{
                          fontSize: 10, padding: '2px 8px', borderRadius: 3, cursor: 'pointer',
                          border: `1px solid ${isActive ? 'rgba(230,0,46,0.25)' : 'rgba(27,153,139,0.25)'}`,
                          background: isActive ? 'rgba(230,0,46,0.1)' : 'rgba(27,153,139,0.1)',
                          color: isActive ? 'var(--viewer-red)' : 'var(--viewer-teal-light)',
                        }}
                      >
                        {isActive ? 'Hide' : 'View'}
                      </button>
                    )}

                    {/* Download — use scan_id for batch+viz so we get the per-scan file */}
                    <button
                      onClick={() => handleDownload(job.id, isBatchViz)}
                      title="Download model output"
                      style={{
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        width: 22, height: 22, borderRadius: 3,
                        background: 'rgba(255,255,255,0.03)',
                        border: '1px solid rgba(255,255,255,0.08)',
                        color: 'var(--viewer-teal-light)', cursor: 'pointer',
                      }}
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                        <polyline points="7 10 12 15 17 10"/>
                        <line x1="12" y1="15" x2="12" y2="3"/>
                      </svg>
                    </button>
                  </>
                )}

                {job.status === 'failed' && job.error_message && (
                  <span title={job.error_message} style={{ fontSize: 10, color: 'var(--viewer-red)', cursor: 'help', padding: '0 4px' }}>ⓘ</span>
                )}

                <button
                  onClick={() => onDeleteJob(job)}
                  title="Delete run and files"
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    width: 22, height: 22, borderRadius: 3,
                    background: 'rgba(255,255,255,0.03)',
                    border: '1px solid rgba(255,255,255,0.08)',
                    color: 'rgba(255,255,255,0.4)', cursor: 'pointer',
                  }}
                >✕</button>
              </div>
            </div>

            {job.status === 'done' && (
              <ErrorBoundary
                fallback={
                  <div style={{ padding: 8, border: '1px dashed rgba(230,0,46,0.3)', borderRadius: 4, color: 'var(--viewer-red)', fontSize: 10, background: 'rgba(230,0,46,0.05)', marginTop: 6 }}>
                    ⚠ Failed to load analysis visualization.
                  </div>
                }
              >
                <JobOutcomeDispatcher jobId={job.id} model={model} scanId={isBatchViz || isBatchAnnotation ? scanId : null} />
              </ErrorBoundary>
            )}
          </div>
        )
      })}
    </div>
  )
}
// ── Main component ─────────────────────────────────────────────────────────────

export default function ModelsPanel({
  catalog, scanId, scanInfo,
  jobs, activeOverlays, setActiveOverlays,
  onJobsChange, onToggleOverlay,
  viewer,
}) {
  const { polygons, clearPolygons, setIsPolygonActive } = useViewerStore()

  const [expandedId,  setExpandedId]  = useState(null)
  const [categoryTab, setCategoryTab] = useState('All')
  const [submitting,  setSubmitting]  = useState(false)
  const [submitError, setSubmitError] = useState('')
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

  async function handleRun(model) {
    if (!scanId) return
    setSubmitting(true); setSubmitError('')
    try {
      const scope  = scopeFor(model.id)
      const params = {}
      ;(model.params || []).forEach(p => { params[p.key] = paramsFor(model.id)[p.key] ?? p.default })

      let roi_json = null
      if (scope === 'roi')            roi_json = polygonsToGeoJSON(polygons)
      else if (scope === 'visible_region') {
        roi_json = viewportToGeoJSON(viewer)
        if (!roi_json) throw new Error('Could not read viewport bounds — try again')
      }

      const job = await api.submitAnalysis(scanId, { model_id: model.id, scope, params, roi_json })
      onJobsChange(prev => [job, ...prev])

      if (scope === 'roi') { clearPolygons(); setIsPolygonActive(false) }
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
    } catch {}
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
    <div style={{
      width: 296, flexShrink: 0,
      background: 'var(--surface-dark-card)',
      borderLeft: '1px solid var(--border-dark)',
      display: 'flex', flexDirection: 'column', overflow: 'hidden',
    }}>
      {/* Header */}
      <div style={{ padding: '9px 12px', borderBottom: '1px solid rgba(255,255,255,0.05)', display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        <SectionLabel style={{ flex: 1, color: 'var(--text-dark-2)' }}>Analysis models</SectionLabel>
        {runningCount > 0 && (
          <span style={{ fontSize: 9, color: 'var(--viewer-amber)', background: 'rgba(251,191,36,0.12)', padding: '2px 7px', borderRadius: 3, fontWeight: 600 }}>
            {runningCount} running
          </span>
        )}
      </div>

      {/* Category tabs */}
      <div style={{ padding: '6px 10px', flexShrink: 0, overflowX: 'auto' }}>
        <SegmentedControl
          dark
          small
          options={categories.map(c => [c, c])}
          value={categoryTab}
          onChange={setCategoryTab}
        />
      </div>

      {/* Model list */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '0 8px' }}>
        {submitError && (
          <div style={{ margin: '4px 2px 6px', padding: '6px 8px', background: 'rgba(230,0,46,0.12)', border: '1px solid rgba(230,0,46,0.25)', borderRadius: 5, fontSize: 10, color: 'var(--viewer-red)' }}>
            {submitError}
          </div>
        )}

        {visible.map(model => {
          const latest   = latestJob(model.id)
          const isOpen   = expandedId === model.id
          const catColor = CATEGORY_COLORS[model.category] || CATEGORY_COLORS.other

          return (
            <div
              key={model.id}
              style={{
                border: `1px solid ${isOpen ? 'rgba(27,153,139,0.35)' : 'rgba(255,255,255,0.07)'}`,
                borderRadius: 7, marginBottom: 6, overflow: 'hidden',
                transition: 'var(--transition-base)',
              }}
            >
              {/* Model header */}
              <div
                onClick={() => setExpandedId(isOpen ? null : model.id)}
                style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', cursor: 'pointer' }}
              >
                <div style={{ width: 6, height: 6, borderRadius: '50%', background: catColor, flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-dark-1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {model.name}
                  </div>
                  <div style={{ fontSize: 9, color: 'var(--text-dark-2)', marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {model.description}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexShrink: 0 }}>
                  <JobStatusBadge status={latest?.status} />
                  <span style={{ fontSize: 9, color: 'var(--text-dark-2)', background: 'rgba(255,255,255,0.05)', padding: '2px 5px', borderRadius: 3 }}>
                    ~{model.estimated_minutes}m
                  </span>
                </div>
              </div>

              {/* Expanded body */}
              {isOpen && (
                <div style={{ borderTop: '1px solid rgba(255,255,255,0.05)', padding: '10px 10px 12px' }}>
                  <p style={{ fontSize: 11, color: 'var(--text-dark-2)', lineHeight: 1.55, margin: '0 0 10px' }}>
                    {model.description}
                  </p>

                  {/* Stain compat badges */}
                  <div style={{ display: 'flex', gap: 4, marginBottom: 10 }}>
                    {(model.stain_compatibility || []).map(s => (
                      <span key={s} style={{ fontSize: 9, padding: '2px 6px', borderRadius: 3, background: 'rgba(255,255,255,0.06)', color: 'var(--text-dark-2)', border: '1px solid rgba(255,255,255,0.1)' }}>
                        {s}
                      </span>
                    ))}
                  </div>

                  {/* Model params */}
                  {(model.params || []).map(param => (
                    <ParamRow
                      key={param.key}
                      param={param}
                      value={paramsFor(model.id)[param.key] ?? param.default}
                      onChange={val => setParam(model.id, param.key, val)}
                    />
                  ))}

                  <ScopeSelector
                    modelId={model.id}
                    scope={scopeFor(model.id)}
                    hasPolygons={hasPolygons}
                    polygonCount={polygons.length}
                    onScopeChange={(id, val) => setScope(id, val)}
                  />

                  <ModelRunArea
                    latest={latest}
                    model={model}
                    submitting={submitting}
                    scanInfo={scanInfo}
                    scanId={scanId}
                    onRun={() => handleRun(model)}
                    onCancel={() => handleCancel(latest)}
                    onToggleOverlay={onToggleOverlay}
                    activeOverlays={activeOverlays}
                  />

                  <PastJobsList
                    jobs={jobsForModel(model.id)}
                    catalog={catalog}
                    activeOverlays={activeOverlays}
                    onToggleOverlay={onToggleOverlay}
                    onDeleteJob={handleDelete}
                    scanId={scanId}
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