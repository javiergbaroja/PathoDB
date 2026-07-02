// frontend/src/pages/ProjectDetail/ProjectModelsPanel.jsx
//
// AI model submission panel for the ProjectDetail view.
// Renders inside the "AI" tab of ClassPanel.
// Responsibilities:
//   - Model selection (shared ModelPickerCards), parameter configuration, scope selection
//   - Job submission and SLURM polling
//   - Delegates actual DB import to parent via onAutoImport callback
//   - Reports completion count back for display

import { useState, useEffect, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../api'
import { roiFeature, roiFeatureCollection } from '../../lib/roiGeoJSON'
import { Spinner, ElapsedTimer } from '../../components/ui'
import ModelPickerCards from '../../components/ModelPickerCards'
import ModelParamRow from '../../components/ModelParamRow'
import ScopeOptionList from '../../components/ScopeOptionList'

// ── System class — reserved for ROI drawing ─────────────────────────────────
// Defined here as the single source of truth; imported by ClassPanel and index.jsx
export const AI_ROI_CLASS = {
  id:    '__ai_roi__',
  name:  'AI Model ROI',
  color: 'var(--purple-80)',
}

// ── Main component ───────────────────────────────────────────────────────────

export default function ProjectModelsPanel({
  catalog           = [],
  scanId,
  onAutoImport,          // async (jobId, importMode) => number (imported count)
  aiRoiAnnotations  = [],
  onSetActiveClass,      // (classObj) => void — activates AI_ROI_CLASS for drawing
  readOnly          = false,
}) {
  const [selectedModelId, setSelectedModelId] = useState(null)
  const [scope, setScope] = useState(aiRoiAnnotations.length > 0 ? 'roi' : 'whole_slide')
  // NOTE: preserved exactly as it was before this merge — importMode starts
  // as {} (an empty object), not a string. Neither radio button below shows
  // as pre-checked until the user clicks one. This predates this change; see
  // the accompanying message for why I left it as-is rather than "fixing" it.
  const [importMode,      setImportMode]      = useState({})
  const [modelParams,     setModelParams]     = useState({})
  const [activeJobId,     setActiveJobId]     = useState(null)
  // phase: null | 'submitting' | 'queued' | 'running' | 'importing' | 'done' | 'failed'
  const [phase,           setPhase]           = useState(null)
  const [importedCount,   setImportedCount]   = useState(0)
  const [error,           setError]           = useState('')

  const handledJobsRef = useRef(new Set())

  const prevRoiCount = useRef(aiRoiAnnotations.length)
  useEffect(() => {
    if (aiRoiAnnotations.length > 0 && prevRoiCount.current === 0) {
      setScope('roi')
    }
    prevRoiCount.current = aiRoiAnnotations.length
  }, [aiRoiAnnotations.length])

  const selectedModel = catalog.find(m => m.id === selectedModelId) ?? null

  useEffect(() => {
    if (!selectedModel) return
    const defaults = {}
    ;(selectedModel.params || []).forEach(p => { defaults[p.key] = p.default })
    setModelParams(defaults)
  }, [selectedModelId]) // eslint-disable-line

  useEffect(() => {
    setActiveJobId(null)
    setPhase(null)
    setError('')
    setImportedCount(0)
    handledJobsRef.current.clear()
  }, [scanId])

  const { data: jobs = [] } = useQuery({
    queryKey:       ['jobs', scanId],
    queryFn:        () => api.getAnalysisJobs(scanId),
    enabled:        !!scanId,
    refetchInterval: 5000,
  })

  useEffect(() => {
    if (!activeJobId && jobs.length > 0) {
      const latestActive = jobs.find(j => j.status === 'running' || j.status === 'queued')
      if (latestActive) setActiveJobId(latestActive.id)
    }
  }, [jobs, activeJobId])

  const activeJob = activeJobId ? (jobs.find(j => j.id === activeJobId) ?? null) : null

  useEffect(() => {
    if (!activeJob || handledJobsRef.current.has(activeJob.id)) return

    if (activeJob.status === 'running') {
      setPhase('running')
    } else if (activeJob.status === 'done') {
      handledJobsRef.current.add(activeJob.id)
      triggerAutoImport(activeJob)
    } else if (activeJob.status === 'failed' || activeJob.status === 'cancelled') {
      setPhase('failed')
      setError(activeJob.error_message || `Analysis ${activeJob.status}`)
      setActiveJobId(null)
    }
  }, [activeJob?.status, activeJob?.progress]) // eslint-disable-line

  async function triggerAutoImport(job) {
    setPhase('importing')
    setError('')
    try {
      const count = await onAutoImport(job.id, importMode)
      setImportedCount(count)
      setPhase('done')
    } catch (e) {
      setPhase('failed')
      setError(e.message || 'Auto-import failed after analysis completed')
    }
  }

  async function handleRun() {
    if (!selectedModelId || !scanId || readOnly) return
    setPhase('submitting')
    setError('')
    setImportedCount(0)

    try {
      const params = {}
      ;(selectedModel.params || []).forEach(p => {
        params[p.key] = modelParams[p.key] ?? p.default
      })

      const roi_json = (scope === 'roi' && aiRoiAnnotations.length > 0)
        ? buildRoiGeoJSON(aiRoiAnnotations)
        : null

      const job = await api.submitAnalysis(scanId, {
        model_id: selectedModelId,
        scope:    scope === 'roi' ? 'roi' : 'whole_slide',
        params,
        roi_json,
      })

      setActiveJobId(job.id)
      setPhase('queued')
    } catch (e) {
      setPhase('failed')
      setError(e.message || 'Submission failed')
    }
  }

  function handleReset() {
    setActiveJobId(null)
    setPhase(null)
    setError('')
    setImportedCount(0)
  }

  const isRunning = ['submitting', 'queued', 'running', 'importing'].includes(phase)
  const hasRoi    = aiRoiAnnotations.length > 0
  const canRun    = !!selectedModelId && !isRunning && !readOnly

  if (catalog.length === 0) {
    return (
      <div style={{ padding: 20, textAlign: 'center', fontSize: 12, color: 'var(--transparent-white-3)' }}>
        No models available.
      </div>
    )
  }

  return (
    <div style={{ padding: '10px 10px 16px', display: 'flex', flexDirection: 'column', gap: 14 }}>

      {readOnly && (
        <div style={{ fontSize: 10, color: 'var(--gray-blue)', background: 'var(--transparent-gray-blue-1)', border: '1px solid var(--transparent-gray-blue-2)', borderRadius: 5, padding: '6px 9px' }}>
          Read-only — analysis cannot be submitted.
        </div>
      )}

      <RoiHint
        count={aiRoiAnnotations.length}
        onActivate={() => onSetActiveClass?.(AI_ROI_CLASS)}
        readOnly={readOnly}
      />

      <ModelPickerCards
        catalog={catalog}
        scrollable={false}
        showHeader={false}
        expandedId={selectedModelId}
        onExpandedChange={id => setSelectedModelId(id === selectedModelId ? null : id)}
        statusFor={modelId => modelId === selectedModelId ? activeJob?.status : undefined}
      >
        {model => (
          <>
            <div style={{ marginBottom: 10 }}>
              <FieldLabel>Analysis scope</FieldLabel>
              <ScopeOptionList
                value={scope}
                onChange={setScope}
                options={[
                  { value: 'whole_slide', label: 'Whole slide', enabled: !isRunning },
                  {
                    value: 'roi',
                    label: 'AI Model ROI',
                    enabled: !isRunning && hasRoi,
                    desc: hasRoi
                      ? `${aiRoiAnnotations.length} region${aiRoiAnnotations.length > 1 ? 's' : ''} defined`
                      : 'No ROI annotations drawn yet — activate the class above',
                    descColor: hasRoi ? 'var(--purple-80)' : 'var(--transparent-white-3)',
                  },
                ]}
              />
            </div>

            {(model.params || []).length > 0 && (
              <div style={{ marginBottom: 10 }}>
                <FieldLabel>Parameters</FieldLabel>
                {model.params.map(param => (
                  <ModelParamRow
                    key={param.key}
                    param={param}
                    value={modelParams[param.key] ?? param.default}
                    disabled={isRunning}
                    onChange={val => setModelParams(p => ({ ...p, [param.key]: val }))}
                  />
                ))}
              </div>
            )}

            <div style={{ marginBottom: 10 }}>
              <FieldLabel>Class resolution</FieldLabel>
              {[
                { value: 'keep_all',   label: 'Keep all',            desc: 'Unmatched classes saved as Unclassified' },
                { value: 'match_only', label: 'Project classes only', desc: 'Discard unrecognised class names' },
              ].map(opt => (
                <label key={opt.value} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 7, cursor: isRunning ? 'default' : 'pointer' }}>
                  <input
                    type='radio' name='importMode' value={opt.value}
                    checked={importMode === opt.value} disabled={isRunning}
                    onChange={() => setImportMode(opt.value)}
                    style={{ accentColor: 'var(--viewer-teal)', marginTop: 2, flexShrink: 0 }}
                  />
                  <div>
                    <div style={{ fontSize: 12, color: 'var(--transparent-white-8)' }}>{opt.label}</div>
                    <div style={{ fontSize: 10, color: 'var(--transparent-white-3)', marginTop: 1, lineHeight: 1.4 }}>{opt.desc}</div>
                  </div>
                </label>
              ))}
            </div>

            {error && (
              <div style={{ fontSize: 10, color: 'var(--viewer-red)', background: 'var(--transparent-crimson-1)', border: '1px solid var(--transparent-crimson-2)', borderRadius: 5, padding: '6px 9px', lineHeight: 1.5, marginBottom: 10 }}>
                ⚠ {error}
              </div>
            )}

            <RunArea
              phase={phase}
              job={activeJob}
              importedCount={importedCount}
              canRun={canRun}
              onRun={handleRun}
              onReset={handleReset}
            />
          </>
        )}
      </ModelPickerCards>
    </div>
  )
}

