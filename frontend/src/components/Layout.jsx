import { useState, useEffect, useRef } from 'react'
import { NavLink, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { api } from '../api'
import { TYPE_COLORS, TYPE_LABELS } from '../constants/stains'
import logoHorizontalNeg from '../assets/logos/logo_horizontal_neg.svg'
import s from './Layout.module.css'

const cx = (...names) => names.filter(Boolean).join(' ')
function AdminImportIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor">
      <path d="M8.5 6.5a.5.5 0 00-1 0v3.793L6.354 9.146a.5.5 0 10-.708.708l2 2a.5.5 0 00.708 0l2-2a.5.5 0 00-.708-.708L8.5 10.293V6.5z"/>
      <path d="M14 14V4.5L9.5 0H4a2 2 0 00-2 2v12a2 2 0 002 2h8a2 2 0 002-2zM9.5 3A1.5 1.5 0 0011 4.5h2V14a1 1 0 01-1 1H4a1 1 0 01-1-1V2a1 1 0 011-1h5.5v2z"/>
    </svg>
  )
}

const NAV = [
  {
    section: 'Overview',
    items: [
      { to: '/dashboard', label: 'Dashboard', icon: <DashboardIcon /> },
    ],
  },
  {
    section: 'Research',
    items: [
      { to: '/patients',  label: 'Patients',       icon: <PatientIcon /> },
      { to: '/cohorts',   label: 'Cohorts',         icon: <CohortIcon /> },
      { to: '/tmas',      label: 'TMAs',            icon: <TmaIcon /> },
      { to: '/stains',    label: 'Stains',          icon: <StainIcon /> },
    ],
  },
  {
    section: 'Annotation',
    items: [
      { to: '/projects',  label: 'Projects',        icon: <ProjectIcon /> },
    ],
  },
  {
    section: 'AI Analysis',
    items: [
      { to: '/batch-analysis', label: 'Batch Analysis', icon: <BatchIcon /> },
      { to: '/job-tracker',    label: 'Job Tracker',    icon: <TrackerIcon /> },
    ],
  },
  {
    section: 'AI',
    items: [
      { to: '/assistant', label: 'Query Assistant', icon: <AIIcon />, badge: 'Beta' },
    ],
  },
]

const ADMIN_NAV = {
  section: 'Admin',
  items: [
    { to: '/admin/data-import', label: 'Data Import', icon: <AdminImportIcon /> },
  ],
}

