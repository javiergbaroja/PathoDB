// frontend/src/pages/PatientDetail/SummaryPanel.jsx
import { useState, useRef, useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { request } from '../../api/client'
import { getSummarizeHealth, streamPatientSummary } from '../../api/summarize'
import { Spinner, Btn } from '../../components/ui'

async function fetchSummary(id) {
  const res = await request('GET', `/summarize/patient/${id}/summary?_t=${Date.now()}`)
  return res?.data !== undefined ? res.data : res
}

export function usePatientSummaryExists(patientId) {
  const { data } = useQuery({
    queryKey: ['patient-summary', String(patientId)],
    queryFn:  () => fetchSummary(patientId),
    enabled:  !!patientId,
  })
  return !!data?.summary_text
}

// ── Sparkle icon ──────────────────────────────────────────────────────────────

function SparkleIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
      <path d="M7.657 6.247c.11-.33.576-.33.686 0l.645 1.937a2.89 2.89 0 001.829 1.828l1.936.645c.33.11.33.576 0 .686l-1.937.645a2.89 2.89 0 00-1.828 1.829l-.645 1.936a.361.361 0 01-.686 0l-.645-1.937a2.89 2.89 0 00-1.828-1.828l-1.937-.645a.361.361 0 010-.686l1.937-.645a2.89 2.89 0 001.828-1.828l.645-1.937zM3.794 1.148a.217.217 0 01.412 0l.387 1.162c.173.518.579.924 1.097 1.097l1.162.387a.217.217 0 010 .412l-1.162.387A1.734 1.734 0 004.593 5.69l-.387 1.162a.217.217 0 01-.412 0L3.407 5.69A1.734 1.734 0 002.31 4.593l-1.162-.387a.217.217 0 010-.412l1.162-.387A1.734 1.734 0 003.407 2.31l.387-1.162zM10.863.099a.145.145 0 01.274 0l.258.774c.115.346.386.617.732.732l.774.258a.145.145 0 010 .274l-.774.258a1.156 1.156 0 00-.732.732l-.258.774a.145.145 0 01-.274 0l-.258-.774a1.156 1.156 0 00-.732-.732L9.1 2.137a.145.145 0 010-.274l.774-.258c.346-.115.617-.386.732-.732L10.863.1z"/>
    </svg>
  )
}

// Blinking cursor for streaming
function Cursor() {
  return (
    <span style={{
      display: 'inline-block',
      width: 2,
      height: '1em',
      background: 'var(--navy)',
      marginLeft: 2,
      verticalAlign: 'text-bottom',
      animation: 'blink 0.9s step-end infinite',
    }} />
  )
}

// Inject blink keyframe once
if (typeof document !== 'undefined' && !document.getElementById('sp-blink-style')) {
  const s = document.createElement('style')
  s.id = 'sp-blink-style'
  s.textContent = `@keyframes blink { 0%,100%{opacity:1} 50%{opacity:0} }`
  document.head.appendChild(s)
}

// ── Main component ────────────────────────────────────────────────────────────

