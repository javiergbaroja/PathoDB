// frontend/src/pages/PatientDetail/SummaryPanel.jsx

import { useState, useRef, useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../api'
import { getSummarizeHealth, streamPatientSummary } from '../../api/summarize'

// ── Visual constants ───────────────────────────────────────────────────────────
const PANEL_BG     = 'white'
const ACCENT       = 'var(--navy)'
const BORDER       = 'var(--border-l)'
const TEXT_BODY    = 'var(--text-1)'
const TEXT_MUTED   = 'var(--text-3)'

// ── Sub-components ─────────────────────────────────────────────────────────────

function SparkleIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
      <path d="M7.657 6.247c.11-.33.576-.33.686 0l.645 1.937a2.89 2.89 0 001.829 1.828l1.936.645c.33.11.33.576 0 .686l-1.937.645a2.89 2.89 0 00-1.828 1.829l-.645 1.936a.361.361 0 01-.686 0l-.645-1.937a2.89 2.89 0 00-1.828-1.828l-1.937-.645a.361.361 0 010-.686l1.937-.645a2.89 2.89 0 001.828-1.828l.645-1.937zM3.794 1.148a.217.217 0 01.412 0l.387 1.162c.173.518.579.924 1.097 1.097l1.162.387a.217.217 0 010 .412l-1.162.387A1.734 1.734 0 004.593 5.69l-.387 1.162a.217.217 0 01-.412 0L3.407 5.69A1.734 1.734 0 002.31 4.593l-1.162-.387a.217.217 0 010-.412l1.162-.387A1.734 1.734 0 003.407 2.31l.387-1.162zM10.863.099a.145.145 0 01.274 0l.258.774c.115.346.386.617.732.732l.774.258a.145.145 0 010 .274l-.774.258a1.156 1.156 0 00-.732.732l-.258.774a.145.145 0 01-.274 0l-.258-.774a1.156 1.156 0 00-.732-.732L9.1 2.137a.145.145 0 010-.274l.774-.258c.346-.115.617-.386.732-.732L10.863.1z"/>
    </svg>
  )
}

function Cursor() {
  // Blinking cursor shown while streaming
  return (
    <span style={{
      display: 'inline-block',
      width: 2,
      height: '1em',
      background: 'var(--navy)',
      marginLeft: 2,
      verticalAlign: 'text-bottom',
      animation: 'sp-blink 0.9s step-end infinite',
    }} />
  )
}

