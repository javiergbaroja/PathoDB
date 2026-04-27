import { useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { Btn, ErrorMsg } from '../components/ui'
import { api } from '../api' 

export default function Login() {
  const { login } = useAuth()
  const navigate = useNavigate()
  const location = useLocation() 

  // CRITICAL LINE: This defines "from" so the submit handler can use it!
  const from = location.state?.from?.pathname || '/patients'

  const [form, setForm] = useState({ username: '', email: '', password: '' })
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [isRegistering, setIsRegistering] = useState(false) 

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    setLoading(true)
    try {
      if (isRegistering) {
        // 1. Create the account
        await api.register({
          username: form.username,
          email: form.email,
          password: form.password
        })
      }
      // 2. Log in (works for both existing users and newly registered ones)
      await login(form.username, form.password)
      
      // 3. Navigate back to where they came from using the "from" variable!
      navigate(from, { replace: true })
      
    } catch (err) {
      setError(err.message || (isRegistering ? 'Registration failed' : 'Invalid username or password'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'var(--navy)',
    }}>
      <div style={{ width: 380 }}>
        {/* Header */}
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <div style={{
            width: 48, height: 48, background: 'var(--crimson)', borderRadius: 12,
            display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px',
          }}>
            <svg width="26" height="26" viewBox="0 0 16 16" fill="white">
              <path d="M8 1a2 2 0 012 2v1h1a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2V6a2 2 0 012-2h1V3a2 2 0 012-2zm0 1.5A.5.5 0 007.5 3v1h1V3A.5.5 0 008 2.5zM5.5 7a.5.5 0 000 1H6v1.5a.5.5 0 001 0V8h1v1.5a.5.5 0 001 0V8h.5a.5.5 0 000-1H5.5z"/>
            </svg>
          </div>
          <div style={{ fontFamily: 'var(--font-serif)', fontSize: 26, color: 'white' }}>PathoDB</div>
          <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.45)', marginTop: 4, letterSpacing: '0.04em' }}>
            Computational Pathology Database
          </div>
        </div>

        {/* Card */}
        <div style={{ background: 'white', borderRadius: 12, padding: '28px 32px' }}>
          
          <h2 style={{ textAlign: 'center', marginBottom: 20, fontSize: 18, fontWeight: 600, color: 'var(--text-1)'}}>
            {isRegistering ? 'Create Account' : 'Welcome Back'}
          </h2>

          <ErrorMsg message={error} />
          <form onSubmit={handleSubmit}>
            <div style={{ marginBottom: 16 }}>
              <label style={labelStyle}>Username</label>
              <input
                style={inputStyle}
                type="text"
                autoComplete="username"
                autoFocus
                value={form.username}
                onChange={e => setForm(f => ({ ...f, username: e.target.value }))}
                required
              />
            </div>
            
            {/* Render Email field only when registering */}
            {isRegistering && (
              <div style={{ marginBottom: 16 }}>
                <label style={labelStyle}>Email</label>
                <input
                  style={inputStyle}
                  type="email"
                  autoComplete="email"
                  value={form.email}
                  onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
                  required
                />
              </div>
            )}

            <div style={{ marginBottom: 24 }}>
              <label style={labelStyle}>Password</label>
              <input
                style={inputStyle}
                type="password"
                autoComplete="current-password"
                value={form.password}
                onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
                required
              />
            </div>

            <Btn type="submit" variant="primary" disabled={loading} style={{ width: '100%', justifyContent: 'center', padding: '10px 0', fontSize: 14 }}>
              {loading ? (isRegistering ? 'Creating...' : 'Signing in…') : (isRegistering ? 'Sign up' : 'Sign in')}
            </Btn>
          </form>

          {/* Toggle Button */}
          <div style={{ textAlign: 'center', marginTop: 16 }}>
            <button
              type="button"
              style={{
                background: 'none', border: 'none', color: 'var(--crimson)',
                fontSize: 13, fontWeight: 500, cursor: 'pointer'
              }}
              onClick={() => {
                setIsRegistering(!isRegistering)
                setError('') // Clear errors when swapping modes
              }}
            >
              {isRegistering ? 'Already have an account? Sign in' : 'Need an account? Sign up'}
            </button>
          </div>
        </div>

        <div style={{ textAlign: 'center', marginTop: 20, fontSize: 12, color: 'rgba(255,255,255,0.25)' }}>
          Institute of Pathology · University of Bern
        </div>
      </div>
    </div>
  )
}

const labelStyle = {
  display: 'block', fontSize: 12, fontWeight: 600,
  color: 'var(--text-2)', textTransform: 'uppercase',
  letterSpacing: '0.06em', marginBottom: 6,
}
const inputStyle = {
  width: '100%', padding: '9px 12px',
  border: '1px solid var(--border)', borderRadius: 6,
  fontSize: 14, outline: 'none',
  transition: 'border-color 0.15s',
}