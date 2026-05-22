// frontend/src/pages/TMAs/CreateTMAModal.jsx
import { useState } from 'react'
import { api } from '../../api'
import { Modal, Btn, FormField, FormInput } from '../../components/ui'

export default function CreateTMAModal({ onClose, onCreated }) {
  const [name, setName] = useState('')
  const [description, setDesc] = useState('')
  const [isPublic, setIsPublic] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const handleCreate = async () => {
    if (!name.trim()) return
    setLoading(true)
    try {
      const fd = new FormData()
      fd.append('name', name.trim())
      fd.append('description', description.trim())
      fd.append('is_public', isPublic)
      
      const result = await api.createTMA(fd)
      onCreated(result)
    } catch (e) {
      setError(e.message || 'Failed to create TMA')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Modal isOpen={true} onClose={onClose} title="Register New TMA" width={480}>
      <Modal.Body style={{ padding: '24px 28px' }}>
        <FormField label="TMA Name *" style={{ marginBottom: 16 }}>
          <FormInput autoFocus value={name} onChange={e => setName(e.target.value)} placeholder="e.g. CRC TMA Cohort A" />
        </FormField>
        
        <FormField label="Description (optional)" style={{ marginBottom: 16 }}>
          <FormInput value={description} onChange={e => setDesc(e.target.value)} placeholder="Details regarding cohort or study..." />
        </FormField>

        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13, color: 'var(--text-1)' }}>
          <input type="checkbox" checked={isPublic} onChange={e => setIsPublic(e.target.checked)} style={{ accentColor: 'var(--teal)' }} />
          Make globally visible to all researchers
        </label>

        {error && <div style={{ marginTop: 16, padding: 12, background: 'var(--crimson-10)', color: 'var(--crimson)', borderRadius: 'var(--radius-sm)', fontSize: 12 }}>{error}</div>}
      </Modal.Body>
      <Modal.Footer>
        <Btn variant="ghost" onClick={onClose}>Cancel</Btn>
        <Btn variant="primary" onClick={handleCreate} disabled={!name.trim() || loading}>
          {loading ? 'Creating...' : 'Create TMA'}
        </Btn>
      </Modal.Footer>
    </Modal>
  )
}