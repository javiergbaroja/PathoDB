import { useState, useRef } from 'react'
import { api } from '../../api'
import { Modal, Btn, FormInput, FormField, ErrorMsg } from '../../components/ui'
import InlineCohortBuilder from '../../components/InlineCohortBuilder'
import { PATHOLOGY_PALETTE } from '../../constants/stains'

function genId() {
  return Math.random().toString(36).slice(2, 10)
}

// ─── Brand-aligned custom SVG icons ───────────────────────────────────────────

// Cell Detection icon: organic (slightly irregular) cell outline in navy,
// with a teal nucleus inside — no fill on cell body, solid teal nucleus
function CellDetectionIcon({ size = 48 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
      {/* Organic cell outline — irregular path, not a perfect circle */}
      <path
        d="M24 6 C30 5, 37 8, 40 15 C43 21, 42 29, 38 34 C34 39, 28 43, 22 42 C16 41, 10 37, 8 31 C5 24, 7 16, 12 11 C16 7, 19 7, 24 6 Z"
        stroke="var(--navy)"
        strokeWidth="2"
        fill="none"
        strokeLinejoin="round"
      />
      {/* Teal nucleus — slightly off-center, organic shape */}
      <path
        d="M24 18 C27 17.5, 30 19, 31 22 C32 25, 30.5 28, 27.5 29 C24.5 30, 21 28.5, 20 26 C18.5 23, 20 18.5, 24 18 Z"
        fill="var(--teal)"
        opacity="0.9"
      />
    </svg>
  )
}

// Region Annotation icon: lasso/polygon shape — irregular closed loop
// with dashed stroke, angular with some organic variation
function RegionAnnotationIcon({ size = 48 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
      {/* Lasso/polygon path — closed, irregular, angular-organic hybrid */}
      <path
        d="M12 14 L20 9 L32 11 L40 19 L38 30 L29 38 L18 37 L9 28 L10 20 Z"
        stroke="var(--navy)"
        strokeWidth="2"
        fill="none"
        strokeDasharray="3.5 2.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      {/* Small closing dot to hint "lasso close" */}
      <circle cx="10.5" cy="14.5" r="1.5" fill="var(--navy)" opacity="0.7" />
    </svg>
  )
}

// Source icons — line art, matching dashboard icon aesthetic:
// centered in a small box, navy stroke, no fill

// Magnifying glass (reuses dashboard design language)
function SearchIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" width="18" height="18">
      <path d="M11.742 10.344a6.5 6.5 0 10-1.397 1.398h-.001c.03.04.062.078.098.115l3.85 3.85a1 1 0 001.415-1.414l-3.85-3.85a1.007 1.007 0 00-.115-.099zM12 6.5a5.5 5.5 0 11-11 0 5.5 5.5 0 0111 0z" />
    </svg>
  )
}

// Folder icon — custom line art, open folder with document tab
function FolderIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" width="18" height="18" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M1.5 3.5 C1.5 2.948 1.948 2.5 2.5 2.5 L5.5 2.5 L7 4 L13.5 4 C14.052 4 14.5 4.448 14.5 5 L14.5 12.5 C14.5 13.052 14.052 13.5 13.5 13.5 L2.5 13.5 C1.948 13.5 1.5 13.052 1.5 12.5 Z"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinejoin="round"
      />
    </svg>
  )
}

// List/lines icon — rectangle with rounded horizontal lines inside
function ListIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" width="18" height="18" xmlns="http://www.w3.org/2000/svg">
      <rect x="1.5" y="1.5" width="13" height="13" rx="2" stroke="currentColor" strokeWidth="1.25" />
      <line x1="4" y1="5.5" x2="12" y2="5.5" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
      <line x1="4" y1="8" x2="12" y2="8" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
      <line x1="4" y1="10.5" x2="9" y2="10.5" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
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

// ─── Type card — redesigned with custom SVG icons ─────────────────────────────

