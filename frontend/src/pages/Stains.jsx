import { useState, useEffect } from 'react'
import Layout from '../components/Layout'
import { Badge, Btn, Panel, ErrorMsg, SpinnerPage, IdCell } from '../components/ui'
import { api } from '../api'

const CATEGORIES = ['HE', 'IHC', 'special_stain', 'FISH', 'other']

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

  useEffect(() => { load() }, [filter])

  async function saveStain(id, data) {
    await api.updateStain(id, data)
    setEditing(null)
    load()
  }

  const needsReview = stains.filter(s => s.needs_review)

  const actions = (
    <>
      {needsReview.length > 0 && (
        <span style={{ fontSize: 12, background: 'var(--warning-bg)', color: 'var(--warning)', padding: '5px 10px', borderRadius: 6, fontWeight: 500 }}>
          {needsReview.length} stain{needsReview.length !== 1 ? 's' : ''} need review
        </span>
      )}
    </>
  )

  return (
    <Layout title="Stains" actions={actions}>
      <div style={{ height: '100%', overflowY: 'auto', padding: '20px 24px' }}>
        <ErrorMsg message={error} />

        <div style={{ display: 'flex', gap: 10, marginBottom: 16, alignItems: 'center' }}>
          <select style={selStyle} value={filter.category}
            onChange={e => setFilter(f => ({ ...f, category: e.target.value }))}>
            <option value="">All categories</option>
            {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <select style={selStyle} value={filter.needs_review}
            onChange={e => setFilter(f => ({ ...f, needs_review: e.target.value }))}>
            <option value="">All</option>
            <option value="true">Needs review</option>
            <option value="false">Reviewed</option>
          </select>
        </div>

        {loading ? <SpinnerPage /> : (
          <div style={{ background: 'white', border: '1px solid var(--border-l)', borderRadius: 8, overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: 'var(--navy-05)' }}>
                  {['Stain name', 'Category', 'Aliases', 'Scans', 'Status', ''].map(h => (
                    <th key={h} style={thStyle}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {stains.map(s => (
                  <tr key={s.id} style={{ background: s.needs_review ? 'var(--warning-bg)' : 'white' }}>
                    <td style={tdStyle}><IdCell>{s.stain_name}</IdCell></td>
                    <td style={tdStyle}>
                      <Badge variant={s.stain_category === 'HE' ? 'navy' : 'muted'}>{s.stain_category}</Badge>
                    </td>
                    <td style={{ ...tdStyle, color: 'var(--text-3)', fontFamily: 'var(--font-mono)', fontSize: 11 }}>
                      {s.aliases?.join(', ') || '—'}
                    </td>
                    <td style={tdStyle}>
                      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: s.scan_count > 0 ? 'var(--navy)' : 'var(--text-3)', fontWeight: s.scan_count > 0 ? 600 : 400 }}>
                        {s.scan_count.toLocaleString()}
                      </span>
                    </td>
                    <td style={tdStyle}>
                      {s.needs_review
                        ? <Badge variant="warning">Needs review</Badge>
                        : <Badge variant="green">OK</Badge>
                      }
                    </td>
                    <td style={{ ...tdStyle, textAlign: 'right' }}>
                      <Btn variant="ghost" small onClick={() => setEditing(s)}>Edit</Btn>
                    </td>
                  </tr>
                ))}
                {stains.length === 0 && (
                  <tr><td colSpan={6} style={{ padding: 24, textAlign: 'center', color: 'var(--text-3)' }}>No stains found</td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        {editing && <EditModal stain={editing} onSave={saveStain} onClose={() => setEditing(null)} />}
      </div>
    </Layout>
  )
}

function EditModal({ stain, onSave, onClose }) {
  const [form, setForm]   = useState({
    stain_name:     stain.stain_name,
    stain_category: stain.stain_category,
    aliases:        stain.aliases?.join(', ') || '',
  })
  const [saving, setSaving] = useState(false)

  async function handleSave() {
    setSaving(true)
    await onSave(stain.id, {
      stain_name:     form.stain_name,
      stain_category: form.stain_category,
      aliases:        form.aliases.split(',').map(a => a.trim()).filter(Boolean),
    })
    setSaving(false)
  }

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,20,100,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}>
      <div onClick={e => e.stopPropagation()} style={{ background: 'white', borderRadius: 12, padding: 24, width: 420, boxShadow: '0 8px 32px rgba(0,20,100,0.18)' }}>
        <h3 style={{ fontFamily: 'var(--font-serif)', fontSize: 18, marginBottom: 20, color: 'var(--navy)' }}>Edit stain</h3>
        {[
          { label: 'Stain name',                key: 'stain_name' },
          { label: 'Aliases (comma separated)', key: 'aliases' },
        ].map(({ label, key }) => (
          <div key={key} style={{ marginBottom: 14 }}>
            <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 5 }}>{label}</label>
            <input type="text" style={{ width: '100%', padding: '7px 10px', border: '1px solid var(--border)', borderRadius: 6, fontSize: 13, outline: 'none' }}
              value={form[key]} onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))} />
          </div>
        ))}
        <div style={{ marginBottom: 20 }}>
          <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 5 }}>Category</label>
          <select style={{ width: '100%', padding: '7px 10px', border: '1px solid var(--border)', borderRadius: 6, fontSize: 13, outline: 'none' }}
            value={form.stain_category} onChange={e => setForm(f => ({ ...f, stain_category: e.target.value }))}>
            {['HE','IHC','special_stain','FISH','other'].map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Btn variant="ghost" onClick={onClose}>Cancel</Btn>
          <Btn variant="primary" onClick={handleSave} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Btn>
        </div>
      </div>
    </div>
  )
}

const thStyle  = { padding: '10px 14px', textAlign: 'left', fontSize: 11, fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.06em', borderBottom: '1px solid var(--border-l)' }
const tdStyle  = { padding: '10px 14px', borderBottom: '1px solid var(--border-l)', verticalAlign: 'middle' }
const selStyle = { padding: '7px 10px', border: '1px solid var(--border)', borderRadius: 6, fontSize: 13, background: 'white', outline: 'none' }