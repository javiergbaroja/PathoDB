// frontend/src/pages/ProjectDetail/ImportModal.jsx
import { useState } from 'react'
import { Modal, Btn, ErrorMsg } from '../../components/ui'

export default function ImportModal({ isOpen, onClose, onImport }) {
  const [file,    setFile]    = useState(null)
  const [mode,    setMode]    = useState('keep_all')
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState('')

  const handleImport = async () => {
    if (!file) return
    setLoading(true)
    setError('')
    try {
      await onImport(file, mode)
      onClose()
    } catch (e) {
      setError(e.message || 'Import failed')
    } finally {
      setLoading(false)
    }
  }

  // Reset state when closed
  const handleClose = () => {
    if (!loading) { setFile(null); setError(''); onClose() }
  }

  const RADIO_OPTS = [
    {
      value: 'keep_all',
      title: 'Keep All Annotations',
      desc:  "Import everything. Class names that don't match this project will be labeled as 'Unclassified'.",
    },
    {
      value: 'match_only',
      title: 'Match Project Classes Only',
      desc:  'Discard any annotations whose class names do not perfectly match the classes defined in this project.',
    },
  ]

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title="Import GeoJSON" width={440}>
      <Modal.Body>
        {/* Drop zone */}
        <div style={{
          border: `2px dashed ${file ? 'var(--teal)' : 'var(--border)'}`,
          borderRadius: 'var(--radius-lg)',
          padding: 24,
          textAlign: 'center',
          background: file ? 'var(--teal-10)' : 'rgba(0,0,0,0.02)',
          transition: 'var(--transition-base)',
          marginBottom: 'var(--space-5)',
          position: 'relative',
        }}>
          <input
            type="file"
            accept=".geojson,.json"
            onChange={e => { setFile(e.target.files[0]); setError('') }}
            disabled={loading}
            style={{ position: 'absolute', inset: 0, opacity: 0, cursor: 'pointer' }}
          />
          {file ? (
            <div style={{ color: 'var(--teal)', fontSize: 13, fontWeight: 500 }}>
              <div style={{ fontSize: 24, marginBottom: 8 }}>📄</div>
              {file.name}
            </div>
          ) : (
            <div style={{ color: 'var(--text-3)', fontSize: 13 }}>
              Click or drag to select a <strong>.geojson</strong> file
            </div>
          )}
        </div>

        <ErrorMsg message={error} onDismiss={() => setError('')} />

        {/* Mode selection */}
        <div style={{ fontSize: 12, color: 'var(--text-1)', marginBottom: 12, fontWeight: 600 }}>
          Class Resolution Strategy
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {RADIO_OPTS.map(opt => (
            <label key={opt.value} style={{
              display: 'flex',
              gap: 10,
              alignItems: 'flex-start',
              cursor: loading ? 'not-allowed' : 'pointer',
              opacity: loading ? 0.5 : 1,
            }}>
              <input
                type="radio"
                name="importMode"
                value={opt.value}
                checked={mode === opt.value}
                onChange={e => setMode(e.target.value)}
                disabled={loading}
                style={{ accentColor: 'var(--teal)', marginTop: 2 }}
              />
              <div>
                <div style={{ fontSize: 13, color: 'var(--text-1)', fontWeight: 500 }}>{opt.title}</div>
                <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-3)', marginTop: 2 }}>{opt.desc}</div>
              </div>
            </label>
          ))}
        </div>
      </Modal.Body>

      <Modal.Footer>
        <Btn variant="ghost" onClick={handleClose} disabled={loading}>Cancel</Btn>
        <Btn
          variant={file ? 'primary' : 'ghost'}
          onClick={handleImport}
          disabled={!file || loading}
        >
          {loading ? 'Importing…' : 'Start Import'}
        </Btn>
      </Modal.Footer>
    </Modal>
  )
}