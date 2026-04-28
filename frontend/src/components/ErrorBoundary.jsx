// frontend/src/components/ErrorBoundary.jsx
import React from 'react'

export class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error) {
    // Update state so the next render will show the fallback UI.
    return { hasError: true, error }
  }

  componentDidCatch(error, errorInfo) {
    // In a real production app, you would log this to Sentry or Datadog here
    console.error("ErrorBoundary caught an error:", error, errorInfo)
  }

  render() {
    if (this.state.hasError) {
      // If a custom fallback is provided, use it. Otherwise, use the default.
      if (this.props.fallback) {
        return this.props.fallback
      }

      return (
        <div style={{ padding: '12px 16px', border: '1px solid rgba(230,0,46,0.3)', background: 'rgba(230,0,46,0.08)', borderRadius: '6px', margin: '8px 0' }}>
          <div style={{ color: '#ff8099', fontSize: '11px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '4px' }}>
            Component Crashed
          </div>
          <div style={{ color: 'rgba(255,255,255,0.7)', fontSize: '12px', fontFamily: 'monospace', wordBreak: 'break-all' }}>
            {this.state.error?.message || 'An unknown rendering error occurred.'}
          </div>
        </div>
      )
    }

    return this.props.children
  }
}