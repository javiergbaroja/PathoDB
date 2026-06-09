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

  useEffect(() => {
    api.getAnalysisResult(jobId)
      .then(data => {
        let resolved = null
        if (data?.outcome) {
          // Single-slide result format
          resolved = data.outcome
        } else if (Array.isArray(data?.scans) && scanId != null) {
          // Batch result format — find the entry for this specific slide
          const scanEntry = data.scans.find(s => s.scan_id === scanId)
          resolved = scanEntry?.outcome ?? null
        }
        setOutcome(resolved)
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [jobId, scanId])

  // Don't render anything while fetching, or if the model didn't output an outcome
  if (loading || !outcome) return null

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