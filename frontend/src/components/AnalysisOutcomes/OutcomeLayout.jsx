// components/AnalysisOutcomes/OutcomeLayout.jsx
import React from 'react'

export function SummaryCard({ isPositive, children }) {
  const bgColor = isPositive ? 'rgba(230,0,46,0.1)' : 'rgba(27,153,139,0.1)'
  const borderColor = isPositive ? 'rgba(230,0,46,0.2)' : 'rgba(27,153,139,0.2)'
  
  return (
    <div style={{ 
      marginTop: 8, 
      padding: '8px 10px', 
      background: bgColor, 
      border: `1px solid ${borderColor}`, 
      borderRadius: 6, 
      display: 'flex', 
      flexDirection: 'column', 
      gap: 4 
    }}>
      {children}
    </div>
  )
}

export function SummaryRow({ label, value, highlight = false, isMono = false }) {
  if (value === undefined || value === null) return null;

  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
      <span style={{ fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'rgba(255,255,255,0.5)' }}>
        {label}
      </span>
      <span style={{ 
        fontSize: 11, 
        fontWeight: highlight ? 700 : 500, 
        fontFamily: isMono ? 'monospace' : 'sans-serif', 
        color: highlight ? '#ff8099' : 'rgba(255,255,255,0.8)', 
        textTransform: typeof value === 'string' && !isMono ? 'capitalize' : 'none' 
      }}>
        {value}
      </span>
    </div>
  )
}