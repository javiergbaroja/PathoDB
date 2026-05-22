// frontend/src/pages/TMAs/index.jsx
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import * as tmaApi from '../../api/tmas'
import { Btn, EmptyState, ConfirmDialog, SpinnerPage } from '../../components/ui'
import Layout from '../../components/Layout'
import CreateTMAModal from './CreateTMAModal'
import { useAuth } from '../../context/AuthContext'

const token = () => localStorage.getItem('pathodb_token')

function TMACard({ tma, onDelete, onNavigate }) {
  const [imgError, setImgError] = useState(false)

  const matchPct = tma.core_count > 0
    ? Math.round((tma.matched_core_count / tma.core_count) * 100)
    : null

  return (
    <div
      onClick={() => onNavigate(tma.id)}
      style={{
        background: 'var(--white)', borderRadius: 10, overflow: 'hidden',
        border: '1px solid var(--border-l)', cursor: 'pointer',
        boxShadow: 'var(--shadow-s)', transition: 'all 0.15s',
        display: 'flex', flexDirection: 'column',
      }}
      onMouseEnter={e => { e.currentTarget.style.boxShadow = 'var(--shadow-m)'; e.currentTarget.style.transform = 'translateY(-2px)' }}
      onMouseLeave={e => { e.currentTarget.style.boxShadow = 'var(--shadow-s)'; e.currentTarget.style.transform = 'translateY(0)' }}
    >
      {/* Thumbnail */}
      <div style={{ height: 120, background: 'var(--surface-dark-2)', position: 'relative', overflow: 'hidden', flexShrink: 0 }}>
        {tma.first_scan_id && !imgError ? (
          <img
            src={`/api/slides/${tma.first_scan_id}/thumbnail?width=400&token=${token()}`}
            alt="TMA scan thumbnail"
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
            onError={() => setImgError(true)}
          />
        ) : (
          <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.15)" strokeWidth="1">
              <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/>
              <rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>
            </svg>
          </div>
        )}

        {/* Type badge */}
        <div style={{
          position: 'absolute', top: 8, left: 8,
          fontSize: 9, fontWeight: 700, padding: '3px 8px', borderRadius: 20,
          background: 'rgba(167,139,250,0.25)', color: '#a78bfa',
          letterSpacing: '0.06em', textTransform: 'uppercase', backdropFilter: 'blur(4px)',
        }}>
          TMA
        </div>
      </div>

      {/* Body */}
      <div style={{ padding: '12px 14px', flex: 1, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--navy)', marginBottom: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {tma.name}
          </div>
          {tma.description && (
            <div style={{ fontSize: 11, color: 'var(--text-3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {tma.description}
            </div>
          )}
        </div>

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
            <div style={{ height: 3, background: 'var(--navy-10)', borderRadius: 2, overflow: 'hidden' }}>
              <div style={{
                height: '100%', width: `${matchPct}%`, borderRadius: 2, transition: 'width 0.3s',
                background: matchPct === 100 ? 'var(--teal)' : matchPct > 50 ? 'var(--amber)' : 'var(--crimson)',
              }} />
            </div>
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
      </div>

      {/* Footer */}
      <div
        onClick={e => e.stopPropagation()}
        style={{ padding: '10px 14px', borderTop: '1px solid var(--border-l)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
      >
        <div style={{ fontSize: 11, color: 'var(--text-3)' }}>
          {new Date(tma.created_at).toLocaleDateString()}
        </div>
        <Btn
          variant="ghost"
          small
          onClick={() => onDelete(tma)}
          style={{ color: 'var(--crimson)' }}
        >
          Delete
        </Btn>
      </div>
    </div>
  )
}

export default function TMAsList() {
  const navigate     = useNavigate()
  const queryClient  = useQueryClient()
  const { user }     = useAuth()
  const [showCreate,     setShowCreate]     = useState(false)
  const [deleteTarget,   setDeleteTarget]   = useState(null)
  const [deleting,       setDeleting]       = useState(false)

  const { data: tmas = [], isLoading, refetch } = useQuery({
    queryKey: ['tmas'],
    queryFn:  tmaApi.getTMAs,
  })

  async function handleDelete(tma) {
    setDeleting(true)
    try {
      await tmaApi.deleteTMA(tma.id)
      await refetch()
      setDeleteTarget(null)
    } catch (e) {
      console.error(e)
    } finally {
      setDeleting(false)
    }
  }

  const actions = (
    <Btn variant="primary" onClick={() => setShowCreate(true)}>
      <svg width="12" height="12" viewBox="0 0 16 16" fill="white">
        <path d="M8 2a.5.5 0 01.5.5v5h5a.5.5 0 010 1h-5v5a.5.5 0 01-1 0v-5h-5a.5.5 0 010-1h5v-5A.5.5 0 018 2z"/>
      </svg>
      New TMA
    </Btn>
  )

  return (
    <Layout title="Tissue Microarrays" actions={actions}>
      <div style={{ height: '100%', overflowY: 'auto', padding: '20px 24px' }}>

        {isLoading ? (
          <SpinnerPage />
        ) : tmas.length === 0 ? (
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
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 16 }}>
            {tmas.map(tma => (
              <TMACard
                key={tma.id}
                tma={tma}
                onNavigate={id => navigate(`/tmas/${id}`)}
                onDelete={setDeleteTarget}
              />
            ))}
          </div>
        )}
      </div>

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
    </Layout>
  )
}