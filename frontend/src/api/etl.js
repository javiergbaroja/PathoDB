// frontend/src/api/etl.js
import { request, BASE, getToken } from './client'

export const getEtlJobs = (jobType = null) => {
  const params = new URLSearchParams()
  if (jobType) params.set('job_type', jobType)
  params.set('limit', '200')   // backend max (api/routers/etl.py: le=200) — was defaulting to 50
  const qs = params.toString()
  return request('GET', `/etl/jobs?${qs}`)
}

export const getEtlJob = (id) => request('GET', `/etl/jobs/${id}`)

export const cancelEtlJob = (id) => request('DELETE', `/etl/jobs/${id}`)

export const purgeEtlJob = (id) => request('DELETE', `/etl/jobs/${id}?purge=true`)

/**
 * Submit a new ETL job.
 * For submissions/blocks: pass file (File object)
 * For scans: pass scanFolder (string path)
 */
export async function submitEtlJob({ jobType, mode, file, scanFolder, deleteScanIds, forceScanIds }) {
  const token = getToken()
  const formData = new FormData()
  formData.append('job_type', jobType)

  if (mode) {
    formData.append('mode', mode)
  }
  if (file) {
    formData.append('file', file)
  }
  if (scanFolder) {
    formData.append('scan_folder', scanFolder)
  }
  if (deleteScanIds) {
    formData.append('delete_scan_ids', JSON.stringify(deleteScanIds))
  }
  if (forceScanIds) {
    formData.append('force_scan_ids', JSON.stringify(forceScanIds))
  }

  const res = await fetch(`${BASE}/etl/jobs`, {
    method: 'POST',
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: formData,
  })

  if (res.status === 401) {
    localStorage.removeItem('pathodb_token')
    window.location.href = '/login'
    return
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }))
    throw new Error(err.detail || 'ETL job submission failed')
  }
  return res.json()
}

export async function downloadEtlReport(jobId) {
  const token = getToken()
  const res = await fetch(`${BASE}/etl/jobs/${jobId}/report`, {
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }))
    throw new Error(err.detail || 'Failed to download report')
  }
  const blob = await res.blob()
  const url = window.URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `etl_job_${jobId}_report.csv`
  document.body.appendChild(a)
  a.click()
  a.remove()
  window.URL.revokeObjectURL(url)
}