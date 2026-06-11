// frontend/src/pages/Projects/CreateProjectModal.jsx
// ─── diff from previous version ─────────────────────────────────────────────
//  - Removed local SearchIcon, FolderIcon, ListIcon, SourceOptionCard
//  - Removed all inline SourceStep logic (loaded cohort, match slides, etc.)
//  - SourceStep now delegates entirely to the shared SlideSourceSelector
// ─────────────────────────────────────────────────────────────────────────────

import { useState } from 'react'
import { api } from '../../api'
import { Modal, Btn, FormInput, FormField, ErrorMsg } from '../../components/ui'
import InlineCohortBuilder from '../../components/InlineCohortBuilder'
import SlideSourceSelector from '../../components/SlideSourceSelector'
import { PATHOLOGY_PALETTE } from '../../constants/stains'

function genId() {
  return Math.random().toString(36).slice(2, 10)
}

// ─── Brand-aligned custom SVG icons ───────────────────────────────────────────

function CellDetectionIcon({ size = 48 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M24 6 C30 5, 37 8, 40 15 C43 21, 42 29, 38 34 C34 39, 28 43, 22 42 C16 41, 10 37, 8 31 C5 24, 7 16, 12 11 C16 7, 19 7, 24 6 Z"
        stroke="var(--navy)" strokeWidth="2" fill="none" strokeLinejoin="round"
      />
      <path
        d="M24 18 C27 17.5, 30 19, 31 22 C32 25, 30.5 28, 27.5 29 C24.5 30, 21 28.5, 20 26 C18.5 23, 20 18.5, 24 18 Z"
        fill="var(--teal)" opacity="0.9"
      />
    </svg>
  )
}

function RegionAnnotationIcon({ size = 48 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M12 14 L20 9 L32 11 L40 19 L38 30 L29 38 L18 37 L9 28 L10 20 Z"
        stroke="var(--navy)" strokeWidth="2" fill="none"
        strokeDasharray="3.5 2.5" strokeLinejoin="round" strokeLinecap="round"
      />
      <circle cx="10.5" cy="14.5" r="1.5" fill="var(--navy)" opacity="0.7" />
    </svg>
  )
}

// ─── Step indicators ──────────────────────────────────────────────────────────

function Steps({ current, steps }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 0, marginBottom: 28 }}>
      {steps.map((label, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', flex: i < steps.length - 1 ? 1 : 'unset' }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
            <div style={{
              width: 28, height: 28, borderRadius: '50%',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 12, fontWeight: 700,
              background: i < current ? 'var(--teal)' : i === current ? 'var(--navy)' : 'var(--navy-10)',
              color: i <= current ? 'var(--white)' : 'var(--text-3)',
              transition: 'var(--transition-base)',
            }}>
              {i < current
                ? <svg width="12" height="12" viewBox="0 0 16 16" fill="white"><path d="M13.854 3.646a.5.5 0 010 .708l-7 7a.5.5 0 01-.708 0l-3.5-3.5a.5.5 0 11.708-.708L6.5 10.293l6.646-6.647a.5.5 0 01.708 0z" /></svg>
                : i + 1}
            </div>
            <span style={{ fontSize: 10, color: i === current ? 'var(--navy)' : 'var(--text-3)', fontWeight: i === current ? 600 : 400, whiteSpace: 'nowrap' }}>
              {label}
            </span>
          </div>
          {i < steps.length - 1 && (
            <div style={{ flex: 1, height: 2, background: i < current ? 'var(--teal)' : 'var(--border)', margin: '0 8px', marginBottom: 20, transition: 'background 0.2s' }} />
          )}
        </div>
      ))}
    </div>
  )
}

// ─── Type card ────────────────────────────────────────────────────────────────

