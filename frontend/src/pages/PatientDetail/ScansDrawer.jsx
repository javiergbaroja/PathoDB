// frontend/src/pages/PatientDetail/ScansDrawer.jsx
import { useState } from 'react'
import { Table, Th, Td, Tr, Btn } from '../../components/ui'

export default function ScansDrawer({ scans, block, probe, sub, onClose }) {
  const [copied, setCopied] = useState(null)

  function copyPath(path, id) {
    navigator.clipboard.writeText(path).then(() => {
      setCopied(id)
      setTimeout(() => setCopied(null), 1500)
    })
  }

  const uniqueStains = [...new Set(scans.map(s => s.stain_name).filter(Boolean))].join(', ')

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{
          position: 'absolute', inset: 0,
          background: 'var(--transparent-dark-2)',
          zIndex: 'var(--z-overlay)',
        }}
      />

      {/* Drawer */}
      <div style={{
        position: 'absolute', top: 0, right: 0, bottom: 0,
        width: '60%',
        background: 'var(--white)',
        borderLeft: '1px solid var(--border-l)',
        zIndex: 'var(--z-modal)',
        display: 'flex', flexDirection: 'column',
        boxShadow: '-4px 0 20px var(--transparent-dark-1)',
      }}>

        {/* Header */}
        <div style={{
          padding: 'var(--space-4) var(--space-5)',
          borderBottom: '1px solid var(--border-l)',
          display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
          flexShrink: 0,
        }}>
          <div>
            <div style={{ fontFamily: 'var(--font-serif)', fontSize: 16, color: 'var(--navy)', marginBottom: 4 }}>
              All scans — Block {block.block_label}
            </div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-sm)', color: 'var(--text-3)' }}>
              {sub.lis_submission_id} / {probe.lis_probe_id} / {block.block_label}
            </div>
          </div>
          <button
            onClick={onClose}
            style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 20, color: 'var(--text-3)', lineHeight: 1, padding: '0 4px', marginTop: 2 }}
          >×</button>
        </div>

        {/* Summary strip */}
        <div style={{
          padding: '10px var(--space-5)',
          background: 'var(--navy-05)',
          borderBottom: '1px solid var(--border-l)',
          display: 'flex', gap: 20,
          flexShrink: 0,
        }}>
          <SummaryItem label="Total scans" value={scans.length} />
          <SummaryItem label="Stains"      value={uniqueStains || '—'} />
        </div>

        {/* Table */}
        <div style={{ flex: 1, overflowY: 'auto' }}>
          <Table style={{ borderRadius: 0, border: 'none' }}>
            <thead style={{ position: 'sticky', top: 0, zIndex: 1 }}>
              <tr>
                <Th>Stain</Th>
                <Th>Category</Th>
                <Th>Format</Th>
                <Th>Mag.</Th>
                <Th>File path</Th>
                <Th>Registered</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {scans.map(sc => (
                <Tr key={sc.id}>
                  <Td>
                    <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, color: 'var(--navy)', fontSize: 12 }}>
                      {sc.stain_name || '—'}
                    </span>
                  </Td>
                  <Td>
                    <span style={{
                      fontSize: 'var(--text-sm)', padding: '2px 6px',
                      borderRadius: 'var(--radius-sm)',
                      background: 'var(--navy-10)', color: 'var(--text-2)',
                      fontWeight: 500,
                    }}>
                      {sc.stain_category || '—'}
                    </span>
                  </Td>
                  <Td mono>{sc.file_format || '—'}</Td>
                  <Td>{sc.magnification ? `${sc.magnification}×` : '—'}</Td>

                  {/* File path with copy */}
                  <Td style={{ maxWidth: 260 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span
                        style={{
                          fontFamily: 'var(--font-mono)', fontSize: 10,
                          color: 'var(--text-2)',
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                          flex: 1, minWidth: 0,
                        }}
                        title={sc.file_path}
                      >
                        {sc.file_path || '—'}
                      </span>
                      {sc.file_path && (
                        <button
                          onClick={() => copyPath(sc.file_path, sc.id)}
                          title="Copy path"
                          style={{
                            background: 'none', border: 'none', cursor: 'pointer',
                            color: copied === sc.id ? 'var(--teal)' : 'var(--text-3)',
                            flexShrink: 0, padding: '2px', fontSize: 'var(--text-sm)',
                          }}
                        >
                          {copied === sc.id ? '✓' : '⎘'}
                        </button>
                      )}
                    </div>
                  </Td>

                  <Td style={{ whiteSpace: 'nowrap', color: 'var(--text-3)' }}>
                    {sc.created_at
                      ? new Date(sc.created_at).toLocaleDateString('en-GB', { year: 'numeric', month: 'short', day: 'numeric' })
                      : '—'}
                  </Td>

                  <Td>
                    <Btn
                      variant="ghost"
                      small
                      onClick={() => window.open(`/viewer/${sc.id}`, '_blank')}
                    >
                      View ↗
                    </Btn>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </div>

        {/* Footer */}
        <div style={{
          padding: '12px var(--space-5)',
          borderTop: '1px solid var(--border-l)',
          display: 'flex', justifyContent: 'flex-end',
          flexShrink: 0, background: 'var(--white)',
        }}>
          <Btn variant="ghost" small onClick={onClose}>Close</Btn>
        </div>
      </div>
    </>
  )
}

function SummaryItem({ label, value }) {
  return (
    <div>
      <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600 }}>
        {label}{' '}
      </span>
      <span style={{ fontSize: 13, color: 'var(--navy)' }}>{value}</span>
    </div>
  )
}