import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import Layout from '../components/Layout'
import {
  StatCard, Panel, ProgressBar, JobStatusBadge, Badge,
  Btn, Spinner, EmptyState,
} from '../components/ui'
import { useAuth } from '../context/AuthContext'
import { api } from '../api'

// ── Helpers ──────────────────────────────────────────────────────────────────

function fmtNum(n) { return n?.toLocaleString('en-CH') ?? '—' }

function relTime(iso) {
  if (!iso) return ''
  const diff = Date.now() - new Date(iso).getTime()
  const h = Math.floor(diff / 3600000)
  if (h < 1) return `${Math.floor(diff / 60000)}m ago`
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

function greeting() {
  const h = new Date().getHours()
  if (h < 12) return 'Good morning'
  if (h < 18) return 'Good afternoon'
  return 'Good evening'
}

function prettifyModelId(id) {
  if (!id) return 'Unknown model'
  return id.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

// ── Submissions by Year chart ─────────────────────────────────────────────────

function TimelineChart({ data }) {
  const [hovered, setHovered] = useState(null)
  if (!data?.length) return null
  const maxCount = Math.max(...data.map(d => d.count))

  return (
    <Panel title="Submissions by Year">
      <div style={{ padding: '0 4px 4px' }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 120 }}>
          {data.map(d => {
            const h = Math.max(4, (d.count / maxCount) * 110)
            const isHov = hovered === d.year
            return (
              <div
                key={d.year}
                style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, cursor: 'default' }}
                onMouseEnter={() => setHovered(d.year)}
                onMouseLeave={() => setHovered(null)}
              >
                {isHov && (
                  <div style={{ fontSize: 9, fontFamily: 'var(--font-mono)', color: 'var(--navy)', fontWeight: 600, whiteSpace: 'nowrap' }}>
                    {fmtNum(d.count)}
                  </div>
                )}
                <div style={{
                  width: '100%', maxWidth: 44, height: h,
                  background: isHov ? 'var(--navy-80)' : 'var(--navy)',
                  borderRadius: '3px 3px 0 0',
                  opacity: isHov ? 1 : 0.75,
                  transition: 'opacity 0.15s, background 0.15s',
                  marginTop: 'auto',
                }} />
              </div>
            )
          })}
        </div>
        <div style={{ display: 'flex', gap: 3, marginTop: 5 }}>
          {data.map(d => (
            <div key={d.year} style={{ flex: 1, textAlign: 'center', fontSize: 9, color: 'var(--text-3)', fontFamily: 'var(--font-mono)' }}>
              {String(d.year).slice(2)}
            </div>
          ))}
        </div>
      </div>
    </Panel>
  )
}

// ── Stain distribution chart ──────────────────────────────────────────────────

const STAIN_COLORS = {
  'H&E':                'var(--blue)',
  'IHC':                'var(--purple)',
  'Special stains':     'var(--teal)',
  'ISH':                'var(--pink)',
  'Immunofluorescence': 'var(--amber)',
  'Unstained':          'var(--text-3)',
}

function StainChart({ data }) {
  if (!data?.length) return null
  const maxCount = Math.max(...data.map(d => d.count))
  const topStains = data.slice(0, 7)

  return (
    <Panel title="Scans by Stain Category">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '0 4px 4px' }}>
        {topStains.map(d => {
          const color = STAIN_COLORS[d.category] || 'var(--navy-40)'
          return (
            <div key={d.category} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ width: 100, fontSize: 'var(--text-sm)', color: 'var(--text-2)', textAlign: 'right', flexShrink: 0 }}>
                {d.category}
              </span>
              <div style={{ flex: 1, background: 'var(--navy-05)', borderRadius: 'var(--radius-full)', overflow: 'hidden', height: 16 }}>
                <div style={{
                  width: `${(d.count / maxCount) * 100}%`,
                  height: '100%',
                  borderRadius: 'var(--radius-full)',
                  background: color,
                  opacity: 0.8,
                  transition: 'width 0.5s ease',
                }} />
              </div>
              <span style={{ width: 50, fontSize: 11, color: 'var(--text-3)', fontFamily: 'var(--font-mono)', textAlign: 'right', flexShrink: 0 }}>
                {fmtNum(d.count)}
              </span>
            </div>
          )
        })}
      </div>
    </Panel>
  )
}

// ── AI Jobs panel ─────────────────────────────────────────────────────────────