function TypeCard({ selected, onClick, icon, title, description }) {
  return (
    <button onClick={onClick} style={{
      flex: 1, padding: '20px 16px', borderRadius: 'var(--radius-xl)', cursor: 'pointer', textAlign: 'left',
      border: `2px solid ${selected ? 'var(--navy)' : 'var(--border)'}`,
      background: selected ? 'var(--navy-05)' : 'var(--white)',
      transition: 'var(--transition-base)', fontFamily: 'var(--font-sans)',
    }}>
      <div style={{
        width: 52, height: 52, borderRadius: 'var(--radius-lg)',
        background: selected ? 'var(--white)' : 'var(--navy-05)',
        border: `1px solid ${selected ? 'var(--navy-20)' : 'var(--border-l)'}`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        marginBottom: 12, transition: 'var(--transition-base)',
      }}>
        {icon}
      </div>
      <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--navy)', marginBottom: 6 }}>{title}</div>
      <div style={{ fontSize: 12, color: 'var(--text-3)', lineHeight: 1.5 }}>{description}</div>
      {selected && (
        <div style={{ marginTop: 10, display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 600, color: 'var(--navy)', background: 'var(--navy-10)', padding: '3px 10px', borderRadius: 'var(--radius-full)' }}>
          <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor"><path d="M13.854 3.646a.5.5 0 010 .708l-7 7a.5.5 0 01-.708 0l-3.5-3.5a.5.5 0 11.708-.708L6.5 10.293l6.646-6.647a.5.5 0 01.708 0z" /></svg>
          Selected
        </div>
      )}
    </button>
  )
}

// ─── Classes step ─────────────────────────────────────────────────────────────

function ClassesStep({ classes, onClasses }) {
  const [newName,  setNewName]  = useState('')
  const [newColor, setNewColor] = useState(PATHOLOGY_PALETTE[0])

  function addCls() {
    if (!newName.trim()) return
    onClasses([...classes, { id: genId(), name: newName.trim(), color: newColor }])
    setNewName('')
  }

  function removeCls(id) {
    onClasses(classes.filter(c => c.id !== id))
  }

  return (
    <div>
      <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--navy)', marginBottom: 6 }}>
        Define annotation classes
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 16, lineHeight: 1.5 }}>
        Classes can be added or edited after creation. You can skip this step if you're not sure yet.
      </div>

      {classes.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 14 }}>
          {classes.map(c => (
            <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', background: 'var(--navy-05)', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-l)' }}>
              <div style={{ width: 14, height: 14, borderRadius: 3, background: c.color, flexShrink: 0 }} />
              <span style={{ flex: 1, fontSize: 13, color: 'var(--text-1)', fontWeight: 500 }}>{c.name}</span>
              <button onClick={() => removeCls(c.id)} style={{ background: 'none', border: 'none', color: 'var(--text-3)', cursor: 'pointer', fontSize: 16, lineHeight: 1, padding: '0 2px' }}>×</button>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 }}>
        <div style={{ width: 28, height: 28, borderRadius: 6, background: newColor, border: '2px solid var(--navy-20)', flexShrink: 0 }} />
        <FormInput
          value={newName}
          onChange={e => setNewName(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addCls() } }}
          placeholder="Class name (e.g. Tumor, Stroma…)"
        />
        <Btn variant="primary" onClick={addCls} disabled={!newName.trim()}>Add</Btn>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
        {PATHOLOGY_PALETTE.map(c => (
          <div key={c} onClick={() => setNewColor(c)}
            style={{ width: 18, height: 18, borderRadius: 'var(--radius-sm)', background: c, cursor: 'pointer', border: newColor === c ? '2px solid var(--navy)' : '2px solid transparent', flexShrink: 0 }}
          />
        ))}
      </div>
    </div>
  )
}

// ─── Source step ──────────────────────────────────────────────────────────────
// Thin wrapper — all card/icon logic lives in SlideSourceSelector.

function SourceStep({
  sourceOption, onSourceOption,
  cohorts, filteredTargets, onTargetsResolved,
  cohortResult, onCohortResult,
}) {
  return (
    <div>
      <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--navy)', marginBottom: 14 }}>
        Where do the slides come from?
      </div>
      <SlideSourceSelector
        sourceOption={sourceOption}
        onSourceOption={onSourceOption}
        cohorts={cohorts}
        filteredTargets={filteredTargets}
        onTargetsResolved={onTargetsResolved}
        cohortResult={cohortResult}
        onCohortResult={onCohortResult}
        descriptions={{
          cohort_inline: 'Filter or query the database on the spot. A cohort is saved automatically with the project name.',
          cohort_saved:  'Load from an existing saved cohort. The project stays linked and can be refreshed later.',
          manual:        'Provide file paths or filenames manually. Best for custom, one-off selections.',
        }}
      />
    </div>
  )
}