// Inject cursor blink animation once
if (typeof document !== 'undefined' && !document.getElementById('sp-styles')) {
  const s = document.createElement('style')
  s.id = 'sp-styles'
  s.textContent = `@keyframes sp-blink { 0%,100%{opacity:1} 50%{opacity:0} }`
  document.head.appendChild(s)
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function SummaryPanel({ patientId }) {
  const [status, setStatus]   = useState('idle')
  // idle | checking | streaming | done | error | offline
  const [text, setText]       = useState('')
  const [errorMsg, setErrorMsg] = useState('')
  const [open, setOpen]       = useState(true)

  // Keep a ref to the abort controller so we can cancel on unmount
  const abortRef = useRef(null)
  const queryClient = useQueryClient()

  const fetchSummary = async (patientId) => {
    const res = await api.get(`/summarize/patient/${patientId}/summary`)
    return res.data
  }

  // ─────────────────────────────────────────────────────────────
  // React Query: persisted DB summary
  // ─────────────────────────────────────────────────────────────
  const { data, isLoading } = useQuery({
    queryKey: ['patient-summary', patientId],
    queryFn: () => fetchSummary(patientId),
    enabled: !!patientId,
  })

  // ─────────────────────────────────────────────────────────────
  // Hydrate local state (keeps original streaming UX)
  // ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (data?.summary_text) {
      setText(data.summary_text)
      setStatus('done')
    }
    // IMPORTANT: do NOT reset to idle here
    // print data in the console for debugging, precede it by a clear message
    console.log('SummaryPanel: fetched summary from DB', data)
  }, [data])

  // ─────────────────────────────────────────────────────────────
  // Streaming generation
  // ─────────────────────────────────────────────────────────────
  async function handleGenerate() {
    setStatus('checking')
    setText('')
    setErrorMsg('')

    try {
      const health = await getSummarizeHealth()
      if (!health.model_available) {
        setStatus('offline')
        setErrorMsg(
          `Model "${health.model}" is not pulled on the Ollama host. ` +
          `Run: ollama pull ${health.model}`
        )
        return
      }
    } catch (err) {
      setStatus('offline')
      setErrorMsg(err.message)
      return
    }

    setStatus('streaming')

    abortRef.current = streamPatientSummary(
      patientId,
      // onToken
      (token) => setText(prev => prev + token),

      async () => {
        setStatus('done')
        await queryClient.invalidateQueries({
          queryKey: ['patient-summary', patientId]
        })
      },

      (msg) => {
        setStatus('error')
        setErrorMsg(msg)
      },
    )
  }

  function handleCancel() {
    abortRef.current?.abort()
    setStatus('done')
  }

  function handleReset() {
    abortRef.current?.abort()
    setStatus('idle')
    setText('')
    setErrorMsg('')
  }

  const isStreaming = status === 'streaming'
  const isDone      = status === 'done'
  const isError     = status === 'error' || status === 'offline'
  const hasText     = text.length > 0

  return (
    <div style={{
      border: `1px solid ${BORDER}`,
      borderRadius: 8,
      background: PANEL_BG,
      overflow: 'hidden',
      marginBottom: 16,
    }}>

      {/* ── Header row ── */}
      <div
        onClick={() => setOpen(o => !o)}
        style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '10px 14px', cursor: 'pointer',
          borderBottom: open ? `1px solid ${BORDER}` : 'none',
          background: 'var(--navy-05)',
          userSelect: 'none',
        }}
      >
        <span style={{ color: 'var(--navy)', display: 'flex' }}>
          <SparkleIcon />
        </span>
        <span style={{
          fontSize: 11, fontWeight: 600, color: TEXT_MUTED,
          textTransform: 'uppercase', letterSpacing: '0.07em', flex: 1,
        }}>
          AI History Summary
        </span>

        {/* Status badge */}
        {isStreaming && (
          <span style={{
            fontSize: 10, padding: '2px 8px', borderRadius: 20,
            background: 'var(--navy-10)', color: 'var(--navy)', fontWeight: 500,
          }}>
            Generating…
          </span>
        )}
        {isDone && hasText && (
          <span style={{
            fontSize: 10, padding: '2px 8px', borderRadius: 20,
            background: 'var(--success-bg)', color: 'var(--success)', fontWeight: 500,
          }}>
            Ready
          </span>
        )}
        {isError && (
          <span style={{
            fontSize: 10, padding: '2px 8px', borderRadius: 20,
            background: 'var(--crimson-10)', color: 'var(--crimson)', fontWeight: 500,
          }}>
            Offline
          </span>
        )}

        <span style={{ fontSize: 11, color: TEXT_MUTED }}>
          {open ? '▾' : '▸'}
        </span>
      </div>

      {/* ── Body ── */}
      {open && (
        <div style={{ padding: '14px 16px' }}>

          {/* Idle state — show generate button */}
          {status === 'idle' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <p style={{ flex: 1, fontSize: 12, color: TEXT_MUTED, lineHeight: 1.5, margin: 0 }}>
                Generate a concise narrative of this patient's pathology history
                using a locally-hosted language model. No data leaves the server.
              </p>
              <button onClick={handleGenerate} style={btnStyle('primary')}>
                <SparkleIcon /> Generate
              </button>
            </div>
          )}

          {/* Checking state */}
          {status === 'checking' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: TEXT_MUTED, fontSize: 13 }}>
              <MiniSpinner /> Checking LLM service…
            </div>
          )}


          {/* Loading DB */}
          {isLoading && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: TEXT_MUTED, fontSize: 13 }}>
              <MiniSpinner /> Loading saved summary…
            </div>
          )}

          {/* Streaming / done state — show accumulated text */}
          {(isStreaming || isDone) && hasText && (
            <div>
              <p style={{
                fontSize: 13, lineHeight: 1.75, color: TEXT_BODY,
                margin: '0 0 12px',
                whiteSpace: 'pre-wrap',
              }}>
                {text}
                {isStreaming && <Cursor />}
              </p>
              <div style={{ display: 'flex', gap: 8 }}>
                {isStreaming && (
                  <button onClick={handleCancel} style={btnStyle('ghost')}>
                    Stop
                  </button>
                )}
                {isDone && (
                  <button onClick={handleReset} style={btnStyle('ghost')}>
                    Regenerate
                  </button>
                )}
                <span style={{ fontSize: 11, color: TEXT_MUTED, alignSelf: 'center' }}>
                  Local model · data never leaves server
                </span>
              </div>
            </div>
          )}

          {/* Streaming started but no text yet */}
          {isStreaming && !hasText && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: TEXT_MUTED, fontSize: 13 }}>
              <MiniSpinner /> Loading model and generating…
            </div>
          )}

          {/* Error / offline state */}
          {isError && (
            <div>
              <div style={{
                background: 'var(--warning-bg)',
                border: '1px solid #e8c84a',
                borderRadius: 6, padding: '10px 12px',
                fontSize: 12, color: 'var(--warning)',
                marginBottom: 10, lineHeight: 1.5,
              }}>
                <strong>LLM service unavailable</strong>
                {errorMsg && <div style={{ marginTop: 4, opacity: 0.85 }}>{errorMsg}</div>}
              </div>
              <div style={{ fontSize: 11, color: TEXT_MUTED, marginBottom: 10, lineHeight: 1.5 }}>
                To enable this feature, start Ollama on the HPC node with sufficient CPU resources.
                See the deployment guide for SLURM setup instructions.
              </div>
              <button onClick={handleReset} style={btnStyle('ghost')}>
                Try again
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Helper components ──────────────────────────────────────────────────────────

function MiniSpinner() {
  return (
    <div style={{
      width: 14, height: 14, borderRadius: '50%',
      border: '2px solid var(--navy-20)',
      borderTopColor: 'var(--navy)',
      animation: 'spin 0.7s linear infinite',
      flexShrink: 0,
    }} />
  )
}

// ── Styles ─────────────────────────────────────────────────────────────────────

function btnStyle(variant) {
  const base = {
    display: 'inline-flex', alignItems: 'center', gap: 5,
    padding: '6px 12px', borderRadius: 6,
    fontSize: 12, fontFamily: 'var(--font-sans)',
    fontWeight: 500, cursor: 'pointer',
    border: 'none', transition: 'all 0.15s',
    whiteSpace: 'nowrap',
  }
  if (variant === 'primary') return {
    ...base,
    background: 'var(--navy)', color: 'white',
  }
  return {
    ...base,
    background: 'transparent', color: 'var(--text-2)',
    border: '1px solid var(--border)',
  }
}