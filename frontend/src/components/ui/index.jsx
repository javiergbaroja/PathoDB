/**
 * PathoDB UI Component Library
 * ==============================
 * Single source for all shared UI.
 */

import React from 'react'

// ─── Inject global spinner animation once ────────────────────────────────────
if (typeof document !== 'undefined' && !document.getElementById('pd-ui-styles')) {
  const s = document.createElement('style')
  s.id = 'pd-ui-styles'
  s.textContent = `
    @keyframes spin { to { transform: rotate(360deg); } }
    @keyframes pd-pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }
    @keyframes pd-fadein { from{opacity:0;transform:translateY(4px)} to{opacity:1;transform:none} }
  `
  document.head.appendChild(s)
}

// ============================================================
// BADGE
// ============================================================

const BADGE_VARIANTS = {
  red:     { background: 'var(--crimson-10)',  color: 'var(--crimson)' },
  green:   { background: 'var(--success-bg)',  color: 'var(--success)' },
  navy:    { background: 'var(--navy-10)',      color: 'var(--navy)' },
  muted:   { background: 'var(--navy-10)',      color: 'var(--text-2)' },
  warning: { background: 'var(--warning-bg)',   color: 'var(--warning)' },
  teal:    { background: 'var(--teal-10)',      color: 'var(--teal)' },
}

export function Badge({ variant = 'muted', children, style = {} }) {
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      padding: '2px 8px',
      borderRadius: 'var(--radius-full)',
      fontSize: 'var(--text-sm)',
      fontWeight: 600,
      whiteSpace: 'nowrap',
      ...BADGE_VARIANTS[variant],
      ...style,
    }}>
      {children}
    </span>
  )
}

// ============================================================
// BUTTON
// ============================================================

const BTN_VARIANTS = {
  primary: {
    background: 'var(--navy)',
    color: 'var(--white)',
    border: 'none',
  },
  teal: {
    background: 'var(--teal)',
    color: 'var(--white)',
    border: 'none',
  },
  ghost: {
    background: 'transparent',
    color: 'var(--text-2)',
    border: '1px solid var(--border)',
  },
  danger: {
    background: 'var(--crimson)',
    color: 'var(--white)',
    border: 'none',
  },
  link: {
    background: 'transparent',
    color: 'var(--navy)',
    border: 'none',
    padding: '4px 0',
  },
}

export function Btn({
  variant = 'ghost',
  onClick,
  children,
  disabled,
  style = {},
  type = 'button',
  small = false,
  icon = null,
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: small ? '5px 10px' : '7px 14px',
        borderRadius: 'var(--radius-md)',
        fontSize: small ? 'var(--text-sm)' : 'var(--text-base)',
        fontFamily: 'var(--font-sans)',
        fontWeight: 500,
        transition: 'var(--transition-base)',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        ...BTN_VARIANTS[variant],
        ...style,
      }}
    >
      {icon && <span style={{ display: 'flex', alignItems: 'center' }}>{icon}</span>}
      {children}
    </button>
  )
}

// ============================================================
// SPINNER  (replaces MiniSpinner in SummaryPanel, custom spinners)
// ============================================================

export function Spinner({ size = 20, color = 'var(--navy)', trackColor = 'var(--navy-20)' }) {
  return (
    <div style={{
      width: size,
      height: size,
      borderRadius: '50%',
      border: `2px solid ${trackColor}`,
      borderTopColor: color,
      animation: 'spin 0.7s linear infinite',
      flexShrink: 0,
    }} />
  )
}

export function SpinnerPage() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
      <Spinner size={32} />
    </div>
  )
}

// ============================================================
// ERROR MESSAGE
// ============================================================

export function ErrorMsg({ message, onDismiss }) {
  if (!message) return null
  return (
    <div style={{
      background: 'var(--crimson-10)',
      border: '1px solid var(--crimson)',
      borderRadius: 'var(--radius-md)',
      padding: '10px 14px',
      fontSize: 'var(--text-base)',
      color: 'var(--crimson)',
      marginBottom: 'var(--space-3)',
      display: 'flex',
      alignItems: 'center',
      gap: 8,
    }}>
      <span style={{ flex: 1 }}>{message}</span>
      {onDismiss && (
        <button
          onClick={onDismiss}
          style={{ background: 'none', border: 'none', color: 'var(--crimson)', cursor: 'pointer', fontSize: 16, lineHeight: 1, padding: '0 2px' }}
        >×</button>
      )}
    </div>
  )
}

