// components/AnalysisOutcomes/JobOutcomeDispatcher.jsx
import React, { useState, useEffect } from 'react'
import { api } from '../../api' // Ensure this path correctly points to your api.js

import DetectionSummary from './DetectionSummary'
import ScoringSummary from './ScoringSummary'
import SegmentationSummary from './SegmentationSummary'
import MultiClassDetectionSummary from './MultiClassDetectionSummary'

export default function JobOutcomeDispatcher({ jobId, model }) {
  // These are the state variables that were missing!
  const [outcome, setOutcome] = useState(null)
  const [loading, setLoading] = useState(true)

  // The fetch logic to get the result.json
  useEffect(() => {
    api.getAnalysisResult(jobId)
      .then(data => {
        if (data && data.outcome) setOutcome(data.outcome)
      })
      .catch(() => {}) // Silently fail if the file isn't ready yet
      .finally(() => setLoading(false))
  }, [jobId])

  // Don't render anything while fetching, or if the model didn't output an outcome
  if (loading || !outcome) return null

  // Route the data to the correct UI component based on the model's schema
  switch (model?.result_type) {
    case 'segmentation': 
      return <SegmentationSummary outcome={outcome} />
      
    case 'classification':      
      return <ScoringSummary outcome={outcome} />
      
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