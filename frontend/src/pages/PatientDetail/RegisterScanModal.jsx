// frontend/src/pages/PatientDetail/RegisterScanModal.jsx
import { useState, useEffect } from 'react'
import { useForm } from 'react-hook-form'
import { Modal, Btn, FormField, FormInput, FormSelect, ErrorMsg } from '../../components/ui'
import { api } from '../../api'

const FILE_FORMATS = ['SVS', 'CZI', 'NDPI', 'SCN', 'TIF', 'MRXS', 'VSI', 'BIF', 'OTHER']

export default function RegisterScanModal({ block, probe, sub, existingScans, onClose, onSuccess, existingScan, submissionProbes = [] }) {
  const [stains, setStains] = useState([])
  const [error,  setError]  = useState('')
  const isEditing = !!existingScan

  const {
    register, handleSubmit, watch,
    formState: { isSubmitting, errors },
  } = useForm({
    defaultValues: isEditing
      ? { stain_name: existingScan.stain_name ?? '', file_format: existingScan.file_format ?? 'SVS', magnification: existingScan.magnification ?? '', block_id: block.id }
      : { stain_name: '', file_path: '', file_format: 'SVS', magnification: '' },
  })

  useEffect(() => { api.getStains().then(setStains).catch(() => {}) }, [])

  const stainName = watch('stain_name')
  const selectedBlockId = Number(watch('block_id'))
  const isMoving = isEditing && selectedBlockId && selectedBlockId !== block.id
  const existingStains = new Set(existingScans.map(s => s.stain_name).filter(Boolean))
  // The duplicate-stain hint only applies to the current block. We don't have the
  // destination block's scans loaded, so suppress it while reassigning.
  const isDuplicate = stainName && !isMoving && existingStains.has(stainName)

  async function onSubmit(form) {
    setError('')
    try {
      if (isEditing) {
        const nextBlockId = Number(form.block_id)
        await api.updateScan(existingScan.id, {
          stain_name:    form.stain_name   || null,
          file_format:   form.file_format  || null,
          magnification: form.magnification ? parseFloat(form.magnification) : null,
          // Only send block_id when the scan is actually being moved.
          ...(nextBlockId && nextBlockId !== block.id ? { block_id: nextBlockId } : {}),
        })
      } else {
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
      }
      onSuccess()
    } catch (e) {
      setError(e.message)
    }
  }

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={isEditing ? 'Edit scan' : 'Register scan'}
      subtitle={`${sub.lis_submission_id} / ${probe.lis_probe_id} / Block ${block.block_label}`}
      width={480}
    >
      <form onSubmit={handleSubmit(onSubmit)} noValidate>
        <Modal.Body style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
          <ErrorMsg message={error} onDismiss={() => setError('')} />

          <FormField label="Stain *" htmlFor="scan-stain" error={errors.stain_name?.message}>
            <FormSelect
              id="scan-stain"
              aria-invalid={!!errors.stain_name}
              {...register('stain_name', { required: 'Stain is required' })}
            >
              <option value="">Select stain…</option>
              {stains.map(s => (
                <option key={s.id} value={s.stain_name}>{s.stain_name} ({s.stain_category})</option>
              ))}
            </FormSelect>
            {isDuplicate && (
              <div style={{ marginTop: 5, fontSize: 12, color: 'var(--warning)', fontWeight: 500 }}>
                ⚠ A {stainName} scan already exists for this block. You can still proceed.
              </div>
            )}
          </FormField>

          {isEditing && submissionProbes.length > 0 && (
            <FormField label="Block" htmlFor="scan-block">
              <FormSelect id="scan-block" {...register('block_id')}>
                {submissionProbes.map(p => (
                  <optgroup key={p.id} label={`Probe ${p.lis_probe_id}`}>
                    {(p.blocks ?? []).map(b => (
                      <option key={b.id} value={b.id}>
                        Block {b.block_label}{b.id === block.id ? ' (current)' : ''}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </FormSelect>
              {isMoving && (
                <div style={{ marginTop: 5, fontSize: 12, color: 'var(--text-2)' }}>
                  This scan will move out of Block {block.block_label} into the selected block.
                </div>
              )}
            </FormField>
          )}

          {!isEditing && (
            <FormField label="File path *" htmlFor="scan-path" error={errors.file_path?.message}>
              <FormInput
                id="scan-path"
                type="text"
                placeholder="/storage/slides/..."
                aria-invalid={!!errors.file_path}
                {...register('file_path', { required: !isEditing ? 'File path is required' : false })}
              />
            </FormField>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <FormField label="Format" htmlFor="scan-format">
              <FormSelect id="scan-format" {...register('file_format')}>
                {FILE_FORMATS.map(fmt => <option key={fmt} value={fmt}>{fmt}</option>)}
              </FormSelect>
            </FormField>
            <FormField label="Magnification" htmlFor="scan-mag">
              <FormInput
                id="scan-mag"
                type="number"
                step="0.1"
                min="0"
                placeholder="e.g. 40"
                {...register('magnification')}
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
          <Btn variant="primary" type="submit" disabled={isSubmitting}>
            {isSubmitting ? (isEditing ? 'Saving…' : 'Registering…') : (isEditing ? 'Save changes' : 'Register scan')}
          </Btn>
        </Modal.Footer>
      </form>
    </Modal>
  )
}
