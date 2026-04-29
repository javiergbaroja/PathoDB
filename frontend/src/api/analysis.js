import { request, BASE, getToken } from './client'

export const getModels          = ()                    => request('GET', '/analysis/models')
export const getAnalysisJobs    = (scanId)              => request('GET', `/analysis/jobs?scan_id=${scanId}`)
export const getAnalysisJob     = (jobId)               => request('GET', `/analysis/jobs/${jobId}`)
export const submitAnalysis     = (scanId, body)        => request('POST', `/analysis/jobs?scan_id=${scanId}`, body)
export const cancelAnalysis     = (jobId)               => request('DELETE', `/analysis/jobs/${jobId}`)
export const deleteAnalysis     = (jobId)               => request('DELETE', `/analysis/jobs/${jobId}?purge=true`)
export const getAnalysisResult  = (jobId)               => request('GET', `/analysis/jobs/${jobId}/result`)
export const getAnalysisOverlay = (jobId, file)         => request('GET', `/analysis/jobs/${jobId}/overlay?file=${file}`)


export const downloadAnalysisFile = async (jobId, fileKey = 'download_file') => {
  const token = getToken()
  const headers = {}
  if (token) headers['Authorization'] = `Bearer ${token}`

  const res = await fetch(`${BASE}/analysis/jobs/${jobId}/download?file_key=${fileKey}`, {
    method: 'GET',
    headers,
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }))
    throw new Error(err.detail || 'Failed to download file')
  }

  const blob = await res.blob()
  
  // Extract filename from headers if possible
  const disposition = res.headers.get('Content-Disposition')
  let filename = `job_${jobId}_output`
  if (disposition && disposition.includes('filename=')) {
    const matches = /filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/.exec(disposition)
    if (matches != null && matches[1]) filename = matches[1].replace(/['"]/g, '')
  }

  // Trigger local browser download
  const url = window.URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  window.URL.revokeObjectURL(url)
}