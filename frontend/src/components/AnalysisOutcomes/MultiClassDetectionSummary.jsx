// components/AnalysisOutcomes/MultiClassDetectionSummary.jsx
import React from 'react'
import { SummaryCard, SummaryRow } from './OutcomeLayout'

export default function MultiClassDetectionSummary({ outcome }) {
  if (!outcome) return null
  
  const isPositive = outcome.label === 1
  const statusText = outcome.status ? outcome.status.replace(/_/g, ' ') : 'Analyzed'
  
  // Safely extract class counts and total
  const counts = outcome.class_counts || {}
  const total = outcome.total_cells || Object.values(counts).reduce((a, b) => a + b, 0)
  
  // Sort classes by count (highest first) for a cleaner UI
  const sortedClasses = Object.entries(counts).sort(([, a], [, b]) => b - a)

  return (
    <SummaryCard isPositive={isPositive}>
      {/* 1. Global Impression & Primary Metric */}
      <SummaryRow label="" value={statusText} highlight={isPositive} />
      
      {outcome.primary_metric && (
        <SummaryRow 
          label={outcome.primary_metric.label || 'Metric'} 
          value={outcome.primary_metric.value} 
          highlight={isPositive} 
          isMono 
        />
      )}

      {/* 2. Cell Population Breakdown */}
      {sortedClasses.length > 0 && (
        <div style={{ marginTop: 6, borderTop: '1px dashed rgba(255,255,255,0.1)', paddingTop: 6 }}>
          <div style={{ fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'rgba(255,255,255,0.4)', marginBottom: 4 }}>
            Cell Population ({total.toLocaleString()})
          </div>
          
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            {sortedClasses.map(([className, count]) => {
              const pct = total > 0 ? ((count / total) * 100).toFixed(1) : 0
              
              return (
                <div key={className} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.7)', display: 'flex', alignItems: 'center', gap: 6 }}>
                    {/* Tiny bullet point for visual rhythm */}
                    <div style={{ width: 3, height: 3, borderRadius: '50%', background: 'rgba(255,255,255,0.3)' }} />
                    {className}
                  </span>
                  
                  {/* Right side: Count + Percentage */}
                  <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                    <span style={{ fontSize: 11, fontFamily: 'monospace', color: 'rgba(255,255,255,0.8)' }}>
                      {count.toLocaleString()}
                    </span>
                    <span style={{ fontSize: 9, fontFamily: 'monospace', color: 'rgba(255,255,255,0.4)', width: 32, textAlign: 'right' }}>
                      {pct}%
                    </span>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </SummaryCard>
  )
}