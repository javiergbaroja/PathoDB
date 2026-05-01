// frontend/src/api/summarize.js
// Streams patient summary tokens from the backend SSE endpoint.
// Uses the native fetch ReadableStream API — no EventSource needed because
// we need to send an Authorization header which EventSource cannot do.

import { BASE, getToken } from './client'

/**
 * Check whether the Ollama service is reachable.
 * Returns the JSON response or throws on network/HTTP error.
 */
export async function getSummarizeHealth() {
  const token = getToken()
  const res = await fetch(`${BASE}/summarize/health`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: 'Ollama offline' }))
    throw new Error(err.detail || 'Ollama offline')
  }
  return res.json()
}

/**
 * Stream a patient summary from the backend.
 *
 * @param {number} patientId
 * @param {function} onToken   - called with each string token as it arrives
 * @param {function} onDone    - called when streaming completes
 * @param {function} onError   - called with an error message string
 * @returns {AbortController}  - call .abort() to cancel mid-stream
 */
export function streamPatientSummary(patientId, onToken, onDone, onError) {
  const controller = new AbortController()
  const token = getToken()

  ;(async () => {
    try {
      const res = await fetch(`${BASE}/summarize/patient/${patientId}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'text/event-stream',
        },
        signal: controller.signal,
      })

      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: res.statusText }))
        onError(err.detail || 'Failed to start summary')
        return
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })

        // SSE lines are separated by \n\n
        const parts = buffer.split('\n\n')
        // The last part may be incomplete — keep it in the buffer
        buffer = parts.pop() ?? ''

        for (const part of parts) {
          const line = part.trim()
          if (!line.startsWith('data:')) continue

          const raw = line.slice(5).trim()

          if (raw === '[DONE]') {
            onDone()
            return
          }

          try {
            const payload = JSON.parse(raw)
            if (payload.error) {
              onError(
                payload.error === 'ollama_offline'
                  ? 'The LLM service is currently offline. Start Ollama on the HPC node to enable this feature.'
                  : payload.error
              )
              return
            }
            if (payload.token) {
              onToken(payload.token)
            }
          } catch {
            // malformed chunk — skip
          }
        }
      }

      // Stream ended without [DONE] sentinel
      onDone()
    } catch (err) {
      if (err.name === 'AbortError') return  // user cancelled — not an error
      onError(err.message || 'Streaming failed')
    }
  })()

  return controller
}