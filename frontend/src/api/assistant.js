// frontend/src/api/assistant.js
// Conversational agent client. Streams over SSE (same transport as summarize.js)
// and dispatches the agent event types to callbacks.

import { BASE, getToken, request } from './client'

export const createChatSession  = ()    => request('POST', '/assistant/sessions')
export const listChatSessions   = ()    => request('GET', '/assistant/sessions')
export const getChatSession     = (id)  => request('GET', `/assistant/sessions/${id}`)
export const getAssistantHealth = ()    => request('GET', '/assistant/health')

// Consume a POST SSE stream, routing events to handlers:
//   onToken, onToolCall, onToolResult, onCitations, onConfirmation, onDoneTurn,
//   onDone, onError. Returns an AbortController.
function consumeSSE(path, body, handlers = {}) {
  const controller = new AbortController()
  const token = getToken()

  ;(async () => {
    try {
      const res = await fetch(`${BASE}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          Accept: 'text/event-stream',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })

      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: res.statusText }))
        handlers.onError?.(err.detail || 'Assistant request failed')
        return
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const parts = buffer.split('\n\n')
        buffer = parts.pop() ?? ''

        for (const part of parts) {
          const line = part.trim()
          if (!line.startsWith('data:')) continue
          const raw = line.slice(5).trim()
          if (raw === '[DONE]') { handlers.onDone?.(); return }
          let p
          try { p = JSON.parse(raw) } catch { continue }
          if (p.error)                { handlers.onError?.(p.error); return }
          if (p.token)                handlers.onToken?.(p.token)
          if (p.stage)                handlers.onStage?.(p.stage)
          if (p.plan)                 handlers.onPlan?.(p.plan)
          if (p.thinking)             handlers.onThinking?.(p.thinking)
          if (p.reasoning)            handlers.onReasoning?.(p.reasoning)
          if (p.tool_call)            handlers.onToolCall?.(p.tool_call)
          if (p.tool_result)          handlers.onToolResult?.(p.tool_result)
          if (p.citations)            handlers.onCitations?.(p.citations)
          if (p.confirmation_request) handlers.onConfirmation?.(p.confirmation_request)
          if (p.done_turn)            handlers.onDoneTurn?.(p.done_turn)
        }
      }
      handlers.onDone?.()
    } catch (err) {
      if (err.name === 'AbortError') return
      handlers.onError?.(err.message || 'Streaming failed')
    }
  })()

  return controller
}

export function streamChat(sessionId, message, handlers) {
  return consumeSSE('/assistant/chat', { session_id: sessionId, message }, handlers)
}

export function confirmAction(sessionId, approved, editedArgs, handlers) {
  return consumeSSE('/assistant/confirm',
    { session_id: sessionId, approved, edited_args: editedArgs ?? null }, handlers)
}
