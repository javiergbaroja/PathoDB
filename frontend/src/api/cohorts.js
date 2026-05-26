import { request, BASE, getToken } from './client'

export const deleteCohort     = (id)        => request('DELETE', `/cohorts/${id}`)
export const getCohortResults = (id)        => request('GET', `/cohorts/${id}/results`)
export const queryCohort      = (filters)   => request('POST', '/cohorts/query', filters)
export const queryList        = (req)       => request('POST', '/cohorts/query_list', req)
export const getCohorts       = ()          => request('GET', '/cohorts')
export const saveCohort       = (data)      => request('POST', '/cohorts', data)

/**
 * Download a saved cohort as CSV or JSON.
 * Uses fetch + auth header so the protected endpoint receives the token,
 * then creates a transient <a> to trigger the browser save-file dialog.
 */
export async function exportCohort(id, fmt, name) {
  const token = getToken()
  const res = await fetch(`${BASE}/cohorts/${id}/export?fmt=${fmt}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })

  if (res.status === 401) {
    localStorage.removeItem('pathodb_token')
    window.location.href = '/login'
    return
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }))
    throw new Error(err.detail || 'Export failed')
  }

  const blob     = await res.blob()
  const url      = URL.createObjectURL(blob)
  const filename = ((name || `cohort_${id}`).replace(/\s+/g, '_')) + `.${fmt}`
  const a        = document.createElement('a')
  a.href         = url
  a.download     = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  // Small delay before revoking so the browser has time to queue the download
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}