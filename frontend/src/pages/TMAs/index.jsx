import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import * as tmaApi from '../../api/tmas' 
import { Btn } from '../../components/ui'
import Layout from '../../components/Layout' 
import CreateTMAModal from './CreateTMAModal'
import { useAuth } from '../../context/AuthContext'

export default function TMAsList() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const [showCreate, setShowCreate] = useState(false)

  const { data: tmas = [], isLoading, refetch } = useQuery({
    queryKey: ['tmas'],
    queryFn: tmaApi.getTMAs
  })

  return (
    <Layout 
      title="Tissue Microarrays" 
      actions={
        <Btn variant="primary" onClick={() => setShowCreate(true)}>
          + New TMA
        </Btn>
      }
    >
      <div style={{ padding: '24px', maxWidth: 1200, margin: '0 auto' }}>
        
        {/* Page Subtitle */}
        <div style={{ color: 'var(--text-2)', fontSize: 14, marginBottom: 24 }}>
          Manage batch WSI uploads and coordinate mappings for Tissue Microarrays.
        </div>

        {isLoading ? (
          <div style={{ color: 'var(--text-3)', fontSize: 14 }}>Loading TMAs...</div>
        ) : tmas.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 60, background: 'var(--white)', borderRadius: 'var(--radius-lg)', border: '1px dashed var(--border)' }}>
            <div style={{ fontSize: 32, marginBottom: 12 }}>🧫</div>
            <div style={{ color: 'var(--text-2)', fontSize: 14 }}>No Tissue Microarrays found.</div>
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 16 }}>
            {tmas.map(tma => {
              const isOwner = tma.owner_id === user?.id;
              
              return (
                <div 
                  key={tma.id} 
                  onClick={() => navigate(`/tmas/${tma.id}`)}
                  style={{
                    background: 'var(--white)', borderRadius: 'var(--radius-lg)', border: '1px solid var(--border)',
                    padding: '20px', cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 16,
                    transition: 'all 0.2s', boxShadow: 'var(--shadow-sm)'
                  }}
                  onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-2px)'; e.currentTarget.style.boxShadow = 'var(--shadow-md)' }}
                  onMouseLeave={e => { e.currentTarget.style.transform = 'none'; e.currentTarget.style.boxShadow = 'var(--shadow-sm)' }}
                >
                  {/* Header Row */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <div style={{
                        width: 36, height: 36, borderRadius: 'var(--radius-md)',
                        background: 'rgba(167, 139, 250, 0.1)', // Subtle purple background
                        color: '#a78bfa', // Purple icon
                        display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18
                      }}>
                        🧫
                      </div>
                      <div>
                        <h3 style={{ fontSize: 16, fontWeight: 600, color: 'var(--navy)', margin: 0 }}>{tma.name}</h3>
                        <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 2 }}>
                          Tissue Microarray
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Description with Line Clamping */}
                  {tma.description && (
                    <div style={{ 
                      fontSize: 13, color: 'var(--text-2)', lineHeight: 1.5, 
                      display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' 
                    }}>
                      {tma.description}
                    </div>
                  )}

                  {/* Anchored Footer */}
                  <div style={{ 
                    marginTop: 'auto', paddingTop: 16, borderTop: '1px solid var(--border-l)', 
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12, color: 'var(--text-3)' 
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <div style={{ 
                        width: 6, height: 6, borderRadius: '50%', 
                        background: isOwner ? 'var(--teal)' : '#a78bfa' 
                      }} />
                      {isOwner ? 'Owner: You' : 'Shared / Public'}
                    </div>
                    <div>{new Date(tma.created_at).toLocaleDateString()}</div>
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {showCreate && (
          <CreateTMAModal 
            onClose={() => setShowCreate(false)} 
            onCreated={(newTMA) => {
              setShowCreate(false)
              navigate(`/tmas/${newTMA.id}`)
            }} 
          />
        )}
      </div>
    </Layout>
  )
}