// frontend/src/pages/Projects/CreateProjectModal.jsx
import { useState, useRef } from 'react'
import { api } from '../../api'

const PRESET_COLORS = [
  '#ef4444','#f97316','#eab308','#22c55e',
  '#14b8a6','#3b82f6','#8b5cf6','#ec4899',
  '#6ee7b7','#fbbf24','#60a5fa','#f472b6',
]

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
              background: i < current ? 'var(--success)' : i === current ? 'var(--navy)' : 'var(--navy-10)',
              color: i <= current ? 'white' : 'var(--text-3)',
              transition: 'all 0.2s',
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
            <div style={{ flex:1, height:2, background: i < current ? 'var(--success)' : 'var(--border)', margin:'0 8px', marginBottom:20, transition:'background 0.2s' }} />
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
      flex:1, padding:'20px 16px', borderRadius:10, cursor:'pointer', textAlign:'left',
      border: `2px solid ${selected ? 'var(--navy)' : 'var(--border)'}`,
      background: selected ? 'var(--navy-05)' : 'white',
      transition:'all 0.15s',
    }}>
      <div style={{ fontSize:32, marginBottom:10 }}>{icon}</div>
      <div style={{ fontSize:14, fontWeight:700, color:'var(--navy)', marginBottom:6 }}>{title}</div>
      <div style={{ fontSize:12, color:'var(--text-3)', lineHeight:1.5 }}>{description}</div>
      {selected && (
        <div style={{ marginTop:10, display:'inline-flex', alignItems:'center', gap:4, fontSize:11, fontWeight:600, color:'var(--navy)', background:'var(--navy-10)', padding:'3px 10px', borderRadius:20 }}>
          <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor"><path d="M13.854 3.646a.5.5 0 010 .708l-7 7a.5.5 0 01-.708 0l-3.5-3.5a.5.5 0 11.708-.708L6.5 10.293l6.646-6.647a.5.5 0 01.708 0z"/></svg>
          Selected
        </div>
      )}
    </button>
  )
}

