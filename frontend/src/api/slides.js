import { request, BASE } from './client'

export const getSlideInfo    = (scanId, token) => request('GET', `/slides/${scanId}/info?token=${token}`)
export const getThumbnailUrl = (scanId, token) => `${BASE}/slides/${scanId}/thumbnail?token=${token}`
export const getRelatedScans = async (scanId, token) => {
  // Using standard fetch as per your original file
  const r = await fetch(`/api/slides/${scanId}/related?token=${token}`);
  if (!r.ok) throw new Error('Failed to fetch related scans');
  return r.json();
}

export const matchSlides = async (queries) => {
  const token = localStorage.getItem('pathodb_token')
  const r = await fetch(`${BASE}/slides/match?token=${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ queries })
  });
  if (!r.ok) throw new Error('Failed to match slides');
  return r.json();
}