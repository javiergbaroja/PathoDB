// frontend/src/pages/PatientDetail/RegisterScanModal.jsx
import { useState, useEffect } from 'react'
import { Modal, Btn, FormField, FormInput, FormSelect, ErrorMsg } from '../../components/ui'
import { api } from '../../api'

const FILE_FORMATS = ['SVS', 'CZI', 'NDPI', 'SCN', 'TIF', 'MRXS', 'VSI', 'BIF', 'OTHER']

export default function RegisterScanModal({ block, probe, sub, existingScans, onClose, onSuccess }) {
  const [stains,  setStains]  = useState([])
  const [form,    setForm]    = useState({ stain_name: '', file_path: '', file_format: 'SVS', magnification: '' })
  const [saving,  setSaving]  = useState(false)
  const [error,   setError]   = useState('')

  useEffect(() => { api.getStains().then(setStains).catch(() => {}) }, [])

  const existingStains = new Set(existingScans.map(s => s.stain_name).filter(Boolean))
  const isDuplicate    = form.stain_name && existingStains.has(form.stain_name)

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    setSaving(true)
    try {
      await api.registerScan({
        lis_submission_id: sub.lis_submission_id,
        lis_probe_id:      probe.lis_probe_id,
        block_label:       block.block_label,
        stain_name:        form.stain_name,
        file_path:         form.file_path,
        file_format:       form.file_format || null,
        magnification:     form.magnification ? parseFloat(form.magnification) : null,
        block_lis_ref:     block.block_label,
      })
      onSuccess()
    } catch (e) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      isOpen
      onClose={onClose}
      title="Register scan"
      subtitle={`${sub.lis_submission_id} / ${probe.lis_probe_id} / Block ${block.block_label}`}
      width={480}
    >
      <form onSubmit={handleSubmit}>
        <Modal.Body style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
          <ErrorMsg message={error} onDismiss={() => setError('')} />

          <FormField label="Stain *">
            <FormSelect
              required
              value={form.stain_name}
              onChange={e => setForm(f => ({ ...f, stain_name: e.target.value }))}
            >
              <option value="">Select stain…</option>
              {stains.map(s => (
                <option key={s.id} value={s.stain_name}>{s.stain_name} ({s.stain_category})</option>
              ))}
            </FormSelect>
            {isDuplicate && (
              <div style={{ marginTop: 5, fontSize: 12, color: 'var(--warning)', fontWeight: 500 }}>
                ⚠ A {form.stain_name} scan already exists for this block. You can still proceed.
              </div>
            )}
          </FormField>

          <FormField label="File path *">
            <FormInput
              required
              type="text"
              placeholder="/storage/slides/..."
              value={form.file_path}
              onChange={e => setForm(f => ({ ...f, file_path: e.target.value }))}
            />
          </FormField>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <FormField label="Format">
              <FormSelect
                value={form.file_format}
                onChange={e => setForm(f => ({ ...f, file_format: e.target.value }))}
              >
                {FILE_FORMATS.map(fmt => <option key={fmt} value={fmt}>{fmt}</option>)}
              </FormSelect>
            </FormField>
            <FormField label="Magnification">
              <FormInput
                type="number"
                step="0.1"
                min="0"
                placeholder="e.g. 40"
                value={form.magnification}
                onChange={e => setForm(f => ({ ...f, magnification: e.target.value }))}
              />
            </FormField>
          </div>

          {existingScans.length > 0 && (
            <div style={{
              background: 'var(--navy-05)',
              borderRadius: 'var(--radius-md)',
              padding: '8px 12px',
              fontSize: 12,
              color: 'var(--text-2)',
            }}>
              <span style={{ fontWeight: 600, color: 'var(--navy)' }}>Already registered: </span>
              {existingScans.map(s => s.stain_name).filter(Boolean).join(', ')}
            </div>
          )}
        </Modal.Body>

        <Modal.Footer>
          <Btn variant="ghost" type="button" onClick={onClose}>Cancel</Btn>
          <Btn variant="primary" type="submit" disabled={saving}>
            {saving ? 'Registering…' : 'Register scan'}
          </Btn>
        </Modal.Footer>
      </form>
    </Modal>
  )
}