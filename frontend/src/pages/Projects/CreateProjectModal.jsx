// frontend/src/pages/Projects/CreateProjectModal.jsx
import { useState, useRef } from 'react'
import { api } from '../../api'
import { Modal, Btn, FormLabel, FormInput, FormField } from '../../components/ui'
import SlideTargetManager from '../../components/SlideTargetManager'
import { PATHOLOGY_PALETTE } from '../../constants/stains' 

function genId() {
  return Math.random().toString(36).slice(2, 10)
}

// ─── Step indicators ──────────────────────────────────────────────────────────
function Steps({ current, steps }) {
  return (
    <div style={{ display:'flex', alignItems:'center', gap:0, marginBottom:28 }}>
      {steps.map((label, i) => (
        <div key={i} style={{ display:'flex', alignItems:'center', flex: i < steps.length-1 ? 1 : 'unset' }}>
          <div style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:4 }}>
            <div style={{
              width:28, height:28, borderRadius:'50%',
              display:'flex', alignItems:'center', justifyContent:'center',
              fontSize:12, fontWeight:700,
              background: i < current ? 'var(--teal)' : i === current ? 'var(--navy)' : 'var(--navy-10)',
              color: i <= current ? 'var(--white)' : 'var(--text-3)',
              transition: 'var(--transition-base)',
            }}>
              {i < current
                ? <svg width="12" height="12" viewBox="0 0 16 16" fill="white"><path d="M13.854 3.646a.5.5 0 010 .708l-7 7a.5.5 0 01-.708 0l-3.5-3.5a.5.5 0 11.708-.708L6.5 10.293l6.646-6.647a.5.5 0 01.708 0z"/></svg>
                : i + 1
              }
            </div>
            <span style={{ fontSize:10, color: i===current ? 'var(--navy)' : 'var(--text-3)', fontWeight: i===current ? 600 : 400, whiteSpace:'nowrap' }}>
              {label}
            </span>
          </div>
          {i < steps.length - 1 && (
            <div style={{ flex:1, height:2, background: i < current ? 'var(--teal)' : 'var(--border)', margin:'0 8px', marginBottom:20, transition:'background 0.2s' }} />
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
      flex:1, padding:'20px 16px', borderRadius:'var(--radius-xl)', cursor:'pointer', textAlign:'left',
      border: `2px solid ${selected ? 'var(--navy)' : 'var(--border)'}`,
      background: selected ? 'var(--navy-05)' : 'var(--white)',
      transition:'var(--transition-base)',
      fontFamily: 'var(--font-sans)',
    }}>
      <div style={{ fontSize:32, marginBottom:10 }}>{icon}</div>
      <div style={{ fontSize:14, fontWeight:700, color:'var(--navy)', marginBottom:6 }}>{title}</div>
      <div style={{ fontSize:12, color:'var(--text-3)', lineHeight:1.5 }}>{description}</div>
      {selected && (
        <div style={{ marginTop:10, display:'inline-flex', alignItems:'center', gap:4, fontSize:11, fontWeight:600, color:'var(--navy)', background:'var(--navy-10)', padding:'3px 10px', borderRadius:'var(--radius-full)' }}>
          <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor"><path d="M13.854 3.646a.5.5 0 010 .708l-7 7a.5.5 0 01-.708 0l-3.5-3.5a.5.5 0 11.708-.708L6.5 10.293l6.646-6.647a.5.5 0 01.708 0z"/></svg>
          Selected
        </div>
      )}
    </button>
  )
}

// ─── Class editor ─────────────────────────────────────────────────────────────
function ClassEditor({ classes, setClasses }) {
  const [newName,  setNewName]  = useState('')
  const [newColor, setNewColor] = useState(PATHOLOGY_PALETTE[0])

  function addCls() {
    const name = newName.trim()
    if (!name) return
    setClasses(prev => [...prev, { id: genId(), name, color: newColor }])
    setNewName('')
    setNewColor(PATHOLOGY_PALETTE[(classes.length + 1) % PATHOLOGY_PALETTE.length])
  }

  function removeCls(id)          { setClasses(prev => prev.filter(c => c.id !== id)) }
  function updateColor(id, color) { setClasses(prev => prev.map(c => c.id === id ? { ...c, color } : c)) }
  function updateName(id, name)   { setClasses(prev => prev.map(c => c.id === id ? { ...c, name }  : c)) }

  return (
    <div>
      <div style={{ display:'flex', flexDirection:'column', gap:6, marginBottom:12 }}>
        {classes.map(cls => (
          <div key={cls.id} style={{
            display:'flex', alignItems:'center', gap:8, padding:'8px 10px',
            borderRadius:'var(--radius-md)', border:'1px solid var(--border-l)', background:'var(--navy-05)',
          }}>
            <div style={{ position:'relative' }}>
              <div
                style={{ width:22, height:22, borderRadius:5, background:cls.color, border:'1px solid rgba(0,0,0,0.1)', cursor:'pointer', flexShrink:0 }}
                onClick={() => document.getElementById(`cp-${cls.id}`)?.click()}
              />
              <input id={`cp-${cls.id}`} type="color" value={cls.color}
                onChange={e => updateColor(cls.id, e.target.value)}
                style={{ position:'absolute', opacity:0, width:0, height:0, pointerEvents:'none' }}
              />
            </div>
            <input
              value={cls.name}
              onChange={e => updateName(cls.id, e.target.value)}
              style={{ flex:1, border:'1px solid var(--border)', borderRadius:'var(--radius-sm)', padding:'4px 8px', fontSize:13, outline:'none', fontFamily:'var(--font-sans)' }}
            />
            <button onClick={() => removeCls(cls.id)}
              style={{ background:'none', border:'none', cursor:'pointer', color:'var(--crimson)', fontSize:16, lineHeight:1, padding:'0 4px' }}>
              ×
            </button>
          </div>
        ))}
      </div>

      {/* Add new class */}
      <div style={{ display:'flex', gap:8, alignItems:'center' }}>
        <div style={{ position:'relative', flexShrink:0 }}>
          <div
            style={{ width:32, height:32, borderRadius:'var(--radius-md)', background:newColor, border:'2px solid var(--border)', cursor:'pointer' }}
            onClick={() => document.getElementById('cp-new')?.click()}
          />
          <input id="cp-new" type="color" value={newColor}
            onChange={e => setNewColor(e.target.value)}
            style={{ position:'absolute', opacity:0, width:0, height:0, pointerEvents:'none' }}
          />
        </div>
        <FormInput
          value={newName}
          onChange={e => setNewName(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addCls() } }}
          placeholder="Class name (e.g. Tumor, Stroma…)"
        />
        <Btn variant="primary" onClick={addCls} disabled={!newName.trim()}>
          Add
        </Btn>
      </div>

      {/* Preset palette */}
      <div style={{ display:'flex', flexWrap:'wrap', gap:6, marginTop:10 }}>
        {PATHOLOGY_PALETTE.map(c => (
          <div key={c} onClick={() => setNewColor(c)}
            style={{ width:18, height:18, borderRadius:'var(--radius-sm)', background:c, cursor:'pointer', border: newColor===c ? '2px solid var(--navy)' : '2px solid transparent', flexShrink:0 }}
          />
        ))}
      </div>
    </div>
  )
}

