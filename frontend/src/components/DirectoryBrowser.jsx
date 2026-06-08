import { useState, useEffect, useCallback } from 'react'
import { Modal, Btn, FormInput } from './ui'
import { api } from '../api'

const BROWSABLE_ROOT = '/storage/research'

function toWindowsUNC(hpcPath) {
  const relative = hpcPath.replace(BROWSABLE_ROOT, '').replace(/^\//, '')
  const winRelative = relative.replace(/\//g, '\\')
  return '\\\\resstore.unibe.ch\\' + (winRelative || '')
}

const FolderIcon = ({ size = 14, color = 'var(--navy)' }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill={color} style={{ display: 'block', flexShrink: 0 }}>
    <path d="M.54 3.87.5 3a2 2 0 0 1 2-2h3.19a2 2 0 0 1 1.345.51l.33.33A1 1 0 0 0 8.5 2H14a2 2 0 0 1 2 2v8.5a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2V3.87a2 2 0 0 1 .54-1.37zM2 14h12a1 1 0 0 0 1-1V6H1v7a1 1 0 0 0 1 1z"/>
  </svg>
)

const ChevronRight = () => (
  <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
    <path fillRule="evenodd" d="M4.646 1.646a.5.5 0 0 1 .708 0l6 6a.5.5 0 0 1 0 .708l-6 6a.5.5 0 0 1-.708-.708L10.293 8 4.646 2.354a.5.5 0 0 1 0-.708z"/>
  </svg>
)

const NewFolderIcon = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor" style={{ display: 'block' }}>
    <path d="M.54 3.87.5 3a2 2 0 0 1 2-2h3.19a2 2 0 0 1 1.345.51l.33.33A1 1 0 0 0 8.5 2H14a2 2 0 0 1 2 2v8.5a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2V3.87zM2 14h12a1 1 0 0 0 1-1V6H1v7a1 1 0 0 0 1 1z"/>
    <path d="M8 8a.5.5 0 0 1 .5.5v1.5H10a.5.5 0 0 1 0 1H8.5V12.5a.5.5 0 0 1-1 0V11H6a.5.5 0 0 1 0-1h1.5V8.5A.5.5 0 0 1 8 8z"/>
  </svg>
)

const Spinner = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" style={{ animation: 'spin 0.8s linear infinite', display: 'block', margin: '24px auto' }}>
    <circle cx="12" cy="12" r="10" stroke="var(--border)" strokeWidth="3" />
    <path d="M12 2a10 10 0 0 1 10 10" stroke="var(--teal)" strokeWidth="3" strokeLinecap="round" />
  </svg>
)

function Breadcrumb({ path, onNavigate }) {
  const relative = path.replace(BROWSABLE_ROOT, '').replace(/^\//, '')
  const parts = relative ? relative.split('/') : []

  const crumbs = [{ label: 'research', fullPath: BROWSABLE_ROOT }]
  let accumulator = BROWSABLE_ROOT
  for (const part of parts) {
    accumulator += '/' + part
    crumbs.push({ label: part, fullPath: accumulator })
  }

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap',
      padding: '8px 12px', background: 'var(--navy-05)', borderRadius: 'var(--radius-md)',
      border: '1px solid var(--border-l)', minHeight: 34,
    }}>
      <FolderIcon size={12} color="var(--teal)" />
      <span style={{ width: 4 }} />
      {crumbs.map((crumb, i) => (
        <span key={crumb.fullPath} style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
          {i > 0 && <ChevronRight />}
          <button
            onClick={() => onNavigate(crumb.fullPath)}
            style={{
              background: 'none', border: 'none', cursor: 'pointer', padding: '1px 4px',
              fontSize: 12, fontFamily: 'var(--font-mono)', borderRadius: 'var(--radius-sm)',
              color: i === crumbs.length - 1 ? 'var(--navy)' : 'var(--text-3)',
              fontWeight: i === crumbs.length - 1 ? 600 : 400,
              transition: 'var(--transition-fast)',
            }}
            onMouseEnter={e => { if (i < crumbs.length - 1) e.target.style.color = 'var(--teal)' }}
            onMouseLeave={e => { if (i < crumbs.length - 1) e.target.style.color = 'var(--text-3)' }}
          >
            {crumb.label}
          </button>
        </span>
      ))}
    </div>
  )
}

