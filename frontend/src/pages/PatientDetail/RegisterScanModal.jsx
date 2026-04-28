// frontend/src/pages/PatientDetail/RegisterScanModal.jsx
import { useState, useEffect } from 'react'
import { Btn } from '../../components/ui'
import { api } from '../../api'

const FILE_FORMATS = ['SVS', 'CZI', 'NDPI', 'SCN', 'TIF', 'MRXS', 'VSI', 'BIF', 'OTHER']
const lbl = { display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--text-2)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 5 }
const inp = { width: '100%', padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 6, fontSize: 13, fontFamily: 'var(--font-sans)', outline: 'none', background: 'white' }

export default function RegisterScanModal({ block, probe, sub, existingScans, onClose, onSuccess }) {
  const [stains, setStains]       = useState([])
  const [form, setForm]           = useState({ stain_name: '', file_path: '', file_format: 'SVS', magnification: '' })
  const [saving, setSaving]       = useState(false)
  const [error, setError]         = useState('')

  useEffect(() => {
    api.getStains().then(setStains).catch(() => {})
  }, [])

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
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,20,100,0.25)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50 }}>
      <div onClick={e => e.stopPropagation()} style={{ background: 'white', borderRadius: 12, width: 480, boxShadow: '0 8px 32px rgba(0,20,100,0.18)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ padding: '18px 24px 14px', borderBottom: '1px solid var(--border-l)' }}>
          <div style={{ fontFamily: 'var(--font-serif)', fontSize: 17, color: 'var(--navy)' }}>Register scan</div>
          <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-3)', marginTop: 4 }}>{sub.lis_submission_id} / {probe.lis_probe_id} / Block {block.block_label}</div>
        </div>

        <form onSubmit={handleSubmit} style={{ padding: '18px 24px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          {error && <div style={{ background: 'var(--crimson-10)', border: '1px solid var(--crimson)', borderRadius: 6, padding: '9px 12px', fontSize: 12, color: 'var(--crimson)' }}>{error}</div>}
          <div>
            <label style={lbl}>Stain *</label>
            <select required style={inp} value={form.stain_name} onChange={e => setForm(f => ({ ...f, stain_name: e.target.value }))}>
              <option value="">Select stain…</option>
              {stains.map(s => <option key={s.id} value={s.stain_name}>{s.stain_name} ({s.stain_category})</option>)}
            </select>
            {isDuplicate && <div style={{ marginTop: 5, fontSize: 12, color: 'var(--warning)', fontWeight: 500 }}>⚠ A {form.stain_name} scan already exists for this block. You can still proceed.</div>}
          </div>
          <div>
            <label style={lbl}>File path *</label>
            <input required type="text" style={inp} placeholder="/storage/slides/..." value={form.file_path} onChange={e => setForm(f => ({ ...f, file_path: e.target.value }))} />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div>
              <label style={lbl}>Format</label>
              <select style={inp} value={form.file_format} onChange={e => setForm(f => ({ ...f, file_format: e.target.value }))}>
                {FILE_FORMATS.map(f => <option key={f} value={f}>{f}</option>)}
              </select>
            </div>
            <div>
              <label style={lbl}>Magnification</label>
              <input type="number" step="0.1" min="0" style={inp} placeholder="e.g. 40" value={form.magnification} onChange={e => setForm(f => ({ ...f, magnification: e.target.value }))} />
            </div>
          </div>
          {existingScans.length > 0 && (
            <div style={{ background: 'var(--navy-05)', borderRadius: 6, padding: '8px 12px', fontSize: 12, color: 'var(--text-2)' }}>
              <span style={{ fontWeight: 600, color: 'var(--navy)' }}>Already registered: </span>{existingScans.map(s => s.stain_name).filter(Boolean).join(', ')}
            </div>
          )}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, paddingTop: 4 }}>
            <Btn variant="ghost" type="button" onClick={onClose}>Cancel</Btn>
            <Btn variant="primary" type="submit" disabled={saving}>{saving ? 'Registering…' : 'Register scan'}</Btn>
          </div>
        </form>
      </div>
    </div>
  )
}