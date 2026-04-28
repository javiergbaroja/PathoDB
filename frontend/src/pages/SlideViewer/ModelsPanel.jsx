// frontend/src/pages/SlideViewer/ModelsPanel.jsx
import { useState, useEffect } from 'react'
import { api } from '../../api'
import JobOutcomeDispatcher from '../../components/AnalysisOutcomes/JobOutcomeDispatcher'
import { CATEGORY_COLORS } from '../../constants/viewer'

export default function ModelsPanel({ catalog, scanId, scanInfo, jobs, activeOverlays, setActiveOverlays, onJobsChange, onToggleOverlay }) {
  const [expandedId,  setExpandedId]  = useState(null)
  const [categoryTab, setCategoryTab] = useState('All')
  const [submitting,  setSubmitting]  = useState(false)
  const [submitError, setSubmitError] = useState('')

  const [modelScope,  setModelScope]  = useState({})
  const [modelParams, setModelParams] = useState({})

  const categories = ['All', ...Array.from(new Set(catalog.map(m => m.category)))]
  const visible = categoryTab === 'All' ? catalog : catalog.filter(m => m.category === categoryTab)

  function scopeFor(id)  { return modelScope[id]  || 'whole_slide' }
  function paramsFor(id) { return modelParams[id]  || {} }

  function setScope(id, val)       { setModelScope(s  => ({ ...s, [id]: val })) }
  function setParam(id, key, val)  { setModelParams(p => ({ ...p, [id]: { ...paramsFor(id), [key]: val } })) }

  function jobsForModel(modelId) {
    return jobs.filter(j => j.model_id === modelId).sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
  }

  function latestJob(modelId) { return jobsForModel(modelId)[0] || null }

  async function handleRun(model) {
    if (!scanId) return
    setSubmitting(true)
    setSubmitError('')
    try {
      const params = {}
      ;(model.params || []).forEach(p => { params[p.key] = paramsFor(model.id)[p.key] ?? p.default })
      const job = await api.submitAnalysis(scanId, { model_id: model.id, scope: scopeFor(model.id), params })
      onJobsChange(prev => [job, ...prev])
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
    if (!window.confirm('Are you sure you want to permanently delete this run and all its files?')) return
    try {
      if (activeOverlays[job.id]) onToggleOverlay(job.id, job.model_id)
      await api.deleteAnalysis(job.id)
      onJobsChange(prev => prev.filter(j => j.id !== job.id))
    } catch (e) {
      alert(`Failed to delete job: ${e.message}`)
    }
  }

  const overlayJobs = jobs.filter(j => j.status === 'done' && activeOverlays[j.id])
  const runningCount = jobs.filter(j => j.status === 'queued' || j.status === 'running').length

  return (
    <div style={{ width: 296, flexShrink: 0, background: 'rgba(2,5,18,0.98)', borderLeft: '1px solid rgba(255,255,255,0.07)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ padding: '9px 12px', borderBottom: '1px solid rgba(255,255,255,0.05)', display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.50)', textTransform: 'uppercase', letterSpacing: '0.1em', fontWeight: 600, flex: 1 }}>Analysis models</span>
        {runningCount > 0 && <span style={{ fontSize: 9, color: '#fbbf24', background: 'rgba(251,191,36,0.12)', padding: '2px 7px', borderRadius: 3, fontWeight: 600 }}>{runningCount} running</span>}
      </div>

      <div style={{ display: 'flex', gap: 4, padding: '6px 10px', flexShrink: 0, overflowX: 'auto' }}>
        {categories.map(cat => (
          <button key={cat} onClick={() => setCategoryTab(cat)} style={{ fontSize: 10, padding: '3px 9px', borderRadius: 20, cursor: 'pointer', whiteSpace: 'nowrap', background: categoryTab === cat ? 'rgba(27,153,139,0.18)' : 'rgba(255,255,255,0.04)', border: `1px solid ${categoryTab === cat ? 'rgba(27,153,139,0.4)' : 'rgba(255,255,255,0.08)'}`, color: categoryTab === cat ? '#6ee7b7' : 'rgba(255,255,255,0.40)' }}>{cat}</button>
        ))}
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '0 8px' }}>
        {submitError && <div style={{ margin: '4px 2px 6px', padding: '6px 8px', background: 'rgba(230,0,46,0.12)', border: '1px solid rgba(230,0,46,0.25)', borderRadius: 5, fontSize: 10, color: '#ff8099' }}>{submitError}</div>}
        {visible.map(model => {
          const latest  = latestJob(model.id)
          const isOpen  = expandedId === model.id
          const catColor = CATEGORY_COLORS[model.category] || CATEGORY_COLORS.other

          return (
            <div key={model.id} style={{ border: `1px solid ${isOpen ? 'rgba(27,153,139,0.35)' : 'rgba(255,255,255,0.07)'}`, borderRadius: 7, marginBottom: 6, overflow: 'hidden', transition: 'border-color 0.15s' }}>
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

              {isOpen && (
                <div style={{ borderTop: '1px solid rgba(255,255,255,0.05)', padding: '10px 10px 12px' }}>
                  <p style={{ fontSize: 11, color: 'rgba(255,255,255,0.55)', lineHeight: 1.55, margin: '0 0 10px' }}>{model.description}</p>
                  <div style={{ display: 'flex', gap: 4, marginBottom: 10 }}>
                    {(model.stain_compatibility || []).map(s => <span key={s} style={{ fontSize: 9, padding: '2px 6px', borderRadius: 3, background: 'rgba(255,255,255,0.06)', color: 'rgba(255,255,255,0.50)', border: '1px solid rgba(255,255,255,0.1)' }}>{s}</span>)}
                  </div>
                  {(model.params || []).map(param => <ParamRow key={param.key} param={param} value={paramsFor(model.id)[param.key] ?? param.default} onChange={val => setParam(model.id, param.key, val)} />)}
                  
                  <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.45)', margin: '8px 0 5px' }}>Analysis scope</div>
                  <div style={{ display: 'flex', gap: 5, marginBottom: 10 }}>
                    {[['whole_slide', 'Whole slide'], ['visible_region', 'Visible region']].map(([val, lbl]) => (
                      <button key={val} onClick={() => setScope(model.id, val)} style={{ flex: 1, fontSize: 10, padding: '4px 0', borderRadius: 4, cursor: 'pointer', border: `1px solid ${scopeFor(model.id) === val ? 'rgba(27,153,139,0.4)' : 'rgba(255,255,255,0.1)'}`, background: scopeFor(model.id) === val ? 'rgba(27,153,139,0.15)' : 'transparent', color: scopeFor(model.id) === val ? '#6ee7b7' : 'rgba(255,255,255,0.40)' }}>{lbl}</button>
                    ))}
                  </div>

                  <ModelRunArea latest={latest} model={model} submitting={submitting} scanInfo={scanInfo} onRun={() => handleRun(model)} onCancel={() => handleCancel(latest)} />
                  <PastJobsList jobs={jobsForModel(model.id)} catalog={catalog} activeOverlays={activeOverlays} onToggleOverlay={onToggleOverlay} onDeleteJob={handleDelete} />
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

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
  return <span style={{ fontSize: 9, padding: '2px 6px', borderRadius: 3, fontWeight: 500, background: s.bg, color: s.color }}>{s.label}</span>
}

function ParamRow({ param, value, onChange }) {
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
        <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.45)' }}>{param.label}</span>
        <span style={{ fontSize: 10, fontFamily: 'monospace', color: 'rgba(255,255,255,0.65)' }}>{param.type === 'float' ? parseFloat(value).toFixed(2) : value}</span>
      </div>
      {param.options ? (
        <div style={{ display: 'flex', gap: 4 }}>
          {param.options.map(opt => <button key={opt} onClick={() => onChange(opt)} style={{ flex: 1, fontSize: 10, padding: '3px 0', borderRadius: 3, cursor: 'pointer', border: `1px solid ${value === opt ? 'rgba(27,153,139,0.4)' : 'rgba(255,255,255,0.1)'}`, background: value === opt ? 'rgba(27,153,139,0.15)' : 'transparent', color: value === opt ? '#6ee7b7' : 'rgba(255,255,255,0.40)' }}>{opt}</button>)}
        </div>
      ) : <input type="range" min={param.min} max={param.max} step={param.step || 1} value={value} onChange={e => onChange(param.type === 'float' ? parseFloat(e.target.value) : parseInt(e.target.value))} style={{ width: '100%', accentColor: '#1b998b', cursor: 'pointer' }} /> }
    </div>
  )
}

function ModelRunArea({ latest, model, submitting, scanInfo, onRun, onCancel }) {
  const stainOk = !model.stain_compatibility?.length || model.stain_compatibility.includes(scanInfo?.stain_category)
  if (latest && (latest.status === 'queued' || latest.status === 'running')) {
    return (
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'rgba(255,255,255,0.50)', marginBottom: 4 }}><span>SLURM #{latest.slurm_job_id || '—'}</span><ElapsedTimer since={latest.created_at} /></div>
        <div style={{ height: 2, background: 'rgba(255,255,255,0.06)', borderRadius: 1, marginBottom: 5, overflow: 'hidden' }}><div style={{ height: '100%', background: '#1b998b', borderRadius: 1, width: `${latest.progress || 0}%`, transition: 'width 0.5s' }} /></div>
        <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.35)', marginBottom: 8 }}>{latest.status === 'queued' ? 'Waiting in queue…' : `Processing… ${latest.progress || 0}%`}</div>
        <button onClick={onCancel} style={{ width: '100%', padding: '6px 0', borderRadius: 5, border: '1px solid rgba(255,255,255,0.12)', background: 'rgba(255,255,255,0.04)', color: 'rgba(255,255,255,0.40)', fontSize: 11, cursor: 'pointer' }}>Cancel job</button>
      </div>
    )
  }
  if (latest?.status === 'done') return <div><div style={{ fontSize: 10, color: '#6ee7b7', marginBottom: 8 }}>✓ Analysis complete</div><button onClick={onRun} disabled={submitting} style={{ width: '100%', padding: '6px 0', borderRadius: 5, border: 'none', background: 'rgba(27,153,139,0.15)', color: '#6ee7b7', fontSize: 11, cursor: 'pointer', marginBottom: 4 }}>Run again →</button></div>
  return <div>{!stainOk && <div style={{ fontSize: 10, color: '#fbbf24', marginBottom: 6 }}>⚠ Current stain may not match — expects {model.stain_compatibility?.join(', ')}</div>}<button onClick={onRun} disabled={submitting} style={{ width: '100%', padding: '7px 0', borderRadius: 5, border: 'none', background: submitting ? 'rgba(255,255,255,0.06)' : '#1b998b', color: submitting ? 'rgba(255,255,255,0.30)' : 'white', fontSize: 12, fontWeight: 500, cursor: submitting ? 'default' : 'pointer' }}>{submitting ? 'Submitting…' : 'Run on GPU →'}</button></div>
}

