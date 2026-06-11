/**
 * SlideTargetManager
 * ==================
 * Compatibility shim. The implementation now lives in SlideSourceSelector.
 *
 * This wrapper keeps the legacy two-mode tab interface (manual / cohort) for
 * any call-site that hasn't been updated yet. New code should use
 * SlideSourceSelector directly, which provides the three-card UI matching
 * the Project creation flow.
 */

import { useState } from 'react'
import SlideSourceSelector from './SlideSourceSelector'

export default function SlideTargetManager({ cohorts = [], onTargetsResolved }) {
  const [sourceOption,    setSourceOption]    = useState('cohort_saved')
  const [filteredTargets, setFilteredTargets] = useState([])
  const [cohortResult,    setCohortResult]    = useState(null)

  function handleTargetsResolved(targets) {
    setFilteredTargets(targets)
    if (onTargetsResolved) onTargetsResolved(targets)
  }

  return (
    <SlideSourceSelector
      sourceOption={sourceOption}
      onSourceOption={setSourceOption}
      cohorts={cohorts}
      filteredTargets={filteredTargets}
      onTargetsResolved={handleTargetsResolved}
      cohortResult={cohortResult}
      onCohortResult={setCohortResult}
    />
  )
}