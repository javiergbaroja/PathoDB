import React, { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import Layout from '../components/Layout'
import { SpinnerPage, ErrorMsg, Btn, Badge, StatCard, Spinner } from '../components/ui'
import { api } from '../api'

// Helper: Elapsed time counter
function ElapsedTimer({ since, status }) {
  const [elapsed, setElapsed] = useState(0)
  
  useEffect(() => {
    if (status === 'done' || status === 'failed' || status === 'cancelled') return
    const start = new Date(since).getTime()
    const tick = () => setElapsed(Math.floor((Date.now() - start) / 1000))
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [since, status])

  if (status === 'done' || status === 'failed' || status === 'cancelled') return <span>—</span>
  
  const m = Math.floor(elapsed / 60)
  const s = String(elapsed % 60).padStart(2, '0')
  return <span>{m}m {s}s</span>
}

// ── BATCH DRILL-DOWN COMPONENT ───────────────────────────────────────────────
function BatchDrillDown({ job }) {
  const queryClient = useQueryClient()
  const [retryMsg, setRetryMsg] = useState('')
  
  const isRunning = job.status === 'running'

  // Fetch the result.json. If running, poll every 3 seconds for live updates!
  const { data, isLoading, error } = useQuery({
    queryKey: ['job-result', job.id],
    queryFn: () => api.getAnalysisResult(job.id),
    enabled: job.status === 'done' || job.status === 'running',
    refetchInterval: isRunning ? 3000 : false,
  })

  const retryMutation = useMutation({
    mutationFn: async (payload) => await api.submitBatchAnalysis(payload),
    onSuccess: () => {
      setRetryMsg('Retry batch submitted successfully!')
      queryClient.invalidateQueries(['all-jobs'])
    },
    onError: (err) => setRetryMsg(`Retry failed: ${err.message}`)
  })

  if (job.status === 'queued') {
    return <div style={{ padding: '24px', background: 'var(--navy-05)', textAlign: 'center', color: 'var(--text-3)', fontSize: 13 }}>Waiting for cluster allocation...</div>
  }

  if (isLoading) return <div style={{ padding: 24, display: 'flex', justifyContent: 'center', background: 'var(--navy-05)' }}><Spinner size={24} /></div>
  if (error) return <div style={{ padding: 24, background: 'var(--navy-05)', color: 'var(--crimson)', fontSize: 13 }}>Failed to load batch results: {error.message}</div>

  const slides = data?.scans || []
  
  if (slides.length === 0) {
    return <div style={{ padding: 24, background: 'var(--navy-05)', textAlign: 'center', color: 'var(--text-3)', fontSize: 13 }}>No slides have finished processing yet.</div>
  }

  const failedSlides = slides.filter(s => s.status === 'failed')

  const handleRetry = () => {
    const payload = {
      model_id: job.model_id,
      output_directory: job.params_json.output_directory,
      scan_ids: failedSlides.map(s => s.scan_id),
      params: job.params_json
    }
    retryMutation.mutate(payload)
  }

  return (
    <div style={{ padding: '16px 24px', background: 'var(--navy-05)', borderBottom: '1px solid var(--border-l)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <h4 style={{ margin: 0, fontSize: 13, color: 'var(--navy)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Batch Status Breakdown</h4>
          {isRunning && <span style={{ fontSize: 11, color: '#d97706', display: 'flex', alignItems: 'center', gap: 6 }}><Spinner size={12}/> Live Tracking</span>}
        </div>
        
        {/* SMART RETRY BUTTON */}
        {!isRunning && failedSlides.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            {retryMsg && <span style={{ fontSize: 12, color: retryMsg.includes('failed') ? 'var(--crimson)' : '#1b998b', fontWeight: 500 }}>{retryMsg}</span>}
            <Btn variant="primary" small onClick={handleRetry} disabled={retryMutation.isLoading || retryMutation.isPending}>
              {retryMutation.isLoading || retryMutation.isPending ? 'Queuing...' : `Retry ${failedSlides.length} Failed Slides`}
            </Btn>
          </div>
        )}
      </div>

      <div style={{ background: 'white', borderRadius: 6, border: '1px solid var(--border-l)', overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ background: '#f8fafc', borderBottom: '1px solid var(--border-l)', color: 'var(--text-3)', textTransform: 'uppercase' }}>
              <th style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 600 }}>Scan ID</th>
              <th style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 600 }}>Status</th>
              <th style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 600, width: '60%' }}>Details</th>
            </tr>
          </thead>
          <tbody>
            {slides.map((s, idx) => {
              // EXPLICIT STATE CHECKING
              const isFailed = s.status === 'failed'
              const isSuccess = s.status === 'success'
              const isPending = !isFailed && !isSuccess // Catches null, undefined, or missing

              let badgeVariant = 'muted'
              let badgeText = 'Pending'
              let detailText = 'Waiting to be processed...'
              let detailColor = 'var(--text-3)'

              if (isFailed) {
                badgeVariant = 'red'
                badgeText = 'Failed'
                detailText = s.error || 'Unknown error occurred.'
                detailColor = 'var(--crimson)'
              } else if (isSuccess) {
                badgeVariant = 'green'
                badgeText = 'Success'
                detailText = 'Processed successfully.'
                detailColor = 'var(--text-2)'
              }

              const slideName = s.scan_path 
                ? s.scan_path.split('/').pop() 
                : (s.scan_id ? `Scan #${s.scan_id}` : 'Unknown')

              return (
                <tr key={s.scan_id || idx} style={{ borderBottom: '1px solid var(--border-l)' }}>
                  {/* DISPLAY SLIDE NAME WITH TOOLTIP */}
                  <td 
                    title={s.file_path} // Hovering shows the full path
                    style={{ padding: '8px 12px', fontFamily: 'monospace', color: 'var(--navy)', fontWeight: 600, maxWidth: 200, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
                  >
                    {slideName}
                  </td>
                  <td style={{ padding: '8px 12px' }}>
                    <Badge variant={badgeVariant}>{badgeText}</Badge>
                  </td>
                  <td style={{ padding: '8px 12px', color: detailColor }}>
                    {detailText}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── MAIN PAGE ────────────────────────────────────────────────────────────────
export default function JobTracker() {
  const queryClient = useQueryClient()
  const [errorMsg, setErrorMsg] = useState('')
  const [filter, setFilter] = useState('All') // 'All' | 'Running' | 'Done' | 'Failed' | 'Batch' | 'Single'
  const [expandedJobs, setExpandedJobs] = useState({})

  const { data: jobs = [], isLoading } = useQuery({
    queryKey: ['all-jobs'],
    queryFn: () => api.getAnalysisJobs(),
    refetchInterval: 5000, 
  })

  const cancelMutation = useMutation({
    mutationFn: async (id) => await api.cancelAnalysis(id),
    onSuccess: () => queryClient.invalidateQueries(['all-jobs']),
    onError: (err) => setErrorMsg(err.message || 'Failed to cancel job')
  })

  const deleteMutation = useMutation({
    mutationFn: async (id) => await api.deleteAnalysis(id),
    onSuccess: () => queryClient.invalidateQueries(['all-jobs']),
    onError: (err) => setErrorMsg(err.message || 'Failed to delete job')
  })

  const handleCancel = (id) => { if (window.confirm('Cancel this running job?')) cancelMutation.mutate(id) }
  const handleDelete = (id) => { if (window.confirm('Permanently delete this job and its output files?')) deleteMutation.mutate(id) }
  const handleDownload = async (id) => {
    try { await api.downloadAnalysisFile(id, 'download_file') } 
    catch (err) { alert(`Download failed: ${err.message}`) }
  }

  const toggleExpand = (id) => setExpandedJobs(prev => ({ ...prev, [id]: !prev[id] }))

  if (isLoading) return <SpinnerPage />

  // Derived Analytics & Filtering
  const activeJobs = jobs.filter(j => j.status === 'running' || j.status === 'queued')
  const completedJobs = jobs.filter(j => j.status === 'done')
  const failedJobs = jobs.filter(j => j.status === 'failed')
  const successRate = jobs.length > 0 ? Math.round((completedJobs.length / (completedJobs.length + failedJobs.length)) * 100) || 0 : 0

  const filteredJobs = jobs.filter(job => {
    const isBatch = job.params_json?.is_batch === true || job.params_json?.output_directory !== undefined
    if (filter === 'Running') return job.status === 'running' || job.status === 'queued'
    if (filter === 'Done') return job.status === 'done'
    if (filter === 'Failed') return job.status === 'failed'
    if (filter === 'Batch') return isBatch
    if (filter === 'Single') return !isBatch
    return true
  })

  return (
    <Layout title="Job Tracker">
      <div style={{ height: '100%', padding: '20px 24px', overflowY: 'auto' }}>
        <div style={{ maxWidth: 1100, margin: '0 auto' }}>
          
          <div style={{ marginBottom: 24 }}>
            <h2 style={{ fontFamily: 'var(--font-serif)', fontSize: 20, color: 'var(--navy)', marginBottom: 4 }}>Mission Control</h2>
            <p style={{ fontSize: 13, color: 'var(--text-3)', margin: 0 }}>Monitor and manage your SLURM compute jobs. Auto-refreshes every 5 seconds.</p>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16, marginBottom: 24 }}>
            <StatCard label="Total Runs" value={jobs.length} />
            <StatCard label="Active / Queued" value={activeJobs.length} accent={activeJobs.length > 0 ? '#d97706' : undefined} />
            <StatCard label="Completed" value={completedJobs.length} accent="#1b998b" />
            <StatCard label="Success Rate" value={`${successRate}%`} sub="Of finished jobs" />
          </div>

          {errorMsg && <ErrorMsg message={errorMsg} />}

          {/* FILTER BAR */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
            {['All', 'Running', 'Done', 'Failed', 'Batch', 'Single'].map(f => (
              <button 
                key={f} 
                onClick={() => setFilter(f)}
                style={{ 
                  padding: '6px 14px', borderRadius: 20, fontSize: 12, fontWeight: 600, cursor: 'pointer', transition: 'all 0.15s',
                  background: filter === f ? 'var(--navy)' : 'white', 
                  color: filter === f ? 'white' : 'var(--text-2)',
                  border: `1px solid ${filter === f ? 'var(--navy)' : 'var(--border-l)'}`,
                  boxShadow: filter === f ? '0 2px 6px rgba(0,20,100,0.1)' : 'none'
                }}
              >
                {f}
              </button>
            ))}
          </div>

          {/* JOB TABLE */}
          <div style={{ background: 'white', borderRadius: 10, border: '1px solid var(--border-l)', boxShadow: 'var(--shadow-s)', overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
              <thead>
                <tr style={{ background: 'var(--navy-05)', borderBottom: '1px solid var(--border-l)', fontSize: 11, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  <th style={{ width: 40, padding: '12px 0 12px 16px' }}></th>
                  <th style={{ padding: '12px 16px', fontWeight: 600 }}>Job ID</th>
                  <th style={{ padding: '12px 16px', fontWeight: 600 }}>Model</th>
                  <th style={{ padding: '12px 16px', fontWeight: 600 }}>Type</th>
                  <th style={{ padding: '12px 16px', fontWeight: 600 }}>Status / Progress</th>
                  <th style={{ padding: '12px 16px', fontWeight: 600 }}>Runtime</th>
                  <th style={{ padding: '12px 16px', fontWeight: 600, textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredJobs.length === 0 && (
                  <tr>
                    <td colSpan="7" style={{ padding: 40, textAlign: 'center', color: 'var(--text-3)', fontSize: 13 }}>No jobs match this filter.</td>
                  </tr>
                )}
                
                {filteredJobs.map(job => {
                  const isRunning = job.status === 'running' || job.status === 'queued'
                  const params = job.params_json || {}
                  const isBatch = params.is_batch === true || params.output_directory !== undefined
                  const isExpanded = expandedJobs[job.id]

                  return (
                    <React.Fragment key={job.id}>
                      <tr style={{ borderBottom: isExpanded ? 'none' : '1px solid var(--border-l)', fontSize: 13, background: isExpanded ? 'rgba(0,20,100,0.02)' : 'white', transition: 'background 0.2s' }}>
                        
                        <td style={{ padding: '16px 0 16px 16px', verticalAlign: 'middle' }}>
                          {isBatch && (
                            <button 
                              onClick={() => toggleExpand(job.id)}
                              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-3)', fontSize: 14, padding: 4, display: 'flex', alignItems: 'center', justifyContent: 'center', width: 24, height: 24, borderRadius: 4, transition: 'background 0.15s' }}
                              onMouseEnter={e => e.currentTarget.style.background = 'var(--navy-10)'}
                              onMouseLeave={e => e.currentTarget.style.background = 'none'}
                            >
                              {isExpanded ? '▼' : '▶'}
                            </button>
                          )}
                        </td>

                        <td style={{ padding: '16px', color: 'var(--navy)', fontFamily: 'monospace', fontWeight: 600 }}>
                          #{job.id} <br/>
                          <span style={{ fontSize: 10, color: 'var(--text-3)', fontWeight: 400 }}>SLURM: {job.slurm_job_id || '—'}</span>
                        </td>
                        
                        <td style={{ padding: '16px', color: 'var(--text-1)', fontWeight: 500 }}>
                          {job.model_id}
                          {job.error_message && (
                            <div style={{ fontSize: 11, color: 'var(--crimson)', marginTop: 4, maxWidth: 200, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={job.error_message}>
                              ⚠ {job.error_message}
                            </div>
                          )}
                        </td>
                        
                        <td style={{ padding: '16px' }}>
                          <span style={{ 
                            fontSize: 10, padding: '3px 8px', borderRadius: 20, fontWeight: 600, textTransform: 'uppercase',
                            background: isBatch ? 'rgba(100,20,200,0.1)' : 'var(--navy-10)',
                            color: isBatch ? '#6414c8' : 'var(--navy)' 
                          }}>
                            {isBatch ? 'Batch' : 'Single WSI'}
                          </span>
                        </td>                

                        <td style={{ padding: '16px', width: '25%' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 4 }}>
                            <span style={{ 
                              fontWeight: 600, textTransform: 'uppercase',
                              color: job.status === 'done' ? '#1b998b' : 
                                     job.status === 'failed' ? '#dc2626' : 
                                     job.status === 'running' ? '#d97706' : 'var(--text-3)' 
                            }}>
                              {job.status}
                            </span>
                            {isRunning && <span style={{ color: 'var(--text-3)' }}>{job.progress || 0}%</span>}
                          </div>
                          {isRunning && (
                            <div style={{ height: 4, background: 'var(--navy-10)', borderRadius: 2, overflow: 'hidden' }}>
                              <div style={{ height: '100%', width: `${job.progress || 0}%`, background: '#fbbf24', transition: 'width 0.5s' }} />
                            </div>
                          )}
                        </td>

                        <td style={{ padding: '16px', color: 'var(--text-3)', fontFamily: 'monospace' }}>
                          <ElapsedTimer since={job.created_at} status={job.status} />
                        </td>

                        <td style={{ padding: '16px', textAlign: 'right' }}>
                          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center' }}>
                            {!isBatch && job.scan_id && (
                              <Btn variant="primary" small onClick={() => window.open(`/viewer/${job.scan_id}`, '_blank')}>
                                Open Viewer ↗
                              </Btn>
                            )}
                            {job.status === 'done' && (
                              <Btn variant="primary" small onClick={() => handleDownload(job.id)}>
                                Download Result
                              </Btn>
                            )}
                            {isRunning && (
                              <Btn variant="ghost" small onClick={() => handleCancel(job.id)}>
                                Cancel
                              </Btn>
                            )}
                            <button 
                              onClick={() => handleDelete(job.id)}
                              title="Delete Job & Files"
                              style={{ background: 'transparent', border: '1px solid var(--border)', borderRadius: 4, width: 28, height: 28, color: 'var(--text-3)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'all 0.15s' }}
                              onMouseEnter={e => { e.currentTarget.style.color = 'var(--crimson)'; e.currentTarget.style.borderColor = 'var(--crimson-40)' }}
                              onMouseLeave={e => { e.currentTarget.style.color = 'var(--text-3)'; e.currentTarget.style.borderColor = 'var(--border)' }}
                            >
                              ✕
                            </button>
                          </div>
                        </td>
                      </tr>

                      {/* RENDERING THE DRILL-DOWN IF EXPANDED */}
                      {isExpanded && isBatch && (
                        <tr>
                          <td colSpan="7" style={{ padding: 0 }}>
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