import { request } from './client'

export const askAssistant = async (query, token) => {
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