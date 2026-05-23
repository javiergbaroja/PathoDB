import { useForm } from 'react-hook-form'
import { api } from '../../api'
import { Modal, Btn, FormField, FormInput, ErrorMsg } from '../../components/ui'

export default function CreateTMAModal({ onClose, onCreated }) {
  const {
    register, handleSubmit,
    formState: { isSubmitting, errors },
    setError,
  } = useForm({
    defaultValues: { name: '', description: '', is_public: false },
  })

  async function onSubmit(form) {
    try {
      const fd = new FormData()
      fd.append('name',        form.name.trim())
      fd.append('description', form.description.trim())
      fd.append('is_public',   form.is_public)
      const result = await api.createTMA(fd)
      onCreated(result)
    } catch (e) {
      setError('root', { message: e.message || 'Failed to create TMA' })
    }
  }

  return (
    <Modal isOpen onClose={onClose} title="Register New TMA" width={480}>
      <form onSubmit={handleSubmit(onSubmit)} noValidate>
        <Modal.Body style={{ padding: '24px 28px' }}>
          <FormField label="TMA Name *" htmlFor="tma-name" error={errors.name?.message}>
            <FormInput
              id="tma-name"
              autoFocus
              placeholder="e.g. CRC TMA Cohort A"
              aria-invalid={!!errors.name}
              {...register('name', { required: 'Name is required' })}
            />
          </FormField>

          <FormField label="Description (optional)" htmlFor="tma-desc">
            <FormInput
              id="tma-desc"
              placeholder="Details regarding cohort or study…"
              {...register('description')}
            />
          </FormField>

          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13, color: 'var(--text-1)' }}>
            <input type="checkbox" style={{ accentColor: 'var(--teal)' }} {...register('is_public')} />
            Make globally visible to all researchers
          </label>

          <ErrorMsg message={errors.root?.message} style={{ marginTop: 16 }} />
        </Modal.Body>
        <Modal.Footer>
          <Btn variant="ghost" type="button" onClick={onClose}>Cancel</Btn>
          <Btn variant="primary" type="submit" disabled={isSubmitting}>
            {isSubmitting ? 'Creating…' : 'Create TMA'}
          </Btn>
        </Modal.Footer>
      </form>
    </Modal>
  )
}
