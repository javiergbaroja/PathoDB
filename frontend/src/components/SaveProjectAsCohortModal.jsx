// frontend/src/components/SaveProjectAsCohortModal.jsx
// Snapshot a project's slides as a saved cohort at a chosen level. Shared by
// the Projects list (card footer) and ProjectDetail (topbar), like
// ManageClassesModal / AddSlidesModal.
//
// The backend stores a list-mode CohortFilter (id_type 'scan_id') and the
// cohort engine rolls the scans up to the chosen return_level, so the result
// behaves like any other saved cohort (open, export, batch analysis, new
// project source).

import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../api'
import { Modal, Btn, FormInput, FormField, ErrorMsg, Spinner, useToast } from './ui'

// Top-down, same order as the cohort builder's return-level options.
const LEVELS = [
  { key: 'patient',    label: 'Patients',    desc: 'One row per patient. Submissions, probes and blocks behind the slides are summarized per patient.' },
  { key: 'submission', label: 'Submissions', desc: 'One row per case (B-/Z-number). Probe topographies and SNOMED codes are aggregated per submission.' },
  { key: 'probe',      label: 'Probes',      desc: 'One row per probe with its topography and morphology codes.' },
  { key: 'block',      label: 'Blocks',      desc: 'One row per paraffin block, with the stains available for it.' },
  { key: 'scan',       label: 'Scans',       desc: 'One row per slide — exactly the slides in the project.' },
]

function LevelCard({ selected, onClick, label, count, loading }) {
  return (
    <button onClick={onClick} style={{
      flex: 1, minWidth: 0, padding: '12px 8px', textAlign: 'center', cursor: 'pointer',
      borderRadius: 'var(--radius-lg)', fontFamily: 'var(--font-sans)',
      border: `2px solid ${selected ? 'var(--navy)' : 'var(--border)'}`,
      background: selected ? 'var(--navy-05)' : 'var(--white)',
      transition: 'var(--transition-base)',
    }}>
      <div style={{ fontFamily: 'var(--font-serif)', fontSize: 22, lineHeight: 1.1, color: selected ? 'var(--navy)' : 'var(--text-2)', minHeight: 24 }}>
        {loading ? <Spinner size={14} /> : (count ?? '—').toLocaleString()}
      </div>
      <div style={{ fontSize: 11, fontWeight: selected ? 700 : 500, color: selected ? 'var(--navy)' : 'var(--text-3)', marginTop: 4 }}>
        {label}
      </div>
    </button>
  )
}

export default function SaveProjectAsCohortModal({ isOpen, onClose, project }) {
  const queryClient = useQueryClient()
  const toast       = useToast()
  const projectId   = project?.id

  const [level, setLevel] = useState('scan')
  const [name,  setName]  = useState('')
  const [desc,  setDesc]  = useState('')
  const [error, setError] = useState('')

  // The component stays mounted between openings; seed the form from the project each time.
  useEffect(() => {
    if (!isOpen || !project) return
    setLevel('scan')
    setName(project.name || '')
    setDesc(`Saved from project "${project.name}"`)
    setError('')
  }, [isOpen, project])

  const { data: preview, isLoading: previewLoading } = useQuery({
    queryKey: ['project-cohort-preview', projectId],
    queryFn:  () => api.getProjectCohortPreview(projectId),
    enabled:  isOpen && !!projectId,
  })

  const mutation = useMutation({
    mutationFn: () => api.saveProjectAsCohort(projectId, {
      name:         name.trim(),
      description:  desc.trim() || undefined,
      return_level: level,
    }),
    onSuccess: res => {
      queryClient.invalidateQueries({ queryKey: ['cohorts'] })
      const lvl = LEVELS.find(l => l.key === res.return_level)?.label.toLowerCase() ?? res.return_level
      toast.success(`Cohort "${res.name}" saved — ${(res.result_count ?? 0).toLocaleString()} ${lvl}`)
      onClose()
    },
    onError: e => setError(e.message || 'Failed to save cohort'),
  })

  const current  = LEVELS.find(l => l.key === level)
  const unlinked = preview?.unlinked_scans ?? 0
  const empty    = !previewLoading && preview && (preview[level] ?? 0) === 0

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Save as cohort"
      subtitle={project ? `Snapshot the slides of "${project.name}" as a saved cohort.` : undefined}
      width={600}
    >
      <Modal.Body style={{ padding: '24px 28px' }}>
        <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--navy)', marginBottom: 6 }}>
          At which level should the cohort be saved?
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 14, lineHeight: 1.5 }}>
          The project's slides are rolled up to the level you pick. Counts show what the cohort will contain.
        </div>

        <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
          {LEVELS.map(l => (
            <LevelCard
              key={l.key}
              selected={level === l.key}
              onClick={() => setLevel(l.key)}
              label={l.label}
              count={preview?.[l.key]}
              loading={previewLoading}
            />
          ))}
        </div>

        <div style={{ fontSize: 12, color: 'var(--text-2)', lineHeight: 1.5, marginBottom: 18, minHeight: 36 }}>
          {current?.desc}
        </div>

        {unlinked > 0 && (
          <div style={{ marginBottom: 14, fontSize: 11, color: 'var(--warning)', background: 'var(--warning-bg)', padding: '6px 10px', borderRadius: 'var(--radius-md)', border: '1px solid var(--amber)' }}>
            ⚠ {unlinked.toLocaleString()} slide{unlinked !== 1 ? 's' : ''} in this project {unlinked !== 1 ? 'have' : 'has'} no block linkage and will be left out at every level.
          </div>
        )}

        <FormField label="Cohort name" style={{ marginBottom: 14 }}>
          <FormInput value={name} onChange={e => setName(e.target.value)} placeholder="e.g. CRC Cohort 2024" />
        </FormField>
        <FormField label="Description (optional)">
          <FormInput value={desc} onChange={e => setDesc(e.target.value)} placeholder="Optional description…" />
        </FormField>

        <ErrorMsg message={error} style={{ marginTop: 12 }} />
      </Modal.Body>

      <Modal.Footer>
        <Btn variant="ghost" onClick={onClose} disabled={mutation.isPending}>Cancel</Btn>
        <Btn
          variant="primary"
          onClick={() => mutation.mutate()}
          disabled={!name.trim() || empty || previewLoading || mutation.isPending}
        >
          {mutation.isPending ? 'Saving…' : 'Save cohort'}
        </Btn>
      </Modal.Footer>
    </Modal>
  )
}