export default function Layout({ children, title, actions }) {
  const { user, logout, isAdmin } = useAuth()
  const navigate          = useNavigate()

  const [query,     setQuery]     = useState('')
  const [results,   setResults]   = useState([])
  const [activeIdx, setActiveIdx] = useState(-1)
  const [open,      setOpen]      = useState(false)
  const [notFound,  setNotFound]  = useState(false)
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
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  const initials = (user?.username || 'U').slice(0, 2).toUpperCase()
  const dropOpen = open && (results.length > 0 || notFound)

  return (
    <div className={s.root}>
      {/* ── Sidebar ── */}
      <aside className={s.sidebar}>
        <div className={s.sidebarHead}>
          <img src={logoHorizontalNeg} alt="PathoDB" className={s.logo} />
        </div>

        <nav className={s.nav}>
          {NAV.map(({ section, items }) => (
            <div key={section}>
              <div className={s.navSection}>{section}</div>
              {items.map(({ to, label, icon, badge }) => (
                <NavLink
                  key={to}
                  to={to}
                  className={({ isActive }) => cx(s.navLink, isActive && s.navLinkActive)}
                >
                  <span className={s.navIcon}>{icon}</span>
                  {label}
                  {badge && <span className={s.navBadge}>{badge}</span>}
                </NavLink>
              ))}
            </div>
          ))}
          {isAdmin && (
            <div>
              <div className={s.navSection}>{ADMIN_NAV.section}</div>
              {ADMIN_NAV.items.map(({ to, label, icon, badge }) => (
                <NavLink
                  key={to}
                  to={to}
                  className={({ isActive }) => cx(s.navLink, isActive && s.navLinkActive)}
                >
                  <span className={s.navIcon}>{icon}</span>
                  {label}
                  {badge && <span className={s.navBadge}>{badge}</span>}
                </NavLink>
              ))}
            </div>
          )}
        </nav>


        <div className={s.sidebarFoot}>
          <div className={s.userRow}>
            <div className={s.avatar}>{initials}</div>
            <div className={s.username}>{user?.username || '—'}</div>
            <button
              onClick={() => { logout(); navigate('/login') }}
              title="Log out"
              className={s.logoutBtn}
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                <path d="M7.5 1v7h1V1h-1zM3 8.812a4.999 4.999 0 002.578 4.375l-.485.874A6 6 0 113 8.812zm7 4.375a4.998 4.998 0 002.578-4.375H14a6 6 0 01-3.063 5.249l-.485-.874z" />
              </svg>
            </button>
          </div>
        </div>
      </aside>

      {/* ── Main ── */}
      <div className={s.main}>
        <div className={s.topbar}>
          <h1 className={s.pageTitle}>{title}</h1>

          <div ref={dropdownRef} className={s.searchWrap}>
            <div className={cx(s.searchBox, notFound && s.searchBoxError, dropOpen && !notFound && s.searchBoxOpen)}>
              <svg
                width="14" height="14" viewBox="0 0 16 16"
                fill={notFound ? 'var(--crimson)' : 'var(--text-3)'}
                style={{ flexShrink: 0 }}
              >
                <path d="M11.742 10.344a6.5 6.5 0 10-1.397 1.398h-.001c.03.04.062.078.098.115l3.85 3.85a1 1 0 001.415-1.414l-3.85-3.85a1.007 1.007 0 00-.115-.099zM12 6.5a5.5 5.5 0 11-11 0 5.5 5.5 0 0111 0z" />
              </svg>
              <input
                ref={inputRef}
                type="text"
                placeholder="Patient code, submission or probe ID  (/)"
                value={query}
                onChange={handleChange}
                onKeyDown={handleKey}
                className={cx(s.searchInput, notFound && s.searchInputError)}
              />
              {searching && <span style={{ fontSize: 11, color: 'var(--text-3)', flexShrink: 0 }}>…</span>}
              {query && !searching && (
                <button onClick={clearSearch} className={s.searchClear}>×</button>
              )}
              {!query && <kbd className={s.searchKbd}>/</kbd>}
            </div>

            {dropOpen && (
              <div className={cx(s.searchDrop, notFound && s.searchDropError)}>
                {notFound ? (
                  <div className={s.searchEmpty}>
                    No patient, submission or probe matches "{query}"
                  </div>
                ) : (
                  <>
                    {results.map((r, i) => {
                      const colours = TYPE_COLORS[r.type] || TYPE_COLORS.patient
                      const label   = TYPE_LABELS[r.type]  || r.type
                      return (
                        <div
                          key={i}
                          onClick={() => handleSelect(r)}
                          onMouseEnter={() => setActiveIdx(i)}
                          className={cx(s.searchResult, i === activeIdx && s.searchResultActive)}
                          style={{ borderBottom: i < results.length - 1 ? '1px solid var(--border-l)' : 'none' }}
                        >
                          <span
                            className={s.searchResultType}
                            style={{ background: colours.bg, color: colours.text }}
                          >
                            {label}
                          </span>
                          <div className={s.searchResultBody}>
                            <div className={s.searchResultLabel}>{r.label}</div>
                            {r.sub_label && <div className={s.searchResultSub}>{r.sub_label}</div>}
                          </div>
                          <svg width="12" height="12" viewBox="0 0 16 16" fill="var(--text-3)" style={{ flexShrink: 0 }}>
                            <path d="M4 8a.5.5 0 01.5-.5h5.793L8.146 5.354a.5.5 0 11.708-.708l3 3a.5.5 0 010 .708l-3 3a.5.5 0 01-.708-.708L10.293 8.5H4.5A.5.5 0 014 8z" />
                          </svg>
                        </div>
                      )
                    })}
                    <div className={s.searchHint}>
                      ↑↓ navigate &nbsp;·&nbsp; ↵ open &nbsp;·&nbsp; Esc clear
                    </div>
                  </>
                )}
              </div>
            )}
          </div>

          {actions && <div className={s.topbarActions}>{actions}</div>}
        </div>

        <div className={s.content}>{children}</div>
      </div>
    </div>
  )
}

