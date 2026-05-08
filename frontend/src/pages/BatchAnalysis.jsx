import { useState, useEffect } from 'react'
import { useQuery, useMutation } from '@tanstack/react-query'
import Layout from '../components/Layout'
import { Btn, SpinnerPage, Spinner, ErrorMsg } from '../components/ui'
import { api } from '../api'
import SlideTargetManager from '../components/SlideTargetManager'

// ── Param row ────────────────────────────────────────────────────────────────
function ParamRow({ param, value, onChange }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-2)' }}>{param.label}</span>
        <span style={{ fontSize: 13, fontFamily: 'monospace', color: 'var(--navy)', background: 'var(--navy-05)', padding: '2px 6px', borderRadius: 4 }}>
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
                flex: 1, fontSize: 12, padding: '6px 0', borderRadius: 5, cursor: 'pointer', 
                border: `1px solid ${value === opt ? 'rgba(27,153,139,0.4)' : 'var(--border-l)'}`, 
                background: value === opt ? 'rgba(27,153,139,0.1)' : 'white', 
                color: value === opt ? '#1b998b' : 'var(--text-3)',
                fontWeight: value === opt ? 600 : 400,
                transition: 'all 0.15s'
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
          style={{ width: '100%', accentColor: '#1b998b', cursor: 'pointer' }} 
        />
      )}
    </div>
  )
}

// ── Main Page ────────────────────────────────────────────────────────────────
export default function BatchAnalysis() {
  const [selectedModelId, setSelectedModelId] = useState('')
  const [modelParams, setModelParams]         = useState({})
  const [outputDir, setOutputDir]             = useState('')
  
  const [filteredTargets, setFilteredTargets] = useState([])
  const [errorMsg, setErrorMsg]               = useState('')
  const [successMsg, setSuccessMsg]           = useState('')

  const { data: catalog, isLoading: modelsLoading } = useQuery({ queryKey: ['models'], queryFn: () => api.getModels() })
  const { data: cohorts = [] } = useQuery({ queryKey: ['cohorts'], queryFn: () => api.getCohorts() })
  
  const batchModels = catalog?.models?.filter(m => m.supports_batch) || []
  const selectedModelDef = batchModels.find(m => m.id === selectedModelId)

  const handleModelSelect = (e) => {
    setSelectedModelId(e.target.value)
    setModelParams({}) // Reset parameters when switching to a new model
  }

  const submitMutation = useMutation({
    mutationFn: async (payload) => await api.submitBatchAnalysis(payload),
    onSuccess: (data) => {
      setSuccessMsg(`Success! Batch job #${data.id} submitted to SLURM.`)
      setFilteredTargets([])
    },
    onError: (err) => setErrorMsg(err.message || 'Failed to submit batch job.')
  })

  const handleSubmit = () => {
    if (filteredTargets.length === 0) return
    const payload = {
      model_id: selectedModelId,
      output_directory: outputDir,
      scan_ids: filteredTargets.map(m => m.scan_id),
      params: modelParams 
    }
    submitMutation.mutate(payload)
  }

  if (modelsLoading) return <SpinnerPage />

  return (
    <Layout title="Batch Analysis">
      <div style={{ height: '100%', padding: '20px 24px', maxWidth: 900, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 24, overflowY: 'auto' }}>
        
        {errorMsg && <ErrorMsg message={errorMsg} />}
        {successMsg && <div style={{ padding: 16, background: 'rgba(27,153,139,0.12)', color: '#1b998b', borderRadius: 8 }}>{successMsg}</div>}

        {/* STEP 1: Configuration */}
        <div style={{ background: 'white', borderRadius: 10, padding: 24, border: '1px solid var(--border-l)', boxShadow: 'var(--shadow-s)' }}>
          <h2 style={{ fontFamily: 'var(--font-serif)', fontSize: 18, color: 'var(--navy)', marginBottom: 16 }}>1. Configuration</h2>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--text-2)', marginBottom: 6 }}>Select Model</label>
                <select value={selectedModelId} onChange={handleModelSelect} style={{ width: '100%', padding: '10px 12px', borderRadius: 6, border: '1px solid var(--border-l)', fontSize: 14, background: 'white' }}>
                  <option value="" disabled>-- Choose an AI Model --</option>
                  {batchModels.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
                {selectedModelDef?.stain_compatibility && (
                  <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 4 }}>
                    Requires stains: <span style={{fontWeight: 600}}>{selectedModelDef.stain_compatibility.join(', ')}</span>
                  </div>
                )}
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--text-2)', marginBottom: 6 }}>Output Directory (Absolute Path)</label>
                <input type="text" placeholder="/storage/research/results/..." value={outputDir} onChange={(e) => { setOutputDir(e.target.value); setMatchResults(null); }} style={{ width: '100%', padding: '10px 12px', borderRadius: 6, border: '1px solid var(--border-l)', fontSize: 14 }} />
              </div>
            </div>

            <div style={{ background: 'var(--navy-05)', padding: 16, borderRadius: 8, border: '1px solid var(--border-l)' }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-2)', marginBottom: 16, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Model Parameters</div>
              {!selectedModelId ? (
                <div style={{ fontSize: 13, color: 'var(--text-3)', fontStyle: 'italic' }}>Select a model to configure its parameters.</div>
              ) : selectedModelDef?.params?.length > 0 ? (
                selectedModelDef.params.map(param => <ParamRow key={param.key} param={param} value={modelParams[param.key] ?? param.default} onChange={val => handleParamChange(param.key, val)} />)
              ) : (
                <div style={{ fontSize: 13, color: 'var(--text-3)' }}>This model requires no additional configuration.</div>
              )}
            </div>
          </div>
        </div>

        {/* STEP 2: Target Slides */}
        <div style={{ background: 'white', borderRadius: 10, padding: 24, border: '1px solid var(--border-l)', boxShadow: 'var(--shadow-s)' }}>
          <h2 style={{ fontFamily: 'var(--font-serif)', fontSize: 18, color: 'var(--navy)', marginBottom: 16 }}>2. Target Slides</h2>
          <SlideTargetManager 
             cohorts={cohorts} 
             requiredStains={selectedModelDef?.stain_compatibility || []}
             onTargetsResolved={setFilteredTargets}
          />
        </div>

        {/* STEP 3: Submit */}
        {filteredTargets.length > 0 && (
          <div style={{ background: 'white', borderRadius: 10, padding: 24, border: '1px solid var(--border-l)', boxShadow: 'var(--shadow-s)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 13, color: 'var(--text-3)' }}>Ready to submit {filteredTargets.length} slides to SLURM.</span>
              <Btn variant="primary" onClick={handleSubmit} disabled={submitMutation.isLoading || !selectedModelId || !outputDir}>
                {submitMutation.isLoading ? 'Submitting...' : 'Submit Batch Job'}
              </Btn>
            </div>
          </div>
        )}
      </div>
    </Layout>
  )
}