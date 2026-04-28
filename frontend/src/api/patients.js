import { request } from './client'

export const getPatients = (params = {}) => {
  const q = new URLSearchParams(params).toString()
  return request('GET', `/patients${q ? '?' + q : ''}`)
}
export const getPatient   = (id) => request('GET', `/patients/${id}`)
export const getHierarchy = (id) => request('GET', `/patients/${id}/hierarchy`)