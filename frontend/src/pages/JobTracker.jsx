import React, { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import Layout from '../components/Layout'
import {
  SpinnerPage, Spinner, ErrorMsg, Btn, Badge, StatCard,
  Table, Th, Td, Tr, ElapsedTimer, JobStatusBadge, ProgressBar,
} from '../components/ui'
import { api } from '../api'

// ── Batch drill-down panel ────────────────────────────────────────────────────

function BatchDrillDown({ job }) {
  const queryClient = useQueryClient()
  const [retryMsg,  setRetryMsg]  = useState('')
  const isRunning = job.status === 'running'

  const { data, isLoading, error } = useQuery({
    queryKey:      ['job-result', job.id],
    queryFn:       () => api.getAnalysisResult(job.id),
    enabled:       job.status === 'done' || job.status === 'running',
    refetchInterval: isRunning ? 3000 : false,
  })

  const retryMutation = useMutation({
    mutationFn: payload => api.submitBatchAnalysis(payload),
    onSuccess: () => {
      setRetryMsg('Retry batch submitted successfully!')
      queryClient.invalidateQueries(['all-jobs'])
    },
    onError: err => setRetryMsg(`Retry failed: ${err.message}`),
  })

  if (job.status === 'queued') {
    return (
      <div style={{
        padding: 24,
        background: 'var(--navy-05)',
        textAlign: 'center',
        color: 'var(--text-3)',
        fontSize: 13,
      }}>
        Waiting for cluster allocation…
      </div>
    )
  }

  if (isLoading) {
    return (
      <div style={{ padding: 24, display: 'flex', justifyContent: 'center', background: 'var(--navy-05)' }}>
        <Spinner size={24} />
      </div>
    )
  }

  if (error) {
    return (
      <div style={{ padding: 24, background: 'var(--navy-05)', color: 'var(--crimson)', fontSize: 13 }}>
        Failed to load batch results: {error.message}
      </div>
    )
  }

  const slides       = data?.scans || []
  const failedSlides = slides.filter(s => s.status === 'failed')

  if (!slides.length) {
    return (
      <div style={{ padding: 24, background: 'var(--navy-05)', textAlign: 'center', color: 'var(--text-3)', fontSize: 13 }}>
        No slides have finished processing yet.
      </div>
    )
  }

  const handleRetry = () => {
    retryMutation.mutate({
      model_id:         job.model_id,
      output_directory: job.params_json.output_directory,
      scan_ids:         failedSlides.map(s => s.scan_id),
      params:           job.params_json,
    })
  }

  return (
    <div style={{ padding: 'var(--space-4) var(--space-6)', background: 'var(--navy-05)', borderBottom: '1px solid var(--border-l)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--navy)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Batch Status
          </span>
          {isRunning && (
            <span style={{ fontSize: 'var(--text-sm)', color: 'var(--warning-dot)', display: 'flex', alignItems: 'center', gap: 6 }}>
              <Spinner size={12} color="var(--warning-dot)" trackColor="rgba(251,191,36,0.2)" />
              Live Tracking
            </span>
          )}
        </div>

        {!isRunning && failedSlides.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            {retryMsg && (
              <span style={{
                fontSize: 12,
                color: retryMsg.includes('failed') ? 'var(--crimson)' : 'var(--teal)',
                fontWeight: 500,
              }}>
                {retryMsg}
              </span>
            )}
            <Btn
              variant="primary"
              small
              onClick={handleRetry}
              disabled={retryMutation.isLoading || retryMutation.isPending}
            >
              {retryMutation.isLoading || retryMutation.isPending
                ? 'Queuing…'
                : `Retry ${failedSlides.length} Failed`}
            </Btn>
          </div>
        )}
      </div>

      <Table>
        <thead>
          <tr>
            <Th>Slide</Th>
            <Th>Status</Th>
            <Th style={{ width: '60%' }}>Details</Th>
          </tr>
        </thead>
        <tbody>
          {slides.map((s, idx) => {
            const isFailed  = s.status === 'failed'
            const isSuccess = s.status === 'success'
            const slideName = s.scan_path
              ? s.scan_path.split('/').pop()
              : s.scan_id ? `Scan #${s.scan_id}` : 'Unknown'

            return (
              <tr key={s.scan_id || idx} style={{ borderBottom: '1px solid var(--border-l)' }}>
                <Td mono style={{ maxWidth: 200, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  <span title={s.file_path}>{slideName}</span>
                </Td>
                <Td>
                  <Badge variant={isFailed ? 'red' : isSuccess ? 'green' : 'muted'}>
                    {isFailed ? 'Failed' : isSuccess ? 'Success' : 'Pending'}
                  </Badge>
                </Td>
                <Td style={{ color: isFailed ? 'var(--crimson)' : isSuccess ? 'var(--text-2)' : 'var(--text-3)' }}>
                  {isFailed
                    ? (s.error || 'Unknown error occurred.')
                    : isSuccess
                    ? 'Processed successfully.'
                    : 'Waiting to be processed…'}
                </Td>
              </tr>
            )
          })}
        </tbody>
      </Table>
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────────

const FILTER_OPTS = ['All', 'Running', 'Done', 'Failed', 'Batch', 'Single']

export default function JobTracker() {
  const queryClient = useQueryClient()
  const [errorMsg,      setErrorMsg]      = useState('')
  const [filter,        setFilter]        = useState('All')
  const [expandedJobs,  setExpandedJobs]  = useState({})

  const { data: jobs = [], isLoading } = useQuery({
    queryKey:       ['all-jobs'],
    queryFn:        () => api.getAnalysisJobs(),
    refetchInterval: 5000,
  })

  const cancelMutation = useMutation({
    mutationFn: id => api.cancelAnalysis(id),
    onSuccess:  ()  => queryClient.invalidateQueries(['all-jobs']),
    onError:    err => setErrorMsg(err.message || 'Failed to cancel job'),
  })

  const deleteMutation = useMutation({
    mutationFn: id => api.deleteAnalysis(id),
    onSuccess:  ()  => queryClient.invalidateQueries(['all-jobs']),
    onError:    err => setErrorMsg(err.message || 'Failed to delete job'),
  })

  const handleCancel   = id => { if (window.confirm('Cancel this running job?')) cancelMutation.mutate(id) }
  const handleDelete   = id => { if (window.confirm('Permanently delete this job and its output files?')) deleteMutation.mutate(id) }
  const handleDownload = async id => {
    try { await api.downloadAnalysisFile(id, 'download_file') }
    catch (err) { alert(`Download failed: ${err.message}`) }
  }
  const toggleExpand = id => setExpandedJobs(prev => ({ ...prev, [id]: !prev[id] }))

  if (isLoading) return <SpinnerPage />

  // Derived stats
  const activeJobs     = jobs.filter(j => j.status === 'running' || j.status === 'queued')
  const completedJobs  = jobs.filter(j => j.status === 'done')
  const failedJobs     = jobs.filter(j => j.status === 'failed')
  const successRate    = (completedJobs.length + failedJobs.length) > 0
    ? Math.round((completedJobs.length / (completedJobs.length + failedJobs.length)) * 100)
    : 0

  const filteredJobs = jobs.filter(job => {
    const isBatch = job.params_json?.is_batch === true || job.params_json?.output_directory !== undefined
    if (filter === 'Running') return job.status === 'running' || job.status === 'queued'
    if (filter === 'Done')    return job.status === 'done'
    if (filter === 'Failed')  return job.status === 'failed'
    if (filter === 'Batch')   return isBatch
    if (filter === 'Single')  return !isBatch
    return true
  })

  return (
    <Layout title="Job Tracker">
      <div style={{ height: '100%', padding: 'var(--space-5) var(--space-6)', overflowY: 'auto' }}>
        <div style={{ maxWidth: 1100, margin: '0 auto' }}>

          {/* Header */}
          <div style={{ marginBottom: 'var(--space-6)' }}>
            <h2 style={{ fontFamily: 'var(--font-serif)', fontSize: 20, color: 'var(--navy)', marginBottom: 4 }}>
              Mission Control
            </h2>
            <p style={{ fontSize: 'var(--text-base)', color: 'var(--text-3)', margin: 0 }}>
              Monitor and manage your SLURM compute jobs. Auto-refreshes every 5 seconds.
            </p>
          </div>

          {/* Stats */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 'var(--space-4)', marginBottom: 'var(--space-6)' }}>
            <StatCard label="Total Runs"      value={jobs.length} />
            <StatCard label="Active / Queued" value={activeJobs.length}    accent={activeJobs.length > 0 ? 'var(--warning-dot)' : undefined} />
            <StatCard label="Completed"       value={completedJobs.length} accent="var(--teal)" />
            <StatCard label="Success Rate"    value={`${successRate}%`}    sub="Of finished jobs" />
          </div>

          <ErrorMsg message={errorMsg} onDismiss={() => setErrorMsg('')} />

          {/* Filter tabs */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 'var(--space-4)' }}>
            {FILTER_OPTS.map(f => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                style={{
                  padding: '6px 14px',
                  borderRadius: 'var(--radius-full)',
                  fontSize: 12,
                  fontWeight: 600,
                  cursor: 'pointer',
                  transition: 'var(--transition-base)',
                  background: filter === f ? 'var(--navy)' : 'var(--white)',
                  color:      filter === f ? 'var(--white)' : 'var(--text-2)',
                  border:     `1px solid ${filter === f ? 'var(--navy)' : 'var(--border-l)'}`,
                  boxShadow:  filter === f ? 'var(--shadow-s)' : 'none',
                }}
              >
                {f}
              </button>
            ))}
          </div>

          {/* Jobs table */}
          <div style={{
            background: 'var(--white)',
            borderRadius: 'var(--radius-xl)',
            border: '1px solid var(--border-l)',
            boxShadow: 'var(--shadow-s)',
            overflow: 'hidden',
          }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
              <thead>
                <tr>
                  <Th style={{ width: 40, paddingRight: 0 }} />
                  <Th>Job ID</Th>
                  <Th>Model</Th>
                  <Th>Type</Th>
                  <Th>Status / Progress</Th>
                  <Th>Runtime</Th>
                  <Th style={{ textAlign: 'right' }}>Actions</Th>
                </tr>
              </thead>
              <tbody>
                {filteredJobs.length === 0 && (
                  <tr>
                    <td colSpan={7} style={{ padding: 40, textAlign: 'center', color: 'var(--text-3)', fontSize: 13 }}>
                      No jobs match this filter.
                    </td>
                  </tr>
                )}

                {filteredJobs.map(job => {
                  const isActive   = job.status === 'running' || job.status === 'queued'
                  const params     = job.params_json || {}
                  const isBatch    = params.is_batch === true || params.output_directory !== undefined
                  const isExpanded = expandedJobs[job.id]

                  return (
                    <React.Fragment key={job.id}>
                      <tr style={{
                        borderBottom:  isExpanded ? 'none' : '1px solid var(--border-l)',
                        fontSize:      'var(--text-base)',
                        background:    isExpanded ? 'var(--navy-05)' : 'var(--white)',
                        transition:    'var(--transition-base)',
                      }}>
                        {/* Expand toggle */}
                        <td style={{ padding: 'var(--space-4) 0 var(--space-4) var(--space-4)', verticalAlign: 'middle' }}>
                          {isBatch && (
                            <button
                              onClick={() => toggleExpand(job.id)}
                              style={{
                                background: 'none', border: 'none', cursor: 'pointer',
                                color: 'var(--text-3)', fontSize: 13, padding: 4,
                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                                width: 24, height: 24, borderRadius: 'var(--radius-sm)',
                                transition: 'var(--transition-fast)',
                              }}
                              onMouseEnter={e => e.currentTarget.style.background = 'var(--navy-10)'}
                              onMouseLeave={e => e.currentTarget.style.background = 'none'}
                            >
                              {isExpanded ? '▼' : '▶'}
                            </button>
                          )}
                        </td>

                        <Td mono>
                          #{job.id}
                          <br />
                          <span style={{ fontSize: 10, color: 'var(--text-3)', fontWeight: 400 }}>
                            SLURM: {job.slurm_job_id || '—'}
                          </span>
                        </Td>

                        <Td style={{ fontWeight: 500 }}>
                          {job.model_id}
                          {job.error_message && (
                            <div style={{
                              fontSize: 'var(--text-sm)', color: 'var(--crimson)', marginTop: 4,
                              maxWidth: 200, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                            }} title={job.error_message}>
                              ⚠ {job.error_message}
                            </div>
                          )}
                        </Td>

                        <Td>
                          <Badge style={{
                            background: isBatch ? 'rgba(100,20,200,0.10)' : 'var(--navy-10)',
                            color:      isBatch ? '#6414c8' : 'var(--navy)',
                            borderRadius: 'var(--radius-full)',
                          }}>
                            {isBatch ? 'Batch' : 'Single WSI'}
                          </Badge>
                        </Td>

                        <Td style={{ width: '25%' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--text-sm)', marginBottom: 4 }}>
                            <JobStatusBadge status={job.status} />
                            {isActive && (
                              <span style={{ color: 'var(--text-3)' }}>{job.progress || 0}%</span>
                            )}
                          </div>
                          {isActive && (
                            <ProgressBar
                              value={job.progress || 0}
                              color="var(--warning-dot)"
                              height={4}
                            />
                          )}
                        </Td>

                        <Td mono>
                          <ElapsedTimer since={job.created_at} status={job.status} />
                        </Td>

                        <Td style={{ textAlign: 'right' }}>
                          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center' }}>
                            {!isBatch && job.scan_id && (
                              <Btn variant="primary" small onClick={() => window.open(`/viewer/${job.scan_id}`, '_blank')}>
                                Open Viewer ↗
                              </Btn>
                            )}
                            {job.status === 'done' && (
                              <Btn variant="primary" small onClick={() => handleDownload(job.id)}>
                                Download
                              </Btn>
                            )}
                            {isActive && (
                              <Btn variant="ghost" small onClick={() => handleCancel(job.id)}>
                                Cancel
                              </Btn>
                            )}
                            <button
                              onClick={() => handleDelete(job.id)}
                              title="Delete Job & Files"
                              style={{
                                background: 'transparent',
                                border: '1px solid var(--border)',
                                borderRadius: 'var(--radius-sm)',
                                width: 28, height: 28,
                                color: 'var(--text-3)',
                                cursor: 'pointer',
                                display: 'flex', alignItems: 'center', justifyContent: 'center',
                                transition: 'var(--transition-fast)',
                              }}
                              onMouseEnter={e => { e.currentTarget.style.color = 'var(--crimson)'; e.currentTarget.style.borderColor = 'var(--crimson)' }}
                              onMouseLeave={e => { e.currentTarget.style.color = 'var(--text-3)';  e.currentTarget.style.borderColor = 'var(--border)' }}
                            >
                              ✕
                            </button>
                          </div>
                        </Td>
                      </tr>

                      {isExpanded && isBatch && (
                        <tr>
                          <td colSpan={7} style={{ padding: 0 }}>
                            <BatchDrillDown job={job} />
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>

        </div>
      </div>
    </Layout>
  )
}