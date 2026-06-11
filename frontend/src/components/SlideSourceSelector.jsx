/**
 * SlideSourceSelector
 * ===================
 * Shared "where do the slides come from?" UI used in:
 *   - BatchAnalysis (panel 2 — Target Slides)
 *   - CreateProjectModal (step 3 — Source)
 *
 * Renders three option cards identical to the Project creation flow.
 * Each card reveals its own inline content when selected.
 *
 * Props
 * -----
 * sourceOption        'cohort_inline' | 'cohort_saved' | 'manual'
 * onSourceOption      (key) => void
 * cohorts             Cohort[]     — list of saved cohorts from GET /cohorts
 * filteredTargets     ScanTarget[] — resolved scan list (for saved/manual modes)
 * onTargetsResolved   (ScanTarget[]) => void
 * cohortResult        { scanCount, queryPayload } | null  — inline builder result
 * onCohortResult      (result | null) => void
 *
 * ScanTarget shape: { scan_id, block_id, file_path, stain, stain_category }
 */

import { useState } from 'react'
import InlineCohortBuilder from './InlineCohortBuilder'
import { api } from '../api'
import { Btn, FormField, Spinner } from './ui'

// ─── Line-art icons (same as CreateProjectModal) ──────────────────────────────

export function SearchIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" width="18" height="18">
      <path d="M11.742 10.344a6.5 6.5 0 10-1.397 1.398h-.001c.03.04.062.078.098.115l3.85 3.85a1 1 0 001.415-1.414l-3.85-3.85a1.007 1.007 0 00-.115-.099zM12 6.5a5.5 5.5 0 11-11 0 5.5 5.5 0 0111 0z" />
    </svg>
  )
}

export function FolderIcon() {
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

export function ListIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" width="18" height="18" xmlns="http://www.w3.org/2000/svg">
      <rect x="1.5" y="1.5" width="13" height="13" rx="2" stroke="currentColor" strokeWidth="1.25" />
      <line x1="4" y1="5.5"  x2="12" y2="5.5"  stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
      <line x1="4" y1="8"    x2="12" y2="8"    stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
      <line x1="4" y1="10.5" x2="9"  y2="10.5" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
    </svg>
  )
}

// ─── Option card ──────────────────────────────────────────────────────────────

export function SourceOptionCard({ selected, onClick, iconComponent, title, description }) {
  return (
    <button
      onClick={onClick}
      style={{
        width: '100%', padding: '14px 16px',
        borderRadius: 'var(--radius-xl)',
        cursor: 'pointer', textAlign: 'left',
        display: 'flex', alignItems: 'flex-start', gap: 14,
        border: `2px solid ${selected ? 'var(--navy)' : 'var(--border)'}`,
        background: selected ? 'var(--navy-05)' : 'var(--white)',
        transition: 'var(--transition-base)',
        fontFamily: 'var(--font-sans)',
      }}
    >
      {/* Icon box */}
      <div style={{
        width: 34, height: 34, flexShrink: 0,
        borderRadius: 'var(--radius-md)',
        background: selected ? 'var(--navy)' : 'var(--navy-05)',
        border: `1px solid ${selected ? 'var(--navy-80)' : 'var(--navy-10)'}`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: selected ? 'var(--white)' : 'var(--navy)',
        transition: 'var(--transition-base)',
      }}>
        {iconComponent}
      </div>

      <div style={{ flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--navy)' }}>{title}</span>
          {selected && (
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: 3,
              fontSize: 10, fontWeight: 600, color: 'var(--navy)',
              background: 'var(--navy-10)', padding: '2px 8px',
              borderRadius: 'var(--radius-full)',
            }}>
              <svg width="9" height="9" viewBox="0 0 16 16" fill="currentColor">
                <path d="M13.854 3.646a.5.5 0 010 .708l-7 7a.5.5 0 01-.708 0l-3.5-3.5a.5.5 0 11.708-.708L6.5 10.293l6.646-6.647a.5.5 0 01.708 0z" />
              </svg>
              Selected
            </span>
          )}
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-3)', lineHeight: 1.5 }}>{description}</div>
      </div>
    </button>
  )
}

// ─── Option definitions ───────────────────────────────────────────────────────
// descriptions are overridable via the `descriptions` prop so BatchAnalysis
// can swap the cohort_inline line without forking the card component.

const DEFAULT_DESCRIPTIONS = {
  cohort_inline: 'Filter or query the database on the spot. A cohort is saved automatically.',
  cohort_saved:  'Load from an existing saved cohort.',
  manual:        'Provide file paths or filenames manually. Best for custom, one-off selections.',
}

const SOURCE_OPTIONS = [
  { key: 'cohort_inline', icon: <SearchIcon />, title: 'Build a cohort' },
  { key: 'cohort_saved',  icon: <FolderIcon />, title: 'Saved cohort'   },
  { key: 'manual',        icon: <ListIcon />,   title: 'Paste slide list' },
]

// ─── Main component ───────────────────────────────────────────────────────────

