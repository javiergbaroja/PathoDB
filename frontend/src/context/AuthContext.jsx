import { createContext, useContext, useState, useEffect } from 'react'
import { api } from '../api'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [token, setToken] = useState(() => localStorage.getItem('pathodb_token'))
  const [user, setUser]   = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (token) {
      // 1. Swap api.health() for api.getMe()
      api.getMe()
        .then((userData) => {
          // 2. If successful, set the user data to restore the session!
          if (userData) setUser(userData) 
          setLoading(false)
        })
        .catch(() => {
          // If this fails, the token is genuinely expired or invalid.
          logout()
          setLoading(false)
        })
    } else {
      setLoading(false)
    }
  }, [])

  async function login(username, password) {
    const data = await api.login(username, password)
    localStorage.setItem('pathodb_token', data.access_token)
    setToken(data.access_token)
    setUser({ username })
    return data
  }

  function logout() {
    localStorage.removeItem('pathodb_token')
    setToken(null)
    setUser(null)
  }

  return (
    <AuthContext.Provider value={{ token, user, login, logout, isAuth: !!token, loading }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  return useContext(AuthContext)
}
