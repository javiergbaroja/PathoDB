// frontend/src/pages/Projects/index.jsx
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import Layout from '../../components/Layout'
import { Btn, SpinnerPage, ErrorMsg } from '../../components/ui'
import { api } from '../../api'
import CreateProjectModal from './CreateProjectModal'
import ShareModal from './ShareModal'

const token = () => localStorage.getItem('pathodb_token')

// ─── Project card ─────────────────────────────────────────────────────────────
function ProjectCard({ project, onOpen, onShare, onDelete, isOwner }) {
  const [imgError, setImgError] = useState(false)
  const pct = project.scan_count > 0
    ? Math.round((project.annotated_scans / project.scan_count) * 100)
    : 0

  const typeLabel = project.project_type === 'cell_detection' ? 'Cell detection' : 'Region annotation'
  const typeColor = project.project_type === 'cell_detection' ? '#fbbf24' : '#6ee7b7'
  const typeBg    = project.project_type === 'cell_detection' ? 'rgba(251,191,36,0.12)' : 'rgba(27,153,139,0.12)'

  return (
    <div
      onClick={() => onOpen(project.id)}
      style={{
        background:'white', borderRadius:10, overflow:'hidden',
        border:'1px solid var(--border-l)', cursor:'pointer',
        boxShadow:'var(--shadow-s)',
        transition:'all 0.15s',
        display:'flex', flexDirection:'column',
      }}
      onMouseEnter={e => { e.currentTarget.style.boxShadow = 'var(--shadow-m)'; e.currentTarget.style.transform = 'translateY(-2px)' }}
      onMouseLeave={e => { e.currentTarget.style.boxShadow = 'var(--shadow-s)'; e.currentTarget.style.transform = 'translateY(0)' }}
    >
      {/* Thumbnail */}
      <div style={{ height:140, background:'#0d1623', position:'relative', overflow:'hidden', flexShrink:0 }}>
        {project.first_scan_id && !imgError ? (
          <img
            src={`/api/slides/${project.first_scan_id}/thumbnail?width=400&token=${token()}`}
            alt="First slide"
            style={{ width:'100%', height:'100%', objectFit:'cover' }}
            onError={() => setImgError(true)}
          />
        ) : (
          <div style={{ width:'100%', height:'100%', display:'flex', alignItems:'center', justifyContent:'center' }}>
            <svg width="32" height="32" viewBox="0 0 16 16" fill="rgba(255,255,255,0.15)">
              <path d="M4.502 9a1.5 1.5 0 100-3 1.5 1.5 0 000 3z"/><path d="M14.002 13a2 2 0 01-2 2h-10a2 2 0 01-2-2V5A2 2 0 012 3a2 2 0 012-4h3.5a.5.5 0 01.5.5v.5h2V1.5a.5.5 0 01.5-.5H12a2 2 0 012 2v10z"/>
            </svg>
          </div>
        )}

        {/* Type badge */}
        <div style={{ position:'absolute', top:8, left:8, fontSize:9, fontWeight:700, padding:'3px 8px', borderRadius:20, background:typeBg, color:typeColor, letterSpacing:'0.06em', textTransform:'uppercase', backdropFilter:'blur(4px)' }}>
          {typeLabel}
        </div>

        {/* Shared badge */}
        {project.access !== 'owner' && (
          <div style={{ position:'absolute', top:8, right:8, fontSize:9, fontWeight:700, padding:'3px 8px', borderRadius:20, background:'rgba(148,163,184,0.2)', color:'#94a3b8', letterSpacing:'0.06em', textTransform:'uppercase', backdropFilter:'blur(4px)' }}>
            {project.access === 'edit' ? 'Collaborator' : 'Viewer'}
          </div>
        )}

        {/* Annotation count overlay */}
        {project.annotation_count > 0 && (
          <div style={{ position:'absolute', bottom:8, right:8, fontSize:10, fontFamily:'monospace', padding:'2px 7px', borderRadius:20, background:'rgba(0,0,0,0.6)', color:'rgba(255,255,255,0.8)' }}>
            {project.annotation_count.toLocaleString()} ann.
          </div>
        )}
      </div>

      {/* Body */}
      <div style={{ padding:'12px 14px', flex:1, display:'flex', flexDirection:'column', gap:8 }}>
        <div>
          <div style={{ fontSize:14, fontWeight:600, color:'var(--navy)', marginBottom:2, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
            {project.name}
          </div>
          {project.description && (
            <div style={{ fontSize:11, color:'var(--text-3)', overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
              {project.description}
            </div>
          )}
        </div>

        {/* Stats row */}
        <div style={{ display:'flex', gap:12, fontSize:11, color:'var(--text-3)' }}>
          <span><strong style={{ color:'var(--navy)', fontFamily:'var(--font-serif)' }}>{project.scan_count}</strong> slides</span>
          <span><strong style={{ color:'var(--navy)', fontFamily:'var(--font-serif)' }}>{project.annotated_scans}</strong> annotated</span>
        </div>

        {/* Progress bar */}
        <div>
          <div style={{ height:4, background:'var(--navy-10)', borderRadius:2, overflow:'hidden' }}>
            <div style={{ height:'100%', width:`${pct}%`, background:'#1b998b', borderRadius:2, transition:'width 0.3s' }} />
          </div>
          <div style={{ fontSize:10, color:'var(--text-3)', marginTop:3 }}>{pct}% complete</div>
        </div>

        {/* Classes */}
        {project.classes?.length > 0 && (
          <div style={{ display:'flex', gap:4, flexWrap:'wrap' }}>
            {project.classes.slice(0,5).map(c => (
              <span key={c.id} style={{ display:'inline-flex', alignItems:'center', gap:4, fontSize:10, padding:'2px 7px', borderRadius:20, background:`${c.color}20`, color:c.color, fontWeight:600 }}>
                <div style={{ width:6, height:6, borderRadius:'50%', background:c.color }} />
                {c.name}
              </span>
            ))}
            {project.classes.length > 5 && (
              <span style={{ fontSize:10, color:'var(--text-3)', padding:'2px 6px' }}>+{project.classes.length-5}</span>
            )}
          </div>
        )}
      </div>

      {/* Footer actions */}
      <div onClick={e => e.stopPropagation()} style={{ padding:'10px 14px', borderTop:'1px solid var(--border-l)', display:'flex', gap:6, alignItems:'center' }}>
        <Btn variant="primary" small onClick={() => onOpen(project.id)}>
          Open ↗
        </Btn>

        {project.annotation_count > 0 && (
          <Btn variant="ghost" small onClick={() => window.open(`/api/projects/${project.id}/export`, '_blank')}>
            <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor"><path d="M.5 9.9a.5.5 0 01.5.5v2.5a1 1 0 001 1h12a1 1 0 001-1v-2.5a.5.5 0 011 0v2.5a2 2 0 01-2 2H2a2 2 0 01-2-2v-2.5a.5.5 0 01.5-.5z"/><path d="M7.646 11.854a.5.5 0 00.708 0l3-3a.5.5 0 00-.708-.708L8.5 10.293V1.5a.5.5 0 00-1 0v8.793L5.354 8.146a.5.5 0 10-.708.708l3 3z"/></svg>
            Export
          </Btn>
        )}

        {isOwner && (
          <Btn variant="ghost" small onClick={() => onShare(project)}>
            <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor"><path d="M11 2.5a2.5 2.5 0 11.603 1.628l-6.718 3.12a2.499 2.499 0 010 1.504l6.718 3.12a2.5 2.5 0 11-.488.876l-6.718-3.12a2.5 2.5 0 110-3.256l6.718-3.12A2.5 2.5 0 0111 2.5z"/></svg>
            Share
          </Btn>
        )}

        <div style={{ flex:1 }} />

        {isOwner && (
          <button
            onClick={() => onDelete(project)}
            style={{ background:'none', border:'none', cursor:'pointer', color:'var(--text-3)', fontSize:11, fontFamily:'var(--font-sans)', padding:'3px 6px', borderRadius:4 }}
            onMouseEnter={e => e.currentTarget.style.color = 'var(--crimson)'}
            onMouseLeave={e => e.currentTarget.style.color = 'var(--text-3)'}
          >
            Delete
          </button>
        )}
      </div>
    </div>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────
export default function Projects() {
  const navigate     = useNavigate()
  const queryClient  = useQueryClient()
  const [showCreate, setShowCreate]   = useState(false)
  const [shareTarget, setShareTarget] = useState(null)
  const [deleteTarget, setDeleteTarget] = useState(null)
  const [deleting, setDeleting]       = useState(false)
  const [error, setError]             = useState('')

  const { data: projects = [], isLoading, refetch } = useQuery({
    queryKey: ['projects'],
    queryFn:  () => api.getProjects(),
  })

  const { data: cohorts = [] } = useQuery({
    queryKey: ['cohorts'],
    queryFn:  () => api.getCohorts(),
  })

  const { data: authUser } = useQuery({
    queryKey: ['me'],
    queryFn:  () => api.getMe(),
  })
  const myUserId = authUser?.id

  async function handleDelete(project) {
    setDeleting(true)
    try {
      await api.deleteProject(project.id)
      await refetch()
      setDeleteTarget(null)
    } catch (e) {
      setError(e.message || 'Failed to delete')
    } finally {
      setDeleting(false)
    }
  }

  const actions = (
    <Btn variant="primary" onClick={() => setShowCreate(true)}>
      <svg width="12" height="12" viewBox="0 0 16 16" fill="white"><path d="M8 2a.5.5 0 01.5.5v5h5a.5.5 0 010 1h-5v5a.5.5 0 01-1 0v-5h-5a.5.5 0 010-1h5v-5A.5.5 0 018 2z"/></svg>
      New project
    </Btn>
  )

  const ownedProjects  = projects.filter(p => p.owner_id === myUserId)
  const sharedProjects = projects.filter(p => p.owner_id !== myUserId)

  return (
    <Layout title="Projects" actions={actions}>
      <div style={{ height:'100%', overflowY:'auto', padding:'20px 24px' }}>
        <ErrorMsg message={error} />

        {isLoading ? <SpinnerPage /> : projects.length === 0 ? (
          <EmptyState onCreate={() => setShowCreate(true)} />
        ) : (
          <>
            {/* Owned projects */}
            {ownedProjects.length > 0 && (
              <Section title="My projects" count={ownedProjects.length}>
                {ownedProjects.map(p => (
                  <ProjectCard key={p.id} project={p} isOwner={true}
                    onOpen={id => navigate(`/projects/${id}`)}
                    onShare={setShareTarget}
                    onDelete={setDeleteTarget} />
                ))}
              </Section>
            )}

            {/* Shared with me */}
            {sharedProjects.length > 0 && (
              <Section title="Shared with me" count={sharedProjects.length}>
                {sharedProjects.map(p => (
                  <ProjectCard key={p.id} project={p} isOwner={false}
                    onOpen={id => navigate(`/projects/${id}`)}
                    onShare={() => {}}
                    onDelete={() => {}} />
                ))}
              </Section>
            )}
          </>
        )}
      </div>

      {showCreate && (
        <CreateProjectModal
          cohorts={cohorts}
          onClose={() => setShowCreate(false)}
          onCreated={p => {
            queryClient.invalidateQueries({ queryKey:['projects'] })
            setShowCreate(false)
            navigate(`/projects/${p.id}`)
          }}
        />
      )}

      {shareTarget && (
        <ShareModal
          project={shareTarget}
          onClose={() => setShareTarget(null)}
          onUpdated={() => {
            refetch()
            setShareTarget(p => projects.find(x => x.id === p?.id) || p)
          }}
        />
      )}

      {/* Delete confirm */}
      {deleteTarget && (
        <div onClick={() => setDeleteTarget(null)} style={{ position:'fixed',inset:0,background:'rgba(0,20,100,0.35)',display:'flex',alignItems:'center',justifyContent:'center',zIndex:200 }}>
          <div onClick={e=>e.stopPropagation()} style={{ background:'white',borderRadius:12,padding:'24px 28px',width:380,boxShadow:'0 12px 40px rgba(0,20,100,0.18)' }}>
            <div style={{ fontFamily:'var(--font-serif)',fontSize:18,color:'var(--navy)',marginBottom:8 }}>Delete project?</div>
            <div style={{ fontSize:13,color:'var(--text-2)',marginBottom:20,lineHeight:1.6 }}>
              This will permanently delete <strong>"{deleteTarget.name}"</strong> and all its annotations. This cannot be undone.
            </div>
            <div style={{ display:'flex',gap:8,justifyContent:'flex-end' }}>
              <Btn variant="ghost" onClick={() => setDeleteTarget(null)}>Cancel</Btn>
              <Btn variant="danger" disabled={deleting} onClick={() => handleDelete(deleteTarget)}>
                {deleting ? 'Deleting…' : 'Delete permanently'}
              </Btn>
            </div>
          </div>
        </div>
      )}
    </Layout>
  )
}

function Section({ title, count, children }) {
  return (
    <div style={{ marginBottom:32 }}>
      <div style={{ display:'flex', alignItems:'baseline', gap:8, marginBottom:14 }}>
        <h2 style={{ fontFamily:'var(--font-serif)', fontSize:16, color:'var(--navy)', fontWeight:400 }}>{title}</h2>
        <span style={{ fontSize:12, color:'var(--text-3)' }}>{count}</span>
      </div>
      <div style={{ display:'grid', gridTemplateColumns:'repeat(auto-fill,minmax(280px,1fr))', gap:16 }}>
        {children}
      </div>
    </div>
  )
}

function EmptyState({ onCreate }) {
  return (
    <div style={{ display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center', height:400, gap:16 }}>
      <div style={{ width:64, height:64, borderRadius:16, background:'var(--navy-10)', display:'flex', alignItems:'center', justifyContent:'center' }}>
        <svg width="28" height="28" viewBox="0 0 16 16" fill="var(--navy-40)">
          <path d="M2 2a2 2 0 012-2h8a2 2 0 012 2v12a2 2 0 01-2 2H4a2 2 0 01-2-2V2zm2 0v12h8V2H4zm1 2h2a.5.5 0 010 1H5a.5.5 0 010-1zm0 2h6a.5.5 0 010 1H5a.5.5 0 010-1zm0 2h6a.5.5 0 010 1H5a.5.5 0 010-1zm0 2h4a.5.5 0 010 1H5a.5.5 0 010-1z"/>
        </svg>
      </div>
      <div style={{ textAlign:'center' }}>
        <div style={{ fontFamily:'var(--font-serif)', fontSize:20, color:'var(--navy)', marginBottom:6 }}>No projects yet</div>
        <div style={{ fontSize:13, color:'var(--text-3)', maxWidth:320, lineHeight:1.6 }}>
          Create your first annotation project from a saved cohort or a list of slide paths.
        </div>
      </div>
      <Btn variant="primary" onClick={onCreate}>
        <svg width="12" height="12" viewBox="0 0 16 16" fill="white"><path d="M8 2a.5.5 0 01.5.5v5h5a.5.5 0 010 1h-5v5a.5.5 0 01-1 0v-5h-5a.5.5 0 010-1h5v-5A.5.5 0 018 2z"/></svg>
        Create first project
      </Btn>
    </div>
  )
}