import { useState, useEffect } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { api } from '../../api'
import { Btn, Spinner } from '../../components/ui'

export default function BatchAIModal({ isOpen, onClose, projectId, projectClasses = [], projectScans: initialScans }) {
  const [selectedModelId, setSelectedModelId] = useState('')
  const [importMode, setImportMode]           = useState('keep_all')
  const [classMapping, setClassMapping]       = useState({})
  const [errorMsg, setErrorMsg]               = useState('')
  const [successMsg, setSuccessMsg]           = useState('')

  // 1. Fetch Scans ONLY if they weren't passed down from the parent (e.g., from the List view)
  const { data: fetchedScans = [], isLoading: scansLoading } = useQuery({
    queryKey: ['project-batch-scans', projectId],
    queryFn: () => api.getProjectScans(projectId),
    enabled: !!isOpen && !!projectId && !initialScans
  })

  // Use passed scans if available, otherwise use fetched scans
  const scans = initialScans || fetchedScans
  const isMetadataLoading = !initialScans && scansLoading

  // 2. Fetch Available Models
  const { data: catalog, isLoading: modelsLoading } = useQuery({ 
    queryKey: ['models'], 
    queryFn: () => api.getModels(),
    enabled: !!isOpen
  })

  const batchModels = catalog?.models?.filter(m => m.supports_batch) || []
  const selectedModel = batchModels.find(m => m.id === selectedModelId)

  // 3. Auto-Match Logic (Now uses projectClasses prop directly)
  useEffect(() => {
    if (selectedModel && importMode === 'map_classes' && projectClasses.length > 0) {
      const initialMap = {}
      const pClassesLower = projectClasses.map(pc => ({ ...pc, lower: pc.name.toLowerCase() }))
      const mClasses = selectedModel.classes || []
      
      mClasses.forEach(mc => {
        const mcName = typeof mc === 'string' ? mc : mc.name
        const match = pClassesLower.find(pc => pc.lower === mcName.toLowerCase())
        initialMap[mcName] = match ? match.name : 'IGNORE'
      })
      setClassMapping(initialMap)
    }
  }, [selectedModel, importMode, projectClasses])

  // 4. Submission Logic
  const submitMutation = useMutation({
    mutationFn: (payload) => api.submitBatchAnalysis(payload),
    onSuccess: (data) => {
      setSuccessMsg(`Batch job #${data.id} submitted.`)
      setTimeout(() => { onClose(); setSuccessMsg(''); setSelectedModelId(''); }, 2500)
    },
    onError: (err) => setErrorMsg(err.message || 'Submission failed.')
  })

  const handleSubmit = () => {
    setErrorMsg('')
    if (importMode === 'map_classes' && Object.values(classMapping).some(v => v === '')) {
      setErrorMsg('Please map all classes or set them to "Ignore".'); return;
    }
    
    // Send the payload with an explicit empty string for the output directory
    submitMutation.mutate({
      model_id: selectedModelId,
      output_directory: "", // <--- ADD THIS LINE
      
      // Fallback to s.id just in case your API returns 'id' instead of 'scan_id' in some views
      scan_ids: scans.map(s => s.scan_id || s.id), 
      
      params: {
        project_id: projectId,
        import_mode: importMode,
        class_mapping: importMode === 'map_classes' ? classMapping : null
      }
    })
  }

  if (!isOpen) return null

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,20,100,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, backdropFilter: 'blur(2px)' }}>
      <div onClick={e => e.stopPropagation()} style={{ background: 'white', borderRadius: 12, width: 600, maxHeight: '90vh', overflowY: 'auto', display: 'flex', flexDirection: 'column', boxShadow: '0 20px 40px rgba(0,0,0,0.2)' }}>
        
        {/* Header */}
        <div style={{ padding: '20px 24px', borderBottom: '1px solid var(--border-l)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 style={{ margin: 0, fontSize: 18, color: 'var(--navy)' }}>Run Batch AI Analysis</h2>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: 'var(--text-3)' }}>&times;</button>
        </div>

        {/* Body */}
        <div style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: 24 }}>
          {errorMsg && <div style={{ color: '#dc2626', background: '#fef2f2', padding: 12, borderRadius: 6, fontSize: 13, border: '1px solid #fca5a5' }}>{errorMsg}</div>}
          {successMsg && <div style={{ color: '#059669', background: '#ecfdf5', padding: 12, borderRadius: 6, fontSize: 13, border: '1px solid #6ee7b7' }}>{successMsg}</div>}

          {(isMetadataLoading || modelsLoading) ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: 40 }}>
              <Spinner size={32} />
              <div style={{ marginTop: 12, fontSize: 13, color: 'var(--text-3)' }}>Loading slide metadata...</div>
            </div>
          ) : (
            <>
              {/* Step 1: Model Selection */}
              <div>
                <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--navy)', marginBottom: 8, textTransform: 'uppercase' }}>1. Select Model</label>
                <select 
                  value={selectedModelId} 
                  onChange={e => { setSelectedModelId(e.target.value); setImportMode('keep_all'); }}
                  style={{ width: '100%', padding: '10px 12px', borderRadius: 6, border: '1px solid var(--border-l)', fontSize: 14, background: 'white' }}
                >
                  <option value="" disabled>-- Choose an AI Model --</option>
                  {batchModels.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
                <div style={{ marginTop: 6, fontSize: 12, color: 'var(--text-3)' }}>
                  This will queue <b>{scans.length}</b> slides for background processing.
                </div>
              </div>

              {/* Step 2: Class Mapping Strategy */}
              {selectedModel && (
                <div style={{ background: 'var(--navy-05)', padding: 16, borderRadius: 8, border: '1px solid var(--border-l)' }}>
                  <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--navy)', marginBottom: 12, textTransform: 'uppercase' }}>2. Import Strategy</label>
                  
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, cursor: 'pointer' }}>
                      <input type="radio" name="importMode" checked={importMode === 'keep_all'} onChange={() => setImportMode('keep_all')} style={{ marginTop: 3, accentColor: 'var(--navy)' }} />
                      <div>
                        <div style={{ fontSize: 14, fontWeight: 500, color: 'var(--navy)' }}>Keep Model Classes</div>
                        <div style={{ fontSize: 12, color: 'var(--text-2)' }}>Imports all predictions exactly as the model outputs them. Creates new project classes if they don't exist.</div>
                      </div>
                    </label>

                    <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, cursor: 'pointer' }}>
                      <input type="radio" name="importMode" checked={importMode === 'map_classes'} onChange={() => setImportMode('map_classes')} style={{ marginTop: 3, accentColor: 'var(--navy)' }} />
                      <div>
                        <div style={{ fontSize: 14, fontWeight: 500, color: 'var(--navy)' }}>Map to Project Classes</div>
                        <div style={{ fontSize: 12, color: 'var(--text-2)' }}>Force the model to use your existing project classes, or ignore specific outputs.</div>
                      </div>
                    </label>
                  </div>
                </div>
              )}

              {/* Step 3: Visual Mapping Table */}
              {selectedModel && importMode === 'map_classes' && (
                <div>
                   <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--navy)', marginBottom: 8, textTransform: 'uppercase' }}>3. Class Mapping</label>
                   <div style={{ border: '1px solid var(--border-l)', borderRadius: 8, overflow: 'hidden' }}>
                     <div style={{ display: 'grid', gridTemplateColumns: '1fr 20px 1fr', background: '#f8fafc', padding: '8px 12px', fontSize: 11, fontWeight: 600, color: 'var(--text-3)', borderBottom: '1px solid var(--border-l)' }}>
                       <div>AI MODEL OUTPUT</div>
                       <div></div>
                       <div>PROJECT CLASS</div>
                     </div>
                     
                     <div style={{ maxHeight: 200, overflowY: 'auto', background: 'white' }}>
                       {(() => {
                         const mClasses = selectedModel.classes || []
                         const pClassesLower = projectClasses.map(pc => pc.name.toLowerCase())
                         
                         // 👇 NEW: Sort matched classes to the top, then alphabetically
                         const sortedClasses = [...mClasses].sort((a, b) => {
                           const aName = typeof a === 'string' ? a : a.name
                           const bName = typeof b === 'string' ? b : b.name
                           const aMatched = pClassesLower.includes(aName.toLowerCase())
                           const bMatched = pClassesLower.includes(bName.toLowerCase())
                           
                           if (aMatched && !bMatched) return -1
                           if (!aMatched && bMatched) return 1
                           return aName.localeCompare(bName)
                         })

                         return sortedClasses.map(mc => {
                           const mcName = typeof mc === 'string' ? mc : mc.name
                           const currentValue = classMapping[mcName]
                           
                           const isAutoMatched = currentValue !== '' && currentValue !== 'IGNORE' && 
                                                 projectClasses.some(pc => pc.name.toLowerCase() === mcName.toLowerCase())

                           return (
                             <div key={mcName} style={{ display: 'grid', gridTemplateColumns: '1fr 20px 1fr', gap: 12, padding: '10px 12px', borderBottom: '1px solid #f1f5f9', alignItems: 'center' }}>
                               <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--navy)' }}>{mcName}</div>
                               <div style={{ color: '#cbd5e1' }}>→</div>
                               <div>
                                 <select 
                                   value={currentValue || ''} 
                                   onChange={e => setClassMapping(prev => ({ ...prev, [mcName]: e.target.value }))}
                                   style={{ 
                                     width: '100%', padding: '6px 8px', borderRadius: 4, fontSize: 12, outline: 'none',
                                     border: currentValue === '' ? '1px solid #ef4444' : (isAutoMatched ? '1px solid #10b981' : '1px solid var(--border-l)'),
                                     background: currentValue === '' ? '#fef2f2' : (isAutoMatched ? '#ecfdf5' : 'white'),
                                     color: currentValue === 'IGNORE' ? 'var(--text-3)' : 'var(--navy)'
                                   }}
                                 >
                                   <option value="" disabled>-- Select mapping --</option>
                                   <option value="IGNORE" style={{ fontStyle: 'italic' }}>❌ Do not import</option>
                                   <optgroup label="Project Classes">
                                     {projectClasses.map(pc => <option key={pc.id} value={pc.name}>{pc.name}</option>)}
                                   </optgroup>
                                 </select>
                                 {isAutoMatched && <div style={{ fontSize: 9, color: '#10b981', marginTop: 2, textAlign: 'right' }}>Auto-matched</div>}
                               </div>
                             </div>
                           )
                         })
                       })()}
                     </div>
                   </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div style={{ padding: '16px 24px', borderTop: '1px solid var(--border-l)', background: '#f8fafc', display: 'flex', justifyContent: 'flex-end', gap: 12 }}>
          <Btn variant="secondary" onClick={onClose} disabled={submitMutation.isLoading}>Cancel</Btn>
          <Btn 
            variant="primary" 
            onClick={handleSubmit} 
            disabled={!selectedModelId || submitMutation.isLoading || (importMode === 'map_classes' && Object.values(classMapping).some(v => v === '')) || isMetadataLoading || modelsLoading}
          >
            {submitMutation.isLoading ? 'Launching...' : `Process ${scans.length} Slides`}
          </Btn>
        </div>

      </div>
    </div>
  )
}