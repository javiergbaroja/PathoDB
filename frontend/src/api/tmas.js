import { request, BASE, getToken } from './client'

export const getTMAs    = ()          => request('GET', '/tmas')
export const getTMA     = (id)        => request('GET', `/tmas/${id}`)
export const getTMACores = (id)       => request('GET', `/tmas/${id}/cores`)
export const updateTMA  = (id, data) => request('PATCH', `/tmas/${id}`, data)
export const deleteTMA  = (id)        => request('DELETE', `/tmas/${id}`)

export async function createTMA(formData) {
  const token = getToken()
  const res = await fetch(`${BASE}/tmas`, {
    method:  'POST',
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body:    formData,
  })
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export async function uploadTMACoresCSV(tmaId, file) {
  const token = getToken()
  const formData = new FormData()
  formData.append('file', file)
  const res = await fetch(`${BASE}/tmas/${tmaId}/batch-cores`, {
    method:  'POST',
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body:    formData,
  })
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

export async function uploadTMAScansCSV(tmaId, file) {
  const token = getToken()
  const formData = new FormData()
  formData.append('file', file)
  const res = await fetch(`${BASE}/tmas/${tmaId}/batch-scans`, {
    method:  'POST',
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body:    formData,
  })
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}