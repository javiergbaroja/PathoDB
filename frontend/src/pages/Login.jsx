import { useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { Btn, ErrorMsg } from '../components/ui'
import { api } from '../api' 
import logo from '../assets/logos/logo_horizontal_neg.svg'

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
          <img 
            src={logo} 
            alt="PathoDB Logo" 
            style={{ 
              width: 380, 
              height: 'auto', 
              margin: '0 auto 16px', 
              display: 'block' 
            }} 
          />
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