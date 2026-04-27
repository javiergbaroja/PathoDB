import { useState, useEffect, useRef, useCallback } from 'react'
import { NavLink, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { api } from '../api'

const NAV = [
  {
    section: 'Research',
    items: [
      { to: '/patients',  label: 'Patients',        icon: <PatientIcon /> },
      { to: '/cohorts',   label: 'Cohorts',          icon: <CohortIcon /> },
      { to: '/stains',    label: 'Stains',           icon: <StainIcon /> },
    ]
  },
  {
    section: 'AI',
    items: [
      { to: '/assistant', label: 'Query Assistant',  icon: <AIIcon />, badge: 'Beta' },
    ]
  },
]

const TYPE_COLOURS = {
  patient:    { bg: 'var(--navy-10)',    text: 'var(--navy)' },
  submission: { bg: 'var(--crimson-10)', text: 'var(--crimson)' },
  probe:      { bg: '#e6f4ec',           text: '#0a6e3a' },
  block:      { bg: '#fef6e4',           text: '#7a4f00' },
}

const TYPE_LABELS = {
  patient: 'Patient', submission: 'Submission', probe: 'Probe', block: 'Block'
}

export default function Layout({ children, title, actions }) {
  const { user, logout } = useAuth()
  const navigate          = useNavigate()

  // Search state
  const [query, setQuery]       = useState('')
  const [results, setResults]   = useState([])
  const [activeIdx, setActiveIdx] = useState(-1)
  const [open, setOpen]         = useState(false)
  const [notFound, setNotFound] = useState(false)
  const [searching, setSearching] = useState(false)
  const inputRef    = useRef(null)
  const dropdownRef = useRef(null)
  const debounceRef = useRef(null)

  function clearSearch() {
    setQuery('')
    setResults([])
    setOpen(false)
    setActiveIdx(-1)
    setNotFound(false)
  }

  function handleSelect(result) {
    clearSearch()
    navigate(`${result.url}?q=${encodeURIComponent(result.label)}`)
  }

  async function runSearch(term) {
    if (!term.trim()) { clearSearch(); return }
    setSearching(true)
    try {
      const res = await api.search(term.trim())
      setResults(res)
      setOpen(true)
      setActiveIdx(-1)
      setNotFound(res.length === 0)
    } catch {
      setResults([])
      setNotFound(true)
      setOpen(true)
    } finally {
      setSearching(false)
    }
  }

  function handleChange(e) {
    const val = e.target.value
    setQuery(val)
    setNotFound(false)
    clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => runSearch(val), 250)
  }

  function handleKey(e) {
    if (!open) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIdx(i => Math.min(i + 1, results.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIdx(i => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const target = activeIdx >= 0 ? results[activeIdx] : results[0]
      if (target) handleSelect(target)
    } else if (e.key === 'Escape') {
      clearSearch()
      inputRef.current?.blur()
    }
  }

  function handleLogout() {
    logout()
    navigate('/login')
  }

  // Global shortcut: "/" focuses search
  useEffect(() => {
    function handler(e) {
      if (e.key === '/' && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') {
        e.preventDefault()
        inputRef.current?.focus()
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [])

  useEffect(() => {
    function handler(e) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const initials = (user?.username || 'U').slice(0, 2).toUpperCase()

  return (
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>
      {/* ── Sidebar ── */}
      <aside style={{ width: 220, background: 'var(--navy)', flexShrink: 0, display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '20px 18px 16px', borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ width: 28, height: 28, background: 'var(--crimson)', borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="white">
                <path d="M8 1a2 2 0 012 2v1h1a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2V6a2 2 0 012-2h1V3a2 2 0 012-2zm0 1.5A.5.5 0 007.5 3v1h1V3A.5.5 0 008 2.5zM5.5 7a.5.5 0 000 1H6v1.5a.5.5 0 001 0V8h1v1.5a.5.5 0 001 0V8h.5a.5.5 0 000-1H5.5z"/>
              </svg>
            </div>
            <div>
              <div style={{ fontFamily: 'var(--font-serif)', fontSize: 17, color: 'white', letterSpacing: '0.02em' }}>PathoDB</div>
              <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.4)', letterSpacing: '0.08em', textTransform: 'uppercase', fontWeight: 300 }}>Computational Pathology</div>
            </div>
          </div>
        </div>

        <nav style={{ padding: '12px 0', flex: 1, overflowY: 'auto' }}>
          {NAV.map(({ section, items }) => (
            <div key={section}>
              <div style={{ padding: '8px 14px 4px', fontSize: 10, color: 'rgba(255,255,255,0.35)', textTransform: 'uppercase', letterSpacing: '0.1em', fontWeight: 600 }}>
                {section}
              </div>
              {items.map(({ to, label, icon, badge }) => (
                <NavLink key={to} to={to} style={({ isActive }) => ({
                  display: 'flex', alignItems: 'center', gap: 10, padding: '9px 16px',
                  color: isActive ? 'white' : 'rgba(255,255,255,0.6)',
                  fontSize: 13.5, fontWeight: isActive ? 500 : 400,
                  background: isActive ? 'rgba(255,255,255,0.1)' : 'transparent',
                  borderLeft: isActive ? '2px solid var(--crimson)' : '2px solid transparent',
                  textDecoration: 'none', transition: 'all 0.15s',
                })}>
                  <span style={{ width: 15, height: 15, flexShrink: 0, opacity: 0.8 }}>{icon}</span>
                  {label}
                  {badge && (
                    <span style={{ marginLeft: 'auto', fontSize: 10, background: 'rgba(230,0,46,0.2)', color: '#ff8099', padding: '2px 6px', borderRadius: 10, fontWeight: 600 }}>
                      {badge}
                    </span>
                  )}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>

        <div style={{ padding: '12px 16px', borderTop: '1px solid rgba(255,255,255,0.1)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ width: 28, height: 28, borderRadius: '50%', background: 'var(--crimson)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 600, color: 'white', flexShrink: 0 }}>{initials}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12.5, color: 'rgba(255,255,255,0.8)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{user?.username || '—'}</div>
            </div>
            <button onClick={handleLogout} title="Log out" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'rgba(255,255,255,0.35)', padding: 4 }}>
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                <path d="M7.5 1v7h1V1h-1zM3 8.812a4.999 4.999 0 002.578 4.375l-.485.874A6 6 0 113 8.812zm7 4.375a4.998 4.998 0 002.578-4.375H14a6 6 0 01-3.063 5.249l-.485-.874z"/>
              </svg>
            </button>
          </div>
        </div>
      </aside>

      {/* ── Main ── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {/* Topbar with universal search */}
        <div style={{ height: 52, padding: '0 24px', borderBottom: '1px solid var(--border-l)', display: 'flex', alignItems: 'center', gap: 16, background: 'white', flexShrink: 0 }}>
          <h1 style={{ fontFamily: 'var(--font-serif)', fontSize: 18, color: 'var(--navy)', fontWeight: 400, flexShrink: 0 }}>{title}</h1>

          {/* Search bar */}
          <div ref={dropdownRef} style={{ flex: 1, maxWidth: 480, position: 'relative' }}>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8,
              background: notFound ? 'var(--crimson-10)' : 'var(--navy-05)',
              border: `1px solid ${notFound ? 'var(--crimson)' : open && results.length > 0 ? 'var(--navy-20)' : 'var(--border)'}`,
              borderRadius: open && (results.length > 0 || notFound) ? '8px 8px 0 0' : 8,
              padding: '0 10px', transition: 'all 0.15s',
            }}>
              <svg width="14" height="14" viewBox="0 0 16 16"
                fill={notFound ? 'var(--crimson)' : 'var(--text-3)'}
                style={{ flexShrink: 0 }}>
                <path d="M11.742 10.344a6.5 6.5 0 10-1.397 1.398h-.001c.03.04.062.078.098.115l3.85 3.85a1 1 0 001.415-1.414l-3.85-3.85a1.007 1.007 0 00-.115-.099zM12 6.5a5.5 5.5 0 11-11 0 5.5 5.5 0 0111 0z"/>
              </svg>
              <input
                ref={inputRef}
                type="text"
                placeholder="Patient code, B-number, submission or probe ID  (/)"
                value={query}
                onChange={handleChange}
                onKeyDown={handleKey}
                style={{
                  flex: 1, border: 'none', background: 'transparent',
                  padding: '8px 0', fontSize: 13, outline: 'none',
                  fontFamily: 'var(--font-sans)',
                  color: notFound ? 'var(--crimson)' : 'var(--text-1)',
                }}
              />
              {searching && (
                <span style={{ fontSize: 11, color: 'var(--text-3)', flexShrink: 0 }}>…</span>
              )}
              {query && !searching && (
                <button onClick={clearSearch}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-3)', fontSize: 16, lineHeight: 1, padding: 2, flexShrink: 0 }}>
                  ×
                </button>
              )}
              {!query && (
                <kbd style={{ fontSize: 10, color: 'var(--text-3)', background: 'var(--border-l)', border: '1px solid var(--border)', borderRadius: 4, padding: '1px 5px', fontFamily: 'var(--font-mono)', flexShrink: 0 }}>/</kbd>
              )}
            </div>

            {open && (results.length > 0 || notFound) && (
              <div style={{
                position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 200,
                background: 'white',
                border: `1px solid ${notFound ? 'var(--crimson)' : 'var(--navy-20)'}`,
                borderTop: 'none', borderRadius: '0 0 8px 8px',
                boxShadow: '0 4px 16px rgba(0,20,80,0.1)',
                overflow: 'hidden',
              }}>
                {notFound ? (
                  <div style={{ padding: '12px 14px', fontSize: 13, color: 'var(--text-3)' }}>
                    No patient, submission or probe matches "{query}"
                  </div>
                ) : (
                  <>
                    {results.map((r, i) => {
                      const colours = TYPE_COLOURS[r.type] || TYPE_COLOURS.patient
                      const label   = TYPE_LABELS[r.type]  || r.type
                      return (
                        <div
                          key={i}
                          onClick={() => handleSelect(r)}
                          onMouseEnter={() => setActiveIdx(i)}
                          style={{
                            display: 'flex', alignItems: 'center', gap: 10,
                            padding: '10px 14px', cursor: 'pointer',
                            background: i === activeIdx ? 'var(--navy-05)' : 'white',
                            borderBottom: i < results.length - 1 ? '1px solid var(--border-l)' : 'none',
                            transition: 'background 0.1s',
                          }}
                        >
                          <span style={{
                            fontSize: 10, fontWeight: 600, padding: '2px 7px', borderRadius: 4,
                            background: colours.bg, color: colours.text,
                            flexShrink: 0, textTransform: 'uppercase', letterSpacing: '0.05em',
                          }}>
                            {label}
                          </span>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--navy)', fontWeight: 500 }}>
                              {r.label}
                            </div>
                            {r.sub_label && (
                              <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 1 }}>
                                {r.sub_label}
                              </div>
                            )}
                          </div>
                          <svg width="12" height="12" viewBox="0 0 16 16" fill="var(--text-3)" style={{ flexShrink: 0 }}>
                            <path d="M4 8a.5.5 0 01.5-.5h5.793L8.146 5.354a.5.5 0 11.708-.708l3 3a.5.5 0 010 .708l-3 3a.5.5 0 01-.708-.708L10.293 8.5H4.5A.5.5 0 014 8z"/>
                          </svg>
                        </div>
                      )
                    })}
                    <div style={{
                      padding: '5px 14px', fontSize: 11, color: 'var(--text-3)',
                      background: 'var(--navy-05)', borderTop: '1px solid var(--border-l)',
                    }}>
                      ↑↓ navigate &nbsp;·&nbsp; ↵ open &nbsp;·&nbsp; Esc clear
                    </div>
                  </>
                )}
              </div>
            )}
          </div>

          {actions && <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>{actions}</div>}
        </div>

        <div style={{ flex: 1, overflow: 'hidden' }}>
          {children}
        </div>
      </div>
    </div>
  )
}

function PatientIcon() { return <svg viewBox="0 0 16 16" fill="currentColor" width="15" height="15"><path d="M8 8a3 3 0 100-6 3 3 0 000 6zm5 5a5 5 0 00-10 0h10z"/></svg> }
function CohortIcon()  { return <svg viewBox="0 0 16 16" fill="currentColor" width="15" height="15"><path d="M1 2.5A1.5 1.5 0 012.5 1h3A1.5 1.5 0 017 2.5v3A1.5 1.5 0 015.5 7h-3A1.5 1.5 0 011 5.5v-3zm8 0A1.5 1.5 0 0110.5 1h3A1.5 1.5 0 0115 2.5v3A1.5 1.5 0 0113.5 7h-3A1.5 1.5 0 019 5.5v-3zm-8 8A1.5 1.5 0 012.5 9h3A1.5 1.5 0 017 10.5v3A1.5 1.5 0 015.5 15h-3A1.5 1.5 0 011 13.5v-3zm8 0A1.5 1.5 0 0110.5 9h3a1.5 1.5 0 011.5 1.5v3a1.5 1.5 0 01-1.5 1.5h-3A1.5 1.5 0 019 13.5v-3z"/></svg> }
function StainIcon()   { return <svg viewBox="0 0 16 16" fill="currentColor" width="15" height="15"><path d="M14.5 3a.5.5 0 01.5.5v9a.5.5 0 01-.5.5h-13a.5.5 0 01-.5-.5v-9a.5.5 0 01.5-.5h13zM2 4v8h12V4H2zm2 1h8v1H4V5zm0 2h8v1H4V7zm0 2h4v1H4V9z"/></svg> }
function AIIcon()      { return <svg viewBox="0 0 16 16" fill="currentColor" width="15" height="15"><path d="M2.678 11.894a1 1 0 01.287.801 10.97 10.97 0 01-.398 2c1.395-.323 2.247-.697 2.634-.893a1 1 0 01.71-.074A8.06 8.06 0 008 14c3.996 0 7-2.807 7-6 0-3.192-3.004-6-7-6S1 4.808 1 8c0 1.468.617 2.83 1.678 3.894z"/></svg> }