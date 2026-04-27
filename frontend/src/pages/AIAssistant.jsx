import { useState } from 'react'
import Layout from '../components/Layout'
import { Btn } from '../components/ui'
import { useAuth } from '../context/AuthContext'

const EXAMPLE_QUERIES = [
  "Show me all colon sigmoid cases with malignancy from 2019 that have HE but no p53",
  "Which blocks have been scanned more than 3 times?",
  "Summarise the diagnostic history of patient P-2019-00841",
  "Find all unscanned blocks from IHC probes submitted after October 2019",
]

const INITIAL_MESSAGES = [
  {
    role: 'assistant',
    content: "Hello! I'm the PathoDB Query Assistant. I can help you find patients, build cohorts, and answer questions about diagnostic histories using natural language. I'll be powered by MedGemma in Phase 4.\n\nTry one of the example queries below, or type your own."
  }
]

export default function AIAssistant() {
  const [messages, setMessages] = useState(INITIAL_MESSAGES)
  const [input, setInput]       = useState('')
  const { user } = useAuth()
  const initials = (user?.username || 'U').slice(0, 2).toUpperCase()

  function sendMessage(text) {
    const userMsg = { role: 'user', content: text }
    const stubReply = {
      role: 'assistant',
      content: `This feature is coming in Phase 4 with MedGemma + LangChain integration. The query assistant will translate natural language into structured database queries and return results directly in this conversation.\n\nYour query has been noted: "${text}"`,
    }
    setMessages(m => [...m, userMsg, stubReply])
    setInput('')
  }

  function handleKey(e) {
    if (e.key === 'Enter' && !e.shiftKey && input.trim()) {
      e.preventDefault()
      sendMessage(input.trim())
    }
  }

  return (
    <Layout title="Query Assistant">
      <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

        {/* Phase banner */}
        <div style={{
          margin: '12px 24px 0', padding: '10px 14px',
          background: 'var(--warning-bg)', border: '1px solid #e8c84a',
          borderRadius: 8, fontSize: 12, color: 'var(--warning)',
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8.982 1.566a1.13 1.13 0 00-1.96 0L.165 13.233c-.457.778.091 1.767.98 1.767h13.713c.889 0 1.438-.99.98-1.767L8.982 1.566zM8 5c.535 0 .954.462.9.995l-.35 3.507a.552.552 0 01-1.1 0L7.1 5.995A.905.905 0 018 5zm.002 6a1 1 0 110 2 1 1 0 010-2z"/></svg>
          <strong>Phase 4 preview</strong> — MedGemma + LangChain integration coming. Responses below are stubs.
        </div>

        {/* Messages */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '16px 24px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          {messages.map((msg, i) => (
            <div key={i} style={{
              display: 'flex', gap: 10,
              flexDirection: msg.role === 'user' ? 'row-reverse' : 'row',
              alignItems: 'flex-start',
            }}>
              <div style={{
                width: 28, height: 28, borderRadius: '50%', flexShrink: 0,
                background: msg.role === 'user' ? 'var(--crimson)' : 'var(--navy-10)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 11, fontWeight: 700,
                color: msg.role === 'user' ? 'white' : 'var(--navy)',
                marginTop: 2,
              }}>
                {msg.role === 'user' ? initials : 'AI'}
              </div>
              <div style={{
                maxWidth: '75%', padding: '10px 14px', borderRadius: 10,
                fontSize: 13, lineHeight: 1.6,
                background: msg.role === 'user' ? 'var(--navy)' : 'white',
                color: msg.role === 'user' ? 'white' : 'var(--text-1)',
                border: msg.role === 'assistant' ? '1px solid var(--border-l)' : 'none',
                borderRadius: msg.role === 'user' ? '10px 4px 10px 10px' : '4px 10px 10px 10px',
                whiteSpace: 'pre-wrap',
              }}>
                {msg.content}
              </div>
            </div>
          ))}

          {/* Example queries */}
          {messages.length === 1 && (
            <div style={{ marginTop: 8 }}>
              <div style={{ fontSize: 11, color: 'var(--text-3)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>
                Example queries
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {EXAMPLE_QUERIES.map((q, i) => (
                  <button key={i} onClick={() => sendMessage(q)} style={{
                    textAlign: 'left', padding: '9px 12px',
                    border: '1px solid var(--border)', borderRadius: 8,
                    background: 'white', cursor: 'pointer', fontSize: 13,
                    color: 'var(--text-2)', transition: 'all 0.15s',
                    fontFamily: 'var(--font-sans)',
                  }}
                    onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--navy-20)'; e.currentTarget.style.background = 'var(--navy-05)' }}
                    onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.background = 'white' }}
                  >
                    "{q}"
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Input */}
        <div style={{
          padding: '12px 24px 20px', borderTop: '1px solid var(--border-l)',
          background: 'white', display: 'flex', gap: 10,
        }}>
          <textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKey}
            placeholder="Ask about patients, blocks, cohorts, or diagnostic history…"
            rows={2}
            style={{
              flex: 1, padding: '9px 12px',
              border: '1px solid var(--border)', borderRadius: 8,
              fontSize: 13, fontFamily: 'var(--font-sans)', resize: 'none', outline: 'none',
            }}
          />
          <Btn
            variant="primary"
            onClick={() => input.trim() && sendMessage(input.trim())}
            disabled={!input.trim()}
            style={{ alignSelf: 'flex-end', padding: '9px 16px' }}
          >
            Send
          </Btn>
        </div>
      </div>
    </Layout>
  )
}