// ─── Summary helpers ──────────────────────────────────────────────────────────

function SumLine({ label, value }) {
  return (
    <div style={{ display: 'flex', gap: 8 }}>
      <span style={{ fontWeight: 600, color: 'var(--text-3)', minWidth: 60 }}>{label}</span>
      <span style={{ color: 'var(--text-1)' }}>{value}</span>
    </div>
  )
}

function sourceLabel(sourceOption, filteredTargets, cohortResult) {
  if (sourceOption === 'cohort_inline') {
    return cohortResult ? `${cohortResult.scanCount.toLocaleString()} scans (new cohort)` : '—'
  }
  if (sourceOption === 'cohort_saved') {
    return filteredTargets.length > 0 ? `${filteredTargets.length.toLocaleString()} slides (saved cohort)` : '—'
  }
  return filteredTargets.length > 0 ? `${filteredTargets.length} slides (manual list)` : '—'
}

// ─── Main modal ───────────────────────────────────────────────────────────────

const STEPS = ['Type', 'Classes', 'Source', 'Details']

export default function CreateProjectModal({ onClose, onCreated, cohorts }) {
  const [step, setStep] = useState(0)

  const [projectType, setProjectType] = useState(null)
  const [classes,     setClasses]     = useState([])
  const [name,        setName]        = useState('')
  const [description, setDesc]        = useState('')

  // Source state — owned here, passed down to SourceStep / SlideSourceSelector
  const [sourceOption,    setSourceOption]    = useState('cohort_inline')
  const [filteredTargets, setFilteredTargets] = useState([])
  const [cohortResult,    setCohortResult]    = useState(null)

  const [creating, setCreating] = useState(false)
  const [error,    setError]    = useState('')

  function canNext() {
    if (step === 0) return !!projectType
    if (step === 1) return true
    if (step === 2) {
      if (sourceOption === 'cohort_inline') return cohortResult !== null
      return filteredTargets.length > 0
    }
    if (step === 3) return name.trim().length > 0
    return false
  }

  async function handleCreate() {
    setCreating(true)
    setError('')
    try {
      const trimmedName = name.trim()

      if (sourceOption === 'cohort_inline') {
        const { queryPayload } = cohortResult
        const filter_json = { ...queryPayload, return_level: 'scan' }
        const savedCohort = await api.saveCohort({
          name:        trimmedName,
          description: description.trim() || undefined,
          filter_json,
        })
        const result = await api.createProject({
          name:         trimmedName,
          description:  description.trim() || undefined,
          project_type: projectType,
          classes,
          source_type:  'cohort',
          cohort_id:    savedCohort.id,
        })
        onCreated(result)
      } else {
        // cohort_saved or manual — both resolve to a flat file_path list
        const fd = new FormData()
        fd.append('name',         trimmedName)
        fd.append('project_type', projectType)
        fd.append('classes',      JSON.stringify(classes))
        if (description.trim()) fd.append('description', description.trim())
        const fileLines = filteredTargets.map(t => t.file_path)
        const blob = new Blob([fileLines.join('\n')], { type: 'text/plain' })
        fd.append('file', blob, 'slides.txt')
        const result = await api.createProjectFromFile(fd)
        onCreated(result)
      }
    } catch (e) {
      setError(e.message || 'Failed to create project')
    } finally {
      setCreating(false)
    }
  }

  return (
    <Modal
      isOpen={true}
      onClose={onClose}
      title="New project"
      subtitle="Create an annotation project from a cohort or a slide list."
      width={600}
    >
      <Modal.Body style={{ padding: '24px 28px' }}>
        <Steps current={step} steps={STEPS} />

        {/* Step 0 – type */}
        {step === 0 && (
          <div>
            <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--navy)', marginBottom: 14 }}>
              What type of project is this?
            </div>
            <div style={{ display: 'flex', gap: 12 }}>
              <TypeCard
                selected={projectType === 'cell_detection'}
                onClick={() => setProjectType('cell_detection')}
                icon={<CellDetectionIcon size={40} />}
                title="Cell detection"
                description="Place point annotations on individual cells or nuclei. Exports as CSV with coordinates and class."
              />
              <TypeCard
                selected={projectType === 'region_annotation'}
                onClick={() => setProjectType('region_annotation')}
                icon={<RegionAnnotationIcon size={40} />}
                title="Region annotation"
                description="Draw polygons, rectangles, or brush strokes to label tissue regions."
              />
            </div>
          </div>
        )}

        {/* Step 1 – classes */}
        {step === 1 && (
          <ClassesStep classes={classes} onClasses={setClasses} />
        )}

        {/* Step 2 – source */}
        {step === 2 && (
          <SourceStep
            sourceOption={sourceOption}   onSourceOption={setSourceOption}
            cohorts={cohorts}
            filteredTargets={filteredTargets} onTargetsResolved={setFilteredTargets}
            cohortResult={cohortResult}       onCohortResult={setCohortResult}
          />
        )}

        {/* Step 3 – details + summary */}
        {step === 3 && (
          <div>
            <FormField label="Project name" style={{ marginBottom: 14 }}>
              <FormInput
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="e.g. CRC Cohort 2024"
                autoFocus
              />
            </FormField>

            {sourceOption === 'cohort_inline' && name.trim() && (
              <div style={{
                marginBottom: 14, padding: '8px 12px',
                background: 'var(--teal-10)', border: '1px solid rgba(27,153,139,0.2)',
                borderRadius: 'var(--radius-md)', fontSize: 12, color: 'var(--teal)',
                display: 'flex', alignItems: 'center', gap: 6,
              }}>
                <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                  <path d="M8 16A8 8 0 108 0a8 8 0 000 16zm.93-9.412l-1 4.705c-.07.34.029.533.304.533.194 0 .487-.07.686-.246l-.088.416c-.287.346-.92.598-1.465.598-.703 0-1.002-.422-.808-1.319l.738-3.468c.064-.293.006-.399-.287-.47l-.451-.081.082-.381 2.29-.287zM8 5.5a1 1 0 110-2 1 1 0 010 2z" />
                </svg>
                A cohort named <strong style={{ marginLeft: 3 }}>&ldquo;{name.trim()}&rdquo;</strong> will be saved automatically.
              </div>
            )}

            <FormField label="Description (optional)" style={{ marginBottom: 14 }}>
              <FormInput
                value={description}
                onChange={e => setDesc(e.target.value)}
                placeholder="Optional description…"
              />
            </FormField>

            {/* Summary */}
            <div style={{
              background: 'var(--navy-05)', borderRadius: 'var(--radius-lg)',
              padding: '12px 14px', fontSize: 12, color: 'var(--text-2)',
              display: 'flex', flexDirection: 'column', gap: 5,
            }}>
              <SumLine label="Type"    value={projectType === 'cell_detection' ? 'Cell detection' : 'Region annotation'} />
              <SumLine label="Classes" value={classes.length > 0 ? classes.map(c => c.name).join(', ') : 'None defined'} />
              <SumLine label="Source"  value={sourceLabel(sourceOption, filteredTargets, cohortResult)} />
            </div>
          </div>
        )}

        <ErrorMsg message={error} style={{ marginTop: 12 }} />
      </Modal.Body>

      <Modal.Footer>
        <Btn variant="ghost" onClick={onClose}>Cancel</Btn>
        <div style={{ display: 'flex', gap: 8 }}>
          {step > 0 && (
            <Btn variant="ghost" onClick={() => setStep(s => s - 1)}>← Back</Btn>
          )}
          {step < STEPS.length - 1 ? (
            <Btn variant="primary" onClick={() => setStep(s => s + 1)} disabled={!canNext()}>
              Next →
            </Btn>
          ) : (
            <Btn variant="primary" onClick={handleCreate} disabled={!canNext() || creating}>
              {creating ? 'Creating…' : 'Create project'}
            </Btn>
          )}
        </div>
      </Modal.Footer>
    </Modal>
  )
}