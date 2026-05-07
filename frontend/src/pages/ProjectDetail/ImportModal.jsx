// frontend/src/pages/ProjectDetail/ImportModal.jsx
import { useState } from 'react'

export default function ImportModal({ isOpen, onClose, onImport }) {
  const [file, setFile] = useState(null)
  const [mode, setMode] = useState('keep_all')
  const [loading, setLoading] = useState(false)

  if (!isOpen) return null

  const handleImport = async () => {
    if (!file) return
    setLoading(true)
    try {
      await onImport(file, mode)
      onClose()
    } catch (e) {
      alert(e.message || 'Import failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 9999,
      background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(4px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center'
    }}>
      <div style={{
        width: 440, background: '#111827', border: '1px solid rgba(255,255,255,0.1)',
        borderRadius: 12, overflow: 'hidden', boxShadow: '0 20px 40px rgba(0,0,0,0.5)'
      }}>
        {/* Header */}
        <div style={{ padding: '16px 20px', borderBottom: '1px solid rgba(255,255,255,0.05)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h3 style={{ margin: 0, fontSize: 15, color: '#fff', fontWeight: 600 }}>Import GeoJSON</h3>
          <button onClick={onClose} disabled={loading} style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.5)', cursor: 'pointer', fontSize: 18 }}>×</button>
        </div>

        {/* Body */}
        <div style={{ padding: 20 }}>
          <div style={{
            border: `2px dashed ${file ? '#1b998b' : 'rgba(255,255,255,0.15)'}`, borderRadius: 8,
            padding: 24, textAlign: 'center', background: file ? 'rgba(27,153,139,0.05)' : 'rgba(0,0,0,0.2)',
            transition: 'all 0.2s', marginBottom: 20, position: 'relative'
          }}>
            <input
              type="file"
              accept=".geojson,.json"
              onChange={e => setFile(e.target.files[0])}
              disabled={loading}
              style={{ position: 'absolute', inset: 0, opacity: 0, cursor: 'pointer' }}
            />
            {file ? (
              <div style={{ color: '#6ee7b7', fontSize: 13, fontWeight: 500 }}>
                <div style={{ fontSize: 24, marginBottom: 8 }}>📄</div>
                {file.name}
              </div>
            ) : (
              <div style={{ color: 'rgba(255,255,255,0.5)', fontSize: 13 }}>
                Click or drag to select a <b>.geojson</b> file
              </div>
            )}
          </div>

          <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.8)', marginBottom: 12, fontWeight: 600 }}>Class Resolution Strategy</div>
          
          <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', cursor: 'pointer', marginBottom: 12, opacity: loading ? 0.5 : 1 }}>
            <input type="radio" name="importMode" value="keep_all" checked={mode === 'keep_all'} onChange={e => setMode(e.target.value)} disabled={loading} style={{ accentColor: '#1b998b', marginTop: 2 }} />
            <div>
              <div style={{ fontSize: 13, color: '#fff' }}>Keep All Annotations</div>
              <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', marginTop: 2 }}>Import everything. Class names that don't match this project will be labeled as "Unclassified".</div>
            </div>
          </label>

          <label style={{ display: 'flex', gap: 10, alignItems: 'flex-start', cursor: 'pointer', opacity: loading ? 0.5 : 1 }}>
            <input type="radio" name="importMode" value="match_only" checked={mode === 'match_only'} onChange={e => setMode(e.target.value)} disabled={loading} style={{ accentColor: '#1b998b', marginTop: 2 }} />
            <div>
              <div style={{ fontSize: 13, color: '#fff' }}>Match Project Classes Only</div>
              <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', marginTop: 2 }}>Discard any annotations whose class names do not perfectly match the classes defined in this project.</div>
            </div>
          </label>
        </div>

        {/* Footer */}
        <div style={{ padding: '12px 20px', borderTop: '1px solid rgba(255,255,255,0.05)', display: 'flex', justifyContent: 'flex-end', gap: 10, background: 'rgba(0,0,0,0.2)' }}>
          <button onClick={onClose} disabled={loading} style={{ padding: '6px 14px', borderRadius: 6, background: 'transparent', border: '1px solid rgba(255,255,255,0.2)', color: '#fff', cursor: 'pointer', fontSize: 12 }}>
            Cancel
          </button>
          <button onClick={handleImport} disabled={!file || loading} style={{ padding: '6px 16px', borderRadius: 6, background: file ? '#1b998b' : 'rgba(27,153,139,0.3)', border: 'none', color: file ? '#fff' : 'rgba(255,255,255,0.5)', cursor: file ? 'pointer' : 'not-allowed', fontSize: 12, fontWeight: 600, display: 'flex', gap: 8, alignItems: 'center' }}>
            {loading && <div style={{ width: 10, height: 10, borderRadius: '50%', border: '2px solid #fff', borderTopColor: 'transparent', animation: 'spin 0.7s linear infinite' }} />}
            {loading ? 'Importing...' : 'Start Import'}
          </button>
        </div>
      </div>
    </div>
  )
}