// frontend/src/pages/ProjectDetail/ProjectModelsPanel.jsx
//
// AI model submission panel for the ProjectDetail view.
// Renders inside the "AI" tab of ClassPanel.
// Responsibilities:
//   - Model selection, parameter configuration, scope selection
//   - Job submission and SLURM polling
//   - Delegates actual DB import to parent via onAutoImport callback
//   - Reports completion count back for display

import { useState, useEffect, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../api'
import { Spinner, ElapsedTimer } from '../../components/ui'

// ── System class — reserved for ROI drawing ────────────────────────────────────
// Defined here as the single source of truth; imported by ClassPanel and index.jsx
export const AI_ROI_CLASS = {
  id:    '__ai_roi__',
  name:  'AI Model ROI',
  color: '#a78bfa',   // violet-400
}

// ── Main component ─────────────────────────────────────────────────────────────

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
  const [importMode,      setImportMode]      = useState({})
  const [modelParams,     setModelParams]     = useState({})
  const [activeJobId,     setActiveJobId]     = useState(null)
  // phase: null | 'submitting' | 'queued' | 'running' | 'importing' | 'done' | 'failed'
  const [phase,           setPhase]           = useState(null)
  const [importedCount,   setImportedCount]   = useState(0)
  const [error,           setError]           = useState('')

  // Prevent double-importing the same job (React StrictMode / fast re-renders)
  const handledJobsRef = useRef(new Set())

  // Auto-switch to ROI scope the moment the user draws their very first ROI
  const prevRoiCount = useRef(aiRoiAnnotations.length)
  useEffect(() => {
    if (aiRoiAnnotations.length > 0 && prevRoiCount.current === 0) {
      setScope('roi')
    }
    prevRoiCount.current = aiRoiAnnotations.length
  }, [aiRoiAnnotations.length])

  const selectedModel = catalog.find(m => m.id === selectedModelId) ?? null

  // ── Reset param defaults when model changes ──────────────────────────────────
  useEffect(() => {
    if (!selectedModel) return
    const defaults = {}
    ;(selectedModel.params || []).forEach(p => { defaults[p.key] = p.default })
    setModelParams(defaults)
  }, [selectedModelId]) // eslint-disable-line

  // ── Reset UI when the active slide changes ───────────────────────────────────
  useEffect(() => {
    setActiveJobId(null)
    setPhase(null)
    setError('')
    setImportedCount(0)
    handledJobsRef.current.clear()
  }, [scanId])

  // ── Poll for job status ──────────────────────────────────────────────────────
  const { data: jobs = [] } = useQuery({
    queryKey:       ['jobs', scanId],
    queryFn:        () => api.getAnalysisJobs(scanId),
    enabled:        !!scanId, // Always poll if the panel is open
    refetchInterval: 5000,    // Keep polling to catch background completions
  })

  // Automatically latch onto the latest running/queued job if we don't have one active
  useEffect(() => {
    if (!activeJobId && jobs.length > 0) {
      const latestActive = jobs.find(j => j.status === 'running' || j.status === 'queued');
      if (latestActive) {
        setActiveJobId(latestActive.id);
      }
    }
  }, [jobs, activeJobId]);

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

  // ── Submit job ───────────────────────────────────────────────────────────────
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

  // ── Derived state ─────────────────────────────────────────────────────────────
  const isRunning = ['submitting', 'queued', 'running', 'importing'].includes(phase)
  const hasRoi    = aiRoiAnnotations.length > 0
  const canRun    = !!selectedModelId && !isRunning && !readOnly

  // ── Render ───────────────────────────────────────────────────────────────────
  if (catalog.length === 0) {
    return (
      <div style={{ padding: 20, textAlign: 'center', fontSize: 12, color: 'rgba(255,255,255,0.3)' }}>
        No models available.
      </div>
    )
  }

  return (
    <div style={{ padding: '10px 10px 16px', display: 'flex', flexDirection: 'column', gap: 14 }}>

      {readOnly && (
        <div style={{ fontSize: 10, color: '#94a3b8', background: 'rgba(148,163,184,0.08)', border: '1px solid rgba(148,163,184,0.15)', borderRadius: 5, padding: '6px 9px' }}>
          Read-only — analysis cannot be submitted.
        </div>
      )}

      {/* ── AI ROI hint ─────────────────────────────────────────────────────── */}
      <RoiHint
        count={aiRoiAnnotations.length}
        onActivate={() => onSetActiveClass?.(AI_ROI_CLASS)}
        readOnly={readOnly}
      />

      {/* ── Model selector ──────────────────────────────────────────────────── */}
      <div>
        <FieldLabel>Model</FieldLabel>
        <select
          value={selectedModelId || ''}
          disabled={isRunning}
          onChange={e => setSelectedModelId(e.target.value || null)}
          style={selectSty}
        >
          <option value='' style={{ background: '#111827', color: '#fff' }}>Select a model…</option>
          {catalog.map(m => (
            <option key={m.id} value={m.id} style={{ background: '#111827', color: '#fff' }}>{m.name}</option>
          ))}
        </select>
        {selectedModel && <ModelMeta model={selectedModel} />}
      </div>

      {selectedModel && (
        <>
          {/* ── Analysis scope ──────────────────────────────────────────────── */}
          <div>
            <FieldLabel>Analysis scope</FieldLabel>

            <ScopeButton
              active={scope === 'whole_slide'}
              disabled={isRunning}
              onClick={() => setScope('whole_slide')}
              label='Whole slide'
              desc={null}
            />

            <ScopeButton
              active={scope === 'roi'}
              disabled={isRunning || !hasRoi}
              onClick={() => hasRoi && setScope('roi')}
              label='AI Model ROI'
              desc={hasRoi
                ? `${aiRoiAnnotations.length} region${aiRoiAnnotations.length > 1 ? 's' : ''} defined`
                : 'No ROI annotations drawn yet — activate the class above'}
              descColor={hasRoi ? '#a78bfa' : 'rgba(255,255,255,0.28)'}
            />
          </div>

          {/* ── Model parameters ────────────────────────────────────────────── */}
          {(selectedModel.params || []).length > 0 && (
            <div>
              <FieldLabel>Parameters</FieldLabel>
              {selectedModel.params.map(param => (
                <ParamRow
                  key={param.key}
                  param={param}
                  value={modelParams[param.key] ?? param.default}
                  disabled={isRunning}
                  onChange={val => setModelParams(p => ({ ...p, [param.key]: val }))}
                />
              ))}
            </div>
          )}

          {/* ── Class resolution ────────────────────────────────────────────── */}
          <div>
            <FieldLabel>Class resolution</FieldLabel>
            {[
              { value: 'keep_all',   label: 'Keep all',             desc: 'Unmatched classes saved as Unclassified' },
              { value: 'match_only', label: 'Project classes only',  desc: 'Discard unrecognised class names' },
            ].map(opt => (
              <label key={opt.value} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 7, cursor: isRunning ? 'default' : 'pointer' }}>
                <input
                  type='radio' name='importMode' value={opt.value}
                  checked={importMode === opt.value} disabled={isRunning}
                  onChange={() => setImportMode(opt.value)}
                  style={{ accentColor: '#1b998b', marginTop: 2, flexShrink: 0 }}
                />
                <div>
                  <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.78)' }}>{opt.label}</div>
                  <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.33)', marginTop: 1, lineHeight: 1.4 }}>{opt.desc}</div>
                </div>
              </label>
            ))}
          </div>
        </>
      )}

      {/* ── Error message ────────────────────────────────────────────────────── */}
      {error && (
        <div style={{ fontSize: 10, color: '#ff8099', background: 'rgba(230,0,46,0.09)', border: '1px solid rgba(230,0,46,0.2)', borderRadius: 5, padding: '6px 9px', lineHeight: 1.5 }}>
          ⚠ {error}
        </div>
      )}

      {/* ── Run / status area ────────────────────────────────────────────────── */}
      <RunArea
        phase={phase}
        job={activeJob}
        importedCount={importedCount}
        canRun={canRun && !!selectedModelId}
        onRun={handleRun}
        onReset={handleReset}
      />
    </div>
  )
}

