import { useState, useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'
import Layout from '../components/Layout'
import { Btn, FormTextarea } from '../components/ui'
import { useAuth } from '../context/AuthContext'
import { api } from '../api'

const EXAMPLE_QUERIES = [
  "Find all colon cases with malignancy from 2019 that have an H&E slide",
  "Which models can I run on a slide?",
  "Summarise the diagnostic history of patient P-2019-00841",
  "Find unscanned blocks from IHC probes submitted after October 2019",
  "Show cases whose report mentions perineural invasion",
]

const GREETING = {
  role: 'assistant',
  content: "Hi — I'm the PathoDB assistant. Ask me to find cases, search report text, look up a patient, or run an analysis. I cite the records behind every answer. Try an example below.",
  citations: [], tools: [], confirmation: null, streaming: false,
}

function dedupeCitations(list) {
  const seen = new Set()
  const out = []
  for (const c of list) {
    const key = `${c.type}:${c.id}`
    if (!seen.has(key)) { seen.add(key); out.push(c) }
  }
  return out
}

function CitationChip({ c }) {
  const label = c.label || String(c.id)
  const style = {
    display: 'inline-block', padding: '2px 8px', margin: '2px 4px 2px 0',
    fontSize: 11, borderRadius: 12, border: '1px solid var(--border)',
    background: 'var(--navy-05)', color: 'var(--navy)', textDecoration: 'none',
  }
  return c.url
    ? <Link to={c.url} style={style}>{label}</Link>
    : <span style={style}>{label}</span>
}

export default function AIAssistant() {
  const [messages, setMessages] = useState([GREETING])
  const [input, setInput]       = useState('')
  const [sessionId, setSessionId] = useState(null)
  const [streaming, setStreaming] = useState(false)
  const [offline, setOffline]   = useState('')
  const { user } = useAuth()
  const initials = (user?.username || 'U').slice(0, 2).toUpperCase()
  const scrollRef = useRef(null)

  useEffect(() => {
    let cancelled = false
    api.createChatSession()
      .then(s => { if (!cancelled && s) setSessionId(s.id) })
      .catch(() => {})
    api.getAssistantHealth()
      .then(h => { if (!cancelled && h?.vllm?.status !== 'ok') setOffline('The assistant LLM (vLLM) is offline. Start it on the GPU node to enable chat.') })
      .catch(() => { if (!cancelled) setOffline('Assistant service unavailable.') })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [messages])

  // Patch the trailing (assistant) message currently being streamed into.
  const patchLast = (fn) => setMessages(prev => {
    if (!prev.length) return prev
    const copy = prev.slice()
    copy[copy.length - 1] = fn({ ...copy[copy.length - 1] })
    return copy
  })

  const streamHandlers = {
    onToken:        (t) => patchLast(m => ({ ...m, content: (m.content || '') + t })),
    onToolCall:     (tc) => patchLast(m => ({ ...m, tools: [...m.tools, { kind: 'call', ...tc }] })),
    onToolResult:   (tr) => patchLast(m => ({ ...m, tools: [...m.tools, { kind: 'result', ...tr }] })),
    onCitations:    (cs) => patchLast(m => ({ ...m, citations: dedupeCitations([...m.citations, ...cs]) })),
    onConfirmation: (req) => patchLast(m => ({ ...m, confirmation: req, streaming: false })),
    onError:        (e) => { patchLast(m => ({ ...m, content: (m.content ? m.content + '\n\n' : '') + `⚠️ ${e}`, streaming: false })); setStreaming(false) },
    onDoneTurn:     () => {},
    onDone:         () => { patchLast(m => ({ ...m, streaming: false })); setStreaming(false) },
  }

  function startAssistantTurn() {
    setMessages(m => [...m, { role: 'assistant', content: '', citations: [], tools: [], confirmation: null, streaming: true }])
    setStreaming(true)
  }

  function sendMessage(text) {
    if (!text.trim() || streaming || !sessionId) return
    setMessages(m => [...m, { role: 'user', content: text, citations: [], tools: [], confirmation: null }])
    setInput('')
    startAssistantTurn()
    api.streamChat(sessionId, text, streamHandlers)
  }

  function handleConfirm(idx, approved) {
    // Clear the pending confirmation on that message, then stream the continuation.
    setMessages(prev => {
      const copy = prev.slice()
      if (copy[idx]) copy[idx] = { ...copy[idx], confirmation: null, confirmResolved: approved ? 'approved' : 'declined' }
      return copy
    })
    startAssistantTurn()
    api.confirmAction(sessionId, approved, null, streamHandlers)
  }

  function handleKey(e) {
    if (e.key === 'Enter' && !e.shiftKey && input.trim()) {
      e.preventDefault()
      sendMessage(input.trim())
    }
  }

  return (
    <Layout title="Assistant">
      <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

        {offline && (
          <div style={{ margin: '12px 24px 0', padding: '10px 14px', background: 'var(--warning-bg)', border: '1px solid #e8c84a', borderRadius: 8, fontSize: 12, color: 'var(--warning)', display: 'flex', alignItems: 'center', gap: 8 }}>
            <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8.982 1.566a1.13 1.13 0 00-1.96 0L.165 13.233c-.457.778.091 1.767.98 1.767h13.713c.889 0 1.438-.99.98-1.767L8.982 1.566zM8 5c.535 0 .954.462.9.995l-.35 3.507a.552.552 0 01-1.1 0L7.1 5.995A.905.905 0 018 5zm.002 6a1 1 0 110 2 1 1 0 010-2z"/></svg>
            {offline}
          </div>
        )}

        <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', padding: '16px 24px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          {messages.map((msg, i) => (
            <div key={i} style={{ display: 'flex', gap: 10, flexDirection: msg.role === 'user' ? 'row-reverse' : 'row', alignItems: 'flex-start' }}>
              <div style={{ width: 28, height: 28, borderRadius: '50%', flexShrink: 0, background: msg.role === 'user' ? 'var(--crimson)' : 'var(--navy-10)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, color: msg.role === 'user' ? 'white' : 'var(--navy)', marginTop: 2 }}>
                {msg.role === 'user' ? initials : 'AI'}
              </div>
              <div style={{ maxWidth: '78%', display: 'flex', flexDirection: 'column', gap: 6 }}>
                {/* Tool activity */}
                {msg.tools?.length > 0 && (
                  <div style={{ fontSize: 11, color: 'var(--text-3)', display: 'flex', flexDirection: 'column', gap: 2 }}>
                    {msg.tools.map((t, j) => (
                      <div key={j}>
                        {t.kind === 'call' ? `🔧 ${t.name}…` : `✓ ${t.name}: ${t.summary || 'done'}`}
                      </div>
                    ))}
                  </div>
                )}

                {/* Bubble */}
                {(msg.content || msg.streaming) && (
                  <div style={{ padding: '10px 14px', fontSize: 13, lineHeight: 1.6, background: msg.role === 'user' ? 'var(--navy)' : 'white', color: msg.role === 'user' ? 'white' : 'var(--text-1)', border: msg.role === 'assistant' ? '1px solid var(--border-l)' : 'none', borderRadius: msg.role === 'user' ? '10px 4px 10px 10px' : '4px 10px 10px 10px', whiteSpace: 'pre-wrap' }}>
                    {msg.content}{msg.streaming && <span style={{ opacity: 0.5 }}>▍</span>}
                  </div>
                )}

                {/* Citations */}
                {msg.citations?.length > 0 && (
                  <div style={{ marginTop: 2 }}>
                    <div style={{ fontSize: 10, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 2 }}>Sources</div>
                    {msg.citations.map((c, j) => <CitationChip key={j} c={c} />)}
                  </div>
                )}

                {/* Confirmation card */}
                {msg.confirmation && (
                  <div style={{ padding: '10px 14px', background: 'var(--warning-bg)', border: '1px solid #e8c84a', borderRadius: 8, fontSize: 12 }}>
                    <div style={{ fontWeight: 600, marginBottom: 4 }}>Confirm action: {msg.confirmation.action}</div>
                    <pre style={{ margin: '4px 0 8px', fontSize: 11, whiteSpace: 'pre-wrap', color: 'var(--text-2)' }}>{JSON.stringify(msg.confirmation.args, null, 2)}</pre>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <Btn variant="primary" onClick={() => handleConfirm(i, true)} style={{ padding: '4px 12px' }}>Approve</Btn>
                      <Btn onClick={() => handleConfirm(i, false)} style={{ padding: '4px 12px' }}>Decline</Btn>
                    </div>
                  </div>
                )}
                {msg.confirmResolved && (
                  <div style={{ fontSize: 11, color: 'var(--text-3)' }}>Action {msg.confirmResolved}.</div>
                )}
              </div>
            </div>
          ))}

          {messages.length === 1 && (
            <div style={{ marginTop: 8 }}>
              <div style={{ fontSize: 11, color: 'var(--text-3)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>Example queries</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {EXAMPLE_QUERIES.map((q, i) => (
                  <button key={i} onClick={() => sendMessage(q)} disabled={!sessionId || streaming} style={{ textAlign: 'left', padding: '9px 12px', border: '1px solid var(--border)', borderRadius: 8, background: 'white', cursor: (!sessionId || streaming) ? 'not-allowed' : 'pointer', fontSize: 13, color: 'var(--text-2)', fontFamily: 'var(--font-sans)' }}>
                    "{q}"
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        <div style={{ padding: '12px 24px 20px', borderTop: '1px solid var(--border-l)', background: 'white', display: 'flex', gap: 10 }}>
          <FormTextarea
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKey}
            placeholder={sessionId ? 'Ask about patients, cases, reports, cohorts, or analyses…' : 'Connecting…'}
            rows={2}
            disabled={!sessionId || streaming}
            style={{ flex: 1, resize: 'none' }}
          />
          <Btn variant="primary" onClick={() => sendMessage(input.trim())} disabled={!input.trim() || !sessionId || streaming} style={{ alignSelf: 'flex-end', padding: '9px 16px' }}>
            {streaming ? '…' : 'Send'}
          </Btn>
        </div>
      </div>
    </Layout>
  )
}