// ── ROI GeoJSON builder ──────────────────────────────────────────────────────
// Handles polygon, brush (including with holes), and rectangle annotations

function buildRoiGeoJSON(annotations) {
  const features = annotations.flatMap((ann, i) => {
    const g = ann.geometry
    let rings = []

    if (ann.annotation_type === 'polygon' || ann.annotation_type === 'brush') {
      const pts = g.points || []
      rings = Array.isArray(pts[0]) ? pts : [pts]
    } else if (ann.annotation_type === 'rectangle') {
      rings = [[
        { x: g.x,           y: g.y },
        { x: g.x + g.width, y: g.y },
        { x: g.x + g.width, y: g.y + g.height },
        { x: g.x,           y: g.y + g.height },
      ]]
    }

    return rings
      .filter(ring => ring.length >= 3)
      .map((ring, ri) => roiFeature(ring, `ROI ${i + 1}.${ri + 1}`))
  })

  return roiFeatureCollection(features)
}

// ── Sub-components ───────────────────────────────────────────────────────────

function RoiHint({ count, onActivate, readOnly }) {
  return (
    <div style={{
      background: 'var(--transparent-purple-1)',
      border: '1px solid var(--transparent-purple-2)',
      borderRadius: 6, padding: '8px 10px',
      display: 'flex', alignItems: 'center', gap: 8,
    }}>
      <div style={{ width: 8, height: 8, borderRadius: 2, background: 'var(--purple-80)', flexShrink: 0 }} />
      <div style={{ flex: 1, fontSize: 10, color: 'var(--transparent-white-5)', lineHeight: 1.5 }}>
        Optionally draw{' '}
        <strong style={{ color: 'var(--purple-80)' }}>AI Model ROI</strong>{' '}
        annotations to restrict analysis to specific regions.
        {count > 0 && (
          <span style={{ color: 'var(--purple-80)', marginLeft: 4 }}>
            {count} region{count > 1 ? 's' : ''} ready.
          </span>
        )}
      </div>
      {!readOnly && (
        <button onClick={onActivate} style={{
          fontSize: 9, padding: '3px 7px', borderRadius: 3, cursor: 'pointer',
          flexShrink: 0, fontFamily: 'var(--font-sans)',
          background: 'var(--transparent-purple-1)',
          border: '1px solid var(--transparent-purple-3)',
          color: 'var(--purple-80)',
        }}>
          {count > 0 ? 'Edit' : 'Draw'}
        </button>
      )}
    </div>
  )
}