// ── ROI GeoJSON builder ────────────────────────────────────────────────────────
// Handles polygon, brush (including with holes), and rectangle annotations

function buildRoiGeoJSON(annotations) {
  const features = annotations.flatMap((ann, i) => {
    const g = ann.geometry
    let rings = []

    if (ann.annotation_type === 'polygon' || ann.annotation_type === 'brush') {
      const pts = g.points || []
      // Normalise: always work with array-of-rings
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
      .map((ring, ri) => ({
        type: 'Feature',
        properties: { name: `ROI ${i + 1}.${ri + 1}`, classification: { name: 'user_roi' } },
        geometry: {
          type: 'Polygon',
          coordinates: [
            [...ring.map(p => [Math.round(p.x), Math.round(p.y)]),
             [Math.round(ring[0].x), Math.round(ring[0].y)]],
          ],
        },
      }))
  })

  return { type: 'FeatureCollection', features }
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function RoiHint({ count, onActivate, readOnly }) {
  return (
    <div style={{
      background: 'rgba(167,139,250,0.07)',
      border: '1px solid rgba(167,139,250,0.2)',
      borderRadius: 6, padding: '8px 10px',
      display: 'flex', alignItems: 'center', gap: 8,
    }}>
      <div style={{ width: 8, height: 8, borderRadius: 2, background: '#a78bfa', flexShrink: 0 }} />
      <div style={{ flex: 1, fontSize: 10, color: 'rgba(255,255,255,0.48)', lineHeight: 1.5 }}>
        Optionally draw{' '}
        <strong style={{ color: '#a78bfa' }}>AI Model ROI</strong>{' '}
        annotations to restrict analysis to specific regions.
        {count > 0 && (
          <span style={{ color: '#a78bfa', marginLeft: 4 }}>
            {count} region{count > 1 ? 's' : ''} ready.
          </span>
        )}
      </div>
      {!readOnly && (
        <button onClick={onActivate} style={{
          fontSize: 9, padding: '3px 7px', borderRadius: 3, cursor: 'pointer',
          flexShrink: 0, fontFamily: 'sans-serif',
          background: 'rgba(167,139,250,0.14)',
          border: '1px solid rgba(167,139,250,0.28)',
          color: '#a78bfa',
        }}>
          {count > 0 ? 'Edit' : 'Draw'}
        </button>
      )}
    </div>
  )
}

function ModelMeta({ model }) {
  return (
    <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginTop: 5 }}>
      <Chip>~{model.estimated_minutes} min</Chip>
      {(model.stain_compatibility || []).map(s => <Chip key={s}>{s}</Chip>)}
      <Chip>{model.category}</Chip>
    </div>
  )
}

