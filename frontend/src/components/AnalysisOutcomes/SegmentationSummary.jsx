// components/AnalysisOutcomes/SegmentationSummary.jsx
import React from 'react'
import { SummaryCard, SummaryRow } from './OutcomeLayout'

export default function SegmentationSummary({ outcome }) {
  if (!outcome) return null

  // Per-class area fractions, if the model reported them (crc_seg + derived runs).
  const composition = outcome.composition_pct && typeof outcome.composition_pct === 'object'
    ? Object.entries(outcome.composition_pct)
    : []

  return (
    <SummaryCard isPositive={false}>
      <SummaryRow label="Region" value={outcome.status?.replace(/_/g, ' ')} />
      <SummaryRow label="Total Area" value={outcome.area_mm2 ? `${outcome.area_mm2} mm²` : null} isMono />

      {composition.length > 0 && (
        <>
          <div style={{
            marginTop: 4, fontSize: 9, textTransform: 'uppercase',
            letterSpacing: '0.05em', color: 'rgba(255,255,255,0.5)',
          }}>
            Composition
          </div>
          {composition.map(([cls, pct]) => (
            <SummaryRow key={cls} label={cls} value={`${pct}%`} isMono />
          ))}
        </>
      )}
    </SummaryCard>
  )
}