// ============================================================
// PANEL  (white card with optional title)
// ============================================================

export function Panel({ title, children, style = {}, actions = null }) {
  return (
    <div style={{
      background: 'var(--white)',
      border: '1px solid var(--border-l)',
      borderRadius: 'var(--radius-lg)',
      padding: 'var(--space-4)',
      boxShadow: 'var(--shadow-s)',
      ...style,
    }}>
      {(title || actions) && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 'var(--space-3)',
        }}>
          {title && (
            <div style={{
              fontSize: 'var(--text-sm)',
              fontWeight: 600,
              color: 'var(--text-3)',
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
            }}>{title}</div>
          )}
          {actions}
        </div>
      )}
      {children}
    </div>
  )
}

// ============================================================
// STAT CARD  (consolidates Patients.jsx StatCard + ui/index.jsx StatCard)
// ============================================================

export function StatCard({ label, value, sub, accent }) {
  return (
    <div style={{
      background: 'var(--white)',
      border: '1px solid var(--border-l)',
      borderLeft: accent ? `3px solid ${accent}` : undefined,
      borderRadius: 'var(--radius-lg)',
      padding: '12px 14px',
    }}>
      <div style={{
        fontSize: 'var(--text-sm)',
        color: 'var(--text-3)',
        textTransform: 'uppercase',
        letterSpacing: '0.06em',
        fontWeight: 600,
      }}>{label}</div>
      <div style={{
        fontSize: 22,
        fontFamily: 'var(--font-serif)',
        color: accent || 'var(--navy)',
        marginTop: 4,
      }}>{value}</div>
      {sub && <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-3)', marginTop: 2 }}>{sub}</div>}
    </div>
  )
}

// ============================================================
// FORM PRIMITIVES
// Replaces the `const lbl` / `const inp` pattern in 6+ files.
// Usage:
//   <FormLabel>Stain *</FormLabel>
//   <FormInput value={...} onChange={...} />
//   <FormSelect value={...} onChange={...}><option/></FormSelect>
// ============================================================

export function FormLabel({ children, style = {} }) {
  return (
    <label style={{
      display: 'block',
      fontSize: 'var(--text-sm)',
      fontWeight: 600,
      color: 'var(--text-3)',
      textTransform: 'uppercase',
      letterSpacing: '0.06em',
      marginBottom: 5,
      ...style,
    }}>
      {children}
    </label>
  )
}

export function FormInput({ style = {}, ...props }) {
  return (
    <input
      {...props}
      style={{
        width: '100%',
        padding: '8px 10px',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-md)',
        fontSize: 'var(--text-base)',
        fontFamily: 'var(--font-sans)',
        color: 'var(--text-1)',
        background: 'var(--white)',
        outline: 'none',
        transition: 'var(--transition-fast)',
        ...style,
      }}
    />
  )
}

export function FormSelect({ style = {}, children, ...props }) {
  return (
    <select
      {...props}
      style={{
        width: '100%',
        padding: '8px 10px',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-md)',
        fontSize: 'var(--text-base)',
        fontFamily: 'var(--font-sans)',
        color: 'var(--text-1)',
        background: 'var(--white)',
        outline: 'none',
        cursor: 'pointer',
        transition: 'var(--transition-fast)',
        ...style,
      }}
    >
      {children}
    </select>
  )
}

export function FormTextarea({ style = {}, ...props }) {
  return (
    <textarea
      {...props}
      style={{
        width: '100%',
        padding: '8px 10px',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-md)',
        fontSize: 'var(--text-base)',
        fontFamily: 'var(--font-sans)',
        color: 'var(--text-1)',
        background: 'var(--white)',
        outline: 'none',
        resize: 'vertical',
        transition: 'var(--transition-fast)',
        ...style,
      }}
    />
  )
}

