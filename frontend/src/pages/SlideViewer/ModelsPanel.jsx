// frontend/src/pages/SlideViewer/ModelsPanel.jsx
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../api'
import JobOutcomeDispatcher from '../../components/AnalysisOutcomes/JobOutcomeDispatcher'
import { ErrorBoundary } from '../../components/ErrorBoundary'
import { useViewerStore } from '../../store/viewerStore'
import { roiFeature, roiFeatureCollection } from '../../lib/roiGeoJSON'
import { JobStatusBadge, ElapsedTimer, ProgressBar, ConfirmDialog, useToast } from '../../components/ui'
import ModelPickerCards from '../../components/ModelPickerCards'
import ModelParamRow from '../../components/ModelParamRow'
import ScopeOptionList from '../../components/ScopeOptionList'

// ── GeoJSON serialiser ───────────────────────────────────────────────────────

function polygonsToGeoJSON(polygons) {
  return roiFeatureCollection(polygons.map((ring, i) => roiFeature(ring, `ROI ${i + 1}`)))
}

// ── Scope options for this context (ad-hoc drawn polygons) ─────────────────

const SCOPES = [
  { value: 'whole_slide', label: 'Whole slide', alwaysEnabled: true },
  { value: 'roi',         label: 'Drawn ROI',   alwaysEnabled: false },
]

// ── Download icon ────────────────────────────────────────────────────────────

const DownloadIcon = () => (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
    <polyline points="7 10 12 15 17 10"/>
    <line x1="12" y1="15" x2="12" y2="3"/>
  </svg>
)

// ── Model run area ───────────────────────────────────────────────────────────

function ModelRunArea({ latest, model, submitting, scanInfo, scanId, onRun, onCancel, onToggleOverlay, activeOverlays }) {
  const stainOk = !model.stain_compatibility?.length ||
    model.stain_compatibility.includes(scanInfo?.stain_category)

  const isBatch    = !!latest?.params_json?.is_batch
  const isBatchViz = isBatch && !!latest?.params_json?.save_visualization

  const { data: liveState } = useQuery({
    queryKey: ['job-live-viewer', latest?.id],
    queryFn:  () => api.getLiveJobState(latest?.id),
    enabled:  !!latest?.id && isBatch && latest?.status === 'running',
    refetchInterval: 3000,
    staleTime: 0,
  })

  const thisScan = liveState?.slides?.[scanId]

  if (latest?.status === 'queued' || latest?.status === 'running') {
    return (
      <div>
        {isBatch ? (
          <>
            <ProgressBar value={thisScan?.progress || 0} height={2} style={{ marginBottom: 5 }} />
            <div style={{ fontSize: 10, color: 'var(--text-dark-2)', marginBottom: 8 }}>
              {!thisScan
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
            border: '1px solid var(--transparent-white-2)',
            background: 'var(--transparent-white-0)',
            color: 'var(--text-dark-2)', fontSize: 11, cursor: 'pointer',
          }}
        >
          {isBatch ? 'Cancel batch' : 'Cancel job'}
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
            background: 'var(--transparent-teal-2)', color: 'var(--viewer-teal-light)',
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
          background: submitting ? 'var(--transparent-white-1)' : 'var(--viewer-teal)',
          color: submitting ? 'var(--transparent-white-3)' : 'var(--white)',
          fontSize: 12, fontWeight: 500, cursor: submitting ? 'default' : 'pointer',
        }}
      >
        {submitting ? 'Submitting…' : 'Run on GPU →'}
      </button>
    </div>
  )
}

// ── Past jobs list ────────────────────────────────────────────────────────────

