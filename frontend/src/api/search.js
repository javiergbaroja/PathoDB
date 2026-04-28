// frontend/src/api/search.js
import { request } from './client'

export const search = (term) => request('GET', `/search?q=${encodeURIComponent(term)}`)
export const lookup = (field, query) => request('GET', `/stats/lookup/${field}?q=${encodeURIComponent(query)}`)
export const getStats = (params = {}) => {
  const q = new URLSearchParams(params).toString()
  return request('GET', `/stats${q ? '?' + q : ''}`)
}