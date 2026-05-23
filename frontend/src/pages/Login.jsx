import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { useNavigate, useLocation } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { Btn, ErrorMsg, FormField, FormInput } from '../components/ui'
import { api } from '../api'
import logo from '../assets/logos/logo_horizontal_neg.svg'
import styles from './Login.module.css'

export default function Login() {
  const { login } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const from = location.state?.from?.pathname || '/patients'

  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [isRegistering, setIsRegistering] = useState(false)

  const { register, handleSubmit, formState: { errors } } = useForm({
    defaultValues: { username: '', email: '', password: '' },
  })

  async function onSubmit(form) {
    setError('')
    setLoading(true)
    try {
      if (isRegistering) {
        await api.register({
          username: form.username,
          email: form.email,
          password: form.password,
        })
      }
      await login(form.username, form.password)
      navigate(from, { replace: true })
    } catch (err) {
      setError(err.message || (isRegistering ? 'Registration failed' : 'Invalid username or password'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className={styles.wrap}>
      <div className={styles.column}>
        <div className={styles.header}>
          <img src={logo} alt="PathoDB Logo" className={styles.logo} />
        </div>

        <div className={styles.card}>
          <h2 className={styles.title}>
            {isRegistering ? 'Create Account' : 'Welcome Back'}
          </h2>

          <ErrorMsg message={error} />

          <form onSubmit={handleSubmit(onSubmit)} noValidate>
            <FormField label="Username" htmlFor="login-username" error={errors.username?.message}>
              <FormInput
                id="login-username"
                type="text"
                autoComplete="username"
                autoFocus
                aria-invalid={!!errors.username}
                {...register('username', { required: 'Username is required' })}
              />
            </FormField>

            {isRegistering && (
              <FormField label="Email" htmlFor="login-email" error={errors.email?.message}>
                <FormInput
                  id="login-email"
                  type="email"
                  autoComplete="email"
                  aria-invalid={!!errors.email}
                  {...register('email', {
                    required: 'Email is required',
                    pattern: { value: /\S+@\S+\.\S+/, message: 'Enter a valid email' },
                  })}
                />
              </FormField>
            )}

            <FormField label="Password" htmlFor="login-password" error={errors.password?.message}>
              <FormInput
                id="login-password"
                type="password"
                autoComplete={isRegistering ? 'new-password' : 'current-password'}
                aria-invalid={!!errors.password}
                {...register('password', { required: 'Password is required' })}
              />
            </FormField>

            <Btn
              type="submit"
              variant="primary"
              disabled={loading}
              className={styles.submit}
            >
              {loading
                ? (isRegistering ? 'Creating…' : 'Signing in…')
                : (isRegistering ? 'Sign up' : 'Sign in')}
            </Btn>
          </form>

          <div className={styles.toggleWrap}>
            <button
              type="button"
              className={styles.toggleBtn}
              onClick={() => {
                setIsRegistering(!isRegistering)
                setError('')
              }}
            >
              {isRegistering ? 'Already have an account? Sign in' : 'Need an account? Sign up'}
            </button>
          </div>
        </div>

        <div className={styles.footer}>
          Institute of Pathology · University of Bern
        </div>
      </div>
    </div>
  )
}
