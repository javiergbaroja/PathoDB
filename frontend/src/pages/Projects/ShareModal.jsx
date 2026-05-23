import { useState } from 'react'
import { Modal, Btn, FormLabel, FormInput, FormSelect, FormField, ErrorMsg, Badge } from '../../components/ui'
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
            <Btn variant="primary" onClick={handleShare} disabled={loading || !query.trim()}>
              {loading ? '…' : 'Share'}
            </Btn>
          </div>
        </FormField>

        <ErrorMsg message={error} onDismiss={() => setError('')} />

        {success && (
          <div style={{ marginBottom: 10 }}>
            <Badge variant="green">{success}</Badge>
          </div>
        )}

        {shares.length > 0 && (
          <>
            <FormLabel style={{ marginTop: 8 }}>Current access</FormLabel>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {shares.map(sh => (
                <div key={sh.user_id} style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '8px 10px',
                  borderRadius: 'var(--radius-md)',
                  background: 'var(--navy-05)',
                  border: '1px solid var(--border-l)',
                }}>
                  <div style={{
                    width: 28, height: 28, borderRadius: '50%',
                    background: 'var(--navy)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 11, fontWeight: 700, color: 'var(--white)', flexShrink: 0,
                  }}>
                    {(sh.username || 'U').slice(0, 2).toUpperCase()}
                  </div>

                  <span style={{ flex: 1, fontSize: 'var(--text-base)', color: 'var(--text-1)' }}>
                    {sh.username}
                  </span>

                  <FormSelect
                    value={sh.access_level}
                    onChange={e => handleUpdateAccess(sh.user_id, e.target.value)}
                    style={{ width: 'auto', fontSize: 12, padding: '4px 8px' }}
                  >
                    <option value="read">View only</option>
                    <option value="edit">Can annotate</option>
                  </FormSelect>

                  <Btn
                    variant="link"
                    onClick={() => handleRevoke(sh.user_id)}
                    title="Revoke access"
                    style={{ color: 'var(--crimson)', padding: '2px 4px', fontSize: 16 }}
                  >
                    ×
                  </Btn>
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
