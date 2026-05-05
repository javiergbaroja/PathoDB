import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import Layout from '../components/Layout'
import { SpinnerPage, ErrorMsg, Btn } from '../components/ui'
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

export default function JobTracker() {
  const queryClient = useQueryClient()
  const [errorMsg, setErrorMsg] = useState('')

  // Fetch all jobs, polling every 5 seconds
  const { data: jobs = [], isLoading } = useQuery({
    queryKey: ['all-jobs'],
    queryFn: () => api.getAnalysisJobs(),
    refetchInterval: 5000, 
  })

  // Mutations for canceling and deleting
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

  const handleCancel = (id) => {
    if (window.confirm('Cancel this running job?')) cancelMutation.mutate(id)
  }

  const handleDelete = (id) => {
    if (window.confirm('Permanently delete this job and its output files?')) deleteMutation.mutate(id)
  }

  const handleDownload = async (id) => {
    try {
      await api.downloadAnalysisFile(id, 'download_file')
    } catch (err) {
      alert(`Download failed: ${err.message}`)
    }
  }

  if (isLoading) return <SpinnerPage />

  return (
    <Layout title="Job Tracker">
      <div style={{ height: '100%', padding: '20px 24px', overflowY: 'auto' }}>
        <div style={{ maxWidth: 1000, margin: '0 auto' }}>
          
          <div style={{ marginBottom: 24 }}>
            <h2 style={{ fontFamily: 'var(--font-serif)', fontSize: 20, color: 'var(--navy)' }}>Mission Control</h2>
            <p style={{ fontSize: 13, color: 'var(--text-3)' }}>Monitor and manage your SLURM compute jobs. Auto-refreshes every 5 seconds.</p>
          </div>

          {errorMsg && <ErrorMsg message={errorMsg} />}

          <div style={{ background: 'white', borderRadius: 10, border: '1px solid var(--border-l)', boxShadow: 'var(--shadow-s)', overflow: 'hidden' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
              <thead>
                <tr style={{ background: 'var(--navy-05)', borderBottom: '1px solid var(--border-l)', fontSize: 11, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  <th style={{ padding: '12px 16px', fontWeight: 600 }}>Job ID</th>
                  <th style={{ padding: '12px 16px', fontWeight: 600 }}>Model</th>
                  <th style={{ padding: '12px 16px', fontWeight: 600 }}>Type</th>
                  <th style={{ padding: '12px 16px', fontWeight: 600 }}>Status / Progress</th>
                  <th style={{ padding: '12px 16px', fontWeight: 600 }}>Runtime</th>
                  <th style={{ padding: '12px 16px', fontWeight: 600, textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {jobs.length === 0 && (
                  <tr>
                    <td colSpan="6" style={{ padding: 30, textAlign: 'center', color: 'var(--text-3)', fontSize: 13 }}>No jobs found.</td>
                  </tr>
                )}
                {jobs.map(job => {
                  const isRunning = job.status === 'running' || job.status === 'queued'
                  
                  // Extract the parsed JSON object directly from the Pydantic schema
                  const params = job.params_json || {}
                  const isBatch = params.is_batch === true || params.output_directory !== undefined
                  
                  return (
                    <tr key={job.id} style={{ borderBottom: '1px solid var(--border-l)', fontSize: 13 }}>
                      {/* ... Job ID and Model columns stay exactly the same ... */}
                      
                      <td style={{ padding: '16px', color: 'var(--navy)', fontFamily: 'monospace', fontWeight: 500 }}>
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
                      
                      {/* ── UPDATE THIS TYPE COLUMN ── */}
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
                        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                          {/* NEW: View Button (Only for Single WSI) */}
                          {!isBatch && job.scan_id && (
                            <Btn 
                              variant="primary" 
                              small 
                              onClick={() => window.open(`/viewer/${job.scan_id}`, '_blank')}
                            >
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
                            style={{ background: 'transparent', border: '1px solid var(--border)', borderRadius: 4, width: 28, height: 28, color: 'var(--text-3)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                          >
                            ✕
                          </button>
                        </div>
                      </td>
                    </tr>
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