function JobsPanel({ jobs, isLoading }) {
  const navigate = useNavigate()
  if (isLoading) return (
    <Panel title="AI Jobs" actions={<Btn variant="link" small onClick={() => navigate('/job-tracker')}>View all →</Btn>}>
      <div style={{ display: 'flex', justifyContent: 'center', padding: '24px 0' }}><Spinner size={20} /></div>
    </Panel>
  )

  const active = jobs.filter(j => j.status === 'running' || j.status === 'queued')
  const recent = jobs
    .filter(j => ['done', 'failed', 'cancelled'].includes(j.status))
    .slice(0, 4)

  return (
    <Panel
      title="AI Jobs"
      actions={<Btn variant="link" small onClick={() => navigate('/job-tracker')}>View all →</Btn>}
    >
      {active.length === 0 && recent.length === 0 && (
        <EmptyState
          icon={<svg width="22" height="22" viewBox="0 0 16 16" fill="currentColor"><path d="M11.251.068a.5.5 0 01.227.58L9.677 6.5H13a.5.5 0 01.364.843l-8 8.5a.5.5 0 01-.842-.49L6.323 9.5H3a.5.5 0 01-.364-.843l8-8.5a.5.5 0 01.615-.09z"/></svg>}
          title="No jobs yet"
          description="Submit a batch analysis to see your jobs here."
        />
      )}

      {active.map(job => (
        <div key={job.id} style={{ padding: '10px 0', borderBottom: '1px solid var(--border-l)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <JobStatusBadge status={job.status} />
            <span style={{ flex: 1, fontSize: 'var(--text-base)', color: 'var(--text-1)', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {prettifyModelId(job.model_id)}
            </span>
            <span style={{ fontSize: 10, color: 'var(--text-3)', fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap' }}>
              {relTime(job.created_at)}
            </span>
          </div>
          {job.status === 'running' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{ flex: 1 }}>
                <ProgressBar value={job.progress} />
              </div>
              <span style={{ fontSize: 10, color: 'var(--text-3)', whiteSpace: 'nowrap' }}>
                {job.progress}%
              </span>
            </div>
          )}
        </div>
      ))}

      {recent.length > 0 && (
        <>
          <div style={{ fontSize: 9, fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.06em', marginTop: 14, marginBottom: 8 }}>
            Completed recently
          </div>
          {recent.map(job => (
            <div key={job.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 0', borderBottom: '1px solid var(--border-l)' }}>
              <JobStatusBadge status={job.status} />
              <span style={{ flex: 1, fontSize: 'var(--text-sm)', color: 'var(--text-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {prettifyModelId(job.model_id)}
              </span>
              <span style={{ fontSize: 10, color: 'var(--text-3)', fontFamily: 'var(--font-mono)' }}>
                {relTime(job.updated_at)}
              </span>
            </div>
          ))}
        </>
      )}
    </Panel>
  )
}

// ── Projects panel ────────────────────────────────────────────────────────────

function ProjectsPanel({ projects, isLoading }) {
  const navigate = useNavigate()
  if (isLoading) return (
    <Panel title="Projects" actions={<Btn variant="link" small onClick={() => navigate('/projects')}>View all →</Btn>}>
      <div style={{ display: 'flex', justifyContent: 'center', padding: '24px 0' }}><Spinner size={20} /></div>
    </Panel>
  )

  const myProjects  = projects.filter(p => p.access === 'owner').slice(0, 3)
  const sharedProjs = projects.filter(p => p.access !== 'owner').slice(0, 2)
  const hasAny = myProjects.length > 0 || sharedProjs.length > 0

  return (
    <Panel
      title="Projects"
      actions={<Btn variant="link" small onClick={() => navigate('/projects')}>View all →</Btn>}
    >
      {!hasAny && (
        <EmptyState
          icon={<svg width="22" height="22" viewBox="0 0 16 16" fill="currentColor"><path d="M2 2a2 2 0 012-2h8a2 2 0 012 2v12a2 2 0 01-2 2H4a2 2 0 01-2-2V2zm2 0v12h8V2H4zm1 2h2v1H5V4zm0 2h6v1H5V6zm0 2h6v1H5V8zm0 2h4v1H5v-1z"/></svg>}
          title="No projects yet"
          description="Create your first annotation project."
        />
      )}

      {myProjects.map(p => {
        const pct = p.scan_count > 0 ? Math.round((p.annotated_scans / p.scan_count) * 100) : 0
        const typeIsCell = p.project_type === 'cell_detection'
        return (
          <div key={p.id} style={{ padding: '10px 0', borderBottom: '1px solid var(--border-l)', cursor: 'pointer' }}
            onClick={() => navigate(`/projects/${p.id}`)}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <Badge variant={typeIsCell ? 'navy' : 'teal'} style={{ fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                {typeIsCell ? 'Cell' : 'Region'}
              </Badge>
              <span style={{ flex: 1, fontSize: 'var(--text-base)', color: 'var(--text-1)', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {p.name}
              </span>
              <span style={{ fontSize: 11, color: pct === 100 ? 'var(--teal)' : 'var(--text-3)', fontFamily: 'var(--font-mono)', fontWeight: 600 }}>
                {pct}%
              </span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{ flex: 1 }}>
                <ProgressBar value={pct} color={pct === 100 ? 'var(--teal)' : 'var(--teal)'} />
              </div>
              <span style={{ fontSize: 10, color: 'var(--text-3)', whiteSpace: 'nowrap' }}>
                {p.annotated_scans}/{p.scan_count} slides
              </span>
            </div>
          </div>
        )
      })}

      {sharedProjs.length > 0 && (
        <>
          <div style={{ fontSize: 9, fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.06em', marginTop: 14, marginBottom: 8 }}>
            Shared with you
          </div>
          {sharedProjs.map(p => {
            const pct = p.scan_count > 0 ? Math.round((p.annotated_scans / p.scan_count) * 100) : 0
            return (
              <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0', borderBottom: '1px solid var(--border-l)', cursor: 'pointer' }}
                onClick={() => navigate(`/projects/${p.id}`)}>
                <Badge variant={p.access === 'edit' ? 'warning' : 'muted'} style={{ fontSize: 9 }}>
                  {p.access === 'edit' ? 'Can edit' : 'View only'}
                </Badge>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-1)', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</div>
                  {p.owner_name && <div style={{ fontSize: 10, color: 'var(--text-3)' }}>from {p.owner_name}</div>}
                </div>
                <span style={{ fontSize: 11, color: 'var(--text-3)', fontFamily: 'var(--font-mono)' }}>{pct}%</span>
              </div>
            )
          })}
        </>
      )}
    </Panel>
  )
}

// ── Saved cohorts ─────────────────────────────────────────────────────────────

function CohortsRow({ cohorts, isLoading }) {
  const navigate = useNavigate()
  if (isLoading || !cohorts?.length) return null
  const recent = cohorts.slice(0, 6)
  return (
    <Panel title="Recent Cohorts" actions={<Btn variant="link" small onClick={() => navigate('/cohorts')}>View all →</Btn>}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', paddingBottom: 2 }}>
        {recent.map(c => (
          <button
            key={c.id}
            onClick={() => navigate(`/saved-results/${c.id}`)}
            style={{
              padding: '6px 14px', borderRadius: 'var(--radius-full)',
              border: '1px solid var(--border-l)', background: 'var(--navy-05)',
              fontSize: 12, color: 'var(--text-2)', cursor: 'pointer',
              display: 'flex', alignItems: 'center', gap: 8,
              transition: 'var(--transition-fast)',
              fontFamily: 'var(--font-sans)',
            }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--teal)'; e.currentTarget.style.color = 'var(--teal)' }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border-l)'; e.currentTarget.style.color = 'var(--text-2)' }}
          >
            <span style={{ fontWeight: 500 }}>{c.name}</span>
            <span style={{ fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--text-3)' }}>
              {fmtNum(c.result_count)}
            </span>
          </button>
        ))}
      </div>
    </Panel>
  )
}

// ── Quick actions ─────────────────────────────────────────────────────────────

function QuickActions() {
  const navigate = useNavigate()
  const actions = [
    { label: 'Search patients',   icon: '🔍', to: '/patients',  accent: false },
    { label: 'Build a cohort',    icon: '📊', to: '/cohorts',   accent: false },
    { label: 'New project',       icon: '➕', to: '/projects',  accent: false },
    { label: 'Ask AI assistant',  icon: '💬', to: '/assistant', accent: true  },
  ]
  return (
    <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
      {actions.map(a => (
        <button
          key={a.label}
          onClick={() => navigate(a.to)}
          style={{
            flex: '1 1 170px', padding: '14px 16px',
            display: 'flex', alignItems: 'center', gap: 10,
            cursor: 'pointer',
            border: a.accent ? '1px solid var(--teal-20)' : '1px solid var(--border-l)',
            background: a.accent ? 'var(--teal-10)' : 'var(--white)',
            borderRadius: 'var(--radius-lg)',
            boxShadow: 'var(--shadow-s)',
            fontFamily: 'var(--font-sans)', fontSize: 'var(--text-base)',
            color: a.accent ? 'var(--teal)' : 'var(--text-2)',
            fontWeight: 500,
            transition: 'var(--transition-base)',
          }}
          onMouseEnter={e => { e.currentTarget.style.boxShadow = 'var(--shadow-m)'; e.currentTarget.style.transform = 'translateY(-1px)' }}
          onMouseLeave={e => { e.currentTarget.style.boxShadow = 'var(--shadow-s)'; e.currentTarget.style.transform = 'none' }}
        >
          <span style={{ fontSize: 17 }}>{a.icon}</span>
          {a.label}
          <span style={{ marginLeft: 'auto', fontSize: 14, opacity: 0.35 }}>→</span>
        </button>
      ))}
    </div>
  )
}

// ── Main dashboard ────────────────────────────────────────────────────────────

export default function Dashboard() {
  const navigate    = useNavigate()
  const { user }    = useAuth()

  const { data: stats, isLoading: statsLoading } = useQuery({
    queryKey: ['dashboard-stats'],
    queryFn:  () => api.getDashboardStats(),
    staleTime: 60_000,
  })

  const { data: jobs = [], isLoading: jobsLoading } = useQuery({
    queryKey: ['all-jobs'],
    queryFn:  () => api.getAnalysisJobs(),
    refetchInterval: 15_000,
  })

  const { data: projects = [], isLoading: projectsLoading } = useQuery({
    queryKey: ['projects'],
    queryFn:  () => api.getProjects(),
    staleTime: 30_000,
  })

  const { data: cohorts = [], isLoading: cohortsLoading } = useQuery({
    queryKey: ['cohorts'],
    queryFn:  () => api.getCohorts(),
    staleTime: 30_000,
  })

  const now = new Date()
  const dateStr = now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
  const username = user?.username || ''

  const activeJobCount = jobs.filter(j => j.status === 'running' || j.status === 'queued').length
  const totalProjects  = projects.length

  return (
    <Layout title="Dashboard">
      <div style={{ height: '100%', overflowY: 'auto', padding: 'var(--space-5) var(--space-6)' }}>
        <div style={{ maxWidth: 1160, margin: '0 auto' }}>

          {/* ── Greeting ──────────────────────────────────────────── */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 24 }}>
            <h1 style={{ fontFamily: 'var(--font-serif)', fontSize: 22, fontWeight: 400, color: 'var(--navy)', margin: 0 }}>
              {greeting()}{username ? `, ${username}` : ''}
            </h1>
            <span style={{ fontSize: 13, color: 'var(--text-3)' }}>{dateStr}</span>
          </div>

          {/* ── Stat cards ────────────────────────────────────────── */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12, marginBottom: 24 }}>
            <StatCard
              label="Patients"
              value={statsLoading ? '…' : fmtNum(stats?.patient_count)}
              sub={stats ? `Since ${stats.year_min ?? '?'}` : ''}
            />
            <StatCard
              label="Submissions"
              value={statsLoading ? '…' : fmtNum(stats?.submission_count)}
              sub={stats ? `${stats.malignancy_rate ?? 0}% malignant` : ''}
            />
            <StatCard
              label="Scans"
              value={statsLoading ? '…' : fmtNum(stats?.scan_count)}
              sub={stats ? `${stats.scanned_pct ?? 0}% blocks scanned` : ''}
              accent="var(--teal)"
            />
            <StatCard
              label="Stain types"
              value={statsLoading ? '…' : (stats?.stain_type_count ?? '—')}
              sub="H&E, IHC, Special…"
              accent="var(--purple)"
            />
            <StatCard
              label="Projects"
              value={projectsLoading ? '…' : totalProjects}
              sub={`${projects.filter(p => p.access !== 'owner').length} shared with you`}
              accent="var(--amber)"
            />
            <StatCard
              label="Active jobs"
              value={jobsLoading ? '…' : activeJobCount}
              sub={`${jobs.length} total`}
              accent={activeJobCount > 0 ? 'var(--warning-dot)' : undefined}
            />
          </div>

          {/* ── Active work: Jobs + Projects ──────────────────────── */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 24 }}>
            <JobsPanel      jobs={jobs}         isLoading={jobsLoading} />
            <ProjectsPanel  projects={projects} isLoading={projectsLoading} />
          </div>

          {/* ── Collection charts ─────────────────────────────────── */}
          {!statsLoading && (stats?.submissions_by_year?.length > 0 || stats?.stain_distribution?.length > 0) && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 24 }}>
              <TimelineChart data={stats?.submissions_by_year} />
              <StainChart    data={stats?.stain_distribution} />
            </div>
          )}

          {/* ── Saved cohorts ────────────────────────────────────── */}
          <div style={{ marginBottom: 24 }}>
            <CohortsRow cohorts={cohorts} isLoading={cohortsLoading} />
          </div>

          {/* ── Quick actions ────────────────────────────────────── */}
          <QuickActions />

        </div>
      </div>
    </Layout>
  )
}
