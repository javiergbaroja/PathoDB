// frontend/src/pages/TMADetail/TMAManageModal.jsx
import { useState } from 'react'
import { Modal, Btn, ErrorMsg, Badge, SegmentedControl, FileDropZone } from '../../components/ui'

const CSV_SPECS = {
  cores: {
    title:       'Core Map CSV',
    description: 'Maps each spot in the array to a patient block. Uploading replaces all existing core data.',
    accept:      '.csv',
    columns: [
      { name: 'row',                 required: true,  example: '1',               desc: 'Integer row index' },
      { name: 'col',                 required: true,  example: '1',               desc: 'Integer column index' },
      { name: 'identifier',          required: false, example: 'B08.17770_I_I',   desc: 'Block identifier (era-aware)' },
      { name: 'core_type',           required: false, example: 'tissue',          desc: 'tissue | control | empty' },
      { name: 'description',         required: false, example: 'Tonsil control',  desc: 'Free text if core_type=control' },
    ],
  },
  scans: {
    title:       'WSI Scans CSV',
    description: 'Registers Whole Slide Images for this TMA. Uploading adds to existing scans (duplicates are skipped).',
    accept:      '.csv',
    columns: [
      { name: 'file_path',  required: true, example: '/storage/research/.../TMA_HE.ndpi', desc: 'Absolute NFS path' },
      { name: 'stain_name', required: true, example: 'HE',                   desc: 'Must match a registered stain' },
    ],
  },
}

function UploadTab({ spec, onUpload, loading, error, result }) {
  const [file, setFile] = useState(null)

  function handleSubmit() {
    if (!file) return
    onUpload(file)
    setFile(null)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <p style={{ fontSize: 13, color: 'var(--text-2)', lineHeight: 1.6 }}>
        {spec.description}
      </p>

      {/* Column reference */}
      <div style={{
        background: 'var(--navy-05)', border: '1px solid var(--border-l)',
        borderRadius: 'var(--radius-md)', overflow: 'hidden',
      }}>
        <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--border-l)', background: 'var(--white)' }}>
          <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            Required columns
          </span>
        </div>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <tbody>
            {spec.columns.map(col => (
              <tr key={col.name} style={{ borderBottom: '1px solid var(--border-l)' }}>
                <td style={{ padding: '7px 12px', fontFamily: 'var(--font-mono)', color: 'var(--navy)', fontWeight: 600, whiteSpace: 'nowrap' }}>
                  {col.name}
                  {!col.required && (
                    <span style={{ marginLeft: 4, fontSize: 9, fontWeight: 400, color: 'var(--text-3)', fontFamily: 'var(--font-sans)' }}>optional</span>
                  )}
                </td>
                <td style={{ padding: '7px 12px', color: 'var(--text-2)' }}>{col.desc}</td>
                <td style={{ padding: '7px 12px', fontFamily: 'var(--font-mono)', color: 'var(--text-3)', textAlign: 'right', whiteSpace: 'nowrap' }}>
                  {col.example}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Result feedback */}
      {result && <Badge variant="green" style={{ fontSize: 12, padding: '6px 10px', borderRadius: 'var(--radius-md)', whiteSpace: 'normal', lineHeight: 1.5 }}>{result}</Badge>}

      <ErrorMsg message={error} />

      {/* File picker */}
      <FileDropZone
        file={file}
        onSelect={f => setFile(f)}
        accept={spec.accept}
        disabled={loading}
        padding={20}
        iconSize={22}
        hint={<>Click or drag to select a <strong>.csv</strong> file</>}
      />

      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <Btn variant="primary" onClick={handleSubmit} disabled={!file || loading}>
          {loading ? 'Uploading…' : 'Upload & Replace'}
        </Btn>
      </div>
    </div>
  )
}

export default function TMAManageModal({ isOpen, onClose, tmaId, onCoresUpdated, onScansUpdated, coreCount, scanCount }) {
  const [activeTab, setActiveTab] = useState('cores')
  const [loading,   setLoading]   = useState(false)
  const [error,     setError]     = useState('')
  const [result,    setResult]    = useState('')

  function handleTabChange(tab) {
    setActiveTab(tab)
    setError('')
    setResult('')
  }

  async function handleCoresUpload(file) {
    setLoading(true); setError(''); setResult('')
    try {
      const { api } = await import('../../api')
      const res = await api.uploadTMACoresCSV(tmaId, file)
      if (res.total === 0) {
        setError('0 cores were mapped. Check your CSV headers and delimiter.')
      } else {
        setResult(`✓ Mapped ${res.total} cores — ${res.matched} matched to patient blocks, ${res.total - res.matched} unmatched.`)
        onCoresUpdated?.()
      }
    } catch (e) {
      setError(e.message || 'Upload failed')
    } finally {
      setLoading(false)
    }
  }

  async function handleScansUpload(file) {
    setLoading(true); setError(''); setResult('')
    try {
      const { api } = await import('../../api')
      const res = await api.uploadTMAScansCSV(tmaId, file)
      if (res.total === 0) {
        setError('0 scans were registered. Check file_path and stain_name columns.')
      } else {
        setResult(`✓ Processed ${res.total} scans — ${res.added} newly registered.`)
        onScansUpdated?.()
      }
    } catch (e) {
      setError(e.message || 'Upload failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Manage TMA Data" subtitle="Upload or replace core mapping and WSI scan lists." width={560}>
      {/* Tabs */}
      <div style={{ padding: '10px 24px', borderBottom: '1px solid var(--border-l)' }}>
        <SegmentedControl
          value={activeTab}
          onChange={handleTabChange}
          options={[
            { value: 'cores', label: `Core Map${coreCount > 0 ? ` (${coreCount})` : ''}` },
            { value: 'scans', label: `WSI Scans${scanCount > 0 ? ` (${scanCount})` : ''}` },
          ]}
        />
      </div>

      <Modal.Body>
        {activeTab === 'cores' && (
          <UploadTab
            spec={CSV_SPECS.cores}
            onUpload={handleCoresUpload}
            loading={loading}
            error={error}
            result={result}
          />
        )}
        {activeTab === 'scans' && (
          <UploadTab
            spec={CSV_SPECS.scans}
            onUpload={handleScansUpload}
            loading={loading}
            error={error}
            result={result}
          />
        )}
      </Modal.Body>

      <Modal.Footer>
        <Btn variant="ghost" onClick={onClose}>Close</Btn>
      </Modal.Footer>
    </Modal>
  )
}