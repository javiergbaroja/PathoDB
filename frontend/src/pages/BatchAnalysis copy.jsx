import { useState, useEffect } from 'react'
import { useQuery, useMutation } from '@tanstack/react-query'
import Layout from '../components/Layout'
import { Btn, SpinnerPage, Spinner, ErrorMsg } from '../components/ui'
import { api } from '../api'

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
  
  const [inputMode, setInputMode]             = useState('manual')
  const [rawInput, setRawInput]               = useState('')
  const [selectedCohortId, setSelectedCohortId] = useState('')
  
  const [matchResults, setMatchResults]       = useState(null)
  const [selectedStains, setSelectedStains]   = useState([])
  const [errorMsg, setErrorMsg]               = useState('')
  const [successMsg, setSuccessMsg]           = useState('')
  
  // EXPLICIT LOADING STATE
  const [isValidating, setIsValidating]       = useState(false)

  const { data: catalog, isLoading: modelsLoading } = useQuery({
    queryKey: ['models'],
    queryFn: () => api.getModels(),
  })
  
  const models = catalog?.models || []
  const batchModels = models.filter(m => m.supports_batch)

  const { data: cohorts = [] } = useQuery({
    queryKey: ['cohorts'],
    queryFn: () => api.getCohorts(),
  })

  // Mutations
  const matchMutation = useMutation({
    // FIX: Removed curly braces around `queries` to solve 422 Unprocessable Entity error
    mutationFn: async (queries) => await api.matchSlides({ queries }), 
    onMutate: () => setIsValidating(true),
    onSettled: () => setIsValidating(false),
    onSuccess: (data) => {
      // Apply the same Unmatched interception logic here
      const matched = data.matched.map(r => {
        let stainCategory = r.stain_category || 'Missing Metadata'
        if (r.stain.toLowerCase() === 'unmatched') stainCategory = 'Unmatched'
        return { ...r, stain_category: stainCategory }
      })
      setMatchResults({ matched, unmatched: data.unmatched })
      setErrorMsg('')
    },
    onError: (err) => {
      setErrorMsg(err.message || 'Failed to validate slides.')
      setMatchResults(null)
    }
  })

  const loadCohortMutation = useMutation({
    mutationFn: async (cohortId) => {
      const cohort = cohorts.find(c => c.id === parseInt(cohortId))
      if (!cohort) throw new Error("Cohort not found")
      
      const queryPayload = { ...cohort.filter_json, return_level: 'scan' }
      return await api.queryCohort(queryPayload)
    },
    onMutate: () => setIsValidating(true),
    onSettled: () => setIsValidating(false),
    onSuccess: (data) => {
      const matched = data.results.map(r => {
        const stainName = r.stain_name || 'Unknown'
        let stainCategory = r.stain_category || 'Missing Metadata'
        
        // Break the 'unmatched' stain out of 'special_stain'
        if (stainName.toLowerCase() === 'unmatched') stainCategory = 'Unmatched'

        return {
          scan_id: r.scan_id,
          file_path: r.file_path,
          stain: stainName,
          stain_category: stainCategory
        }
      })
      
      setMatchResults({ matched, unmatched: [] })
      setErrorMsg('')
    },
    onError: (err) => {
      setErrorMsg(err.message || 'Failed to load cohort scans.')
      setMatchResults(null)
    }
  })

  const submitMutation = useMutation({
    mutationFn: async (payload) => await api.submitBatchAnalysis(payload),
    onSuccess: (data) => {
      setSuccessMsg(`Success! Batch job #${data.id} submitted to SLURM.`)
      setMatchResults(null)
      setRawInput('')
      setSelectedCohortId('')
    },
    onError: (err) => {
      setErrorMsg(err.message || 'Failed to submit batch job.')
    }
  })

  const selectedModelDef = batchModels.find(m => m.id === selectedModelId)
  const requiredStains = selectedModelDef?.stain_compatibility || []
  const requiredStainsStr = requiredStains.join(',')

  useEffect(() => {
    if (matchResults?.matched) {
      const uniqueStains = [...new Set(matchResults.matched.map(m => m.stain_category))]
      const required = requiredStainsStr ? requiredStainsStr.split(',') : []
      
      if (required.length === 0) {
        setSelectedStains(uniqueStains)
      } else {
        setSelectedStains(uniqueStains.filter(s => required.includes(s)))
      }
    }
  }, [matchResults, requiredStainsStr])

  const handleModelSelect = (e) => {
    const mId = e.target.value
    setSelectedModelId(mId)
    const selected = batchModels.find(m => m.id === mId)
    const initialParams = {}
    if (selected && selected.params) {
      selected.params.forEach(p => { initialParams[p.key] = p.default })
    }
    setModelParams(initialParams)
  }

  const handleParamChange = (key, value) => {
    setModelParams(prev => ({ ...prev, [key]: value }))
  }

  const toggleStain = (stain) => {
    setSelectedStains(prev => 
      prev.includes(stain) ? prev.filter(s => s !== stain) : [...prev, stain]
    )
  }

  const handleValidate = () => {
    setSuccessMsg('')
    setMatchResults(null)
    setErrorMsg('')
    
    if (inputMode === 'manual') {
      const queries = rawInput.split('\n').map(s => s.trim()).filter(s => s.length > 0)
      if (queries.length === 0) {
        setErrorMsg('Please enter at least one slide path or filename.')
        return
      }
      matchMutation.mutate(queries)
    } else {
      if (!selectedCohortId) {
        setErrorMsg('Please select a saved cohort.')
        return
      }
      loadCohortMutation.mutate(selectedCohortId)
    }
  }

  const handleSubmit = () => {
    if (!filteredMatched || filteredMatched.length === 0) return
    const payload = {
      model_id: selectedModelId,
      output_directory: outputDir,
      scan_ids: filteredMatched.map(m => m.scan_id),
      params: modelParams 
    }
    submitMutation.mutate(payload)
  }

  if (modelsLoading) return <SpinnerPage />

  const uniqueStainsInList = matchResults 
    ? [...new Set(matchResults.matched.map(m => m.stain_category))]
        .sort((a, b) => {
          if (a === 'Unmatched' || a === 'Missing Metadata') return 1;
          if (b === 'Unmatched' || b === 'Missing Metadata') return -1;
          return a.localeCompare(b);
        }) 
    : []

  const filteredMatched = matchResults?.matched.filter(m => selectedStains.includes(m.stain_category)) || []
  const isStainValid = (category) => requiredStains.length === 0 || requiredStains.includes(category)
  const mismatchCount = filteredMatched.filter(m => !isStainValid(m.stain_category)).length || 0
  const isSubmitting = submitMutation.isLoading || submitMutation.isPending

  return (
    <Layout title="Batch Analysis">
      <div style={{ height: '100%', padding: '20px 24px', maxWidth: 900, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 24, overflowY: 'auto' }}>
        
        {errorMsg && <ErrorMsg message={errorMsg} />}
        {successMsg && (
          <div style={{ padding: 16, background: 'rgba(27,153,139,0.12)', color: '#1b998b', borderRadius: 8, border: '1px solid #6ee7b7', fontWeight: 600 }}>
            {successMsg}
          </div>
        )}

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
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <h2 style={{ fontFamily: 'var(--font-serif)', fontSize: 18, color: 'var(--navy)', margin: 0 }}>2. Target Slides</h2>
            <div style={{ display: 'flex', background: 'var(--navy-05)', padding: 4, borderRadius: 6, border: '1px solid var(--border-l)' }}>
              <button onClick={() => { setInputMode('manual'); setMatchResults(null) }} style={{ padding: '6px 12px', fontSize: 12, borderRadius: 4, border: 'none', cursor: 'pointer', background: inputMode === 'manual' ? 'white' : 'transparent', color: inputMode === 'manual' ? 'var(--navy)' : 'var(--text-3)', fontWeight: inputMode === 'manual' ? 600 : 400, boxShadow: inputMode === 'manual' ? '0 1px 3px rgba(0,0,0,0.1)' : 'none' }}>Paste List</button>
              <button onClick={() => { setInputMode('cohort'); setMatchResults(null) }} style={{ padding: '6px 12px', fontSize: 12, borderRadius: 4, border: 'none', cursor: 'pointer', background: inputMode === 'cohort' ? 'white' : 'transparent', color: inputMode === 'cohort' ? 'var(--navy)' : 'var(--text-3)', fontWeight: inputMode === 'cohort' ? 600 : 400, boxShadow: inputMode === 'cohort' ? '0 1px 3px rgba(0,0,0,0.1)' : 'none' }}>Saved Cohort</button>
            </div>
          </div>

          {inputMode === 'manual' ? (
            <>
              <p style={{ fontSize: 13, color: 'var(--text-3)', marginBottom: 12 }}>Paste a list of slide filenames or paths (one per line).</p>
              <textarea rows={6} placeholder="slide_001.svs&#10;/path/to/another/slide_002.ndpi" value={rawInput} onChange={(e) => { setRawInput(e.target.value); setMatchResults(null); }} style={{ width: '100%', padding: 12, borderRadius: 6, border: '1px solid var(--border-l)', fontFamily: 'monospace', fontSize: 13, resize: 'vertical' }} />
            </>
          ) : (
            <>
              <p style={{ fontSize: 13, color: 'var(--text-3)', marginBottom: 12 }}>Select a previously saved cohort. We will extract all valid scans from it.</p>
              <select value={selectedCohortId} onChange={(e) => { setSelectedCohortId(e.target.value); setMatchResults(null); }} style={{ width: '100%', padding: '10px 12px', borderRadius: 6, border: '1px solid var(--border-l)', fontSize: 14, background: 'white' }}>
                <option value="" disabled>-- Select a Cohort --</option>
                {cohorts.map(c => <option key={c.id} value={c.id}>{c.name} ({c.result_count} items)</option>)}
              </select>
            </>
          )}

          <div style={{ marginTop: 16, display: 'flex', justifyContent: 'flex-end' }}>
            <Btn variant="primary" onClick={handleValidate} disabled={!selectedModelId || !outputDir || isValidating || (inputMode === 'manual' && !rawInput.trim()) || (inputMode === 'cohort' && !selectedCohortId)}>
              {isValidating ? 'Loading...' : 'Load & Validate Targets'}
            </Btn>
          </div>
        </div>

        {/* STEP 3: Pre-flight Check & Submit */}
        {isValidating ? (
          <div style={{ background: 'white', borderRadius: 10, padding: 60, border: '1px solid var(--border-l)', boxShadow: 'var(--shadow-s)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 20 }}>
            <Spinner size={36} />
            <div style={{ color: 'var(--navy)', fontSize: 14, fontWeight: 500, fontFamily: 'var(--font-sans)' }}>
              {inputMode === 'cohort' ? 'Extracting and cross-referencing cohort slides...' : 'Validating target slides against database...'}
            </div>
          </div>
        ) : matchResults && (
          <div style={{ background: 'white', borderRadius: 10, padding: 24, border: '1px solid var(--border-l)', boxShadow: 'var(--shadow-s)', animation: 'fadeIn 0.3s' }}>
            <h2 style={{ fontFamily: 'var(--font-serif)', fontSize: 18, color: 'var(--navy)', marginBottom: 16 }}>3. Pre-flight Check & Submit</h2>
            
            <div style={{ marginBottom: 20, padding: 16, background: 'var(--navy-05)', borderRadius: 8, border: '1px solid var(--border-l)' }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--navy)', marginBottom: 12 }}>Filter by Stain Category</div>
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                {uniqueStainsInList.map(stain => {
                  const isSelected = selectedStains.includes(stain)
                  const isCompatible = requiredStains.length === 0 || requiredStains.includes(stain)
                  const count = matchResults.matched.filter(m => m.stain_category === stain).length
                  
                  return (
                    <label key={stain} style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', background: isSelected ? 'white' : 'transparent', padding: '6px 12px', borderRadius: 20, border: `1px solid ${isSelected ? 'var(--navy)' : 'var(--border-l)'}`, fontSize: 12, transition: 'all 0.15s' }}>
                      <input type="checkbox" checked={isSelected} onChange={() => toggleStain(stain)} style={{ cursor: 'pointer' }} />
                      <span style={{ fontWeight: isSelected ? 600 : 400 }}>{stain}</span>
                      {!isCompatible && <span title="Not recommended for this model" style={{ color: '#d97706' }}>⚠</span>}
                      <span style={{ color: 'var(--text-3)', fontSize: 11 }}>({count})</span>
                    </label>
                  )
                })}
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginBottom: 24 }}>
              <div style={{ padding: 16, borderRadius: 8, background: 'rgba(27,153,139,0.05)', border: '1px solid rgba(27,153,139,0.2)' }}>
                <div style={{ fontWeight: 600, color: '#1b998b', marginBottom: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span>✅ Targets Selected ({filteredMatched.length})</span>
                  {filteredMatched.length !== matchResults.matched.length && (
                    <span style={{ fontSize: 11, color: 'var(--text-3)', fontWeight: 400 }}>Filtered from {matchResults.matched.length} total</span>
                  )}
                </div>
                <ul style={{ margin: 0, paddingLeft: 20, fontSize: 12, color: 'var(--text-2)', maxHeight: 150, overflowY: 'auto' }}>
                  {filteredMatched.slice(0, 100).map(m => {
                    const valid = isStainValid(m.stain_category)
                    return (
                      <li key={m.scan_id} style={{ display: 'flex', justifyContent: 'space-between', paddingRight: 8, opacity: valid ? 1 : 0.7 }}>
                        <span style={{ textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap' }}>{m.file_path.split('/').pop()}</span>
                        {!valid && <span title={`Model expects [${requiredStains.join(', ')}] but slide is [${m.stain_category}]`} style={{ color: '#d97706', fontWeight: 'bold', cursor: 'help', flexShrink: 0, marginLeft: 8 }}>⚠ Mismatch</span>}
                      </li>
                    )
                  })}
                  {filteredMatched.length > 100 && <li style={{ fontStyle: 'italic', marginTop: 4 }}>...and {filteredMatched.length - 100} more</li>}
                  {filteredMatched.length === 0 && <li style={{ fontStyle: 'italic', marginTop: 4 }}>All slides filtered out.</li>}
                </ul>
              </div>

              <div style={{ padding: 16, borderRadius: 8, background: 'rgba(220,38,38,0.05)', border: '1px solid rgba(220,38,38,0.2)' }}>
                <div style={{ fontWeight: 600, color: '#dc2626', marginBottom: 8 }}>❌ Not Found / Invalid ({matchResults.unmatched?.length || 0})</div>
                <ul style={{ margin: 0, paddingLeft: 20, fontSize: 12, color: 'var(--text-2)', maxHeight: 150, overflowY: 'auto' }}>
                  {(!matchResults.unmatched || matchResults.unmatched.length === 0) && <li>None! All clear.</li>}
                  {matchResults.unmatched?.map((u, i) => <li key={i}>{u}</li>)}
                </ul>
              </div>
            </div>

            {mismatchCount > 0 && (
              <div style={{ padding: 16, background: '#fffbeb', border: '1px solid #fcd34d', borderRadius: 8, marginBottom: 20, display: 'flex', gap: 12, alignItems: 'center' }}>
                <span style={{ fontSize: 24 }}>⚠️</span>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 600, color: '#92400e' }}>Manual Override Detected</div>
                  <div style={{ fontSize: 12, color: '#b45309' }}>You have intentionally included <strong>{mismatchCount} slides</strong> with stains that do not match the expected compatibility for this model ({requiredStains.join(', ')}). You can still run the batch, but results may be inaccurate.</div>
                </div>
              </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '1px solid var(--border-l)', paddingTop: 16 }}>
              <span style={{ fontSize: 13, color: 'var(--text-3)' }}>{filteredMatched.length === 0 ? 'No valid slides selected.' : `Ready to submit ${filteredMatched.length} slides to SLURM.`}</span>
              <Btn variant="primary" onClick={handleSubmit} disabled={filteredMatched.length === 0 || isSubmitting}>
                {isSubmitting ? 'Submitting to Cluster...' : 'Submit Batch Job'}
              </Btn>
            </div>
          </div>
        )}

      </div>
    </Layout>
  )
}