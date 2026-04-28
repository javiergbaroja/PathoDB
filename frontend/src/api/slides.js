import { request, BASE } from './client'

export const getSlideInfo    = (scanId, token) => request('GET', `/slides/${scanId}/info?token=${token}`)
export const getThumbnailUrl = (scanId, token) => `${BASE}/slides/${scanId}/thumbnail?token=${token}`
export const getRelatedScans = async (scanId, token) => {
  // Using standard fetch as per your original file
  const r = await fetch(`/api/slides/${scanId}/related?token=${token}`);
  if (!r.ok) throw new Error('Failed to fetch related scans');
  return r.json();
}