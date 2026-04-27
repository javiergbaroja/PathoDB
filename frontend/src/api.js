const BASE = '/api'

function getToken() {
  return localStorage.getItem('pathodb_token')
}

async function request(method, path, body = null) {
  const token = getToken()
  const headers = { 'Content-Type': 'application/json' }
  if (token) headers['Authorization'] = `Bearer ${token}`

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : null,
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

  if (res.status === 204) return null
  return res.json()
}



export const api = {
  login:    (username, password) => request('POST', '/auth/login', { username, password }),
  register: (data) => request('POST', '/auth/register', data),
  logout:   ()                   => request('POST', '/auth/logout'),
  getMe:    ()                   => request('GET', '/auth/me'),

  search:   (term) => request('GET', `/search?q=${encodeURIComponent(term)}`),
  lookup: (field, query) => request('GET', `/stats/lookup/${field}?q=${encodeURIComponent(query)}`),
  getPatients: (params = {}) => {
    const q = new URLSearchParams(params).toString()
    return request('GET', `/patients${q ? '?' + q : ''}`)
  },
  getPatient:   (id) => request('GET', `/patients/${id}`),
  getHierarchy: (id) => request('GET', `/patients/${id}/hierarchy`),

  getStats: (params = {}) => {
    const q = new URLSearchParams(params).toString()
    return request('GET', `/stats${q ? '?' + q : ''}`)
  },

  getScansForBlock: (blockId) => request('GET', `/blocks/${blockId}/scans`),
  registerScan:     (data)    => request('POST', '/scans', data),
  deleteScan:       (id)      => request('DELETE', `/scans/${id}`),
  deleteCohort:     (id)  => request('DELETE', `/cohorts/${id}`),
  getCohortResults: (id)  => request('GET', `/cohorts/${id}/results`),
  getStains:   (params = {}) => {
    const q = new URLSearchParams(params).toString()
    return request('GET', `/stains${q ? '?' + q : ''}`)
  },
  createStain: (data)        => request('POST', '/stains', data),
  updateStain: (id, data)    => request('PATCH', `/stains/${id}`, data),

  queryCohort:  (filters) => request('POST', '/cohorts/query', filters),
  queryList:    (req)     => request('POST', '/cohorts/query_list', req),
  getCohorts:   ()        => request('GET', '/cohorts'),
  saveCohort:   (data)    => request('POST', '/cohorts', data),
  exportCohort: (id, fmt) => `${BASE}/cohorts/${id}/export?fmt=${fmt}`,

  // Slide viewer — token passed as query param for OpenSeadragon tile URLs
  getSlideInfo:  (scanId, token) => request('GET', `/slides/${scanId}/info?token=${token}`),
  getThumbnailUrl: (scanId, token) => `${BASE}/slides/${scanId}/thumbnail?token=${token}`,
  getRelatedScans: async (scanId, token) => {
    const r = await fetch(`/api/slides/${scanId}/related?token=${token}`);
    if (!r.ok) throw new Error('Failed to fetch related scans');
    return r.json();
  },

  getUsers:       ()     => request('GET', '/auth/users'),
  createUser:     (data) => request('POST', '/auth/users', data),
  deactivateUser: (id)   => request('PATCH', `/auth/users/${id}/deactivate`),

  // ── Analysis — DL model inference ─────────────────────────────────────────
  getModels:       ()                    => request('GET',    '/analysis/models'),
  getAnalysisJobs: (scanId)             => request('GET',    `/analysis/jobs?scan_id=${scanId}`),
  getAnalysisJob:  (jobId)              => request('GET',    `/analysis/jobs/${jobId}`),
  submitAnalysis:  (scanId, body)       => request('POST',   `/analysis/jobs?scan_id=${scanId}`, body),
  cancelAnalysis:  (jobId)              => request('DELETE', `/analysis/jobs/${jobId}`),
  deleteAnalysis:  (jobId)               => request('DELETE', `/analysis/jobs/${jobId}?purge=true`),
  getAnalysisResult: (jobId)            => request('GET',    `/analysis/jobs/${jobId}/result`),
  getAnalysisOverlay: (jobId, file) => request('GET', `/analysis/jobs/${jobId}/overlay?file=${file}`),

  health: () => request('GET', '/health'),

  async askAssistant(query, token) {
    const res = await fetch('/api/assistant/query', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ query })
    });
    if (!res.ok) {
        const err = await res.json();
        throw new Error(err.detail || 'Assistant failed');
    }
    return res.json();
  }
}