// ─── Class editor ─────────────────────────────────────────────────────────────
function ClassEditor({ classes, setClasses }) {
  const [newName, setNewName]   = useState('')
  const [newColor, setNewColor] = useState(PRESET_COLORS[0])

  function addCls() {
    const name = newName.trim()
    if (!name) return
    setClasses(prev => [...prev, { id: genId(), name, color: newColor }])
    setNewName('')
    setNewColor(PRESET_COLORS[(classes.length + 1) % PRESET_COLORS.length])
  }

  function removeCls(id) { setClasses(prev => prev.filter(c => c.id !== id)) }

  function updateColor(id, color) {
    setClasses(prev => prev.map(c => c.id === id ? { ...c, color } : c))
  }

  function updateName(id, name) {
    setClasses(prev => prev.map(c => c.id === id ? { ...c, name } : c))
  }

  return (
    <div>
      <div style={{ display:'flex', flexDirection:'column', gap:6, marginBottom:12 }}>
        {classes.map(cls => (
          <div key={cls.id} style={{
            display:'flex', alignItems:'center', gap:8,
            padding:'8px 10px', borderRadius:6,
            border:'1px solid var(--border-l)', background:'var(--navy-05)',
          }}>
            {/* Color swatch + picker */}
            <div style={{ position:'relative' }}>
              <div style={{ width:22, height:22, borderRadius:5, background:cls.color, border:'1px solid rgba(0,0,0,0.1)', cursor:'pointer', flexShrink:0 }}
                onClick={() => document.getElementById(`cp-${cls.id}`)?.click()} />
              <input id={`cp-${cls.id}`} type="color" value={cls.color}
                onChange={e => updateColor(cls.id, e.target.value)}
                style={{ position:'absolute', opacity:0, width:0, height:0, pointerEvents:'none' }} />
            </div>
            <input
              value={cls.name}
              onChange={e => updateName(cls.id, e.target.value)}
              style={{ flex:1, border:'1px solid var(--border)', borderRadius:5, padding:'4px 8px', fontSize:13, outline:'none', fontFamily:'var(--font-sans)' }}
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
          <div style={{ width:32, height:32, borderRadius:6, background:newColor, border:'2px solid var(--border)', cursor:'pointer' }}
            onClick={() => document.getElementById('cp-new')?.click()} />
          <input id="cp-new" type="color" value={newColor}
            onChange={e => setNewColor(e.target.value)}
            style={{ position:'absolute', opacity:0, width:0, height:0, pointerEvents:'none' }} />
        </div>
        <input
          value={newName}
          onChange={e => setNewName(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addCls() } }}
          placeholder="Class name (e.g. Tumor, Stroma…)"
          style={{ flex:1, border:'1px solid var(--border)', borderRadius:6, padding:'7px 10px', fontSize:13, outline:'none', fontFamily:'var(--font-sans)' }}
        />
        <button onClick={addCls} disabled={!newName.trim()} style={{
          padding:'7px 14px', borderRadius:6, border:'none', cursor: newName.trim() ? 'pointer' : 'not-allowed',
          background: newName.trim() ? 'var(--navy)' : 'var(--navy-10)', color: newName.trim() ? 'white' : 'var(--text-3)',
          fontSize:13, fontFamily:'var(--font-sans)', fontWeight:500, flexShrink:0,
        }}>
          Add
        </button>
      </div>

      {/* Preset palette */}
      <div style={{ display:'flex', flexWrap:'wrap', gap:6, marginTop:10 }}>
        {PRESET_COLORS.map(c => (
          <div key={c} onClick={() => setNewColor(c)}
            style={{ width:18, height:18, borderRadius:4, background:c, cursor:'pointer', border: newColor===c ? '2px solid var(--navy)' : '2px solid transparent', flexShrink:0 }} />
        ))}
      </div>
    </div>
  )
}

// ─── Source selector ──────────────────────────────────────────────────────────
function SourceStep({ sourceType, setSourceType, cohortId, setCohortId, cohorts, fileLines, setFileLines }) {
  const fileRef = useRef(null)

  async function handleFile(e) {
    const f = e.target.files?.[0]
    if (!f) return
    const text = await f.text()
    setFileLines(text.split('\n').filter(l => l.trim()))
  }

  return (
    <div style={{ display:'flex', flexDirection:'column', gap:16 }}>
      <div style={{ display:'flex', gap:10 }}>
        {[
          { id:'cohort',      label:'From saved cohort', desc:'Slides stay in sync as the cohort grows.', icon:'🗂️' },
          { id:'file_import', label:'From file list',    desc:'Upload a .txt file with one slide path per line.', icon:'📄' },
        ].map(opt => (
          <button key={opt.id} onClick={() => setSourceType(opt.id)} style={{
            flex:1, padding:'16px 14px', borderRadius:8, cursor:'pointer', textAlign:'left',
            border:`2px solid ${sourceType===opt.id ? 'var(--navy)' : 'var(--border)'}`,
            background: sourceType===opt.id ? 'var(--navy-05)' : 'white',
            transition:'all 0.15s',
          }}>
            <div style={{ fontSize:22, marginBottom:6 }}>{opt.icon}</div>
            <div style={{ fontSize:13, fontWeight:600, color:'var(--navy)', marginBottom:3 }}>{opt.label}</div>
            <div style={{ fontSize:11, color:'var(--text-3)' }}>{opt.desc}</div>
          </button>
        ))}
      </div>

      {sourceType === 'cohort' && (
        <div>
          <label style={lbl}>Select cohort</label>
          <select value={cohortId || ''} onChange={e => setCohortId(Number(e.target.value) || null)} style={inp}>
            <option value="">— choose —</option>
            {(cohorts || []).map(c => (
              <option key={c.id} value={c.id}>{c.name} ({c.result_count ?? '?'} results)</option>
            ))}
          </select>
          {cohortId && (
            <div style={{ marginTop:6, fontSize:11, color:'var(--text-3)' }}>
              Slides will be fetched from this cohort and stay in sync automatically.
            </div>
          )}
        </div>
      )}

      {sourceType === 'file_import' && (
        <div>
          <label style={lbl}>Upload slide list (.txt)</label>
          <input ref={fileRef} type="file" accept=".txt" onChange={handleFile}
            style={{ display:'none' }} id="slide-list-upload" />
          <div style={{ display:'flex', gap:8, alignItems:'center' }}>
            <button onClick={() => fileRef.current?.click()} style={{
              padding:'7px 14px', borderRadius:6, border:'1px solid var(--border)',
              background:'white', cursor:'pointer', fontSize:13, fontFamily:'var(--font-sans)',
            }}>
              Choose file
            </button>
            {fileLines.length > 0 && (
              <span style={{ fontSize:12, color:'var(--success)', fontWeight:500 }}>
                ✓ {fileLines.length} paths loaded
              </span>
            )}
          </div>
          {fileLines.length > 0 && (
            <div style={{ marginTop:8, maxHeight:80, overflowY:'auto', background:'var(--navy-05)', borderRadius:6, padding:'6px 10px', fontFamily:'var(--font-mono)', fontSize:11, color:'var(--text-2)' }}>
              {fileLines.slice(0, 5).map((l,i) => <div key={i}>{l}</div>)}
              {fileLines.length > 5 && <div style={{ color:'var(--text-3)' }}>…and {fileLines.length - 5} more</div>}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Main modal ───────────────────────────────────────────────────────────────
const STEPS = ['Type', 'Classes', 'Source', 'Details']

export default function CreateProjectModal({ onClose, onCreated, cohorts }) {
  const [step, setStep] = useState(0)

  // Step 0 – type
  const [projectType, setProjectType] = useState(null)

  // Step 1 – classes
  const [classes, setClasses] = useState([])

  // Step 2 – source
  const [sourceType, setSourceType] = useState('cohort')
  const [cohortId, setCohortId]     = useState(null)
  const [fileLines, setFileLines]   = useState([])
  const fileRef = useRef(null)

  // Step 3 – details
  const [name, setName]         = useState('')
  const [description, setDesc]  = useState('')

  const [creating, setCreating] = useState(false)
  const [error, setError]       = useState('')

  function canNext() {
    if (step === 0) return !!projectType
    if (step === 1) return true  // classes are optional
    if (step === 2) return sourceType === 'cohort' ? !!cohortId : fileLines.length > 0
    if (step === 3) return name.trim().length > 0
    return false
  }

  async function handleCreate() {
    setCreating(true)
    setError('')
    try {
      let result
      if (sourceType === 'cohort') {
        result = await api.createProject({
          name: name.trim(),
          description: description.trim() || undefined,
          project_type: projectType,
          classes,
          source_type: 'cohort',
          cohort_id: cohortId,
        })
      } else {
        // file import uses FormData
        const fd = new FormData()
        fd.append('name', name.trim())
        fd.append('project_type', projectType)
        fd.append('classes', JSON.stringify(classes))
        if (description.trim()) fd.append('description', description.trim())
        const blob = new Blob([fileLines.join('\n')], { type:'text/plain' })
        fd.append('file', blob, 'slides.txt')
        result = await api.createProjectFromFile(fd)
      }
      onCreated(result)
    } catch (e) {
      setError(e.message || 'Failed to create project')
    } finally {
      setCreating(false)
    }
  }

  return (
    <div onClick={onClose} style={{
      position:'fixed', inset:0, background:'rgba(0,20,100,0.35)',
      display:'flex', alignItems:'center', justifyContent:'center', zIndex:200,
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background:'white', borderRadius:16, width:580,
        maxHeight:'90vh', overflow:'hidden', display:'flex', flexDirection:'column',
        boxShadow:'0 16px 48px rgba(0,20,100,0.2)',
      }}>
        {/* Header */}
        <div style={{ padding:'24px 28px 20px', borderBottom:'1px solid var(--border-l)', flexShrink:0 }}>
          <div style={{ fontFamily:'var(--font-serif)', fontSize:22, color:'var(--navy)', marginBottom:4 }}>
            New project
          </div>
          <div style={{ fontSize:12, color:'var(--text-3)' }}>
            Create an annotation project from a cohort or a slide list.
          </div>
        </div>

        {/* Body */}
        <div style={{ flex:1, overflowY:'auto', padding:'24px 28px' }}>
          <Steps current={step} steps={STEPS} />

          {/* Step 0 – type */}
          {step === 0 && (
            <div>
              <div style={{ fontWeight:600, fontSize:14, color:'var(--navy)', marginBottom:14 }}>
                What type of project is this?
              </div>
              <div style={{ display:'flex', gap:12 }}>
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
              <div style={{ fontWeight:600, fontSize:14, color:'var(--navy)', marginBottom:4 }}>
                Define annotation classes
              </div>
              <div style={{ fontSize:12, color:'var(--text-3)', marginBottom:16 }}>
                Classes can be edited later. Each annotation will be assigned exactly one class.
              </div>
              <ClassEditor classes={classes} setClasses={setClasses} />
              {classes.length === 0 && (
                <div style={{ marginTop:12, padding:'10px 12px', borderRadius:6, background:'var(--warning-bg)', border:'1px solid #e8c84a', fontSize:12, color:'var(--warning)' }}>
                  You can proceed without classes and add them later, but you won't be able to assign labels while annotating.
                </div>
              )}
            </div>
          )}

          {/* Step 2 – source */}
          {step === 2 && (
            <div>
              <div style={{ fontWeight:600, fontSize:14, color:'var(--navy)', marginBottom:14 }}>
                Select slide source
              </div>
              <SourceStep
                sourceType={sourceType} setSourceType={setSourceType}
                cohortId={cohortId} setCohortId={setCohortId}
                cohorts={cohorts}
                fileLines={fileLines} setFileLines={setFileLines}
              />
            </div>
          )}

          {/* Step 3 – details */}
          {step === 3 && (
            <div>
              <div style={{ fontWeight:600, fontSize:14, color:'var(--navy)', marginBottom:14 }}>
                Name your project
              </div>
              <div style={{ marginBottom:14 }}>
                <label style={lbl}>Project name *</label>
                <input autoFocus value={name} onChange={e => setName(e.target.value)}
                  placeholder="e.g. CRC Tumor Grading Q1 2025"
                  style={inp} />
              </div>
              <div style={{ marginBottom:14 }}>
                <label style={lbl}>Description (optional)</label>
                <textarea value={description} onChange={e => setDesc(e.target.value)}
                  placeholder="Briefly describe the annotation goals…"
                  rows={3}
                  style={{ ...inp, resize:'vertical' }} />
              </div>

              {/* Summary */}
              <div style={{ background:'var(--navy-05)', borderRadius:8, padding:'12px 14px', fontSize:12, color:'var(--text-2)', display:'flex', flexDirection:'column', gap:5 }}>
                <SumLine label="Type"    value={projectType === 'cell_detection' ? '🔬 Cell detection' : '🗺️ Region annotation'} />
                <SumLine label="Classes" value={classes.length > 0 ? classes.map(c=>c.name).join(', ') : 'None defined'} />
                <SumLine label="Source"  value={sourceType === 'cohort' ? `Cohort #${cohortId}` : `${fileLines.length} slides from file`} />
              </div>
            </div>
          )}

          {error && (
            <div style={{ marginTop:12, padding:'10px 12px', borderRadius:6, background:'var(--crimson-10)', border:'1px solid var(--crimson)', fontSize:12, color:'var(--crimson)' }}>
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{ padding:'16px 28px', borderTop:'1px solid var(--border-l)', display:'flex', justifyContent:'space-between', flexShrink:0 }}>
          <button onClick={onClose} style={ghostBtn}>Cancel</button>
          <div style={{ display:'flex', gap:8 }}>
            {step > 0 && (
              <button onClick={() => setStep(s => s-1)} style={ghostBtn}>← Back</button>
            )}
            {step < STEPS.length - 1 ? (
              <button onClick={() => setStep(s => s+1)} disabled={!canNext()} style={{
                ...primaryBtn,
                opacity: canNext() ? 1 : 0.4,
                cursor: canNext() ? 'pointer' : 'not-allowed',
              }}>
                Next →
              </button>
            ) : (
              <button onClick={handleCreate} disabled={!canNext() || creating} style={{
                ...primaryBtn,
                opacity: (canNext() && !creating) ? 1 : 0.4,
                cursor: (canNext() && !creating) ? 'pointer' : 'not-allowed',
              }}>
                {creating ? 'Creating…' : 'Create project'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
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

const lbl = { display:'block', fontSize:11, fontWeight:600, color:'var(--text-3)', textTransform:'uppercase', letterSpacing:'0.06em', marginBottom:6 }
const inp = { width:'100%', padding:'8px 10px', border:'1px solid var(--border)', borderRadius:6, fontSize:13, outline:'none', fontFamily:'var(--font-sans)', background:'white' }
const ghostBtn = { padding:'8px 16px', borderRadius:6, border:'1px solid var(--border)', background:'white', cursor:'pointer', fontSize:13, fontFamily:'var(--font-sans)', color:'var(--text-2)' }
const primaryBtn = { padding:'8px 20px', borderRadius:6, border:'none', background:'var(--navy)', color:'white', cursor:'pointer', fontSize:13, fontFamily:'var(--font-sans)', fontWeight:500 }