function DashboardIcon() { return <svg viewBox="0 0 16 16" fill="currentColor" width="15" height="15"><path d="M0 1.5A1.5 1.5 0 011.5 0h5A1.5 1.5 0 018 1.5v5A1.5 1.5 0 016.5 8h-5A1.5 1.5 0 010 6.5v-5zm8 0A1.5 1.5 0 019.5 0h5A1.5 1.5 0 0116 1.5v5A1.5 1.5 0 0114.5 8h-5A1.5 1.5 0 018 6.5v-5zm-8 8A1.5 1.5 0 011.5 8h5A1.5 1.5 0 018 9.5v5A1.5 1.5 0 016.5 16h-5A1.5 1.5 0 010 14.5v-5zm8 0A1.5 1.5 0 019.5 8h5a1.5 1.5 0 011.5 1.5v5a1.5 1.5 0 01-1.5 1.5h-5A1.5 1.5 0 018 14.5v-5z"/></svg> }
function PatientIcon() { return <svg viewBox="0 0 16 16" fill="currentColor" width="15" height="15"><path d="M8 8a3 3 0 100-6 3 3 0 000 6zm5 5a5 5 0 00-10 0h10z" /></svg> }
function CohortIcon()  { return <svg viewBox="0 0 16 16" fill="currentColor" width="15" height="15"><path d="M1 2.5A1.5 1.5 0 012.5 1h3A1.5 1.5 0 017 2.5v3A1.5 1.5 0 015.5 7h-3A1.5 1.5 0 011 5.5v-3zm8 0A1.5 1.5 0 0110.5 1h3A1.5 1.5 0 0115 2.5v3A1.5 1.5 0 0113.5 7h-3A1.5 1.5 0 019 5.5v-3zm-8 8A1.5 1.5 0 012.5 9h3A1.5 1.5 0 017 10.5v3A1.5 1.5 0 015.5 15h-3A1.5 1.5 0 011 13.5v-3zm8 0A1.5 1.5 0 0110.5 9h3a1.5 1.5 0 011.5 1.5v3a1.5 1.5 0 01-1.5 1.5h-3A1.5 1.5 0 019 13.5v-3z" /></svg> }
function StainIcon()   { return <svg viewBox="0 0 16 16" fill="currentColor" width="15" height="15"><path d="M14.5 3a.5.5 0 01.5.5v9a.5.5 0 01-.5.5h-13a.5.5 0 01-.5-.5v-9a.5.5 0 01.5-.5h13zM2 4v8h12V4H2zm2 1h8v1H4V5zm0 2h8v1H4V7zm0 2h4v1H4V9z" /></svg> }
function AIIcon()      { return <svg viewBox="0 0 16 16" fill="currentColor" width="15" height="15"><path d="M2.678 11.894a1 1 0 01.287.801 10.97 10.97 0 01-.398 2c1.395-.323 2.247-.697 2.634-.893a1 1 0 01.71-.074A8.06 8.06 0 008 14c3.996 0 7-2.807 7-6 0-3.192-3.004-6-7-6S1 4.808 1 8c0 1.468.617 2.83 1.678 3.894z" /></svg> }
function ProjectIcon() { return <svg viewBox="0 0 16 16" fill="currentColor" width="15" height="15"><path d="M1.5 0A1.5 1.5 0 000 1.5v2A1.5 1.5 0 001.5 5h2A1.5 1.5 0 005 3.5v-2A1.5 1.5 0 003.5 0h-2zm0 1h2a.5.5 0 01.5.5v2a.5.5 0 01-.5.5h-2a.5.5 0 01-.5-.5v-2a.5.5 0 01.5-.5zm6.5 0A1.5 1.5 0 006.5 1.5v2A1.5 1.5 0 008 5h2A1.5 1.5 0 0011.5 3.5v-2A1.5 1.5 0 0010 0H8zm0 1h2a.5.5 0 01.5.5v2a.5.5 0 01-.5.5H8a.5.5 0 01-.5-.5v-2A.5.5 0 018 1zM1.5 7A1.5 1.5 0 000 8.5v2A1.5 1.5 0 001.5 12h2A1.5 1.5 0 005 10.5v-2A1.5 1.5 0 003.5 7h-2zm0 1h2a.5.5 0 01.5.5v2a.5.5 0 01-.5.5h-2a.5.5 0 01-.5-.5v-2a.5.5 0 01.5-.5zm6.5 0A1.5 1.5 0 006.5 8.5v2A1.5 1.5 0 008 12h2a1.5 1.5 0 001.5-1.5v-2A1.5 1.5 0 0010 7H8zm0 1h2a.5.5 0 01.5.5v2a.5.5 0 01-.5.5H8a.5.5 0 01-.5-.5v-2A.5.5 0 018 8z" /></svg> }
function BatchIcon()   { return <svg viewBox="0 0 16 16" fill="currentColor" width="15" height="15"><path d="M8 1.5c-3 0-5.5 1.3-5.5 3s2.5 3 5.5 3 5.5-1.3 5.5-3-2.5-3-5.5-3zm0 1.5c2.2 0 4 .8 4 1.5s-1.8 1.5-4 1.5-4-.8-4-1.5 1.8-1.5 4-1.5zm0 4.5c-3 0-5.5-1.3-5.5-3v2c0 1.7 2.5 3 5.5 3s5.5-1.3 5.5-3v-2c0 1.7-2.5 3-5.5 3zm0 4c-3 0-5.5-1.3-5.5-3v2c0 1.7 2.5 3 5.5 3s5.5-1.3 5.5-3v-2c0 1.7-2.5 3-5.5 3z" /></svg> }
function TrackerIcon() { return <svg viewBox="0 0 16 16" fill="currentColor" width="15" height="15"><path d="M14 3h-3.53a3.001 3.001 0 00-4.94 0H2a1 1 0 00-1 1v9a1 1 0 001 1h12a1 1 0 001-1V4a1 1 0 00-1-1zM8 2.5a1.5 1.5 0 110 3 1.5 1.5 0 010-3zM4 8h8v1H4V8zm0 3h5v1H4v-1z" /></svg> }
function TmaIcon()     { return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="15" height="15"><rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" /><rect x="14" y="14" width="7" height="7" /><rect x="3" y="14" width="7" height="7" /></svg> }
