// frontend/src/components/SlideTargetManager.jsx
import { useState, useEffect } from 'react'
import { useMutation } from '@tanstack/react-query'
import { api } from '../api'
import { Btn, Spinner } from './ui'

export default function SlideTargetManager({ cohorts = [], requiredStains = [], onTargetsResolved }) {
  const [inputMode, setInputMode]             = useState('manual')
  const [rawInput, setRawInput]               = useState('')
  const [selectedCohortId, setSelectedCohortId] = useState('')

  const [matchResults, setMatchResults]       = useState(null)
  const [selectedStains, setSelectedStains]   = useState([])
  const [onePerBlock, setOnePerBlock]         = useState(false)
  const [errorMsg, setErrorMsg]               = useState('')
  const [isValidating, setIsValidating]       = useState(false)

  const matchMutation = useMutation({
    mutationFn: async (queries) => await api.matchSlides(queries),
    onMutate: () => setIsValidating(true),
    onSettled: () => setIsValidating(false),
    onSuccess: (data) => {
      const matched = data.matched.map(r => ({
        ...r,
        stain_category: r.stain_category || (r.stain?.toLowerCase() === 'unmatched' ? 'Unmatched' : 'Missing Metadata'),
        block_id: r.block_id
      }))
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
      const matched = data.results.map(r => ({
        scan_id: r.scan_id,
        block_id: r.block_id,
        file_path: r.file_path,
        stain: r.stain_name || 'Unknown',
        stain_category: r.stain_category || (r.stain_name?.toLowerCase() === 'unmatched' ? 'Unmatched' : 'Missing Metadata')
      }))
      setMatchResults({ matched, unmatched: [] })
      setErrorMsg('')
    },
    onError: (err) => {
      setErrorMsg(err.message || 'Failed to load cohort scans.')
      setMatchResults(null)
    }
  })

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

  const handleValidate = () => {
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

  const uniqueStainsInList = matchResults
    ? [...new Set(matchResults.matched.map(m => m.stain_category))].sort((a, b) => {
          if (a === 'Unmatched' || a === 'Missing Metadata') return 1;
          if (b === 'Unmatched' || b === 'Missing Metadata') return -1;
          return a.localeCompare(b);
        })
    : []

  let filteredMatched = matchResults?.matched.filter(m => selectedStains.includes(m.stain_category)) || []

  if (onePerBlock && filteredMatched.length > 0) {
    const blockMap = new Map()
    filteredMatched.forEach(m => {
      const key = m.block_id || `orphan_${m.scan_id}`
      if (!blockMap.has(key)) blockMap.set(key, [])
      blockMap.get(key).push(m)
    })
    filteredMatched = Array.from(blockMap.values()).map(slides => {
      const preferred = slides.find(s => requiredStains.length === 0 || requiredStains.includes(s.stain_category))
      return preferred || slides[0]
    })
  }

  // Auto-notify the parent component whenever the final validated list changes
  useEffect(() => {
    if (onTargetsResolved) onTargetsResolved(filteredMatched)
  }, [filteredMatched, onTargetsResolved])

  const isStainValid = (category) => requiredStains.length === 0 || requiredStains.includes(category)
  const mismatchCount = filteredMatched.filter(m => !isStainValid(m.stain_category)).length || 0

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {errorMsg && <div style={{ color: 'var(--crimson)', fontSize: 13, background: 'var(--crimson-10)', padding: 10, borderRadius: 6 }}>{errorMsg}</div>}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', background: 'var(--navy-05)', padding: 4, borderRadius: 6, border: '1px solid var(--border-l)' }}>
          <button onClick={() => { setInputMode('manual'); setMatchResults(null) }} style={{ padding: '6px 12px', fontSize: 12, borderRadius: 4, border: 'none', cursor: 'pointer', background: inputMode === 'manual' ? 'white' : 'transparent', color: inputMode === 'manual' ? 'var(--navy)' : 'var(--text-3)', fontWeight: inputMode === 'manual' ? 600 : 400, boxShadow: inputMode === 'manual' ? '0 1px 3px rgba(0,0,0,0.1)' : 'none' }}>Paste List</button>
          <button onClick={() => { setInputMode('cohort'); setMatchResults(null) }} style={{ padding: '6px 12px', fontSize: 12, borderRadius: 4, border: 'none', cursor: 'pointer', background: inputMode === 'cohort' ? 'white' : 'transparent', color: inputMode === 'cohort' ? 'var(--navy)' : 'var(--text-3)', fontWeight: inputMode === 'cohort' ? 600 : 400, boxShadow: inputMode === 'cohort' ? '0 1px 3px rgba(0,0,0,0.1)' : 'none' }}>Saved Cohort</button>
        </div>
      </div>

      {inputMode === 'manual' ? (
        <textarea rows={4} placeholder="slide_001.svs&#10;/path/to/slide_002.ndpi" value={rawInput} onChange={(e) => { setRawInput(e.target.value); setMatchResults(null); }} style={{ width: '100%', padding: 10, borderRadius: 6, border: '1px solid var(--border)', fontFamily: 'monospace', fontSize: 13, resize: 'vertical' }} />
      ) : (
        <select value={selectedCohortId} onChange={(e) => { setSelectedCohortId(e.target.value); setMatchResults(null); }} style={{ width: '100%', padding: '10px 12px', borderRadius: 6, border: '1px solid var(--border)', fontSize: 14, background: 'white' }}>
          <option value="" disabled>-- Select a Cohort --</option>
          {cohorts.map(c => <option key={c.id} value={c.id}>{c.name} ({c.result_count} items)</option>)}
        </select>
      )}

      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <Btn variant="primary" small onClick={handleValidate} disabled={isValidating || (inputMode === 'manual' && !rawInput.trim()) || (inputMode === 'cohort' && !selectedCohortId)}>
          {isValidating ? 'Validating...' : 'Load & Filter Targets'}
        </Btn>
      </div>

      {isValidating && (
         <div style={{ display: 'flex', gap: 10, alignItems: 'center', justifyContent: 'center', padding: 20 }}>
             <Spinner size={24} />
             <span style={{ fontSize: 13, color: 'var(--navy)' }}>Resolving slides...</span>
         </div>
      )}

      {matchResults && !isValidating && (
         <div style={{ marginTop: 8, padding: 16, border: '1px solid var(--border-l)', borderRadius: 8, background: '#fafafa' }}>
             <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--navy)', marginBottom: 12 }}>Filter Options</div>

             <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
               <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600, color: 'var(--navy)', cursor: 'pointer' }}>
                 <input type="checkbox" checked={onePerBlock} onChange={e => setOnePerBlock(e.target.checked)} style={{ accentColor: 'var(--navy)', cursor: 'pointer', width: 14, height: 14 }} />
                 Keep only one slide per block
               </label>
             </div>

             <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
                {uniqueStainsInList.map(stain => {
                  const isSelected = selectedStains.includes(stain)
                  const isCompatible = requiredStains.length === 0 || requiredStains.includes(stain)
                  const count = matchResults.matched.filter(m => m.stain_category === stain).length
                  return (
                    <label key={stain} style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', background: isSelected ? 'white' : 'transparent', padding: '4px 10px', borderRadius: 20, border: `1px solid ${isSelected ? 'var(--navy)' : 'var(--border-l)'}`, fontSize: 11, transition: 'all 0.15s' }}>
                      <input type="checkbox" checked={isSelected} onChange={() => {
                         setSelectedStains(prev => prev.includes(stain) ? prev.filter(s => s !== stain) : [...prev, stain])
                      }} style={{ cursor: 'pointer' }} />
                      <span style={{ fontWeight: isSelected ? 600 : 400 }}>{stain}</span>
                      {!isCompatible && <span title="Not recommended" style={{ color: '#d97706' }}>⚠</span>}
                      <span style={{ color: 'var(--text-3)' }}>({count})</span>
                    </label>
                  )
                })}
             </div>

             <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
               <div style={{ padding: 12, borderRadius: 6, background: 'rgba(27,153,139,0.05)', border: '1px solid rgba(27,153,139,0.2)' }}>
                 <div style={{ fontSize: 11, fontWeight: 600, color: '#1b998b', marginBottom: 6 }}>✅ Valid ({filteredMatched.length})</div>
                 <div style={{ maxHeight: 100, overflowY: 'auto', fontSize: 11, color: 'var(--text-2)', fontFamily: 'monospace' }}>
                    {filteredMatched.slice(0, 50).map(m => (
                        <div key={m.scan_id} style={{ opacity: isStainValid(m.stain_category) ? 1 : 0.6 }}>{m.file_path.split('/').pop()}</div>
                    ))}
                    {filteredMatched.length > 50 && <div>...and {filteredMatched.length - 50} more</div>}
                 </div>
               </div>
               <div style={{ padding: 12, borderRadius: 6, background: 'rgba(220,38,38,0.05)', border: '1px solid rgba(220,38,38,0.2)' }}>
                 <div style={{ fontSize: 11, fontWeight: 600, color: '#dc2626', marginBottom: 6 }}>❌ Invalid ({matchResults.unmatched?.length || 0})</div>
                 <div style={{ maxHeight: 100, overflowY: 'auto', fontSize: 11, color: 'var(--text-2)', fontFamily: 'monospace' }}>
                    {matchResults.unmatched?.slice(0,50).map((u, i) => <div key={i}>{u}</div>)}
                 </div>
               </div>
             </div>

             {mismatchCount > 0 && (
               <div style={{ marginTop: 12, fontSize: 11, color: '#b45309', background: '#fffbeb', padding: 8, borderRadius: 6 }}>
                 ⚠️ Contains {mismatchCount} slides with incompatible stains.
               </div>
             )}
         </div>
      )}
    </div>
  )
}