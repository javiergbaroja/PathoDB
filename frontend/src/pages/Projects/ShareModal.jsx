// frontend/src/pages/Projects/ShareModal.jsx
import { useState } from 'react'
import { Modal, Btn, FormLabel, FormInput, FormSelect, FormField, ErrorMsg } from '../../components/ui'
import { api } from '../../api'

export default function ShareModal({ project, onClose, onUpdated }) {
  const [query,   setQuery]   = useState('')
  const [access,  setAccess]  = useState('read')
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState('')
  const [success, setSuccess] = useState('')

  const shares = project.shares || []

  async function handleShare() {
    if (!query.trim()) return
    setLoading(true); setError(''); setSuccess('')
    try {
      await api.shareProject(project.id, { username_or_email: query.trim(), access_level: access })
      setSuccess(`Shared with ${query.trim()}`)
      setQuery('')
      onUpdated()
    } catch (e) {
      setError(e.message || 'Failed to share')
    } finally {
      setLoading(false)
    }
  }

  async function handleRevoke(userId) {
    try {
      await api.revokeShare(project.id, userId)
      onUpdated()
    } catch (e) {
      setError(e.message || 'Failed to revoke')
    }
  }

  async function handleUpdateAccess(userId, newLevel) {
    try {
      await api.updateShare(project.id, userId, newLevel)
      onUpdated()
    } catch (e) {
      setError(e.message || 'Failed to update')
    }
  }

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={`Share "${project.name}"`}
      subtitle="You are the owner. You can grant or revoke access at any time."
      width={460}
    >
      <Modal.Body>
        {/* Add collaborator */}
        <FormField label="Add collaborator">
          <div style={{ display: 'flex', gap: 8 }}>
            <FormInput
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleShare()}
              placeholder="Username or email"
              style={{ flex: 1 }}
            />
            <FormSelect
              value={access}
              onChange={e => setAccess(e.target.value)}
              style={{ width: 'auto', flexShrink: 0 }}
            >
              <option value="read">View only</option>
              <option value="edit">Can annotate</option>
            </FormSelect>
            <Btn
              variant="primary"
              onClick={handleShare}
              disabled={loading || !query.trim()}
            >
              {loading ? '…' : 'Share'}
            </Btn>
          </div>
        </FormField>

        <ErrorMsg message={error} onDismiss={() => setError('')} />

        {success && (
          <div style={{
            marginBottom: 10,
            padding: '8px 10px',
            borderRadius: 'var(--radius-md)',
            background: 'var(--success-bg)',
            color: 'var(--success)',
            fontSize: 12,
          }}>
            {success}
          </div>
        )}

        {/* Current shares */}
        {shares.length > 0 && (
          <>
            <FormLabel style={{ marginTop: 8 }}>Current access</FormLabel>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {shares.map(s => (
                <div key={s.user_id} style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '8px 10px',
                  borderRadius: 'var(--radius-md)',
                  background: 'var(--navy-05)',
                  border: '1px solid var(--border-l)',
                }}>
                  {/* Avatar */}
                  <div style={{
                    width: 28, height: 28, borderRadius: '50%',
                    background: 'var(--navy)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 11, fontWeight: 700, color: 'var(--white)', flexShrink: 0,
                  }}>
                    {(s.username || 'U').slice(0, 2).toUpperCase()}
                  </div>

                  <span style={{ flex: 1, fontSize: 'var(--text-base)', color: 'var(--text-1)' }}>
                    {s.username}
                  </span>

                  <FormSelect
                    value={s.access_level}
                    onChange={e => handleUpdateAccess(s.user_id, e.target.value)}
                    style={{ width: 'auto', fontSize: 12, padding: '4px 8px' }}
                  >
                    <option value="read">View only</option>
                    <option value="edit">Can annotate</option>
                  </FormSelect>

                  <button
                    onClick={() => handleRevoke(s.user_id)}
                    title="Revoke access"
                    style={{
                      background: 'none', border: 'none', cursor: 'pointer',
                      color: 'var(--crimson)', fontSize: 16, lineHeight: 1, padding: '2px',
                    }}
                  >×</button>
                </div>
              ))}
            </div>
          </>
        )}

        {shares.length === 0 && (
          <div style={{ textAlign: 'center', padding: '16px 0', fontSize: 12, color: 'var(--text-3)' }}>
            Not shared with anyone yet.
          </div>
        )}
      </Modal.Body>

      <Modal.Footer>
        <Btn variant="ghost" onClick={onClose}>Done</Btn>
      </Modal.Footer>
    </Modal>
  )
}