function FolderRow({ entry, onNavigate }) {
  const [hovered, setHovered] = useState(false)

  return (
    <div
      onClick={() => onNavigate(entry.path)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px',
        cursor: 'pointer', borderBottom: '1px solid var(--border-l)',
        background: hovered ? 'var(--navy-05)' : 'transparent',
        transition: 'var(--transition-fast)',
      }}
    >
      <FolderIcon size={15} color={hovered ? 'var(--teal)' : 'var(--navy-40)'} />
      <span style={{
        fontSize: 13, fontFamily: 'var(--font-sans)', color: 'var(--text-2)',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>
        {entry.name}
      </span>
    </div>
  )
}

export default function DirectoryBrowser({ isOpen, onClose, onSelect }) {
  const [currentPath, setCurrentPath] = useState(BROWSABLE_ROOT)
  const [directories, setDirectories] = useState([])
  const [parentPath, setParentPath] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const [showNewFolder, setShowNewFolder] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')
  const [creating, setCreating] = useState(false)

  const loadDirectory = useCallback(async (path) => {
    setLoading(true)
    setError('')
    try {
      const data = await api.browseDirectory(path)
      setCurrentPath(data.current)
      setDirectories(data.directories)
      setParentPath(data.parent)
    } catch (err) {
      setError(err.message || 'Failed to load directory')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (isOpen) {
      loadDirectory(currentPath)
      setShowNewFolder(false)
      setNewFolderName('')
    }
  }, [isOpen]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleNavigate = (path) => {
    setShowNewFolder(false)
    setNewFolderName('')
    loadDirectory(path)
  }

  const handleSelect = () => {
    onSelect(currentPath)
    onClose()
  }

  const handleCreateFolder = async () => {
    const trimmed = newFolderName.trim()
    if (!trimmed) return

    setCreating(true)
    try {
      const data = await api.createDirectory(currentPath + '/' + trimmed)
      setShowNewFolder(false)
      setNewFolderName('')
      loadDirectory(data.path)
    } catch (err) {
      setError(err.message || 'Failed to create folder')
    } finally {
      setCreating(false)
    }
  }

  const handleNewFolderKeyDown = (e) => {
    if (e.key === 'Enter') handleCreateFolder()
    if (e.key === 'Escape') { setShowNewFolder(false); setNewFolderName('') }
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Browse Storage" width={560}>
      <Modal.Body style={{ display: 'flex', flexDirection: 'column', gap: 12, minHeight: 300 }}>

        <Breadcrumb path={currentPath} onNavigate={handleNavigate} />

        {error && (
          <div style={{
            padding: '8px 12px', fontSize: 12, color: 'var(--crimson)',
            background: 'var(--crimson-10)', borderRadius: 'var(--radius-md)',
            border: '1px solid rgba(230,0,46,0.15)',
          }}>
            {error}
          </div>
        )}

        <div style={{
          flex: 1, border: '1px solid var(--border-l)', borderRadius: 'var(--radius-lg)',
          overflow: 'hidden', background: 'var(--white)', minHeight: 200, maxHeight: 340,
          overflowY: 'auto',
        }}>
          {loading ? (
            <Spinner />
          ) : directories.length === 0 ? (
            <div style={{
              display: 'flex', flexDirection: 'column', alignItems: 'center',
              justifyContent: 'center', height: '100%', minHeight: 120,
              color: 'var(--text-3)', fontSize: 13, gap: 8,
            }}>
              <FolderIcon size={24} color="var(--border)" />
              <span>No subfolders</span>
            </div>
          ) : (
            directories.map(entry => (
              <FolderRow key={entry.path} entry={entry} onNavigate={handleNavigate} />
            ))
          )}
        </div>

        {showNewFolder && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <FolderIcon size={14} color="var(--teal)" />
            <FormInput
              autoFocus
              placeholder="New folder name"
              value={newFolderName}
              onChange={e => setNewFolderName(e.target.value)}
              onKeyDown={handleNewFolderKeyDown}
              style={{ flex: 1 }}
              disabled={creating}
            />
            <Btn variant="teal" small onClick={handleCreateFolder} disabled={creating || !newFolderName.trim()}>
              {creating ? 'Creating...' : 'Create'}
            </Btn>
            <Btn variant="ghost" small onClick={() => { setShowNewFolder(false); setNewFolderName('') }}>
              Cancel
            </Btn>
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 0 0' }}>
          <Btn
            variant="ghost"
            small
            icon={<NewFolderIcon />}
            onClick={() => setShowNewFolder(true)}
            disabled={showNewFolder}
          >
            New Folder
          </Btn>
        </div>

        <div style={{
          padding: '8px 10px', background: 'var(--navy-05)', borderRadius: 'var(--radius-md)',
          border: '1px solid var(--border-l)', fontSize: 11, fontFamily: 'var(--font-mono)',
          display: 'flex', flexDirection: 'column', gap: 3,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ color: 'var(--text-3)', fontFamily: 'var(--font-sans)', fontWeight: 600, fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.04em', flexShrink: 0 }}>Linux</span>
            <span style={{ color: 'var(--text-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{currentPath}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ color: 'var(--text-3)', fontFamily: 'var(--font-sans)', fontWeight: 600, fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.04em', flexShrink: 0 }}>Win</span>
            <span style={{ color: 'var(--text-3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{toWindowsUNC(currentPath)}</span>
          </div>
        </div>

      </Modal.Body>

      <Modal.Footer>
        <Btn variant="ghost" onClick={onClose}>Cancel</Btn>
        <Btn variant="primary" onClick={handleSelect}>Select This Folder</Btn>
      </Modal.Footer>
    </Modal>
  )
}
