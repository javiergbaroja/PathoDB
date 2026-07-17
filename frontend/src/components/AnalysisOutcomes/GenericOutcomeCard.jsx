// components/AnalysisOutcomes/GenericOutcomeCard.jsx
//
// Data-driven outcome card. A tool declares how its result should render by
// emitting `outcome.card`, so new tools never need a bespoke React component:
//
//   outcome.card = {
//     severity: "positive" | "warning" | "neutral",   // card colour
//     rows: [{ label, value, mono?, highlight? }],     // value null/undefined → row hidden
//     note: "…"                                         // optional italic caveat line
//   }
//
import React from 'react'
import { SummaryCard, SummaryRow } from './OutcomeLayout'

export default function GenericOutcomeCard({ card }) {
  if (!card) return null

  const isPositive = card.severity === 'positive'
  const isWarning  = card.severity === 'warning'

  return (
    <SummaryCard isPositive={isPositive} isWarning={isWarning}>
      {(card.rows || []).map((row, i) => (
        <SummaryRow
          key={i}
          label={row.label}
          value={row.value}
          highlight={row.highlight}
          isMono={row.mono}
        />
      ))}

      {card.note && (
        <div style={{
          marginTop: 2, fontSize: 9, lineHeight: 1.4,
          color: 'var(--transparent-white-5)', fontStyle: 'italic',
        }}>
          {card.note}
        </div>
      )}
    </SummaryCard>
  )
}