function PastJobsList({ jobs, catalog, activeOverlays, onToggleOverlay, onDeleteJob, scanId }) {
  const toast = useToast()
  const past = jobs.filter(j => ['done', 'failed', 'cancelled'].includes(j.status))
  if (!past.length) return null

  const handleDownload = async (jobId, isBatch) => {
    try { await api.downloadAnalysisFile(jobId, 'download_file', isBatch ? scanId : null) }
    catch (e) { toast.error(`Download failed: ${e.message}`) }
  }

  return (
    <div style={{ marginTop: 10, borderTop: '1px solid var(--transparent-white-0)', paddingTop: 8 }}>
      <div style={{ fontSize: 9, color: 'var(--text-dark-2)', textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 600, marginBottom: 5 }}>
        Previous runs
      </div>

      {past.map(job => {
        const model       = catalog.find(m => m.id === job.model_id)
        const scopeLabel  = job.scope === 'roi' ? ' · ROI' : job.scope === 'visible_region' ? ' · Visible' : ''
        const isActive    = activeOverlays[job.id]

        const isBatchAnnotation = !!job.params_json?.is_batch && !job.params_json?.save_visualization
        const isBatchViz        = !!job.params_json?.is_batch && !!job.params_json?.save_visualization

        return (
          <div key={job.id} style={{ marginBottom: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
              {job.status === 'done' && isBatchAnnotation ? (
                <span style={{
                  display: 'inline-flex', alignItems: 'center',
                  padding: '2px 8px', borderRadius: 'var(--radius-full)',
                  fontSize: 'var(--text-xs)', fontWeight: 500, whiteSpace: 'nowrap',
                  background: 'var(--transparent-purple-2)', color: '#a78bfa',
                }}>
                  Annotations
                </span>
              ) : (
                <JobStatusBadge status={job.status} />
              )}

              <span style={{ flex: 1, fontSize: 10, color: 'var(--text-dark-2)' }}>
                {new Date(job.created_at).toLocaleDateString()}{scopeLabel}
              </span>

              {job.params_json?.synthetic && (
                <span
                  title={`Auto-registered from analysis job #${job.params_json.derived_from_job}`}
                  style={{
                    display: 'inline-flex', alignItems: 'center',
                    padding: '2px 8px', borderRadius: 'var(--radius-full)',
                    fontSize: 'var(--text-xs)', fontWeight: 500, whiteSpace: 'nowrap',
                    background: 'var(--transparent-teal-2)', color: 'var(--viewer-teal-light)',
                  }}
                >
                  Derived
                </span>
              )}

              <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                {job.status === 'done' && (
                  <>
                    {!isBatchAnnotation && (
                      <button
                        onClick={() => onToggleOverlay(job.id)}
                        style={{
                          fontSize: 10, padding: '2px 8px', borderRadius: 3, cursor: 'pointer',
                          border: `1px solid ${isActive ? 'var(--transparent-crimson-3)' : 'var(--transparent-teal-3)'}`,
                          background: isActive ? 'var(--transparent-crimson-1)' : 'var(--transparent-teal-1)',
                          color: isActive ? 'var(--viewer-red)' : 'var(--viewer-teal-light)',
                        }}
                      >
                        {isActive ? 'Hide' : 'View'}
                      </button>
                    )}

                    <button
                      onClick={() => handleDownload(job.id, isBatchViz || isBatchAnnotation)}
                      title="Download model output"
                      style={{
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        width: 22, height: 22, borderRadius: 3,
                        background: 'var(--transparent-white-0)',
                        border: '1px solid var(--transparent-white-1)',
                        color: 'var(--viewer-teal-light)', cursor: 'pointer',
                      }}
                    >
                      <DownloadIcon />
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
                    background: 'var(--transparent-white-0)',
                    border: '1px solid var(--transparent-white-1)',
                    color: 'var(--transparent-white-4)', cursor: 'pointer',
                  }}
                >✕</button>
              </div>
            </div>

            {job.status === 'done' && (
              <ErrorBoundary
                fallback={
                  <div style={{ padding: 8, border: '1px dashed var(--transparent-crimson-3)', borderRadius: 4, color: 'var(--viewer-red)', fontSize: 10, background: 'var(--transparent-crimson-1)', marginTop: 6 }}>
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

// ── Main component ───────────────────────────────────────────────────────────

export default function ModelsPanel({
  catalog, scanId, scanInfo,
  jobs, activeOverlays, setActiveOverlays,
  onJobsChange, onToggleOverlay,
  viewer,
}) {
  const { polygons, clearPolygons, setIsPolygonActive } = useViewerStore()

  const [submitting,  setSubmitting]  = useState(false)
  const [submitError, setSubmitError] = useState('')
  const [modelScope,  setModelScope]  = useState({})
  const [modelParams, setModelParams] = useState({})
  const [deleteTarget, setDeleteTarget] = useState(null)
  const [deleting,     setDeleting]     = useState(false)
  const toast = useToast()

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
      if (scope === 'roi') roi_json = polygonsToGeoJSON(polygons)

      await api.submitAnalysis(scanId, { model_id: model.id, scope, params, roi_json })
      onJobsChange()

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
      onJobsChange()
    } catch {}
  }

  function handleDelete(job) {
    setDeleteTarget(job)
  }

  async function confirmDelete() {
    const job = deleteTarget
    if (!job) return
    setDeleting(true)
    try {
      if (activeOverlays[job.id]) onToggleOverlay(job.id)
      await api.deleteAnalysis(job.id)
      onJobsChange()
      setDeleteTarget(null)
    } catch (e) {
      toast.error(`Failed to delete job: ${e.message}`)
    } finally {
      setDeleting(false)
    }
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
      {submitError && (
        <div style={{ margin: '8px 10px 0', padding: '6px 8px', background: 'var(--transparent-crimson-1)', border: '1px solid var(--transparent-crimson-3)', borderRadius: 5, fontSize: 10, color: 'var(--viewer-red)' }}>
          {submitError}
        </div>
      )}

      <ModelPickerCards
        catalog={catalog}
        statusFor={modelId => latestJob(modelId)?.status}
        headerRight={runningCount > 0 && (
          <span style={{ fontSize: 9, color: 'var(--viewer-amber)', background: 'var(--transparent-amber-1)', padding: '2px 7px', borderRadius: 3, fontWeight: 600 }}>
            {runningCount} running
          </span>
        )}
      >
        {model => {
          const latest = latestJob(model.id)
          const scope  = scopeFor(model.id)

          return (
            <>
              {(model.params || []).map(param => (
                <ModelParamRow
                  key={param.key}
                  param={param}
                  value={paramsFor(model.id)[param.key] ?? param.default}
                  onChange={val => setParam(model.id, param.key, val)}
                />
              ))}

              <div style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 10, color: 'var(--text-dark-2)', marginBottom: 5 }}>Analysis scope</div>
                <ScopeOptionList
                  value={scope}
                  onChange={val => setScope(model.id, val)}
                  options={SCOPES.map(s => ({
                    value: s.value,
                    label: s.label,
                    enabled: s.alwaysEnabled || hasPolygons,
                    disabledTitle: 'Draw at least one polygon on the slide first (P key)',
                    badge: s.value === 'roi' && hasPolygons ? (
                      <span style={{
                        fontSize: 9, fontWeight: 600,
                        color: scope === 'roi' ? 'var(--viewer-gold)' : 'var(--transparent-gold-5)',
                        background: scope === 'roi' ? 'var(--viewer-gold-bg)' : 'var(--transparent-gold-1)',
                        border: `1px solid ${scope === 'roi' ? 'var(--transparent-gold-4)' : 'var(--viewer-gold-bg)'}`,
                        padding: '1px 5px', borderRadius: 3,
                      }}>
                        {polygons.length} polygon{polygons.length > 1 ? 's' : ''}
                      </span>
                    ) : null,
                  }))}
                />
                {scope === 'roi' && hasPolygons && (
                  <div style={{ marginTop: 5, fontSize: 9, color: 'var(--transparent-gold-6)', lineHeight: 1.5 }}>
                    Polygons will be cleared after the job is submitted.
                  </div>
                )}
              </div>

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
            </>
          )
        }}
      </ModelPickerCards>

      <ConfirmDialog
        isOpen={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={confirmDelete}
        title="Delete analysis run"
        message="Permanently delete this run and all its files? This cannot be undone."
        confirmLabel="Delete"
        loading={deleting}
      />
    </div>
  )
}