// ── FormField: label + input grouped ─────────────────────────
export function FormField({ label, style = {}, children }) {
  return (
    <div style={{ marginBottom: 14, ...style }}>
      {label && <FormLabel>{label}</FormLabel>}
      {children}
    </div>
  )
}

// ============================================================
// TABLE PRIMITIVES
// Replaces thStyle/tdStyle/th/td constants in 6+ files.
// Usage:
//   <Table>
//     <thead><tr><Th>Name</Th></tr></thead>
//     <tbody><tr><Td>Value</Td></tr></tbody>
//   </Table>
// ============================================================

export function Table({ children, style = {} }) {
  return (
    <div style={{
      background: 'var(--white)',
      border: '1px solid var(--border-l)',
      borderRadius: 'var(--radius-lg)',
      overflow: 'hidden',
      ...style,
    }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--text-base)' }}>
        {children}
      </table>
    </div>
  )
}

export function Th({ children, style = {} }) {
  return (
    <th style={{
      padding: '10px 14px',
      textAlign: 'left',
      fontSize: 'var(--text-xs)',
      fontWeight: 600,
      color: 'var(--text-3)',
      textTransform: 'uppercase',
      letterSpacing: '0.06em',
      borderBottom: '1px solid var(--border-l)',
      background: 'var(--navy-05)',
      whiteSpace: 'nowrap',
      ...style,
    }}>
      {children}
    </th>
  )
}

export function Td({ children, mono = false, style = {} }) {
  return (
    <td style={{
      padding: '11px 14px',
      borderBottom: '1px solid var(--border-l)',
      color: 'var(--text-2)',
      verticalAlign: 'middle',
      fontFamily: mono ? 'var(--font-mono)' : undefined,
      fontSize: mono ? 12 : undefined,
      ...style,
    }}>
      {children}
    </td>
  )
}

// Clickable table row
export function Tr({ children, onClick, selected = false, style = {} }) {
  return (
    <tr
      onClick={onClick}
      style={{
        cursor: onClick ? 'pointer' : 'default',
        background: selected ? 'var(--navy-05)' : 'var(--white)',
        transition: 'background var(--transition-fast)',
        ...style,
      }}
      onMouseEnter={onClick ? e => e.currentTarget.style.background = 'var(--navy-05)' : undefined}
      onMouseLeave={onClick ? e => e.currentTarget.style.background = selected ? 'var(--navy-05)' : 'var(--white)' : undefined}
    >
      {children}
    </tr>
  )
}

// ============================================================
// MODAL  (replaces 5+ separate overlay + card implementations)
// Usage:
//   <Modal isOpen={open} onClose={close} title="Edit stain" width={420}>
//     <p>content</p>
//     <Modal.Footer>
//       <Btn onClick={close}>Cancel</Btn>
//       <Btn variant="primary">Save</Btn>
//     </Modal.Footer>
//   </Modal>
// ============================================================

export function Modal({ isOpen, onClose, title, subtitle, children, width = 440 }) {
  if (!isOpen) return null
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,20,100,0.35)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 'var(--z-modal)',
        backdropFilter: 'blur(2px)',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: 'var(--white)',
          borderRadius: 'var(--radius-2xl)',
          width,
          maxHeight: '90vh',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: 'var(--shadow-xl)',
          animation: 'pd-fadein 0.15s ease',
        }}
      >
        {/* Header */}
        {(title || onClose) && (
          <div style={{
            padding: '18px 24px 14px',
            borderBottom: '1px solid var(--border-l)',
            flexShrink: 0,
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
          }}>
            <div>
              {title && (
                <div style={{ fontFamily: 'var(--font-serif)', fontSize: 'var(--text-xl)', color: 'var(--navy)' }}>
                  {title}
                </div>
              )}
              {subtitle && (
                <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-3)', marginTop: 3 }}>
                  {subtitle}
                </div>
              )}
            </div>
            {onClose && (
              <button
                onClick={onClose}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-3)', fontSize: 20, lineHeight: 1, padding: '0 4px', marginTop: 2 }}
              >
                ×
              </button>
            )}
          </div>
        )}

        {/* Scrollable body */}
        <div style={{ overflowY: 'auto', flex: 1 }}>
          {children}
        </div>
      </div>
    </div>
  )
}