function Chip({ children }) {
  return (
    <span style={{
      fontSize: 9, padding: '2px 6px', borderRadius: 3,
      background: 'rgba(255,255,255,0.05)',
      color: 'rgba(255,255,255,0.42)',
      border: '1px solid rgba(255,255,255,0.08)',
    }}>
      {children}
    </span>
  )
}

function ScopeButton({ active, disabled, onClick, label, desc, descColor }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        width: '100%', display: 'flex', alignItems: 'flex-start', gap: 9,
        padding: '7px 10px', borderRadius: 5, marginBottom: 5,
        background: active ? 'rgba(27,153,139,0.11)' : 'rgba(255,255,255,0.02)',
        border: `1px solid ${active ? 'rgba(27,153,139,0.38)' : 'rgba(255,255,255,0.08)'}`,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.42 : 1,
        textAlign: 'left', fontFamily: 'sans-serif',
        transition: 'all 0.12s',
      }}
    >
      <div style={{
        width: 7, height: 7, borderRadius: '50%', flexShrink: 0, marginTop: 4,
        background: active ? '#6ee7b7' : 'rgba(255,255,255,0.2)',
        transition: 'background 0.12s',
      }} />
      <div>
        <div style={{ fontSize: 12, color: active ? '#6ee7b7' : 'rgba(255,255,255,0.72)' }}>
          {label}
        </div>
        {desc && (
          <div style={{ fontSize: 10, color: descColor || 'rgba(255,255,255,0.32)', marginTop: 1, lineHeight: 1.4 }}>
            {desc}
          </div>
        )}
      </div>
    </button>
  )
}