export default function SummaryPanel({ patientId }) {
  const [status,   setStatus]   = useState('idle')
  // idle | checking | streaming | done | error | offline
  const [text,     setText]     = useState('')
  const [errorMsg, setErrorMsg] = useState('')
  const [open,     setOpen]     = useState(true)

  const abortRef    = useRef(null)
  const queryClient = useQueryClient()

  const { data, isLoading } = useQuery({
    queryKey: ['patient-summary', String(patientId)],
    queryFn:  () => fetchSummary(patientId),
    enabled:  !!patientId,
  })

  useEffect(() => {
    if (data?.summary_text) {
      setText(data.summary_text)
      setStatus('done')
    }
  }, [data])

  async function handleGenerate() {
    abortRef.current?.abort()
    setStatus('checking')
    setText('')
    setErrorMsg('')

    try {
      const health = await getSummarizeHealth()
      if (!health.model_available) {
        setStatus('offline')
        setErrorMsg(`Model "${health.model}" is not pulled on the Ollama host. Run: ollama pull ${health.model}`)
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
      token  => setText(prev => prev + token),
      async () => {
        setStatus('done')
        await queryClient.invalidateQueries({ queryKey: ['patient-summary', String(patientId)] })
      },
      msg => { setStatus('error'); setErrorMsg(msg) },
    )
  }

  function handleCancel() { abortRef.current?.abort(); setStatus('done') }
  function handleReset()  { abortRef.current?.abort(); setStatus('idle'); setText(''); setErrorMsg('') }

  const isStreaming = status === 'streaming'
  const isDone      = status === 'done'
  const isError     = status === 'error' || status === 'offline'
  const hasText     = text.length > 0

  // ── Status badge ────────────────────────────────────────────────────────
  function StatusChip() {
    if (isStreaming) return (
      <span style={{ fontSize: 10, padding: '2px 8px', borderRadius: 'var(--radius-full)', background: 'var(--navy-10)', color: 'var(--navy)', fontWeight: 500 }}>
        Generating…
      </span>
    )
    if (isDone && hasText) return (
      <span style={{ fontSize: 10, padding: '2px 8px', borderRadius: 'var(--radius-full)', background: 'var(--success-bg)', color: 'var(--success)', fontWeight: 500 }}>
        Ready
      </span>
    )
    if (isError) return (
      <span style={{ fontSize: 10, padding: '2px 8px', borderRadius: 'var(--radius-full)', background: 'var(--crimson-10)', color: 'var(--crimson)', fontWeight: 500 }}>
        Offline
      </span>
    )
    return null
  }

  return (
    <div style={{
      border: '1px solid var(--border-l)',
      borderRadius: 'var(--radius-lg)',
      background: 'var(--white)',
      overflow: 'hidden',
      marginBottom: 'var(--space-4)',
    }}>
      {/* Header */}
      <div
        onClick={() => setOpen(o => !o)}
        style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '10px 14px',
          cursor: 'pointer',
          borderBottom: open ? '1px solid var(--border-l)' : 'none',
          background: 'var(--navy-05)',
          userSelect: 'none',
        }}
      >
        <span style={{ color: 'var(--navy)', display: 'flex' }}>
          <SparkleIcon />
        </span>
        <span style={{
          fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--text-3)',
          textTransform: 'uppercase', letterSpacing: '0.07em', flex: 1,
        }}>
          AI History Summary
        </span>
        <StatusChip />
        <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-3)' }}>
          {open ? '▾' : '▸'}
        </span>
      </div>

      {/* Body */}
      {open && (
        <div style={{ padding: 'var(--space-3) 16px 14px' }}>

          {/* Idle */}
          {status === 'idle' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <p style={{ flex: 1, fontSize: 12, color: 'var(--text-3)', lineHeight: 1.5, margin: 0 }}>
                Generate a concise narrative of this patient's pathology history using a locally-hosted language model. No data leaves the server.
              </p>
              <Btn variant="ghost" small onClick={handleGenerate}>
                <SparkleIcon /> Generate
              </Btn>
            </div>
          )}

          {/* Checking */}
          {status === 'checking' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-3)', fontSize: 13 }}>
              <Spinner size={14} /> Checking LLM service…
            </div>
          )}

          {/* Loading DB summary */}
          {isLoading && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-3)', fontSize: 13 }}>
              <Spinner size={14} /> Loading saved summary…
            </div>
          )}

          {/* Streaming / done — show text */}
          {(isStreaming || isDone) && hasText && (
            <div>
              <p style={{ fontSize: 13, lineHeight: 1.75, color: 'var(--text-1)', margin: '0 0 12px', whiteSpace: 'pre-wrap' }}>
                {text}
                {isStreaming && <Cursor />}
              </p>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                {isStreaming && <Btn variant="ghost" small onClick={handleCancel}>Stop</Btn>}
                {isDone      && <Btn variant="ghost" small onClick={handleGenerate}>Regenerate</Btn>}
                <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-3)' }}>
                  Local model · data never leaves server
                </span>
              </div>
            </div>
          )}

          {/* Streaming started but no text yet */}
          {isStreaming && !hasText && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-3)', fontSize: 13 }}>
              <Spinner size={14} /> Loading model and generating…
            </div>
          )}

          {/* Error / offline */}
          {isError && (
            <div>
              <div style={{
                background: 'var(--warning-bg)',
                border: '1px solid #e8c84a',
                borderRadius: 'var(--radius-md)',
                padding: '10px 12px',
                fontSize: 12,
                color: 'var(--warning)',
                marginBottom: 10,
                lineHeight: 1.5,
              }}>
                <strong>LLM service unavailable</strong>
                {errorMsg && <div style={{ marginTop: 4, opacity: 0.85 }}>{errorMsg}</div>}
              </div>
              <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-3)', marginBottom: 10, lineHeight: 1.5 }}>
                To enable this feature, start Ollama on the HPC node with sufficient CPU resources.
              </div>
              <Btn variant="ghost" small onClick={handleReset}>Try again</Btn>
            </div>
          )}
        </div>
      )}
    </div>
  )
}