Modal.Body = function ModalBody({ children, style = {} }) {
  return (
    <div style={{ padding: '18px 24px', ...style }}>
      {children}
    </div>
  )
}

Modal.Footer = function ModalFooter({ children }) {
  return (
    <div style={{
      padding: '12px 24px',
      borderTop: '1px solid var(--border-l)',
      display: 'flex',
      justifyContent: 'flex-end',
      gap: 8,
      background: 'rgba(0,0,0,0.02)',
      flexShrink: 0,
    }}>
      {children}
    </div>
  )
}

// ============================================================
// ID CELL  (monospace identifier display)
// ============================================================

export function IdCell({ children }) {
  return (
    <span style={{
      fontFamily: 'var(--font-mono)',
      fontSize: 12,
      color: 'var(--navy)',
      fontWeight: 500,
    }}>
      {children}
    </span>
  )
}

// ============================================================
// EMPTY STATE
// ============================================================

export function EmptyState({ icon, title, description, action }) {
  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 'var(--space-8)',
      gap: 'var(--space-4)',
      color: 'var(--text-3)',
    }}>
      {icon && (
        <div style={{
          width: 56,
          height: 56,
          borderRadius: 'var(--radius-xl)',
          background: 'var(--navy-10)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--navy-40)',
        }}>
          {icon}
        </div>
      )}
      {title && (
        <div style={{ fontFamily: 'var(--font-serif)', fontSize: 'var(--text-2xl)', color: 'var(--navy)', textAlign: 'center' }}>
          {title}
        </div>
      )}
      {description && (
        <div style={{ fontSize: 'var(--text-base)', color: 'var(--text-3)', textAlign: 'center', maxWidth: 340, lineHeight: 1.6 }}>
          {description}
        </div>
      )}
      {action}
    </div>
  )
}

// ============================================================
// SECTION HEADER  (consistent uppercase label pattern)
// ============================================================

export function SectionLabel({ children, style = {} }) {
  return (
    <div style={{
      fontSize: 'var(--text-xs)',
      fontWeight: 600,
      color: 'var(--text-3)',
      textTransform: 'uppercase',
      letterSpacing: '0.1em',
      ...style,
    }}>
      {children}
    </div>
  )
}

// ============================================================
// DIVIDER
// ============================================================

export function Divider({ vertical = false, style = {} }) {
  return (
    <div style={
      vertical
        ? { width: 1, alignSelf: 'stretch', background: 'var(--border-l)', ...style }
        : { height: 1, background: 'var(--border-l)', ...style }
    } />
  )
}

// ============================================================
// PROGRESS BAR
// ============================================================

export function ProgressBar({ value = 0, max = 100, color = 'var(--teal)', height = 4, style = {} }) {
  const pct = Math.min(100, Math.max(0, (value / max) * 100))
  return (
    <div style={{
      height,
      background: 'var(--navy-10)',
      borderRadius: 'var(--radius-full)',
      overflow: 'hidden',
      ...style,
    }}>
      <div style={{
        height: '100%',
        width: `${pct}%`,
        background: color,
        borderRadius: 'var(--radius-full)',
        transition: 'width 0.3s ease',
      }} />
    </div>
  )
}

// ============================================================
// STATUS DOT  (annotation status, scan availability etc.)
// ============================================================

export function StatusDot({ status = 'neutral', size = 8 }) {
  const colors = {
    success:  'var(--teal)',
    warning:  'var(--warning-dot)',
    danger:   'var(--crimson)',
    neutral:  'rgba(255,255,255,0.2)',
    pending:  'var(--navy-20)',
  }
  return (
    <div style={{
      width: size,
      height: size,
      borderRadius: '50%',
      background: colors[status] || colors.neutral,
      flexShrink: 0,
    }} />
  )
}

// ============================================================
// SLIDER ROW  (Brightness/Contrast/Gamma — used in 2 places)
// ============================================================