function TypeCard({ selected, onClick, icon, title, description }) {
  return (
    <button onClick={onClick} style={{
      flex: 1, padding: '20px 16px', borderRadius: 'var(--radius-xl)', cursor: 'pointer', textAlign: 'left',
      border: `2px solid ${selected ? 'var(--navy)' : 'var(--border)'}`,
      background: selected ? 'var(--navy-05)' : 'var(--white)',
      transition: 'var(--transition-base)',
      fontFamily: 'var(--font-sans)',
    }}>
      {/* Icon container — neutral background, icon centred */}
      <div style={{
        width: 52, height: 52,
        borderRadius: 'var(--radius-lg)',
        background: selected ? 'var(--white)' : 'var(--navy-05)',
        border: `1px solid ${selected ? 'var(--navy-20)' : 'var(--border-l)'}`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        marginBottom: 12,
        transition: 'var(--transition-base)',
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

// ─── Source option card ───────────────────────────────────────────────────────
// Matches dashboard quick-action card style: icon in a small box,
// title + description, no emoji, line-art SVG icons

function SourceOptionCard({ selected, onClick, iconComponent, title, description, badge }) {
  return (
    <button onClick={onClick} style={{
      width: '100%', padding: '14px 16px', borderRadius: 'var(--radius-xl)',
      cursor: 'pointer', textAlign: 'left', display: 'flex', alignItems: 'flex-start', gap: 14,
      border: `2px solid ${selected ? 'var(--navy)' : 'var(--border)'}`,
      background: selected ? 'var(--navy-05)' : 'var(--white)',
      transition: 'var(--transition-base)',
      fontFamily: 'var(--font-sans)',
    }}>
      {/* Icon box — same size/style as dashboard quick-action cards */}
      <div style={{
        width: 34, height: 34, flexShrink: 0,
        borderRadius: 'var(--radius-md)',
        background: selected ? 'var(--navy)' : 'var(--navy-05)',
        border: `1px solid ${selected ? 'var(--navy-80)' : 'var(--navy-10)'}`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: selected ? 'var(--white)' : 'var(--navy-60)',
        transition: 'var(--transition-base)',
      }}>
        {iconComponent}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--navy)' }}>{title}</span>
          {badge && (
            <span style={{
              fontSize: 9, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase',
              color: 'var(--teal)', border: '1px solid rgba(27,153,139,0.3)',
              padding: '2px 6px', borderRadius: 'var(--radius-full)',
            }}>
              {badge}
            </span>
          )}
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-3)', lineHeight: 1.5 }}>{description}</div>
      </div>
      {selected && (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="var(--navy)" style={{ flexShrink: 0, marginTop: 2 }}>
          <path d="M13.854 3.646a.5.5 0 010 .708l-7 7a.5.5 0 01-.708 0l-3.5-3.5a.5.5 0 11.708-.708L6.5 10.293l6.646-6.647a.5.5 0 01.708 0z" />
        </svg>
      )}
    </button>
  )
}

// ─── Class editor ─────────────────────────────────────────────────────────────

function ClassEditor({ classes, setClasses }) {
  const [newName, setNewName]   = useState('')
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
  function updateName(id, name)   { setClasses(prev => prev.map(c => c.id === id ? { ...c, name } : c)) }

  return (
    <div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
        {classes.map(cls => (
          <div key={cls.id} style={{
            display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px',
            borderRadius: 'var(--radius-md)', border: '1px solid var(--border-l)', background: 'var(--navy-05)',
          }}>
            <div style={{ position: 'relative' }}>
              <div
                style={{ width: 22, height: 22, borderRadius: 5, background: cls.color, border: '1px solid rgba(0,0,0,0.1)', cursor: 'pointer', flexShrink: 0 }}
                onClick={() => document.getElementById(`cp-${cls.id}`)?.click()}
              />
              <input id={`cp-${cls.id}`} type="color" value={cls.color}
                onChange={e => updateColor(cls.id, e.target.value)}
                style={{ position: 'absolute', opacity: 0, width: 0, height: 0, pointerEvents: 'none' }}
              />
            </div>
            <input
              value={cls.name}
              onChange={e => updateName(cls.id, e.target.value)}
              style={{ flex: 1, border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', padding: '4px 8px', fontSize: 13, outline: 'none', fontFamily: 'var(--font-sans)' }}
            />
            <button onClick={() => removeCls(cls.id)}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--crimson)', fontSize: 16, lineHeight: 1, padding: '0 4px' }}>
              ×
            </button>
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <div style={{ position: 'relative', flexShrink: 0 }}>
          <div
            style={{ width: 32, height: 32, borderRadius: 'var(--radius-md)', background: newColor, border: '2px solid var(--border)', cursor: 'pointer' }}
            onClick={() => document.getElementById('cp-new')?.click()}
          />
          <input id="cp-new" type="color" value={newColor}
            onChange={e => setNewColor(e.target.value)}
            style={{ position: 'absolute', opacity: 0, width: 0, height: 0, pointerEvents: 'none' }}
          />
        </div>
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
// Three option cards. Each card, when selected, reveals only its own input
// inline — no SlideTargetManager duplication.

const SOURCE_OPTIONS = [
  {
    key:         'cohort_inline',
    icon:        <SearchIcon />,
    title:       'Build a cohort',
    description: 'Filter or query the database on the spot. A cohort is saved automatically with the project name.',
  },
  {
    key:         'cohort_saved',
    icon:        <FolderIcon />,
    title:       'Saved cohort',
    description: 'Load from an existing saved cohort. The project stays linked and can be refreshed later.',
  },
  {
    key:         'manual',
    icon:        <ListIcon />,
    title:       'Paste slide list',
    description: 'Provide file paths or filenames manually. Best for custom, one-off selections.',
  },
]

function SourceStep({
  sourceOption, onSourceOption,
  cohorts, filteredTargets, onTargetsResolved,
  cohortResult, onCohortResult,
}) {
  // Saved cohort state — local to this step
  const [selectedCohortId, setSelectedCohortId] = useState('')
  const [loadingCohort, setLoadingCohort]       = useState(false)
  const [cohortError, setCohortError]           = useState('')

  // Manual paste state
  const [rawInput, setRawInput] = useState('')
  const [validating, setValidating] = useState(false)
  const [matchError, setMatchError] = useState('')
  const [matchResults, setMatchResults] = useState(null)

  async function handleLoadCohort(cohortId) {
    if (!cohortId) return
    setSelectedCohortId(cohortId)
    setLoadingCohort(true)
    setCohortError('')
    onTargetsResolved([])
    try {
      const cohort = cohorts.find(c => c.id === parseInt(cohortId))
      if (!cohort) throw new Error('Cohort not found')
      const queryPayload = { ...cohort.filter_json, return_level: 'scan' }
      const data = await api.queryCohort(queryPayload)
      const matched = data.results.map(r => ({
        scan_id:    r.scan_id,
        block_id:   r.block_id,
        file_path:  r.file_path,
        stain:      r.stain_name || 'Unknown',
        stain_category: r.stain_category,
      }))
      onTargetsResolved(matched)
    } catch (e) {
      setCohortError(e.message || 'Failed to load cohort scans.')
      onTargetsResolved([])
    } finally {
      setLoadingCohort(false)
    }
  }

  async function handleValidateManual() {
    const queries = rawInput.split('\n').map(s => s.trim()).filter(Boolean)
    if (queries.length === 0) {
      setMatchError('Please enter at least one slide path or filename.')
      return
    }
    setValidating(true)
    setMatchError('')
    setMatchResults(null)
    onTargetsResolved([])
    try {
      const data = await api.matchSlides(queries)
      const matched = data.matched.map(r => ({
        scan_id:    r.scan_id,
        block_id:   r.block_id,
        file_path:  r.file_path,
        stain:      r.stain || 'Unknown',
        stain_category: r.stain_category,
      }))
      setMatchResults({ matched, unmatched: data.unmatched })
      onTargetsResolved(matched)
    } catch (e) {
      setMatchError(e.message || 'Failed to validate slides.')
    } finally {
      setValidating(false)
    }
  }

  function handleOptionSelect(key) {
    onSourceOption(key)
    // Reset derived state when switching
    setSelectedCohortId('')
    setRawInput('')
    setMatchResults(null)
    setMatchError('')
    setCohortError('')
    onTargetsResolved([])
    onCohortResult(null)
  }

  return (
    <div>
      <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--navy)', marginBottom: 14 }}>
        Where do the slides come from?
      </div>

      {/* Option cards */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 20 }}>
        {SOURCE_OPTIONS.map(opt => (
          <SourceOptionCard
            key={opt.key}
            selected={sourceOption === opt.key}
            onClick={() => handleOptionSelect(opt.key)}
            iconComponent={opt.icon}
            title={opt.title}
            description={opt.description}
            badge={opt.badge}
          />
        ))}
      </div>

      {/* ── Inline content for the selected option ── */}
      {sourceOption === 'cohort_inline' && (
        <div style={{ borderTop: '1px solid var(--border-l)', paddingTop: 20 }}>
          <InlineCohortBuilder onResult={onCohortResult} />
          {cohortResult && (
            <div style={{ marginTop: 10, fontSize: 12, color: 'var(--teal)', fontWeight: 500 }}>
              ✓ {cohortResult.scanCount.toLocaleString()} scans ready — filters will be saved as a cohort named after this project
            </div>
          )}
        </div>
      )}

      {sourceOption === 'cohort_saved' && (
        <div style={{ borderTop: '1px solid var(--border-l)', paddingTop: 20 }}>
          {cohorts.length === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--text-3)', padding: '12px 0' }}>
              No saved cohorts yet. Create one in the Cohort Builder first.
            </div>
          ) : (
            <>
              <FormField label="Select a saved cohort">
                <select
                  value={selectedCohortId}
                  onChange={e => handleLoadCohort(e.target.value)}
                  disabled={loadingCohort}
                  style={{
                    width: '100%', padding: '10px 12px',
                    borderRadius: 'var(--radius-md)',
                    border: '1px solid var(--border)',
                    fontSize: 'var(--text-base)',
                    fontFamily: 'var(--font-sans)',
                    color: 'var(--text-1)',
                    background: 'var(--white)',
                    outline: 'none',
                  }}
                >
                  <option value="" disabled>— Select a cohort —</option>
                  {cohorts.map(c => (
                    <option key={c.id} value={c.id}>
                      {c.name} ({c.result_count?.toLocaleString() ?? '?'} items)
                    </option>
                  ))}
                </select>
              </FormField>

              {loadingCohort && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--text-3)', marginTop: 8 }}>
                  <div style={{ width: 14, height: 14, border: '2px solid var(--navy-20)', borderTopColor: 'var(--navy)', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
                  Loading cohort scans…
                </div>
              )}
              {cohortError && <ErrorMsg message={cohortError} style={{ marginTop: 8 }} />}
              {filteredTargets.length > 0 && !loadingCohort && (
                <div style={{ marginTop: 8, fontSize: 12, color: 'var(--teal)', fontWeight: 500 }}>
                  ✓ {filteredTargets.length.toLocaleString()} slides ready
                </div>
              )}
            </>
          )}
        </div>
      )}

      {sourceOption === 'manual' && (
        <div style={{ borderTop: '1px solid var(--border-l)', paddingTop: 20 }}>
          <FormField label="Paste slide paths or filenames (one per line)">
            <textarea
              rows={5}
              placeholder={'slide_001.svs\n/path/to/slide_002.ndpi\nslide_003.mrxs'}
              value={rawInput}
              onChange={e => {
                setRawInput(e.target.value)
                setMatchResults(null)
                onTargetsResolved([])
              }}
              style={{
                width: '100%', padding: 10,
                borderRadius: 'var(--radius-md)',
                border: '1px solid var(--border)',
                fontFamily: 'var(--font-mono)',
                fontSize: 13, resize: 'vertical',
                outline: 'none',
                color: 'var(--text-1)',
              }}
            />
          </FormField>

          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 4 }}>
            <Btn
              variant="primary" small
              onClick={handleValidateManual}
              disabled={validating || !rawInput.trim()}
            >
              {validating ? 'Validating…' : 'Validate slides'}
            </Btn>
          </div>

          {matchError && <ErrorMsg message={matchError} style={{ marginTop: 8 }} />}

          {matchResults && !validating && (
            <div style={{ marginTop: 12, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <div style={{ padding: 10, borderRadius: 6, background: 'rgba(27,153,139,0.05)', border: '1px solid rgba(27,153,139,0.2)' }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--teal)', marginBottom: 5 }}>
                  ✅ Matched ({matchResults.matched.length})
                </div>
                <div style={{ maxHeight: 80, overflowY: 'auto', fontSize: 11, color: 'var(--text-2)', fontFamily: 'var(--font-mono)' }}>
                  {matchResults.matched.slice(0, 50).map(m => (
                    <div key={m.scan_id}>{m.file_path.split('/').pop()}</div>
                  ))}
                  {matchResults.matched.length > 50 && <div>…and {matchResults.matched.length - 50} more</div>}
                </div>
              </div>
              <div style={{ padding: 10, borderRadius: 6, background: 'rgba(220,38,38,0.05)', border: '1px solid rgba(220,38,38,0.2)' }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--crimson)', marginBottom: 5 }}>
                  ❌ Not found ({matchResults.unmatched?.length ?? 0})
                </div>
                <div style={{ maxHeight: 80, overflowY: 'auto', fontSize: 11, color: 'var(--text-2)', fontFamily: 'var(--font-mono)' }}>
                  {matchResults.unmatched?.slice(0, 50).map((u, i) => <div key={i}>{u}</div>)}
                </div>
              </div>
            </div>
          )}

          {filteredTargets.length > 0 && !validating && (
            <div style={{ marginTop: 8, fontSize: 12, color: 'var(--teal)', fontWeight: 500 }}>
              ✓ {filteredTargets.length} slide{filteredTargets.length !== 1 ? 's' : ''} ready
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Summary line helper ──────────────────────────────────────────────────────

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

  const [projectType,      setProjectType]      = useState(null)
  const [classes,          setClasses]           = useState([])
  const [name,             setName]              = useState('')
  const [description,      setDesc]              = useState('')

  // Source state
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

        {/* Step 0 – project type */}
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
              <ErrorMsg
                message="You can proceed without classes and add them later, but you won't be able to assign labels while annotating."
                style={{ marginTop: 12, background: 'var(--warning-bg)', borderColor: '#e8c84a', color: 'var(--warning)' }}
              />
            )}
          </div>
        )}

        {/* Step 2 – source */}
        {step === 2 && (
          <SourceStep
            sourceOption={sourceOption}
            onSourceOption={setSourceOption}
            cohorts={cohorts}
            filteredTargets={filteredTargets}
            onTargetsResolved={setFilteredTargets}
            cohortResult={cohortResult}
            onCohortResult={setCohortResult}
          />
        )}

        {/* Step 3 – details */}
        {step === 3 && (
          <div>
            <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--navy)', marginBottom: 14 }}>
              Name your project
            </div>
            <FormField label="Project name *" style={{ marginBottom: 14 }}>
              <FormInput
                autoFocus
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="e.g. CRC Cohort 2024"
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
              <SumLine
                label="Type"
                value={projectType === 'cell_detection' ? 'Cell detection' : 'Region annotation'}
              />
              <SumLine label="Classes" value={classes.length > 0 ? classes.map(c => c.name).join(', ') : 'None defined'} />
              <SumLine label="Source"  value={sourceLabel(sourceOption, filteredTargets, cohortResult)} />
            </div>
          </div>
        )}

        <ErrorMsg message={error} style={{ marginTop: 12 }} />
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