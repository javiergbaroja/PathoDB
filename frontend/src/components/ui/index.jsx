import React from 'react'

const s = {
  badge: {
    display: 'inline-flex', alignItems: 'center',
    padding: '2px 8px', borderRadius: 20,
    fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap',
  }
}

export function Badge({ variant = 'muted', children }) {
  const variants = {
    red:    { background: 'var(--crimson-10)', color: 'var(--crimson)' },
    green:  { background: 'var(--success-bg)', color: 'var(--success)' },
    navy:   { background: 'var(--navy-10)', color: 'var(--navy)' },
    muted:  { background: 'var(--navy-10)', color: 'var(--text-2)' },
    warning:{ background: 'var(--warning-bg)', color: 'var(--warning)' },
  }
  return <span style={{ ...s.badge, ...variants[variant] }}>{children}</span>
}

export function Btn({ variant = 'ghost', onClick, children, disabled, style = {}, type = 'button', small }) {
  const base = {
    display: 'inline-flex', alignItems: 'center', gap: 6,
    padding: small ? '5px 10px' : '7px 14px',
    borderRadius: 6, fontSize: small ? 12 : 13,
    fontFamily: 'var(--font-sans)', fontWeight: 500,
    border: 'none', transition: 'all 0.15s',
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.5 : 1,
  }
  const variants = {
    primary: { background: 'var(--navy)', color: 'white' },
    ghost:   { background: 'transparent', color: 'var(--text-2)', border: '1px solid var(--border)' },
    danger:  { background: 'var(--crimson)', color: 'white' },
    link:    { background: 'transparent', color: 'var(--navy)', border: 'none', padding: '4px 0' },
  }
  return (
    <button type={type} onClick={onClick} disabled={disabled}
      style={{ ...base, ...variants[variant], ...style }}>
      {children}
    </button>
  )
}

export function Spinner({ size = 20 }) {
  return (
    <div style={{
      width: size, height: size, borderRadius: '50%',
      border: `2px solid var(--navy-20)`,
      borderTopColor: 'var(--navy)',
      animation: 'spin 0.6s linear infinite',
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

export function ErrorMsg({ message }) {
  if (!message) return null
  return (
    <div style={{
      background: 'var(--crimson-10)', border: '1px solid var(--crimson)',
      borderRadius: 6, padding: '10px 14px', fontSize: 13,
      color: 'var(--crimson)', marginBottom: 12,
    }}>
      {message}
    </div>
  )
}

export function StatCard({ label, value, sub, accent }) {
  return (
    <div style={{
      background: 'white', border: `1px solid var(--border-l)`,
      borderLeft: accent ? `3px solid ${accent}` : undefined,
      borderRadius: 8, padding: '12px 14px',
    }}>
      <div style={{ fontSize: 11, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: 22, fontFamily: 'var(--font-serif)', color: accent || 'var(--navy)', marginTop: 4 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>{sub}</div>}
    </div>
  )
}

export function Panel({ title, children, style = {} }) {
  return (
    <div style={{
      background: 'white', border: '1px solid var(--border-l)',
      borderRadius: 8, padding: 16, ...style
    }}>
      {title && <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 12 }}>{title}</div>}
      {children}
    </div>
  )
}

export function IdCell({ children }) {
  return <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--navy)', fontWeight: 500 }}>{children}</span>
}

// Inject spinner animation
const styleEl = document.createElement('style')
styleEl.textContent = `@keyframes spin { to { transform: rotate(360deg); } }`
document.head.appendChild(styleEl)