export function SliderRow({ label, value, min, max, step = 1, onChange, unit = '', format }) {
  const display = format ? format(value) : value
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
        <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-3)' }}>{label}</span>
        <span style={{ fontSize: 'var(--text-sm)', fontFamily: 'var(--font-mono)', color: 'var(--text-2)' }}>
          {display}{unit}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={e => onChange(parseFloat(e.target.value))}
        style={{ width: '100%', accentColor: 'var(--teal)', cursor: 'pointer' }}
      />
    </div>
  )
}

// ============================================================
// ELAPSED TIMER  (used in ModelsPanel + JobTracker)
// ============================================================

import { useState, useEffect } from 'react'

export function ElapsedTimer({ since, status }) {
  const [elapsed, setElapsed] = useState(0)

  useEffect(() => {
    const isTerminal = ['done', 'failed', 'cancelled'].includes(status)
    if (isTerminal) return
    const start = new Date(since).getTime()
    const tick  = () => setElapsed(Math.floor((Date.now() - start) / 1000))
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [since, status])

  const isTerminal = ['done', 'failed', 'cancelled'].includes(status)
  if (isTerminal) return <span>—</span>

  const m = Math.floor(elapsed / 60)
  const s = String(elapsed % 60).padStart(2, '0')
  return <span>{m}m {s}s</span>
}

// ============================================================
// STATUS BADGE  (analysis job status — used in ModelsPanel + JobTracker)
// ============================================================

const JOB_STATUS_MAP = {
  queued:    { label: 'Queued',    variant: 'muted' },
  running:   { label: 'Running',   bg: 'rgba(251,191,36,0.15)', color: 'var(--warning-dot)' },
  done:      { label: 'Done',      bg: 'rgba(27,153,139,0.18)', color: 'var(--success)' },
  failed:    { label: 'Failed',    variant: 'red' },
  cancelled: { label: 'Cancelled', bg: 'rgba(148,163,184,0.12)', color: '#64748b' },
}

export function JobStatusBadge({ status }) {
  if (!status) return null
  const s = JOB_STATUS_MAP[status] || JOB_STATUS_MAP.queued

  if (s.variant) return <Badge variant={s.variant}>{s.label}</Badge>

  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      padding: '2px 8px',
      borderRadius: 'var(--radius-full)',
      fontSize: 'var(--text-xs)',
      fontWeight: 500,
      background: s.bg,
      color: s.color,
      whiteSpace: 'nowrap',
    }}>
      {s.label}
    </span>
  )
}

// ============================================================
// THUMBNAIL  (slide thumbnail with dark fallback)
// Used in Filmstrip, SlideTray, PatientDetail, ProjectCard
// ============================================================

export function SlideThumbnail({ scanId, token, width = 128, height = 70, alt = 'Slide', style = {} }) {
  const [errored, setErrored] = React.useState(false)
  return (
    <div style={{
      height,
      background: '#0d1623',
      position: 'relative',
      overflow: 'hidden',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      ...style,
    }}>
      {!errored ? (
        <img
          src={`/api/slides/${scanId}/thumbnail?width=${width}&token=${token}`}
          alt={alt}
          loading="lazy"
          style={{ width: '100%', height: '100%', objectFit: 'contain' }}
          onError={() => setErrored(true)}
        />
      ) : (
        <span style={{ color: 'rgba(255,255,255,0.25)', fontSize: 10, fontFamily: 'var(--font-mono)' }}>
          No preview
        </span>
      )}
    </div>
  )
}

// ============================================================
// CONFIRM DIALOG  (consolidates delete confirm patterns)
// ============================================================

export function ConfirmDialog({ isOpen, onClose, onConfirm, title, message, confirmLabel = 'Delete', loading = false }) {
  return (
    <Modal isOpen={isOpen} onClose={onClose} title={title} width={380}>
      <Modal.Body>
        <p style={{ fontSize: 'var(--text-base)', color: 'var(--text-2)', lineHeight: 1.6 }}>
          {message}
        </p>
      </Modal.Body>
      <Modal.Footer>
        <Btn variant="ghost" onClick={onClose} disabled={loading}>Cancel</Btn>
        <Btn variant="danger" onClick={onConfirm} disabled={loading}>
          {loading ? 'Deleting…' : confirmLabel}
        </Btn>
      </Modal.Footer>
    </Modal>
  )
}