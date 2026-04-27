// components/AnalysisOutcomes/ScoringSummary.jsx
import React from 'react'
import { SummaryCard, SummaryRow } from './OutcomeLayout'

export default function ScoringSummary({ outcome }) {
  if (!outcome) return null
  
  const isHighRisk = outcome.label === 1 || outcome.grade_group >= 3
  
  return (
    <SummaryCard isPositive={isHighRisk}>
      <SummaryRow label="Diagnosis" value={outcome.status?.replace(/_/g, ' ')} highlight={isHighRisk} />
      <SummaryRow label="Score" value={outcome.score} isMono />
      <SummaryRow label="Grade Group" value={outcome.grade_group ? `Group ${outcome.grade_group}` : null} />
    </SummaryCard>
  )
}