// frontend/src/pages/PatientDetail/EditModals.jsx
import { useState } from 'react'
import { Modal, Btn, FormField, FormInput, ErrorMsg, MultiSelect } from '../../components/ui'
import { api } from '../../api'

// ── ProbeModal ────────────────────────────────────────────────────────────────
export function ProbeModal({ sub, existing, onClose, onSave, saving }) {
  const isEdit = !!existing
  const [form, setForm] = useState({
    lis_probe_id:        existing?.lis_probe_id        ?? '',
    submission_type:     existing?.submission_type     ?? '',
    snomed_topo_code:    existing?.snomed_topo_code    ?? '',
    topo_description:    existing?.topo_description    ?? '',
    location_additional: existing?.location_additional ?? '',
    snomed_morph_codes:    existing?.snomed_morph_codes?.map(c => c.code) ?? [],
    snomed_etio_codes:      existing?.snomed_etio_codes?.map(c => c.code) ?? [],
  })
  const [error, setError] = useState('')

  function set(field) { return e => setForm(f => ({ ...f, [field]: e.target.value })) }

  async function handleSave() {
    if (!form.lis_probe_id.trim()) { setError('Probe ID is required'); return }
    setError('')
    try {
      await onSave({
        lis_probe_id:        form.lis_probe_id        || null,
        submission_type:     form.submission_type     || null,
        snomed_topo_code:    form.snomed_topo_code    || null,
        topo_description:    form.topo_description    || null,
        location_additional: form.location_additional || null,
        snomed_morph_codes:    form.snomed_morph_codes,
        snomed_etio_codes:      form.snomed_etio_codes,
      })
    } catch (e) { setError(e.message) }
  }

  return (
    <Modal isOpen onClose={onClose} title={isEdit ? 'Edit probe' : 'Add probe'} subtitle={sub.lis_submission_id} width={460}>
      <Modal.Body style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
        <ErrorMsg message={error} onDismiss={() => setError('')} />
        <FormField label="Probe ID *" htmlFor="probe-id">
          <FormInput id="probe-id" value={form.lis_probe_id} onChange={set('lis_probe_id')} placeholder="e.g. I" />
        </FormField>
        <FormField label="Submission type" htmlFor="probe-type">
          <FormInput id="probe-type" value={form.submission_type} onChange={set('submission_type')} placeholder="e.g. Biopsy" />
        </FormField>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <FormField label="SNOMED topo code" htmlFor="probe-snomed">
            <FormInput id="probe-snomed" value={form.snomed_topo_code} onChange={set('snomed_topo_code')} placeholder="e.g. T-59000" />
          </FormField>
          <FormField label="Topo description" htmlFor="probe-topo">
            <FormInput id="probe-topo" value={form.topo_description} onChange={set('topo_description')} placeholder="e.g. Colon" />
          </FormField>
        </div>
        <FormField label="Location (additional)" htmlFor="probe-loc">
          <FormInput id="probe-loc" value={form.location_additional} onChange={set('location_additional')} placeholder="e.g. Ascending" />
        </FormField>
        <FormField label="Morphology codes">
          <MultiSelect
            selected={form.snomed_morph_codes}
            onChange={val => setForm(f => ({ ...f, snomed_morph_codes: val }))}
            loadOptions={val => api.lookup('snomed_morph_code', val)}
            placeholder="e.g. M-81403"
          />
        </FormField>
        <FormField label="Etiology codes">
          <MultiSelect
            selected={form.snomed_etio_codes}
            onChange={val => setForm(f => ({ ...f, snomed_etio_codes: val }))}
            loadOptions={val => api.lookup('snomed_etiology_code', val)}
            placeholder="e.g. L-25000"
          />
        </FormField>
      </Modal.Body>
      <Modal.Footer>
        <Btn variant="ghost" onClick={onClose}>Cancel</Btn>
        <Btn variant="primary" onClick={handleSave} disabled={saving}>
          {saving ? 'Saving…' : (isEdit ? 'Save changes' : 'Add probe')}
        </Btn>
      </Modal.Footer>
    </Modal>
  )
}

// ── BlockModal ────────────────────────────────────────────────────────────────
export function BlockModal({ probe, existing, onClose, onSave, saving }) {
  const isEdit = !!existing
  const [form, setForm] = useState({
    block_label:    existing?.block_label    ?? '',
    block_sequence: existing?.block_sequence ?? '',
    block_info:     existing?.block_info     ?? '',
    tissue_count:   existing?.tissue_count   ?? '',
  })
  const [error, setError] = useState('')

  function set(field) { return e => setForm(f => ({ ...f, [field]: e.target.value })) }

  async function handleSave() {
    if (!form.block_label.trim()) { setError('Block label is required'); return }
    setError('')
    try {
      await onSave({
        block_label:    form.block_label                            || null,
        block_sequence: form.block_sequence ? parseInt(form.block_sequence) : null,
        block_info:     form.block_info                            || null,
        tissue_count:   form.tissue_count   ? parseInt(form.tissue_count)   : null,
      })
    } catch (e) { setError(e.message) }
  }

  return (
    <Modal isOpen onClose={onClose}
      title={isEdit ? 'Edit block' : 'Add block'}
      subtitle={`Probe ${probe.lis_probe_id}`}
      width={400}>
      <Modal.Body style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
        <ErrorMsg message={error} onDismiss={() => setError('')} />
        <FormField label="Block label *" htmlFor="block-label">
          <FormInput id="block-label" value={form.block_label} onChange={set('block_label')} placeholder="e.g. A" />
        </FormField>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <FormField label="Sequence" htmlFor="block-seq">
            <FormInput id="block-seq" type="number" value={form.block_sequence} onChange={set('block_sequence')} placeholder="e.g. 1" />
          </FormField>
          <FormField label="Tissue count" htmlFor="block-tissue">
            <FormInput id="block-tissue" type="number" value={form.tissue_count} onChange={set('tissue_count')} placeholder="e.g. 3" />
          </FormField>
        </div>
        <FormField label="Block info" htmlFor="block-info">
          <FormInput id="block-info" value={form.block_info} onChange={set('block_info')} placeholder="Free text notes" />
        </FormField>
      </Modal.Body>
      <Modal.Footer>
        <Btn variant="ghost" onClick={onClose}>Cancel</Btn>
        <Btn variant="primary" onClick={handleSave} disabled={saving}>
          {saving ? 'Saving…' : (isEdit ? 'Save changes' : 'Add block')}
        </Btn>
      </Modal.Footer>
    </Modal>
  )
}

// ── ConfirmDeleteModal ────────────────────────────────────────────────────────
export function ConfirmDeleteModal({ title, message, onClose, onConfirm, saving }) {
  const [error, setError] = useState('')

  async function handleConfirm() {
    setError('')
    try { await onConfirm() }
    catch (e) { setError(e.message) }
  }

  return (
    <Modal isOpen onClose={onClose} title={title} width={400}>
      <Modal.Body>
        <ErrorMsg message={error} onDismiss={() => setError('')} />
        <p style={{ margin: 0, fontSize: 13, color: 'var(--text-1)', lineHeight: 1.6 }}>{message}</p>
      </Modal.Body>
      <Modal.Footer>
        <Btn variant="ghost" onClick={onClose}>Cancel</Btn>
        <Btn variant="danger" onClick={handleConfirm} disabled={saving}>
          {saving ? 'Deleting…' : 'Delete'}
        </Btn>
      </Modal.Footer>
    </Modal>
  )
}