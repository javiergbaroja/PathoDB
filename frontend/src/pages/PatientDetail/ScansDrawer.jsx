// frontend/src/pages/PatientDetail/ScansDrawer.jsx
import { useState } from 'react'
import { Btn } from '../../components/ui'

const dtd = { padding: '9px 14px', verticalAlign: 'middle', color: 'var(--text-2)' }

export default function ScansDrawer({ scans, block, probe, sub, onClose }) {
  const [copied, setCopied] = useState(null)

  function copyPath(path, id) {
    navigator.clipboard.writeText(path).then(() => {
      setCopied(id)
      setTimeout(() => setCopied(null), 1500)
    })
  }

  return (
    <>
      <div onClick={onClose} style={{ position: 'absolute', inset: 0, background: 'rgba(0,20,100,0.18)', zIndex: 10 }} />
      <div style={{ position: 'absolute', top: 0, right: 0, bottom: 0, width: '60%', background: 'white', borderLeft: '1px solid var(--border-l)', zIndex: 11, display: 'flex', flexDirection: 'column', boxShadow: '-4px 0 20px rgba(0,20,100,0.12)' }}>
        <div style={{ padding: '16px 20px', borderBottom: '1px solid var(--border-l)', display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexShrink: 0 }}>
          <div>
            <div style={{ fontFamily: 'var(--font-serif)', fontSize: 16, color: 'var(--navy)', marginBottom: 4 }}>All scans — Block {block.block_label}</div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-3)' }}>{sub.lis_submission_id} / {probe.lis_probe_id} / {block.block_label}</div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 20, color: 'var(--text-3)', lineHeight: 1, padding: '0 4px', marginTop: 2 }}>×</button>
        </div>

        <div style={{ padding: '10px 20px', background: 'var(--navy-05)', borderBottom: '1px solid var(--border-l)', display: 'flex', gap: 20, flexShrink: 0 }}>
          <div><span style={{ fontSize: 11, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600 }}>Total scans </span><span style={{ fontSize: 13, fontFamily: 'var(--font-serif)', color: 'var(--navy)' }}>{scans.length}</span></div>
          <div><span style={{ fontSize: 11, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600 }}>Stains </span><span style={{ fontSize: 13, color: 'var(--navy)' }}>{[...new Set(scans.map(s => s.stain_name).filter(Boolean))].join(', ') || '—'}</span></div>
        </div>

        <div style={{ flex: 1, overflowY: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead style={{ position: 'sticky', top: 0, background: 'white', zIndex: 1 }}>
              <tr style={{ background: 'var(--navy-05)' }}>
                {['Stain', 'Category', 'Format', 'Mag.', 'File path', 'Registered', ''].map(h => (
                  <th key={h} style={{ padding: '9px 14px', textAlign: 'left', fontSize: 10, fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.06em', borderBottom: '1px solid var(--border-l)', whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {scans.map(sc => (
                <tr key={sc.id} style={{ borderBottom: '1px solid var(--border-l)' }} onMouseEnter={e => e.currentTarget.style.background = 'var(--navy-05)'} onMouseLeave={e => e.currentTarget.style.background = 'white'}>
                  <td style={dtd}><span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, color: 'var(--navy)', fontSize: 12 }}>{sc.stain_name || '—'}</span></td>
                  <td style={dtd}><span style={{ fontSize: 11, padding: '2px 6px', borderRadius: 4, background: 'var(--navy-10)', color: 'var(--text-2)', fontWeight: 500 }}>{sc.stain_category || '—'}</span></td>
                  <td style={{ ...dtd, fontFamily: 'var(--font-mono)' }}>{sc.file_format || '—'}</td>
                  <td style={dtd}>{sc.magnification ? `${sc.magnification}×` : '—'}</td>
                  <td style={{ ...dtd, maxWidth: 260 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0 }} title={sc.file_path}>{sc.file_path || '—'}</span>
                      {sc.file_path && <button onClick={() => copyPath(sc.file_path, sc.id)} title="Copy path" style={{ background: 'none', border: 'none', cursor: 'pointer', color: copied === sc.id ? '#1b998b' : 'var(--text-3)', flexShrink: 0, padding: '2px', fontSize: 11 }}>{copied === sc.id ? '✓' : '⎘'}</button>}
                    </div>
                  </td>
                  <td style={{ ...dtd, whiteSpace: 'nowrap', color: 'var(--text-3)' }}>{sc.created_at ? new Date(sc.created_at).toLocaleDateString('en-GB', { year: 'numeric', month: 'short', day: 'numeric' }) : '—'}</td>
                  <td style={dtd}>
                    <button onClick={() => window.open(`/viewer/${sc.id}`, '_blank')} style={{ fontSize: 11, padding: '3px 8px', background: 'var(--navy-05)', border: '1px solid var(--navy-20)', borderRadius: 4, cursor: 'pointer', color: 'var(--navy)', fontFamily: 'var(--font-sans)', fontWeight: 500, whiteSpace: 'nowrap' }} onMouseEnter={e => { e.currentTarget.style.background = 'var(--navy-10)' }} onMouseLeave={e => { e.currentTarget.style.background = 'var(--navy-05)' }}>
                      View ↗
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div style={{ padding: '12px 20px', borderTop: '1px solid var(--border-l)', display: 'flex', justifyContent: 'flex-end', flexShrink: 0, background: 'white' }}>
          <Btn variant="ghost" small onClick={onClose}>Close</Btn>
        </div>
      </div>
    </>
  )
}