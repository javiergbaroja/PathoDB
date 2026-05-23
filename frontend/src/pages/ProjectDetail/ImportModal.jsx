// frontend/src/pages/ProjectDetail/ImportModal.jsx
import { useState } from 'react'
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
    desc:  'Discard any annotations whose class names do not perfectly match the classes defined in this project.',
  },
]

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

  return (
    <FormModal
      isOpen={isOpen}
      onClose={handleClose}
      title="Import GeoJSON"
      width={440}
      error={error}
      onSubmit={handleImport}
      submitLabel="Start Import"
      loadingLabel="Importing…"
      submitVariant={file ? 'primary' : 'ghost'}
      loading={loading}
      canSubmit={!!file}
    >
      <FileDropZone
        file={file}
        onSelect={f => { setFile(f); setError('') }}
        accept=".geojson,.json"
        disabled={loading}
        style={{ marginBottom: 'var(--space-5)' }}
        hint={<>Click or drag to select a <strong>.geojson</strong> file</>}
      />

      {/* Mode selection */}
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
    </FormModal>
  )
}