function ParamRow({ param, value, onChange, disabled }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
        <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.43)' }}>{param.label}</span>
        <span style={{ fontSize: 10, fontFamily: 'monospace', color: 'rgba(255,255,255,0.62)' }}>
          {param.type === 'float' ? parseFloat(value).toFixed(2) : value}
        </span>
      </div>
      {param.options ? (
        <div style={{ display: 'flex', gap: 3 }}>
          {param.options.map(opt => (
            <button
              key={opt}
              disabled={disabled}
              onClick={() => onChange(opt)}
              style={{
                flex: 1, fontSize: 10, padding: '3px 0', borderRadius: 3,
                cursor: disabled ? 'default' : 'pointer', fontFamily: 'sans-serif',
                border: `1px solid ${value === opt ? 'rgba(27,153,139,0.4)' : 'rgba(255,255,255,0.09)'}`,
                background: value === opt ? 'rgba(27,153,139,0.14)' : 'transparent',
                color: value === opt ? '#6ee7b7' : 'rgba(255,255,255,0.38)',
              }}
            >
              {opt}
            </button>
          ))}
        </div>
      ) : (
        <input
          type='range' min={param.min} max={param.max} step={param.step || 1}
          value={value} disabled={disabled}
          onChange={e => onChange(param.type === 'float' ? parseFloat(e.target.value) : parseInt(e.target.value))}
          style={{ width: '100%', accentColor: '#1b998b', cursor: disabled ? 'default' : 'pointer' }}
        />
      )}
    </div>
  )
}

function RunArea({ phase, job, importedCount, canRun, onRun, onReset }) {
  if (phase === 'done') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
        <div style={{ fontSize: 12, color: '#6ee7b7', display: 'flex', alignItems: 'center', gap: 6 }}>
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
        background: canRun ? '#1b998b' : 'rgba(255,255,255,0.05)',
        color: canRun ? 'white' : 'rgba(255,255,255,0.2)',
        fontSize: 12, fontWeight: 600,
        cursor: canRun ? 'pointer' : 'not-allowed',
        fontFamily: 'sans-serif',
        transition: 'background 0.15s',
      }}>
        ▶ Run Analysis
      </button>
    )
  }

  // Active phases
  const phaseLabel = {
    submitting: 'Submitting…',
    queued:     'Queued — waiting for GPU…',
    running:    `Processing… ${job?.progress || 0}%`,
    importing:  'Importing annotations…',
  }[phase] || 'Working…'

  const barColor = phase === 'importing' ? '#a78bfa' : '#1b998b'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 10, color: 'rgba(255,255,255,0.48)' }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Spinner size={9} color={barColor} trackColor={barColor + '30'} />
          {phaseLabel}
        </span>
        {job && <ElapsedTimer since={job.created_at} />}
      </div>

      <div style={{ height: 3, background: 'rgba(255,255,255,0.07)', borderRadius: 2, overflow: 'hidden' }}>
        {phase === 'running' ? (
          <div style={{ height: '100%', background: barColor, borderRadius: 2, width: `${job?.progress || 0}%`, transition: 'width 0.5s' }} />
        ) : (
          <div style={{ height: '100%', background: barColor, borderRadius: 2, width: '100%', animation: 'pd-pulse 1.4s ease-in-out infinite' }} />
        )}
      </div>

      {job?.slurm_job_id && (
        <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.22)', fontFamily: 'monospace' }}>
          SLURM #{job.slurm_job_id}
        </div>
      )}
    </div>
  )
}

function FieldLabel({ children }) {
  return (
    <div style={{
      fontSize: 9, color: 'rgba(255,255,255,0.33)',
      textTransform: 'uppercase', letterSpacing: '0.08em',
      fontWeight: 600, marginBottom: 6,
    }}>
      {children}
    </div>
  )
}

// ── Style tokens ──────────────────────────────────────────────────────────────

const selectSty = {
  width: '100%', background: 'rgba(255,255,255,0.05)',
  color: 'rgba(255,255,255,0.8)',
  border: '1px solid rgba(255,255,255,0.11)',
  borderRadius: 5, padding: '6px 8px',
  fontSize: 12, outline: 'none',
  cursor: 'pointer', fontFamily: 'sans-serif',
}

const secondarySty = {
  width: '100%', padding: '6px 0', borderRadius: 5,
  background: 'transparent',
  border: '1px solid rgba(27,153,139,0.3)',
  color: '#6ee7b7', fontSize: 11,
  cursor: 'pointer', fontFamily: 'sans-serif',
}