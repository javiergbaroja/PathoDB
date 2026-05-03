// frontend/src/pages/Projects/ShareModal.jsx
import { useState } from 'react'
import { api } from '../../api'

export default function ShareModal({ project, onClose, onUpdated }) {
  const [query, setQuery]       = useState('')
  const [access, setAccess]     = useState('read')
  const [loading, setLoading]   = useState(false)
  const [error, setError]       = useState('')
  const [success, setSuccess]   = useState('')

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
    <div onClick={onClose} style={{
      position:'fixed', inset:0, background:'rgba(0,20,100,0.35)',
      display:'flex', alignItems:'center', justifyContent:'center', zIndex:300,
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background:'white', borderRadius:12, width:460,
        boxShadow:'0 12px 40px rgba(0,20,100,0.18)',
        display:'flex', flexDirection:'column', overflow:'hidden',
      }}>
        {/* Header */}
        <div style={{ padding:'20px 24px 16px', borderBottom:'1px solid var(--border-l)' }}>
          <div style={{ fontFamily:'var(--font-serif)', fontSize:18, color:'var(--navy)', marginBottom:2 }}>
            Share "{project.name}"
          </div>
          <div style={{ fontSize:12, color:'var(--text-3)' }}>
            You are the owner. You can grant or revoke access at any time.
          </div>
        </div>

        <div style={{ padding:'20px 24px', overflowY:'auto' }}>
          {/* Add user */}
          <label style={lbl}>Add collaborator</label>
          <div style={{ display:'flex', gap:8, marginBottom:16 }}>
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleShare()}
              placeholder="Username or email"
              style={{ flex:1, ...inp }}
            />
            <select value={access} onChange={e => setAccess(e.target.value)} style={{ ...inp, width:'auto', flexShrink:0 }}>
              <option value="read">View only</option>
              <option value="edit">Can annotate</option>
            </select>
            <button onClick={handleShare} disabled={loading || !query.trim()} style={primaryBtn}>
              {loading ? '…' : 'Share'}
            </button>
          </div>

          {error && <div style={{ marginBottom:10, padding:'8px 10px', borderRadius:6, background:'var(--crimson-10)', color:'var(--crimson)', fontSize:12 }}>{error}</div>}
          {success && <div style={{ marginBottom:10, padding:'8px 10px', borderRadius:6, background:'var(--success-bg)', color:'var(--success)', fontSize:12 }}>{success}</div>}

          {/* Current shares */}
          {shares.length > 0 && (
            <>
              <div style={lbl}>Current access</div>
              <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
                {shares.map(s => (
                  <div key={s.user_id} style={{ display:'flex', alignItems:'center', gap:10, padding:'8px 10px', borderRadius:6, background:'var(--navy-05)', border:'1px solid var(--border-l)' }}>
                    <div style={{ width:28, height:28, borderRadius:'50%', background:'var(--navy)', display:'flex', alignItems:'center', justifyContent:'center', fontSize:11, fontWeight:700, color:'white', flexShrink:0 }}>
                      {(s.username || 'U').slice(0,2).toUpperCase()}
                    </div>
                    <span style={{ flex:1, fontSize:13, color:'var(--text-1)' }}>{s.username}</span>
                    <select
                      value={s.access_level}
                      onChange={e => handleUpdateAccess(s.user_id, e.target.value)}
                      style={{ ...inp, width:'auto', fontSize:12, padding:'4px 8px' }}>
                      <option value="read">View only</option>
                      <option value="edit">Can annotate</option>
                    </select>
                    <button onClick={() => handleRevoke(s.user_id)} title="Revoke access"
                      style={{ background:'none', border:'none', cursor:'pointer', color:'var(--crimson)', fontSize:16, lineHeight:1, padding:'2px' }}>
                      ×
                    </button>
                  </div>
                ))}
              </div>
            </>
          )}

          {shares.length === 0 && (
            <div style={{ textAlign:'center', padding:'16px 0', fontSize:12, color:'var(--text-3)' }}>
              Not shared with anyone yet.
            </div>
          )}
        </div>

        <div style={{ padding:'14px 24px', borderTop:'1px solid var(--border-l)', display:'flex', justifyContent:'flex-end' }}>
          <button onClick={onClose} style={ghostBtn}>Done</button>
        </div>
      </div>
    </div>
  )
}

const lbl = { display:'block', fontSize:11, fontWeight:600, color:'var(--text-3)', textTransform:'uppercase', letterSpacing:'0.06em', marginBottom:6 }
const inp = { width:'100%', padding:'7px 10px', border:'1px solid var(--border)', borderRadius:6, fontSize:13, outline:'none', fontFamily:'var(--font-sans)', background:'white' }
const ghostBtn = { padding:'7px 16px', borderRadius:6, border:'1px solid var(--border)', background:'white', cursor:'pointer', fontSize:13, fontFamily:'var(--font-sans)', color:'var(--text-2)' }
const primaryBtn = { padding:'7px 14px', borderRadius:6, border:'none', background:'var(--navy)', color:'white', cursor:'pointer', fontSize:13, fontFamily:'var(--font-sans)', fontWeight:500, opacity:1, flexShrink:0 }