import { useState, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Modal, Btn, Spinner, ErrorMsg, FormField, FormInput } from './ui'
import { api } from '../api'

const BROWSE_ROOT = '/storage/research'

const FolderIcon = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" style={{ display: 'block', flexShrink: 0 }}>
    <path d="M.54 3.87.5 3a2 2 0 0 1 2-2h3.19a2 2 0 0 1 1.345.51l.33.33A1 1 0 0 0 8.5 2H14a2 2 0 0 1 2 2v8.5a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2V3.87a2 2 0 0 1 .54-1.37zM2 14h12a1 1 0 0 0 1-1V6H1v7a1 1 0 0 0 1 1z"/>
  </svg>
)

const ChevronIcon = () => (
  <svg width="9" height="9" viewBox="0 0 16 16" fill="currentColor" style={{ display: 'block', flexShrink: 0 }}>
    <path d="M4.646 1.646a.5.5 0 0 1 .708 0l6 6a.5.5 0 0 1 0 .708l-6 6a.5.5 0 0 1-.708-.708L10.293 8 4.646 2.354a.5.5 0 0 1 0-.708z"/>
  </svg>
)

export default function DirBrowserModal({ isOpen, onClose, onSelect }) {
  const [currentPath,   setCurrentPath]   = useState(BROWSE_ROOT)
  const [newFolder,     setNewFolder]     = useState('')
  const [hoveredEntry,  setHoveredEntry]  = useState(null)

  useEffect(() => {
    if (isOpen) { setCurrentPath(BROWSE_ROOT); setNewFolder('') }
  }, [isOpen])

  const { data, isLoading, isError, error } = useQuery({
    queryKey:  ['fs-browse', currentPath],
    queryFn:   () => api.browseDirectory(currentPath),
    enabled:   isOpen,
    staleTime: 30000,
    retry:     false,
  })

  const cleanName    = newFolder.trim().replace(/[/\\]/g, '')
  const selectedPath = cleanName ? `${currentPath}/${cleanName}` : currentPath

  const navigateTo = (path) => { setCurrentPath(path); setNewFolder('') }

  const relParts = currentPath.slice(BROWSE_ROOT.length).replace(/^\//, '').split('/').filter(Boolean)

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Select Output Directory" width={540}>
      <Modal.Body>

        {/* Breadcrumb */}
        <div style={{
          display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '2px 2px',
          fontSize: 12, fontFamily: 'var(--font-mono)',
          background: 'var(--navy-05)', borderRadius: 'var(--radius-md)',
          padding: '6px 10px', marginBottom: 10,
          border: '1px solid var(--border-l)',
        }}>
          <span
            onClick={() => navigateTo(BROWSE_ROOT)}
            style={{ cursor: 'pointer', color: 'var(--navy)', fontWeight: 500 }}
          >
            /storage/research
          </span>
          {relParts.map((part, i) => {
            const pathUpTo = BROWSE_ROOT + '/' + relParts.slice(0, i + 1).join('/')
            const isLast   = i === relParts.length - 1
            return (
              <span key={i} style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                <span style={{ color: 'var(--text-3)', padding: '0 2px' }}>/</span>
                <span
                  onClick={!isLast ? () => navigateTo(pathUpTo) : undefined}
                  style={{
                    cursor:     isLast ? 'default' : 'pointer',
                    color:      isLast ? 'var(--text-1)' : 'var(--navy)',
                    fontWeight: isLast ? 600 : 400,
                  }}
                >
                  {part}
                </span>
              </span>
            )
          })}
        </div>

        {/* Directory list */}
        <div style={{
          border: '1px solid var(--border-l)', borderRadius: 'var(--radius-md)',
          maxHeight: 260, overflowY: 'auto', background: 'var(--white)',
        }}>
          {isLoading ? (
            <div style={{ display: 'flex', justifyContent: 'center', padding: 24 }}>
              <Spinner />
            </div>
          ) : isError ? (
            <div style={{ padding: 12 }}>
              <ErrorMsg message={error?.message || 'Failed to load directory'} />
            </div>
          ) : !data?.entries?.length ? (
            <div style={{ padding: 16, fontSize: 13, color: 'var(--text-3)', textAlign: 'center', fontStyle: 'italic' }}>
              No subdirectories
            </div>
          ) : (
            data.entries.map((entry, i) => (
              <div
                key={entry.path}
                onClick={() => navigateTo(entry.path)}
                onMouseEnter={() => setHoveredEntry(entry.path)}
                onMouseLeave={() => setHoveredEntry(null)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '8px 12px',
                  borderBottom: i < data.entries.length - 1 ? '1px solid var(--border-l)' : 'none',
                  cursor: 'pointer', userSelect: 'none',
                  background: hoveredEntry === entry.path ? 'var(--navy-05)' : 'transparent',
                  transition: 'background 0.1s',
                }}
              >
                <FolderIcon />
                <span style={{ flex: 1, fontSize: 13, color: 'var(--text-1)' }}>{entry.name}</span>
                {entry.has_children && <span style={{ color: 'var(--text-3)' }}><ChevronIcon /></span>}
              </div>
            ))
          )}
        </div>

        {/* New folder input */}
        <FormField label="Or type a new folder name to create here:" style={{ marginTop: 12, marginBottom: 0 }}>
          <FormInput
            type="text"
            placeholder="new-folder-name"
            value={newFolder}
            onChange={e => setNewFolder(e.target.value)}
          />
        </FormField>

        {/* Selected path preview */}
        <div style={{
          marginTop: 12, padding: '8px 10px',
          background: 'rgba(27,153,139,0.08)', borderRadius: 'var(--radius-md)',
          border: '1px solid rgba(27,153,139,0.2)',
          fontSize: 12, fontFamily: 'var(--font-mono)', color: 'var(--navy)',
          wordBreak: 'break-all',
        }}>
          {selectedPath}
        </div>

      </Modal.Body>
      <Modal.Footer>
        <Btn variant="ghost" onClick={onClose}>Cancel</Btn>
        <Btn variant="primary" onClick={() => { onSelect(selectedPath); onClose() }}>Select</Btn>
      </Modal.Footer>
    </Modal>
  )
}
