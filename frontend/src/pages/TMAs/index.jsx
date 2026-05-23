// frontend/src/pages/TMAs/index.jsx
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import * as tmaApi from '../../api/tmas'
import { Btn, EmptyState, ConfirmDialog, ProgressBar, CardGrid, CreateButton } from '../../components/ui'
import ListPage from '../../components/ListPage'
import EntityCard from '../../components/EntityCard'
import CreateTMAModal from './CreateTMAModal'
import { useAuth } from '../../context/AuthContext'

const token = () => localStorage.getItem('pathodb_token')

function TMACard({ tma, onDelete, onNavigate }) {
  const matchPct = tma.core_count > 0
    ? Math.round((tma.matched_core_count / tma.core_count) * 100)
    : null

  return (
    <EntityCard
      onClick={() => onNavigate(tma.id)}
      thumbnailHeight={120}
      thumbnailSrc={tma.first_scan_id ? `/api/slides/${tma.first_scan_id}/thumbnail?width=400&token=${token()}` : null}
      thumbnailAlt="TMA scan thumbnail"
      fallbackIcon={
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.15)" strokeWidth="1">
          <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/>
          <rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>
        </svg>
      }
      thumbnailOverlay={
        <div style={{
          position: 'absolute', top: 8, left: 8,
          fontSize: 9, fontWeight: 700, padding: '3px 8px', borderRadius: 20,
          background: 'rgba(167,139,250,0.25)', color: '#a78bfa',
          letterSpacing: '0.06em', textTransform: 'uppercase', backdropFilter: 'blur(4px)',
        }}>
          TMA
        </div>
      }
      title={tma.name}
      description={tma.description}
      footerStyle={{ justifyContent: 'space-between' }}
      footer={
        <>
          <div style={{ fontSize: 11, color: 'var(--text-3)' }}>
            {new Date(tma.created_at).toLocaleDateString()}
          </div>
          <Btn variant="ghost" small onClick={() => onDelete(tma)} style={{ color: 'var(--crimson)' }}>
            Delete
          </Btn>
        </>
      }
    >
      {/* Stats */}
      <div style={{ display: 'flex', gap: 12, fontSize: 11, color: 'var(--text-3)' }}>
        <span>
          <strong style={{ color: 'var(--navy)', fontFamily: 'var(--font-serif)' }}>
            {tma.scan_count}
          </strong> scans
        </span>
        {tma.core_count > 0 && (
          <span>
            <strong style={{ color: 'var(--navy)', fontFamily: 'var(--font-serif)' }}>
              {tma.core_count}
            </strong> cores
          </span>
        )}
      </div>

      {/* Match progress bar */}
      {tma.core_count > 0 && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4, fontSize: 10, color: 'var(--text-3)' }}>
            <span>Cores matched</span>
            <span style={{ fontFamily: 'var(--font-mono)', color: matchPct === 100 ? 'var(--teal)' : 'var(--text-2)' }}>
              {matchPct}%
            </span>
          </div>
          <ProgressBar
            value={matchPct} max={100} height={3}
            color={matchPct === 100 ? 'var(--teal)' : matchPct > 50 ? 'var(--amber)' : 'var(--crimson)'}
            style={{ background: 'var(--navy-10)' }}
          />
          {tma.unmatched_core_count > 0 && (
            <div style={{ fontSize: 10, color: 'var(--warning)', marginTop: 3 }}>
              ⚠ {tma.unmatched_core_count} cores unmatched
            </div>
          )}
        </div>
      )}

      {tma.core_count === 0 && tma.scan_count === 0 && (
        <div style={{ fontSize: 11, color: 'var(--text-3)', fontStyle: 'italic' }}>
          No data uploaded yet — click to set up
        </div>
      )}
    </EntityCard>
  )
}

export default function TMAsList() {
  const navigate     = useNavigate()
  const queryClient  = useQueryClient()
  const { user }     = useAuth()
  const [showCreate,     setShowCreate]     = useState(false)
  const [deleteTarget,   setDeleteTarget]   = useState(null)
  const [deleting,       setDeleting]       = useState(false)
  const [error,          setError]          = useState('')

  const { data: tmas = [], isLoading, refetch } = useQuery({
    queryKey: ['tmas'],
    queryFn:  tmaApi.getTMAs,
  })

  async function handleDelete(tma) {
    setDeleting(true)
    setError('')
    try {
      await tmaApi.deleteTMA(tma.id)
      await refetch()
      setDeleteTarget(null)
    } catch (e) {
      setError(e.message || 'Failed to delete TMA')
    } finally {
      setDeleting(false)
    }
  }

  const actions = <CreateButton label="New TMA" onClick={() => setShowCreate(true)} />

  const after = (
    <>
      {showCreate && (
        <CreateTMAModal
          onClose={() => setShowCreate(false)}
          onCreated={newTMA => {
            setShowCreate(false)
            navigate(`/tmas/${newTMA.id}`)
          }}
        />
      )}

      <ConfirmDialog
        isOpen={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => handleDelete(deleteTarget)}
        title="Delete TMA?"
        message={`This will permanently delete "${deleteTarget?.name}" and all its core mappings. Original slide files are not affected.`}
        confirmLabel="Delete TMA"
        loading={deleting}
      />
    </>
  )

  return (
    <ListPage title="Tissue Microarrays" actions={actions} isLoading={isLoading} error={error} after={after}>
      {tmas.length === 0 ? (
        <EmptyState
          icon={
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/>
              <rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>
            </svg>
          }
          title="No Tissue Microarrays"
          description="Register a TMA to map patient blocks to array positions and manage multi-core WSI datasets."
          action={
            <Btn variant="primary" onClick={() => setShowCreate(true)}>
              Register first TMA
            </Btn>
          }
        />
      ) : (
        <CardGrid>
          {tmas.map(tma => (
            <TMACard
              key={tma.id}
              tma={tma}
              onNavigate={id => navigate(`/tmas/${id}`)}
              onDelete={setDeleteTarget}
            />
          ))}
        </CardGrid>
      )}
    </ListPage>
  )
}