export default function SlideSourceSelector({
  sourceOption,
  onSourceOption,
  cohorts = [],
  filteredTargets = [],
  onTargetsResolved,
  cohortResult,
  onCohortResult,
  descriptions = {},
  // requiredStains: forwarded from the model's stain_compatibility list.
  // Used to show a compatibility warning on matched slides.
  requiredStains = [],
  // Optional label shown below the cohort_inline builder when cohortResult is set.
  // Defaults to the generic "N scans ready" message. Pass null to suppress.
  cohortReadyLabel,
}) {
  // ── Saved-cohort local state ───────────────────────────────────────────────
  const [selectedCohortId, setSelectedCohortId] = useState('')
  const [loadingCohort,    setLoadingCohort]    = useState(false)
  const [cohortError,      setCohortError]      = useState('')

  // ── Manual paste local state ───────────────────────────────────────────────
  const [rawInput,     setRawInput]     = useState('')
  const [validating,   setValidating]   = useState(false)
  const [matchError,   setMatchError]   = useState('')
  const [matchResults, setMatchResults] = useState(null)

  // ── Switch option — reset all derived state ────────────────────────────────
  function handleOptionSelect(key) {
    onSourceOption(key)
    setSelectedCohortId('')
    setRawInput('')
    setMatchResults(null)
    setMatchError('')
    setCohortError('')
    onTargetsResolved([])
    onCohortResult(null)
  }

  // ── Saved cohort: load on select ──────────────────────────────────────────
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
        scan_id:        r.scan_id,
        block_id:       r.block_id,
        file_path:      r.file_path,
        stain:          r.stain_name || 'Unknown',
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

  // ── Manual paste: validate filenames against the DB ───────────────────────
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
        scan_id:        r.scan_id,
        block_id:       r.block_id,
        file_path:      r.file_path,
        stain:          r.stain || 'Unknown',
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

  const mergedDescriptions = { ...DEFAULT_DESCRIPTIONS, ...descriptions }

  // ── Default ready label for inline cohort ─────────────────────────────────
  const defaultReadyLabel = cohortResult
    ? `✓ ${cohortResult.scanCount.toLocaleString()} scans ready`
    : null
  const readyLabel = cohortReadyLabel !== undefined ? cohortReadyLabel : defaultReadyLabel

  return (
    <div>
      {/* Option cards */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 20 }}>
        {SOURCE_OPTIONS.map(opt => (
          <SourceOptionCard
            key={opt.key}
            selected={sourceOption === opt.key}
            onClick={() => handleOptionSelect(opt.key)}
            iconComponent={opt.icon}
            title={opt.title}
            description={mergedDescriptions[opt.key]}
          />
        ))}
      </div>

      {/* ── Inline content, revealed below the selected card ── */}

      {sourceOption === 'cohort_inline' && (
        <div style={{ borderTop: '1px solid var(--border-l)', paddingTop: 20 }}>
          <InlineCohortBuilder onResult={onCohortResult} />
          {cohortResult && readyLabel && (
            <div style={{ marginTop: 10, fontSize: 12, color: 'var(--teal)', fontWeight: 500 }}>
              {readyLabel}
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
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, fontSize: 12, color: 'var(--text-3)' }}>
                  <Spinner size={14} /> Loading cohort scans…
                </div>
              )}
              {cohortError && (
                <div style={{ marginTop: 8, fontSize: 12, color: 'var(--crimson)', background: 'var(--crimson-10)', padding: '8px 10px', borderRadius: 'var(--radius-md)' }}>
                  {cohortError}
                </div>
              )}
              {filteredTargets.length > 0 && !loadingCohort && (
                <div style={{ marginTop: 10, fontSize: 12, color: 'var(--teal)', fontWeight: 500 }}>
                  ✓ {filteredTargets.length.toLocaleString()} slide{filteredTargets.length !== 1 ? 's' : ''} loaded
                </div>
              )}
            </>
          )}
        </div>
      )}

      {sourceOption === 'manual' && (
        <div style={{ borderTop: '1px solid var(--border-l)', paddingTop: 20 }}>
          <FormField label="Slide paths or filenames (one per line)">
            <textarea
              rows={5}
              placeholder={'slide_001.svs\n/path/to/slide_002.ndpi'}
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
                fontSize: 12,
                resize: 'vertical',
                boxSizing: 'border-box',
              }}
            />
          </FormField>

          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
            <Btn
              variant="primary"
              small
              onClick={handleValidateManual}
              disabled={validating || !rawInput.trim()}
            >
              {validating ? 'Validating…' : 'Validate slides'}
            </Btn>
          </div>

          {matchError && (
            <div style={{ marginTop: 8, fontSize: 12, color: 'var(--crimson)', background: 'var(--crimson-10)', padding: '8px 10px', borderRadius: 'var(--radius-md)' }}>
              {matchError}
            </div>
          )}

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
                  {matchResults.matched.length > 50 && (
                    <div>…and {matchResults.matched.length - 50} more</div>
                  )}
                </div>
              </div>
              <div style={{ padding: 10, borderRadius: 6, background: 'rgba(220,38,38,0.05)', border: '1px solid rgba(220,38,38,0.2)' }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--crimson)', marginBottom: 5 }}>
                  ❌ Not found ({matchResults.unmatched?.length ?? 0})
                </div>
                <div style={{ maxHeight: 80, overflowY: 'auto', fontSize: 11, color: 'var(--text-2)', fontFamily: 'var(--font-mono)' }}>
                  {matchResults.unmatched?.slice(0, 50).map((u, i) => (
                    <div key={i}>{u}</div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {filteredTargets.length > 0 && !validating && (() => {
            const mismatchCount = requiredStains.length > 0
              ? filteredTargets.filter(m => !requiredStains.includes(m.stain_category)).length
              : 0
            return (
              <>
                <div style={{ marginTop: 8, fontSize: 12, color: 'var(--teal)', fontWeight: 500 }}>
                  ✓ {filteredTargets.length} slide{filteredTargets.length !== 1 ? 's' : ''} ready
                </div>
                {mismatchCount > 0 && (
                  <div style={{ marginTop: 6, fontSize: 11, color: '#b45309', background: '#fffbeb', padding: '6px 10px', borderRadius: 'var(--radius-md)', border: '1px solid #fcd34d' }}>
                    ⚠ {mismatchCount} slide{mismatchCount !== 1 ? 's' : ''} may not match the required stain ({requiredStains.join(', ')}).
                  </div>
                )}
              </>
            )
          })()}
        </div>
      )}
    </div>
  )
}