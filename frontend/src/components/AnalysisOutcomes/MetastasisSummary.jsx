// components/AnalysisOutcomes/MetastasisSummary.jsx
import React from 'react'
import { SummaryCard, SummaryRow } from './OutcomeLayout'

// Human-readable labels for every status returned by get_slide_level_result
const STATUS_LABELS = {
  negative:        'Negative',
  itc:             'Isolated Tumor Cells',
  micrometastasis: 'Micrometastasis',
  macrometastasis: 'Macrometastasis',
  tumor_deposit:   'Tumor Deposit',
  acellular_mucin: 'Acellular Mucin',
}

function formatMeasurement(um) {
  if (!um || um <= 0) return null
  // ITC range — keep in µm so the sub-mm size is legible
  if (um < 200) return `${Math.round(um)} µm`
  return `${(um / 1000).toFixed(2)} mm`
}

export default function MetastasisSummary({ outcome }) {
  if (!outcome) return null

  const status     = outcome.status ?? ''
  const isPositive = outcome.label === 1
  // ITC is label=0 (negative for staging) but is a distinct finding — amber card
  const isITC      = status === 'itc'

  const statusLabel = STATUS_LABELS[status] ?? status.replace(/_/g, ' ')

  // Measurement is meaningful for all findings except a clean negative and acellular mucin
  const showMeasurement = outcome.measurement_um > 0
    && status !== 'negative'
    && status !== 'acellular_mucin'

  return (
    <SummaryCard isPositive={isPositive} isWarning={isITC}>
      <SummaryRow
        label="AI Impression"
        value={statusLabel}
        highlight={isPositive || isITC}
      />

      {outcome.ln_count != null && (
        <SummaryRow label="LN Fragments" value={outcome.ln_count} isMono />
      )}

      {showMeasurement && (
        <SummaryRow
          label="Max Extent"
          value={formatMeasurement(outcome.measurement_um)}
          isMono
        />
      )}
    </SummaryCard>
  )
}
