// frontend/src/pages/ProjectDetail/ImportModal.jsx
import { useState, useEffect, useCallback } from 'react'
import { FormModal, FileDropZone, RadioCardGroup } from '../../components/ui'

const RADIO_OPTS = [
  {
    value: 'keep_all',
    title: 'Keep All Annotations',
    desc:  "Import everything. Class names that don't match this project will be labeled as 'Unclassified'.",
  },
  {
    value: 'match_only',
    title: 'Match Project Classes Only',
    desc:  'Map annotation classes from the file to your project classes, or choose to ignore specific classes.',
  },
]

function extractClassNames(geojsonText) {
  try {
    const data = JSON.parse(geojsonText)
    const names = new Set()
    for (const feat of data.features || []) {
      const props = feat.properties || {}
      let name = props.name
      if (!name && props.classification) name = props.classification.name
      if (!name) name = props.class_name
      if (name) names.add(name)
    }
    return [...names].sort()
  } catch {
    return []
  }
}

export default function ImportModal({ isOpen, onClose, onImport, projectClasses = [] }) {
  const [file,         setFile]         = useState(null)
  const [mode,         setMode]         = useState('keep_all')
  const [loading,      setLoading]      = useState(false)
  const [error,        setError]        = useState('')
  const [fileClasses,  setFileClasses]  = useState([])
  const [classMapping, setClassMapping] = useState({})

  const parseFile = useCallback((f) => {
    if (!f) { setFileClasses([]); return }
    const reader = new FileReader()
    reader.onload = (e) => {
      const names = extractClassNames(e.target.result)
      setFileClasses(names)
    }
    reader.readAsText(f)
  }, [])

  useEffect(() => {
    if (fileClasses.length === 0 || projectClasses.length === 0) return
    const pLower = projectClasses.map(pc => ({ ...pc, lower: pc.name.toLowerCase() }))
    const initial = {}
    fileClasses.forEach(fc => {
      const match = pLower.find(pc => pc.lower === fc.toLowerCase())
      initial[fc] = match ? match.name : 'IGNORE'
    })
    setClassMapping(initial)
  }, [fileClasses, projectClasses])

  const handleFileSelect = (f) => {
    setFile(f)
    setError('')
    parseFile(f)
  }

  const handleImport = async () => {
    if (!file) return
    setLoading(true)
    setError('')
    try {
      const mapping = mode === 'match_only' && fileClasses.length > 0 ? classMapping : null
      await onImport(file, mode, mapping)
      onClose()
    } catch (e) {
      setError(e.message || 'Import failed')
    } finally {
      setLoading(false)
    }
  }

  const handleClose = () => {
    if (!loading) {
      setFile(null)
      setError('')
      setFileClasses([])
      setClassMapping({})
      onClose()
    }
  }

  const showMapping = mode === 'match_only' && fileClasses.length > 0
  const mappingIncomplete = showMapping && Object.values(classMapping).some(v => v === '')
  const canSubmit = !!file && !mappingIncomplete

  return (
    <FormModal
      isOpen={isOpen}
      onClose={handleClose}
      title="Import GeoJSON"
      width={showMapping ? 560 : 440}
      error={error}
      onSubmit={handleImport}
      submitLabel="Start Import"
      loadingLabel="Importing..."
      submitVariant={canSubmit ? 'primary' : 'ghost'}
      loading={loading}
      canSubmit={canSubmit}
    >
      <FileDropZone
        file={file}
        onSelect={handleFileSelect}
        accept=".geojson,.json"
        disabled={loading}
        style={{ marginBottom: 'var(--space-5)' }}
        hint={<>Click or drag to select a <strong>.geojson</strong> file</>}
      />

      <div style={{ fontSize: 12, color: 'var(--text-1)', marginBottom: 12, fontWeight: 600 }}>
        Class Resolution Strategy
      </div>

      <RadioCardGroup
        name="importMode"
        value={mode}
        onChange={setMode}
        options={RADIO_OPTS}
        disabled={loading}
      />

      {showMapping && (
        <div style={{ marginTop: 20 }}>
          <label style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--navy)', marginBottom: 8, textTransform: 'uppercase' }}>
            Class Mapping
          </label>
          <div style={{ border: '1px solid var(--border-l)', borderRadius: 8, overflow: 'hidden' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 20px 1fr', background: '#f8fafc', padding: '8px 12px', fontSize: 11, fontWeight: 600, color: 'var(--text-3)', borderBottom: '1px solid var(--border-l)' }}>
              <div>FILE CLASS</div>
              <div></div>
              <div>PROJECT CLASS</div>
            </div>

            <div style={{ maxHeight: 200, overflowY: 'auto', background: 'white' }}>
              {(() => {
                const pLower = projectClasses.map(pc => pc.name.toLowerCase())

                const sorted = [...fileClasses].sort((a, b) => {
                  const aMatched = pLower.includes(a.toLowerCase())
                  const bMatched = pLower.includes(b.toLowerCase())
                  if (aMatched && !bMatched) return -1
                  if (!aMatched && bMatched) return 1
                  return a.localeCompare(b)
                })

                return sorted.map(fc => {
                  const currentValue = classMapping[fc]
                  const isAutoMatched = currentValue && currentValue !== 'IGNORE' &&
                    projectClasses.some(pc => pc.name.toLowerCase() === fc.toLowerCase())

                  return (
                    <div key={fc} style={{ display: 'grid', gridTemplateColumns: '1fr 20px 1fr', gap: 12, padding: '10px 12px', borderBottom: '1px solid #f1f5f9', alignItems: 'center' }}>
                      <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--navy)' }}>{fc}</div>
                      <div style={{ color: '#cbd5e1' }}>{'→'}</div>
                      <div>
                        <select
                          value={currentValue || ''}
                          onChange={e => setClassMapping(prev => ({ ...prev, [fc]: e.target.value }))}
                          style={{
                            width: '100%', padding: '6px 8px', borderRadius: 4, fontSize: 12, outline: 'none',
                            border: currentValue === '' ? '1px solid #ef4444' : (isAutoMatched ? '1px solid #10b981' : '1px solid var(--border-l)'),
                            background: currentValue === '' ? '#fef2f2' : (isAutoMatched ? '#ecfdf5' : 'white'),
                            color: currentValue === 'IGNORE' ? 'var(--text-3)' : 'var(--navy)'
                          }}
                        >
                          <option value="" disabled>-- Select mapping --</option>
                          <option value="IGNORE" style={{ fontStyle: 'italic' }}>Do not import</option>
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
    </FormModal>
  )
}