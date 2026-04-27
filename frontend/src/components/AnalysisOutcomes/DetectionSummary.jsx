// components/AnalysisOutcomes/DetectionSummary.jsx
import React from 'react'
import { SummaryCard, SummaryRow } from './OutcomeLayout'

export default function DetectionSummary({ outcome }) {
  // Defensive checks
  if (!outcome) return null
  
  const isPositive = outcome.label === 1
  const statusText = outcome.status ? outcome.status.replace(/_/g, ' ') : 'Detected'

  // Backwards compatibility for your current MetAssist
  const sizeMm = outcome.measurement_um ? (outcome.measurement_um / 1000).toFixed(2) : null

  return (
    <SummaryCard isPositive={isPositive}>
      <SummaryRow label="AI Impression" value={statusText} highlight={isPositive} />
      
      {/* Renders if it's the old MetAssist schema */}
      <SummaryRow label="Max Extent" value={sizeMm ? `${sizeMm} mm` : null} isMono />

      {/* Renders if it uses the flexible primary_metric schema */}
      {outcome.primary_metric && (
        <SummaryRow 
          label={outcome.primary_metric.label || 'Metric'} 
          value={outcome.primary_metric.value} 
          isMono 
        />
      )}
    </SummaryCard>
  )
}