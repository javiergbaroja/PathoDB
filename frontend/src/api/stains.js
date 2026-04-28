import { request } from './client'

export const getStains = (params = {}) => {
  const q = new URLSearchParams(params).toString()
  return request('GET', `/stains${q ? '?' + q : ''}`)
}
export const createStain = (data)     => request('POST', '/stains', data)
export const updateStain = (id, data) => request('PATCH', `/stains/${id}`, data)