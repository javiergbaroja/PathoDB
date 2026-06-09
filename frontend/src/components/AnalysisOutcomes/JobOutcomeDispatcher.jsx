// components/AnalysisOutcomes/JobOutcomeDispatcher.jsx
import React, { useState, useEffect } from 'react'
import { api } from '../../api' // Ensure this path correctly points to your api.js

import DetectionSummary from './DetectionSummary'
import ScoringSummary from './ScoringSummary'
import SegmentationSummary from './SegmentationSummary'
import MultiClassDetectionSummary from './MultiClassDetectionSummary'
import MetastasisSummary from './MetastasisSummary'

export default function JobOutcomeDispatcher({ jobId, model, scanId = null }) {
  const [outcome, setOutcome] = useState(null)
  const [loading, setLoading] = useState(true)
  const [retryKey, setRetryKey] = useState(0)

  useEffect(() => {
    setLoading(true)
    setOutcome(null)
    api.getAnalysisResult(jobId)
      .then(data => {
        let resolved = null
        if (data?.outcome) {
          resolved = data.outcome
        } else if (Array.isArray(data?.scans) && scanId != null) {
          const scanEntry = data.scans.find(s => s.scan_id === scanId)
          resolved = scanEntry?.outcome ?? null
        }
        setOutcome(resolved)
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [jobId, scanId, retryKey])

  if (loading) return null

  if (!outcome) return (
    <button
      onClick={() => setRetryKey(k => k + 1)}
      style={{
        fontSize: 9, color: 'var(--text-dark-2)', background: 'none',
        border: 'none', cursor: 'pointer', padding: '2px 0', textDecoration: 'underline',
      }}
    >
      Reload summary
    </button>
  )

  // Route the data to the correct UI component based on the model's schema
  switch (model?.result_type) {
    case 'segmentation':
      return <SegmentationSummary outcome={outcome} />

    case 'classification':
      return <ScoringSummary outcome={outcome} />

    case 'ln_metastasis':
      return <MetastasisSummary outcome={outcome} />

    case 'panoptic':
    case 'multiclass_detection':
      return <MultiClassDetectionSummary outcome={outcome} />

    case 'counting':
    case 'detection':
      return <DetectionSummary outcome={outcome} />

    default:
      return <DetectionSummary outcome={outcome} />
  }
}