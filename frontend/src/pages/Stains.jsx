import { useState, useEffect } from 'react'
import { useForm } from 'react-hook-form'
import Layout from '../components/Layout'
import {
  Badge, Btn, Table, Th, Td, Tr, IdCell,
  ErrorMsg, SpinnerPage, Modal, FormInput, FormSelect,
  FormField,
} from '../components/ui'
import { api } from '../api'

const CATEGORIES = ['HE', 'IHC', 'special_stain', 'FISH', 'other']

// ── Edit modal ────────────────────────────────────────────────────────────────

function EditModal({ stain, onSave, onClose }) {
  const { register, handleSubmit, formState: { isSubmitting, errors } } = useForm({
    defaultValues: {
      stain_name:     stain.stain_name,
      stain_category: stain.stain_category,
      aliases:        stain.aliases?.join(', ') || '',
    },
  })

  async function submit(form) {
    await onSave(stain.id, {
      stain_name:     form.stain_name,
      stain_category: form.stain_category,
      aliases:        form.aliases.split(',').map(a => a.trim()).filter(Boolean),
    })
  }

  return (
    <Modal isOpen onClose={onClose} title="Edit stain" width={420}>
      <form onSubmit={handleSubmit(submit)} noValidate>
        <Modal.Body>
          <FormField label="Stain name" htmlFor="stain-name" error={errors.stain_name?.message}>
            <FormInput
              id="stain-name"
              aria-invalid={!!errors.stain_name}
              {...register('stain_name', { required: 'Required' })}
            />
          </FormField>
          <FormField label="Aliases (comma separated)" htmlFor="stain-aliases">
            <FormInput id="stain-aliases" {...register('aliases')} />
          </FormField>
          <FormField label="Category" htmlFor="stain-category">
            <FormSelect id="stain-category" {...register('stain_category')}>
              {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
            </FormSelect>
          </FormField>
        </Modal.Body>
        <Modal.Footer>
          <Btn variant="ghost" type="button" onClick={onClose}>Cancel</Btn>
          <Btn variant="primary" type="submit" disabled={isSubmitting}>
            {isSubmitting ? 'Saving…' : 'Save'}
          </Btn>
        </Modal.Footer>
      </form>
    </Modal>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function Stains() {
  const [stains, setStains]   = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState('')
  const [filter, setFilter]   = useState({ needs_review: '', category: '' })
  const [editing, setEditing] = useState(null)

  async function load() {
    setLoading(true)
    try {
      const params = {}
      if (filter.needs_review !== '') params.needs_review = filter.needs_review
      if (filter.category)           params.category      = filter.category
      setStains(await api.getStains(params))
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [filter]) // eslint-disable-line

  async function saveStain(id, data) {
    await api.updateStain(id, data)
    setEditing(null)
    load()
  }

  const needsReview = stains.filter(s => s.needs_review)

  const actions = needsReview.length > 0 && (
    <span style={{
      fontSize: 12,
      background: 'var(--warning-bg)',
      color: 'var(--warning)',
      padding: '5px 10px',
      borderRadius: 'var(--radius-md)',
      fontWeight: 500,
    }}>
      {needsReview.length} stain{needsReview.length !== 1 ? 's' : ''} need review
    </span>
  )

  return (
    <Layout title="Stains" actions={actions}>
      <div style={{ height: '100%', overflowY: 'auto', padding: 'var(--space-5) var(--space-6)' }}>
        <ErrorMsg message={error} onDismiss={() => setError('')} />

        {/* Filters */}
        <div style={{ display: 'flex', gap: 10, marginBottom: 'var(--space-4)', alignItems: 'center' }}>
          <FormSelect
            style={{ width: 'auto' }}
            value={filter.category}
            onChange={e => setFilter(f => ({ ...f, category: e.target.value }))}
          >
            <option value="">All categories</option>
            {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
          </FormSelect>
          <FormSelect
            style={{ width: 'auto' }}
            value={filter.needs_review}
            onChange={e => setFilter(f => ({ ...f, needs_review: e.target.value }))}
          >
            <option value="">All</option>
            <option value="true">Needs review</option>
            <option value="false">Reviewed</option>
          </FormSelect>
        </div>

        {loading ? <SpinnerPage /> : (
          <Table>
            <thead>
              <tr>
                <Th>Stain name</Th>
                <Th>Category</Th>
                <Th>Aliases</Th>
                <Th>Scans</Th>
                <Th>Status</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {stains.map(s => (
                <Tr key={s.id} style={{ background: s.needs_review ? 'var(--warning-bg)' : 'var(--white)' }}>
                  <Td><IdCell>{s.stain_name}</IdCell></Td>
                  <Td>
                    <Badge variant={s.stain_category === 'HE' ? 'navy' : 'muted'}>
                      {s.stain_category}
                    </Badge>
                  </Td>
                  <Td mono style={{ color: 'var(--text-3)', fontSize: 'var(--text-sm)' }}>
                    {s.aliases?.join(', ') || '—'}
                  </Td>
                  <Td>
                    <span style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 13,
                      color: s.scan_count > 0 ? 'var(--navy)' : 'var(--text-3)',
                      fontWeight: s.scan_count > 0 ? 600 : 400,
                    }}>
                      {s.scan_count.toLocaleString()}
                    </span>
                  </Td>
                  <Td>
                    {s.needs_review
                      ? <Badge variant="warning">Needs review</Badge>
                      : <Badge variant="green">OK</Badge>}
                  </Td>
                  <Td style={{ textAlign: 'right' }}>
                    <Btn variant="ghost" small onClick={() => setEditing(s)}>Edit</Btn>
                  </Td>
                </Tr>
              ))}
              {stains.length === 0 && (
                <tr>
                  <td colSpan={6} style={{ padding: 24, textAlign: 'center', color: 'var(--text-3)' }}>
                    No stains found
                  </td>
                </tr>
              )}
            </tbody>
          </Table>
        )}

        {editing && (
          <EditModal stain={editing} onSave={saveStain} onClose={() => setEditing(null)} />
        )}
      </div>
    </Layout>
  )
}