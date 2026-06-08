// components/AnalysisOutcomes/MetastasisSummary.jsx
import React from 'react'
import { SummaryCard, SummaryRow } from './OutcomeLayout'

export default function MetastasisSummary({ outcome }) {
  if (!outcome) return null

  const isPositive = outcome.label === 1
  const hasLNs     = (outcome.ln_count ?? 0) > 0

  const statusText = outcome.status
    ? outcome.status.replace(/_/g, ' ')
    : isPositive ? 'Metastasis Detected' : 'No Metastasis'

  const sizeMm =
    outcome.measurement_um > 0
      ? `${(outcome.measurement_um / 1000).toFixed(2)} mm`
      : null

  return (
    <SummaryCard isPositive={isPositive}>
      {/* Primary clinical finding */}
      <SummaryRow label="AI Impression" value={statusText} highlight={isPositive} />

      {/* LN burden */}
      {outcome.ln_count != null && (
        <SummaryRow label="LN Detected" value={outcome.ln_count} isMono />
      )}

      {outcome.positive_ln_count != null && outcome.positive_ln_count > 0 && (
        <SummaryRow
          label="LN with Metastasis"
          value={outcome.positive_ln_count}
          highlight
          isMono
        />
      )}

      {/* Extent — only meaningful for positive findings */}
      {isPositive && sizeMm && (
        <SummaryRow label="Max Extent" value={sizeMm} isMono />
      )}

      {/* Edge case: no LN found at all */}
      {!hasLNs && (
        <div style={{
          marginTop: 4,
          fontSize: 9,
          color: 'rgba(255,255,255,0.35)',
          fontStyle: 'italic',
        }}>
          No lymph nodes detected in this slide
        </div>
      )}
    </SummaryCard>
  )
}
