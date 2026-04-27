// components/AnalysisOutcomes/SegmentationSummary.jsx
import React from 'react'
import { SummaryCard, SummaryRow } from './OutcomeLayout'

export default function SegmentationSummary({ outcome }) {
  if (!outcome) return null
  
  // Segmentation might not be "positive/negative", so we can default to neutral (false)
  return (
    <SummaryCard isPositive={false}>
      <SummaryRow label="Region" value={outcome.status?.replace(/_/g, ' ')} />
      <SummaryRow label="Total Area" value={outcome.area_mm2 ? `${outcome.area_mm2} mm²` : null} isMono />
    </SummaryCard>
  )
}