function PastJobsList({ jobs, catalog, activeOverlays, onToggleOverlay, onDeleteJob }) {
  const past = jobs.filter(j => j.status === 'done' || j.status === 'failed' || j.status === 'cancelled')
  if (!past.length) return null
  return (
    <div style={{ marginTop: 10, borderTop: '1px solid rgba(255,255,255,0.05)', paddingTop: 8 }}>
      <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.35)', textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 600, marginBottom: 5 }}>Previous runs</div>
      {past.map(job => {
        const model = catalog.find(m => m.id === job.model_id)
        return (
          <div key={job.id} style={{ marginBottom: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
              <StatusBadge job={job} />
              <span style={{ flex: 1, fontSize: 10, color: 'rgba(255,255,255,0.40)' }}>{new Date(job.created_at).toLocaleDateString()}</span>
              <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                {job.status === 'done' && <button onClick={() => onToggleOverlay(job.id)} style={{ fontSize: 10, padding: '2px 8px', borderRadius: 3, cursor: 'pointer', border: `1px solid ${activeOverlays[job.id] ? 'rgba(230,0,46,0.25)' : 'rgba(27,153,139,0.25)'}`, background: activeOverlays[job.id] ? 'rgba(230,0,46,0.1)' : 'rgba(27,153,139,0.1)', color: activeOverlays[job.id] ? '#ff8099' : '#6ee7b7' }}>{activeOverlays[job.id] ? 'Hide' : 'View'}</button>}
                {job.status === 'failed' && job.error_message && <span title={job.error_message} style={{ fontSize: 10, color: '#ff8099', cursor: 'help', padding: '0 4px' }}>ⓘ</span>}
                <button onClick={() => onDeleteJob(job)} title="Delete run and files" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 22, height: 22, borderRadius: 3, background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.4)', cursor: 'pointer' }}>✕</button>
              </div>
            </div>
            {job.status === 'done' && <JobOutcomeDispatcher jobId={job.id} model={model} />}
          </div>
        )
      })}
    </div>
  )
}

function ElapsedTimer({ since }) {
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    const start = new Date(since).getTime()
    const tick = () => setElapsed(Math.floor((Date.now() - start) / 1000))
    tick(); const id = setInterval(tick, 1000); return () => clearInterval(id)
  }, [since])
  return <span>{Math.floor(elapsed / 60)}m {String(elapsed % 60).padStart(2, '0')}s</span>
}