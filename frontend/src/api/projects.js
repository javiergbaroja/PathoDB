// frontend/src/api/projects.js
import { request, BASE, getToken } from './client'

// ─── Projects ─────────────────────────────────────────────────────────────────
export const getProjects    = ()           => request('GET', '/projects')
export const getProject     = (id)         => request('GET', `/projects/${id}`)
export const createProject  = (data)       => request('POST', '/projects', data)
export const updateProject  = (id, data)   => request('PATCH', `/projects/${id}`, data)
export const deleteProject  = (id)         => request('DELETE', `/projects/${id}`)
export const syncProject    = (id)         => request('POST', `/projects/${id}/sync`)
export const getProjectProgress = (id)     => request('GET', `/projects/${id}/progress`)

export async function createProjectFromFile(formData) {
  const token = getToken()
  const headers = {}
  if (token) headers['Authorization'] = `Bearer ${token}`

  const res = await fetch(`${BASE}/projects/from_file`, {
    method: 'POST',
    headers,
    body: formData,
  })

  if (res.status === 401) {
    localStorage.removeItem('pathodb_token')
    window.location.href = '/login'
    return
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }))
    throw new Error(err.detail || 'Request failed')
  }
  return res.json()
}

export async function exportProject(id) {
  const token = getToken()
  const headers = {}
  if (token) headers['Authorization'] = `Bearer ${token}`

  const res = await fetch(`${BASE}/projects/${id}/export`, { headers })

  if (res.status === 401) {
    localStorage.removeItem('pathodb_token')
    window.location.href = '/login'
    return
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }))
    throw new Error(err.detail || 'Export failed')
  }

  const disposition = res.headers.get('Content-Disposition') ?? ''
  const match = disposition.match(/filename="?([^"]+)"?/)
  const filename = match ? match[1] : `project_${id}_export`

  const blob = await res.blob()
  const url  = URL.createObjectURL(blob)
  Object.assign(document.createElement('a'), { href: url, download: filename }).click()
  URL.revokeObjectURL(url)
}

// ─── Project scans ────────────────────────────────────────────────────────────
export const getProjectScans = (id) => request('GET', `/projects/${id}/scans`)

// ─── Shares ───────────────────────────────────────────────────────────────────
export const shareProject   = (id, data)          => request('POST',   `/projects/${id}/shares`, data)
export const updateShare    = (id, userId, level)  => request('PATCH',  `/projects/${id}/shares/${userId}`, { access_level: level })
export const revokeShare    = (id, userId)         => request('DELETE', `/projects/${id}/shares/${userId}`)

// ─── Annotations ──────────────────────────────────────────────────────────────
export const getAnnotations    = (projectId, scanId)       => request('GET', `/projects/${projectId}/scans/${scanId}/annotations`)
export const createAnnotation  = (projectId, scanId, data) => request('POST', `/projects/${projectId}/scans/${scanId}/annotations`, data)
export const updateAnnotation  = (projectId, scanId, annId, data) => request('PATCH', `/projects/${projectId}/scans/${scanId}/annotations/${annId}`, data)
export const deleteAnnotation  = (projectId, scanId, annId) => request('DELETE', `/projects/${projectId}/scans/${scanId}/annotations/${annId}`)

export const bulkSaveAnnotations = (projectId, scanId, annotations) =>
  request('PUT', `/projects/${projectId}/scans/${scanId}/annotations`, { annotations })

export async function importAnnotations(projectId, scanId, formData) {
  const token = getToken()
  const headers = {}
  if (token) headers['Authorization'] = `Bearer ${token}`

  const res = await fetch(`${BASE}/projects/${projectId}/scans/${scanId}/annotations/import`, {
    method: 'POST',
    headers,
    body: formData,
  })

  if (res.status === 401) {
    localStorage.removeItem('pathodb_token')
    window.location.href = '/login'
    return
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }))
    throw new Error(err.detail || 'Import failed')
  }
  return res.json()
}