function FieldLabel({ children }) {
  return (
    <div style={{
      fontSize: 9, color: 'var(--transparent-white-3)',
      textTransform: 'uppercase', letterSpacing: '0.08em',
      fontWeight: 600, marginBottom: 6,
    }}>
      {children}
    </div>
  )
}

function RunArea({ phase, job, importedCount, canRun, onRun, onReset }) {
  if (phase === 'done') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
        <div style={{ fontSize: 12, color: 'var(--viewer-teal-light)', display: 'flex', alignItems: 'center', gap: 6 }}>
          <svg width='12' height='12' viewBox='0 0 16 16' fill='currentColor'>
            <path d='M13.854 3.646a.5.5 0 010 .708l-7 7a.5.5 0 01-.708 0l-3.5-3.5a.5.5 0 11.708-.708L6.5 10.293l6.646-6.647a.5.5 0 01.708 0z'/>
          </svg>
          {importedCount.toLocaleString()} annotation{importedCount !== 1 ? 's' : ''} imported
        </div>
        <button onClick={onReset} style={secondarySty}>Run again</button>
      </div>
    )
  }

  if (!phase || phase === 'failed') {
    return (
      <button onClick={onRun} disabled={!canRun} style={{
        width: '100%', padding: '8px 0', borderRadius: 6, border: 'none',
        background: canRun ? 'var(--viewer-teal)' : 'var(--transparent-white-0)',
        color: canRun ? 'white' : 'var(--transparent-white-2)',
        fontSize: 12, fontWeight: 600,
        cursor: canRun ? 'pointer' : 'not-allowed',
        fontFamily: 'var(--font-sans)',
        transition: 'background 0.15s',
      }}>
        ▶ Run Analysis
      </button>
    )
  }

  const phaseLabel = {
    submitting: 'Submitting…',
    queued:     'Queued — waiting for GPU…',
    running:    `Processing… ${job?.progress || 0}%`,
    importing:  'Importing annotations…',
  }[phase] || 'Working…'

  const barColor = phase === 'importing' ? 'var(--purple-80)' : 'var(--viewer-teal)'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 10, color: 'var(--transparent-white-5)' }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Spinner size={9} color={barColor} trackColor={barColor + '30'} />
          {phaseLabel}
        </span>
        {job && <ElapsedTimer since={job.created_at} />}
      </div>

      <div style={{ height: 3, background: 'var(--border-dark)', borderRadius: 2, overflow: 'hidden' }}>
        {phase === 'running' ? (
          <div style={{ height: '100%', background: barColor, borderRadius: 2, width: `${job?.progress || 0}%`, transition: 'width 0.5s' }} />
        ) : (
          <div style={{ height: '100%', background: barColor, borderRadius: 2, width: '100%', animation: 'pd-pulse 1.4s ease-in-out infinite' }} />
        )}
      </div>

      {job?.slurm_job_id && (
        <div style={{ fontSize: 9, color: 'var(--transparent-white-2)', fontFamily: 'var(--font-mono)' }}>
          SLURM #{job.slurm_job_id}
        </div>
      )}
    </div>
  )
}

const secondarySty = {
  width: '100%', padding: '6px 0', borderRadius: 5,
  background: 'transparent',
  border: '1px solid var(--transparent-teal-3)',
  color: 'var(--viewer-teal-light)', fontSize: 11,
  cursor: 'pointer', fontFamily: 'var(--font-sans)',
}