// ─── Source step — receives all needed state as props (no parent-scope closure) ─
function SourceStep({ cohorts, filteredTargets, onTargetsResolved }) {
  return (
    <div>
      <div style={{ fontWeight:600, fontSize:14, color:'var(--navy)', marginBottom:14 }}>
        Select slide source
      </div>
      <SlideTargetManager
        cohorts={cohorts}
        onTargetsResolved={onTargetsResolved}
      />
      {filteredTargets.length > 0 && (
        <div style={{ marginTop:12, fontSize:12, color:'var(--teal)', fontWeight:500 }}>
          ✓ {filteredTargets.length} slide{filteredTargets.length !== 1 ? 's' : ''} ready
        </div>
      )}
    </div>
  )
}

// ─── Main modal ───────────────────────────────────────────────────────────────
const STEPS = ['Type', 'Classes', 'Source', 'Details']

export default function CreateProjectModal({ onClose, onCreated, cohorts }) {
  const [step, setStep] = useState(0)

  const [projectType,      setProjectType]      = useState(null)
  const [classes,          setClasses]           = useState([])
  const [name,             setName]              = useState('')
  const [description,      setDesc]              = useState('')
  const [filteredTargets,  setFilteredTargets]   = useState([])
  const [creating,         setCreating]          = useState(false)
  const [error,            setError]             = useState('')

  function canNext() {
    if (step === 0) return !!projectType
    if (step === 1) return true
    if (step === 2) return filteredTargets.length > 0
    if (step === 3) return name.trim().length > 0
    return false
  }

  async function handleCreate() {
    setCreating(true)
    setError('')
    try {
      const fd = new FormData()
      fd.append('name',         name.trim())
      fd.append('project_type', projectType)
      fd.append('classes',      JSON.stringify(classes))
      if (description.trim()) fd.append('description', description.trim())

      const fileLines = filteredTargets.map(t => t.file_path)
      const blob = new Blob([fileLines.join('\n')], { type:'text/plain' })
      fd.append('file', blob, 'slides.txt')

      const result = await api.createProjectFromFile(fd)
      onCreated(result)
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
      width={580}
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
                icon="🔬"
                title="Cell detection"
                description="Place point annotations on individual cells or nuclei. Exports as CSV with coordinates and class."
              />
              <TypeCard
                selected={projectType === 'region_annotation'}
                onClick={() => setProjectType('region_annotation')}
                icon="🗺️"
                title="Region annotation"
                description="Draw polygons, rectangles, ellipses or brush strokes over tissue regions. Exports as QuPath-compatible GeoJSON."
              />
            </div>
          </div>
        )}

        {/* Step 1 – classes */}
        {step === 1 && (
          <div>
            <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--navy)', marginBottom: 4 }}>
              Define annotation classes
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 16 }}>
              Classes can be edited later. Each annotation will be assigned exactly one class.
            </div>
            <ClassEditor classes={classes} setClasses={setClasses} />
            {classes.length === 0 && (
              <div style={{ marginTop: 12, padding: '10px 12px', borderRadius: 'var(--radius-md)', background: 'var(--warning-bg)', border: '1px solid #e8c84a', fontSize: 12, color: 'var(--warning)' }}>
                You can proceed without classes and add them later, but you won't be able to assign labels while annotating.
              </div>
            )}
          </div>
        )}

        {/* Step 2 – source */}
        {step === 2 && (
          <SourceStep
            cohorts={cohorts}
            filteredTargets={filteredTargets}
            onTargetsResolved={setFilteredTargets}
          />
        )}

        {/* Step 3 – details */}
        {step === 3 && (
          <div>
            <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--navy)', marginBottom: 14 }}>Name your project</div>
            <FormField label="Project name *" style={{ marginBottom: 14 }}>
              <FormInput
                autoFocus
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="e.g. Cohort Name"
              />
            </FormField>
            <FormField label="Description (optional)" style={{ marginBottom: 14 }}>
              <FormInput
                value={description}
                onChange={e => setDesc(e.target.value)}
                placeholder="Optional description…"
              />
            </FormField>
            {/* Summary */}
            <div style={{ background: 'var(--navy-05)', borderRadius: 'var(--radius-lg)', padding: '12px 14px', fontSize: 12, color: 'var(--text-2)', display: 'flex', flexDirection: 'column', gap: 5 }}>
              <SumLine label="Type"    value={projectType === 'cell_detection' ? '🔬 Cell detection' : '🗺️ Region annotation'} />
              <SumLine label="Classes" value={classes.length > 0 ? classes.map(c => c.name).join(', ') : 'None defined'} />
              <SumLine label="Source"  value={`${filteredTargets.length} fully filtered slides`} />
            </div>
          </div>
        )}

        {error && (
          <div style={{ marginTop: 12, padding: '10px 12px', borderRadius: 'var(--radius-md)', background: 'var(--crimson-10)', border: '1px solid var(--crimson)', fontSize: 12, color: 'var(--crimson)' }}>
            {error}
          </div>
        )}
      </Modal.Body>

      {/* Footer */}
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

function SumLine({ label, value }) {
  return (
    <div style={{ display:'flex', gap:8 }}>
      <span style={{ fontWeight:600, color:'var(--text-3)', minWidth:60 }}>{label}</span>
      <span style={{ color:'var(--text-1)' }}>{value}</span>
    </div>
  )
}