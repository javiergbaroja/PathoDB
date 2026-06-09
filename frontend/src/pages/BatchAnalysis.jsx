import { useState, useCallback } from 'react'
import { useQuery, useMutation } from '@tanstack/react-query'
import Layout from '../components/Layout'
import { Btn, SpinnerPage, ErrorMsg, FormField, FormInput, FormSelect, FormLabel, SectionHeader } from '../components/ui'
import { api } from '../api'
import SlideTargetManager from '../components/SlideTargetManager'
import DirectoryBrowser from '../components/DirectoryBrowser'

// \\resstore.unibe.ch\X\Y  →  /storage/research/X/Y
function convertToHPCPath(raw) {
  if (!raw) return raw
  const normalized = raw.trim().replace(/\\/g, '/')
  const m = normalized.match(/^\/\/resstore\.unibe\.ch\/(.+)/i)
  if (m) return '/storage/research/' + m[1].replace(/\/$/, '')
  return normalized
}

const FolderIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" style={{ display: 'block' }}>
    <path d="M.54 3.87.5 3a2 2 0 0 1 2-2h3.19a2 2 0 0 1 1.345.51l.33.33A1 1 0 0 0 8.5 2H14a2 2 0 0 1 2 2v8.5a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2V3.87a2 2 0 0 1 .54-1.37zM2 14h12a1 1 0 0 0 1-1V6H1v7a1 1 0 0 0 1 1z"/>
  </svg>
)

// ── Param row ────────────────────────────────────────────────────────────────
function ParamRow({ param, value, onChange }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-2)' }}>{param.label}</span>
        <span style={{ fontSize: 13, fontFamily: 'var(--font-mono)', color: 'var(--navy)', background: 'var(--navy-05)', padding: '2px 6px', borderRadius: 'var(--radius-sm)' }}>
          {param.type === 'float' ? parseFloat(value).toFixed(2) : value}
        </span>
      </div>
      {param.options ? (
        <div style={{ display: 'flex', gap: 6 }}>
          {param.options.map(opt => (
            <button
              key={opt}
              onClick={() => onChange(opt)}
              style={{
                flex: 1, fontSize: 12, padding: '6px 0', borderRadius: 'var(--radius-md)', cursor: 'pointer',
                border: `1px solid ${value === opt ? 'rgba(27,153,139,0.4)' : 'var(--border-l)'}`,
                background: value === opt ? 'rgba(27,153,139,0.1)' : 'var(--white)',
                color: value === opt ? 'var(--teal)' : 'var(--text-3)',
                fontWeight: value === opt ? 600 : 400,
                transition: 'var(--transition-base)',
              }}
            >
              {opt}
            </button>
          ))}
        </div>
      ) : (
        <input
          type="range"
          min={param.min}
          max={param.max}
          step={param.step || 1}
          value={value}
          onChange={e => onChange(param.type === 'float' ? parseFloat(e.target.value) : parseInt(e.target.value))}
          style={{ width: '100%', accentColor: 'var(--teal)', cursor: 'pointer' }}
        />
      )}
    </div>
  )
}

