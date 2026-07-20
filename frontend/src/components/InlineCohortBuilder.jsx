/**
 * InlineCohortBuilder
 * ===================
 * Used exclusively in step 3 of CreateProjectModal when the user chooses
 * "Build cohort" as the slide source.
 *
 * Responsibilities:
 *  - Renders CohortFilterForm (scan-level locked, compact)
 *  - Runs the cohort query and displays a scan count + topography summary
 *  - Calls onResult({ scanCount, queryPayload }) whenever a valid result
 *    arrives so the parent wizard knows whether to enable "Next"
 *
 * Props
 * -----
 * onResult   ({ scanCount: number, queryPayload: object } | null) => void
 */

import { useState, useCallback } from 'react'
import CohortFilterForm, { EMPTY_FILTER, EMPTY_LIST_STATE, buildQueryPayload } from './CohortFilterForm'
import { Spinner } from './ui'
import { api } from '../api'

// ─── Mini result card ─────────────────────────────────────────────────────────

function ResultCard({ result }) {
  if (!result) return null

  const rows   = result.results || []
  const count  = rows.length

  // Topography breakdown (top 5)
  const topoCounts = {}
  rows.forEach(r => { if (r.topo_description) topoCounts[r.topo_description] = (topoCounts[r.topo_description] || 0) + 1 })
  const topEntries = Object.entries(topoCounts).sort((a, b) => b[1] - a[1]).slice(0, 5)
  const maxCount   = topEntries[0]?.[1] ?? 1

  // Stain breakdown (top 5)
  const stainCounts = {}
  rows.forEach(r => { if (r.stain_name) stainCounts[r.stain_name] = (stainCounts[r.stain_name] || 0) + 1 })
  const stainEntries = Object.entries(stainCounts).sort((a, b) => b[1] - a[1]).slice(0, 5)
  const maxStain     = stainEntries[0]?.[1] ?? 1

  if (count === 0) {
    return (
      <div style={{
        marginTop: 16,
        padding: '12px 14px',
        background: 'var(--warning-bg)',
        border: '1px solid var(--amber)',
        borderRadius: 'var(--radius-md)',
        fontSize: 13,
        color: 'var(--warning)',
      }}>
        No scans matched the current filters. Adjust your criteria and run again.
      </div>
    )
  }

  return (
    <div style={{
      marginTop: 16,
      padding: '14px 16px',
      background: 'var(--teal-10)',
      border: '1px solid var(--transparent-teal-3)',
      borderRadius: 'var(--radius-lg)',
    }}>
      {/* Headline count */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 14 }}>
        <span style={{ fontFamily: 'var(--font-serif)', fontSize: 32, color: 'var(--teal)', lineHeight: 1 }}>
          {count.toLocaleString()}
        </span>
        <span style={{ fontSize: 13, color: 'var(--teal)', fontWeight: 500 }}>
          scan{count !== 1 ? 's' : ''} matched
        </span>
        <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--teal)', opacity: 0.7 }}>
          {new Set(rows.map(r => r.patient_code)).size} patients
        </span>
      </div>

      {/* Breakdowns */}
      {(topEntries.length > 0 || stainEntries.length > 0) && (
        <div style={{ display: 'grid', gridTemplateColumns: stainEntries.length ? '1fr 1fr' : '1fr', gap: 16 }}>
          {topEntries.length > 0 && (
            <div>
              <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--teal)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
                Topographies
              </div>
              {topEntries.map(([label, n]) => (
                <MiniBar key={label} label={label} count={n} max={maxCount} color="var(--teal)" />
              ))}
            </div>
          )}
          {stainEntries.length > 0 && (
            <div>
              <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--teal)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
                Stains
              </div>
              {stainEntries.map(([label, n]) => (
                <MiniBar key={label} label={label} count={n} max={maxStain} color="var(--teal)" />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function MiniBar({ label, count, max, color }) {
  const pct = max > 0 ? Math.round((count / max) * 100) : 0
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, marginBottom: 4 }}>
      <div style={{ width: 110, color: 'var(--text-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flexShrink: 0 }} title={label}>
        {label}
      </div>
      <div style={{ flex: 1, background: 'var(--transparent-teal-1)', borderRadius: 3, overflow: 'hidden', height: 7 }}>
        <div style={{ width: `${pct}%`, height: '100%', borderRadius: 3, background: color, opacity: 0.6 }} />
      </div>
      <div style={{ width: 28, textAlign: 'right', color: 'var(--text-3)', fontFamily: 'var(--font-mono)', fontSize: 10 }}>
        {count}
      </div>
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function InlineCohortBuilder({ onResult }) {
  const [mode,      setMode]      = useState('filter')
  const [filter,    setFilter]    = useState({ ...EMPTY_FILTER, return_level: 'scan' })
  const [listState, setListState] = useState({ ...EMPTY_LIST_STATE, listLevel: 'scan' })
  const [loading,   setLoading]   = useState(false)
  const [result,    setResult]    = useState(null)
  const [error,     setError]     = useState('')

  // Patch a single key in filter
  const handleFilterChange = useCallback((key, val) => {
    setFilter(prev => ({ ...prev, [key]: val === '' ? null : val }))
    // Clear stale result when filters change
    setResult(null)
    onResult(null)
  }, [onResult])

  // Patch a single key in listState (handles nested listFilter too)
  const handleListStateChange = useCallback((key, val) => {
    setListState(prev => ({ ...prev, [key]: val }))
    setResult(null)
    onResult(null)
  }, [onResult])

  const handleModeChange = useCallback(newMode => {
    setMode(newMode)
    setResult(null)
    onResult(null)
    setError('')
  }, [onResult])

  async function runQuery() {
    setLoading(true)
    setError('')
    setResult(null)
    onResult(null)

    try {
      const { type, payload } = buildQueryPayload(mode, filter, listState)
      // Force scan level — always, for project creation
      const scanPayload = { ...payload, return_level: 'scan' }

      let res
      if (type === 'filter') {
        res = await api.queryCohort(scanPayload)
      } else {
        res = await api.queryList(scanPayload)
      }

      setResult(res)

      const count = res.results?.length ?? 0
      if (count > 0) {
        onResult({
          scanCount:    count,
          queryPayload: scanPayload,
          queryType:    type,
        })
      } else {
        onResult(null)
      }
    } catch (e) {
      setError(e.message || 'Query failed')
      onResult(null)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div>
      {/* Compact filter form — no outer Panel, return level locked to scan */}
      <CohortFilterForm
        mode={mode}
        onModeChange={handleModeChange}
        filter={filter}
        onFilterChange={handleFilterChange}
        listState={listState}
        onListStateChange={handleListStateChange}
        onRun={runQuery}
        loading={loading}
        lockReturnLevel
        compact
        runLabel="Preview matching scans"
        hideRunButton={false}
      />

      {/* Inline error */}
      {error && (
        <div style={{
          marginTop: 12,
          padding: '8px 12px',
          background: 'var(--crimson-10)',
          border: '1px solid var(--crimson)',
          borderRadius: 'var(--radius-md)',
          fontSize: 12,
          color: 'var(--crimson)',
        }}>
          {error}
        </div>
      )}

      {/* Loading indicator */}
      {loading && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 14 }}>
          <Spinner size={18} />
          <span style={{ fontSize: 12, color: 'var(--text-3)' }}>Running query…</span>
        </div>
      )}

      {/* Result card */}
      {!loading && <ResultCard result={result} />}
    </div>
  )
}