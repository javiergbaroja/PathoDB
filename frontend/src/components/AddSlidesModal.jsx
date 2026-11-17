// frontend/src/components/AddSlidesModal.jsx
// Append slides to an existing project. Shared by the Projects list (card
// footer) and ProjectDetail (topbar), like ManageClassesModal.
//
// The source panel is the same SlideSourceSelector as CreateProjectModal step 3;
// the resolved scan ids are POSTed to /projects/{id}/scans, which skips slides
// already in the project. Nothing else about the project (type, classes,
// cohort link) is touched.

import { useState, useMemo, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../api'
import { Modal, Btn, ErrorMsg, useToast } from './ui'
import SlideSourceSelector, { selectedScanIds } from './SlideSourceSelector'

const DESCRIPTIONS = {
  cohort_inline: 'Filter or query the database on the spot. Matched scans are appended to the project.',
  cohort_saved:  'Load slides from an existing saved cohort.',
  manual:        'Provide file paths or filenames manually. Best for a handful of specific slides.',
}

export default function AddSlidesModal({ isOpen, onClose, project }) {
  const queryClient = useQueryClient()
  const toast       = useToast()
  const projectId   = project?.id

  // Source state — same trio CreateProjectModal owns for its SourceStep
  const [sourceOption,    setSourceOption]    = useState('cohort_inline')
  const [filteredTargets, setFilteredTargets] = useState([])
  const [cohortResult,    setCohortResult]    = useState(null)
  const [error,           setError]           = useState('')

  // The component stays mounted between openings; start each one clean.
  // (SlideSourceSelector's own inputs reset by themselves — Modal unmounts them.)
  useEffect(() => {
    if (!isOpen) return
    setSourceOption('cohort_inline')
    setFilteredTargets([])
    setCohortResult(null)
    setError('')
  }, [isOpen])

  const { data: cohorts = [] } = useQuery({
    queryKey: ['cohorts'],
    queryFn:  () => api.getCohorts(),
    enabled:  isOpen,
  })

  // Current membership, so the footer can say how many slides are actually new.
  // Same key ProjectDetail uses (string id), so the cache is shared.
  const { data: projectScans = [] } = useQuery({
    queryKey: ['project-scans', String(projectId)],
    queryFn:  () => api.getProjectScans(projectId),
    enabled:  isOpen && !!projectId,
  })

  const existing = useMemo(() => new Set(projectScans.map(s => s.scan_id)), [projectScans])
  const selected = useMemo(
    () => selectedScanIds(sourceOption, filteredTargets, cohortResult),
    [sourceOption, filteredTargets, cohortResult],
  )
  const newIds   = useMemo(() => selected.filter(id => !existing.has(id)), [selected, existing])
  const dupCount = selected.length - newIds.length

  const mutation = useMutation({
    mutationFn: scanIds => api.addProjectScans(projectId, scanIds),
    onSuccess: res => {
      queryClient.invalidateQueries({ queryKey: ['project', String(projectId)] })
      queryClient.invalidateQueries({ queryKey: ['project-scans', String(projectId)] })
      queryClient.invalidateQueries({ queryKey: ['project-progress', String(projectId)] })
      queryClient.invalidateQueries({ queryKey: ['projects'] })
      const n = res?.added ?? 0
      toast.success(`Added ${n.toLocaleString()} slide${n !== 1 ? 's' : ''} to "${project?.name}"`)
      onClose()
    },
    onError: e => setError(e.message || 'Failed to add slides'),
  })

  const plural = n => (n !== 1 ? 's' : '')

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Add slides"
      subtitle={project ? `Append slides to "${project.name}". Slides already in the project are skipped.` : undefined}
      width={600}
    >
      <Modal.Body style={{ padding: '24px 28px' }}>
        <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--navy)', marginBottom: 14 }}>
          Where do the slides come from?
        </div>
        <SlideSourceSelector
          sourceOption={sourceOption}       onSourceOption={setSourceOption}
          cohorts={cohorts}
          filteredTargets={filteredTargets} onTargetsResolved={setFilteredTargets}
          cohortResult={cohortResult}       onCohortResult={setCohortResult}
          descriptions={DESCRIPTIONS}
        />

        {selected.length > 0 && (
          <div style={{
            marginTop: 16, padding: '10px 14px',
            background: 'var(--navy-05)', borderRadius: 'var(--radius-md)',
            fontSize: 12, color: 'var(--text-2)',
            display: 'flex', gap: 14, flexWrap: 'wrap',
          }}>
            <span><strong style={{ color: 'var(--navy)' }}>{selected.length.toLocaleString()}</strong> selected</span>
            {dupCount > 0 && (
              <span><strong style={{ color: 'var(--text-3)' }}>{dupCount.toLocaleString()}</strong> already in project</span>
            )}
            <span><strong style={{ color: 'var(--teal)' }}>{newIds.length.toLocaleString()}</strong> will be added</span>
          </div>
        )}

        <ErrorMsg message={error} style={{ marginTop: 12 }} />
      </Modal.Body>

      <Modal.Footer>
        <Btn variant="ghost" onClick={onClose} disabled={mutation.isPending}>Cancel</Btn>
        <Btn
          variant="primary"
          onClick={() => mutation.mutate(newIds)}
          disabled={newIds.length === 0 || mutation.isPending}
        >
          {mutation.isPending
            ? 'Adding…'
            : `Add ${newIds.length.toLocaleString()} slide${plural(newIds.length)}`}
        </Btn>
      </Modal.Footer>
    </Modal>
  )
}