// ── Main Page ────────────────────────────────────────────────────────────────
export default function BatchAnalysis() {
  const [selectedModelId,   setSelectedModelId]   = useState('')
  const [modelParams,       setModelParams]        = useState({})
  const [rawOutputDir,      setRawOutputDir]       = useState('')
  const [saveVisualization, setSaveVisualization]  = useState(false)
  const [filteredTargets,   setFilteredTargets]    = useState([])
  const [errorMsg,          setErrorMsg]           = useState('')
  const [successMsg,        setSuccessMsg]         = useState('')
  const outputDir      = convertToHPCPath(rawOutputDir)
  const outputDirError = rawOutputDir.trim() !== '' && !outputDir.startsWith('/storage/research/')
    ? 'Path must point to the research storage (\\\\resstore.unibe.ch\\… or /storage/research/…)'
    : ''

  const [browserOpen, setBrowserOpen] = useState(false)

  const { data: catalog, isLoading: modelsLoading } = useQuery({
    queryKey: ['models'],
    queryFn:  () => api.getModels(),
  })

  const { data: cohorts = [] } = useQuery({
    queryKey: ['cohorts'],
    queryFn:  () => api.getCohorts(),
  })

  const batchModels = catalog?.models?.filter(m => m.supports_batch) || []
  const selectedModelDef = batchModels.find(m => m.id === selectedModelId)

  const handleModelSelect = (e) => {
    const mId = e.target.value
    setSelectedModelId(mId)
    const selected = batchModels.find(m => m.id === mId)
    const initialParams = {}
    if (selected?.params) {
      selected.params.forEach(p => { initialParams[p.key] = p.default })
    }
    setModelParams(initialParams)
  }

  const handleParamChange = useCallback((key, value) => {
    setModelParams(prev => ({ ...prev, [key]: value }))
  }, [])

  const submitMutation = useMutation({
    mutationFn: async (payload) => await api.submitBatchAnalysis(payload),
    onSuccess: (data) => {
      setSuccessMsg(`Success! Batch job #${data.id} submitted to SLURM.`)
      setFilteredTargets([])
    },
    onError: (err) => setErrorMsg(err.message || 'Failed to submit batch job.'),
  })

  const handleSubmit = () => {
    if (!filteredTargets.length) return
    const payload = {
      model_id:         selectedModelId,
      output_directory: outputDir,
      scan_ids:         filteredTargets.map(m => m.scan_id),
      params:           { ...modelParams, save_visualization: saveVisualization },
    }
    submitMutation.mutate(payload)
  }

  if (modelsLoading) return <SpinnerPage />

  const isSubmitting = submitMutation.isLoading || submitMutation.isPending

  return (
    <Layout title="Batch Analysis">
      <div style={{ height: '100%', padding: '20px 24px', maxWidth: 900, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 24, overflowY: 'auto' }}>

        {errorMsg  && <ErrorMsg message={errorMsg}  onDismiss={() => setErrorMsg('')} />}
        {successMsg && (
          <div style={{ padding: 16, background: 'rgba(27,153,139,0.12)', color: 'var(--teal)', borderRadius: 'var(--radius-lg)', border: '1px solid var(--teal-light)', fontWeight: 600 }}>
            {successMsg}
          </div>
        )}

        {/* STEP 1: Configuration */}
        <div style={{ background: 'var(--white)', borderRadius: 'var(--radius-xl)', padding: 24, border: '1px solid var(--border-l)', boxShadow: 'var(--shadow-s)' }}>
          <SectionHeader title="1. Configuration" />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <FormField label="Select Model">
                <FormSelect value={selectedModelId} onChange={handleModelSelect}>
                  <option value="" disabled>-- Choose an AI Model --</option>
                  {batchModels.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                </FormSelect>
                {selectedModelDef?.stain_compatibility && (
                  <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 4 }}>
                    Requires stains: <span style={{ fontWeight: 600 }}>{selectedModelDef.stain_compatibility.join(', ')}</span>
                  </div>
                )}
              </FormField>

              <FormField label="Output Directory" error={outputDirError}>
                <div style={{ display: 'flex', gap: 8 }}>
                  <FormInput
                    type="text"
                    placeholder="/storage/research/… or \\resstore.unibe.ch\…"
                    value={rawOutputDir}
                    onChange={e => setRawOutputDir(e.target.value)}
                    style={{ flex: 1 }}
                  />
                  <Btn
                    variant="ghost"
                    small
                    onClick={() => setBrowserOpen(true)}
                    icon={<FolderIcon />}
                    title="Browse server storage"
                  >
                    Browse
                  </Btn>
                </div>
                <DirectoryBrowser
                  isOpen={browserOpen}
                  onClose={() => setBrowserOpen(false)}
                  onSelect={(path) => setRawOutputDir(path)}
                />
              </FormField>

              {/* Visualization toggle */}
              <button
                type="button"
                onClick={() => setSaveVisualization(v => !v)}
                style={{
                  display: 'flex', alignItems: 'flex-start', gap: 12,
                  background: saveVisualization ? 'rgba(27,153,139,0.07)' : 'var(--navy-05)',
                  border: `1px solid ${saveVisualization ? 'rgba(27,153,139,0.35)' : 'var(--border-l)'}`,
                  borderRadius: 'var(--radius-lg)', padding: '12px 14px',
                  cursor: 'pointer', textAlign: 'left', transition: 'var(--transition-base)', width: '100%',
                }}
              >
                {/* Toggle pill */}
                <div style={{
                  position: 'relative', width: 36, height: 20, borderRadius: 10, flexShrink: 0, marginTop: 1,
                  background: saveVisualization ? 'var(--teal)' : 'var(--border)',
                  transition: 'background 0.2s',
                }}>
                  <div style={{
                    position: 'absolute', top: 3, left: saveVisualization ? 19 : 3,
                    width: 14, height: 14, borderRadius: '50%', background: 'white',
                    transition: 'left 0.2s', boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
                  }} />
                </div>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: saveVisualization ? 'var(--teal)' : 'var(--text-2)', marginBottom: 2 }}>
                    Save visualization overlays
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-3)', lineHeight: 1.5 }}>
                    {saveVisualization
                      ? 'Overlay images will be generated and saved alongside your results. Jobs will be trackable from the slide viewer with live progress.'
                      : 'Only downloadable result files are saved. Faster processing and less disk space. Track progress in the Job Tracker.'}
                  </div>
                </div>
              </button>
            </div>

            <div style={{ background: 'var(--navy-05)', padding: 16, borderRadius: 'var(--radius-lg)', border: '1px solid var(--border-l)' }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-2)', marginBottom: 16, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                Model Parameters
              </div>
              {!selectedModelId ? (
                <div style={{ fontSize: 13, color: 'var(--text-3)', fontStyle: 'italic' }}>
                  Select a model to configure its parameters.
                </div>
              ) : selectedModelDef?.params?.length > 0 ? (
                selectedModelDef.params.map(param => (
                  <ParamRow
                    key={param.key}
                    param={param}
                    value={modelParams[param.key] ?? param.default}
                    onChange={val => handleParamChange(param.key, val)}
                  />
                ))
              ) : (
                <div style={{ fontSize: 13, color: 'var(--text-3)' }}>
                  This model requires no additional configuration.
                </div>
              )}
            </div>
          </div>
        </div>

        {/* STEP 2: Target Slides */}
        <div style={{ background: 'var(--white)', borderRadius: 'var(--radius-xl)', padding: 24, border: '1px solid var(--border-l)', boxShadow: 'var(--shadow-s)' }}>
          <SectionHeader title="2. Target Slides" />
          <SlideTargetManager
            cohorts={cohorts}
            requiredStains={selectedModelDef?.stain_compatibility || []}
            onTargetsResolved={setFilteredTargets}
          />
        </div>

        {/* STEP 3: Submit */}
        {filteredTargets.length > 0 && (
          <div style={{ background: 'var(--white)', borderRadius: 'var(--radius-xl)', padding: 24, border: '1px solid var(--border-l)', boxShadow: 'var(--shadow-s)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 13, color: 'var(--text-3)' }}>
                Ready to submit <strong>{filteredTargets.length}</strong> slides to SLURM.
              </span>
              <Btn
                variant="primary"
                onClick={handleSubmit}
                disabled={isSubmitting || !selectedModelId || !outputDir || !!outputDirError}
              >
                {isSubmitting ? 'Submitting...' : 'Submit Batch Job'}
              </Btn>
            </div>
          </div>
        )}

      </div>
    </Layout>
  )
}