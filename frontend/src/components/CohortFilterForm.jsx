/**
 * CohortFilterForm
 * ================
 * Self-contained cohort filter/list-mode UI extracted from Cohorts.jsx.
 * Consumed by:
 *   - Cohorts.jsx  (full page, all features)
 *   - InlineCohortBuilder.jsx  (step 3 of CreateProjectModal)
 *
 * Props
 * -----
 * mode              'filter' | 'list'
 * onModeChange      (mode) => void
 * filter            object  — filter-mode state (EMPTY_FILTER shape)
 * onFilterChange    (key, val) => void
 * listState         object  — { idType, bScope, idText, listLevel, listFilter }
 * onListStateChange (key, val) => void
 * onRun             () => void   — called when user clicks Run
 * loading           bool
 * lockReturnLevel   bool  — when true, hides return-level selector and forces 'scan'
 *                           (used by the project builder)
 * compact           bool  — tighter padding, no outer Panel wrapper
 */

import { useRef } from 'react'
import {
  Btn, Panel,
  FormInput, FormSelect, FormField, FormTextarea,
  SegmentedControl, MultiSelect,
} from './ui'
import { api } from '../api'

// ─── Constants (exported so Cohorts.jsx can import them) ─────────────────────

export const EMPTY_FILTER = {
  snomed_topo_codes:       [],
  topo_description_search: [],
  snomed_morph_codes:           [],
  morph_description_search:    [],
  snomed_etio_codes:        [],
  etio_description_search: [],
  stain_names:             [],
  stain_categories:        [],
  submission_types:        [],
  file_formats:            [],
  magnification_min:       null,
  magnification_max:       null,
  submission_date_from:    '',
  submission_date_to:      '',
  malignancy_flag:         null,
  consent_statuses:        [],
  has_scan:                null,
  block_info_search:       '',
  return_level:            'scan',
}

export const EMPTY_LIST_STATE = {
  idType:      'patient_code',
  bScope:      'all',
  idText:      '',
  listLevel:   'scan',
  listFilter: {
    snomed_topo_codes:       [],
    topo_description_search: [],
    submission_types:        [],
    malignancy_flag:         null,
    consent_statuses:        [],
    has_scan:                null,
    block_info_search:       '',
    submission_date_from:    '',
    submission_date_to:      '',
    stain_names:             [],
    stain_categories:        [],
    file_formats:            [],
    magnification_min:       null,
    magnification_max:       null,
    snomed_morph_codes:           [],
    morph_description_search:    [],
    snomed_etio_codes:        [],
    etio_description_search: [],
  },
}

const CONSENT_OPTS = [
  { value: 'consented', label: 'Consented' },
  { value: 'informed',  label: 'Informed' },
  { value: 'refused',   label: 'Refused' },
  { value: 'unknown',   label: 'Unknown / empty' },
]

// ─── Utilities ────────────────────────────────────────────────────────────────

export function cleanFilter(f) {
  return Object.fromEntries(
    Object.entries(f).filter(([, v]) => {
      if (v === '' || v === null) return false
      if (Array.isArray(v) && v.length === 0) return false
      return true
    })
  )
}

export function buildQueryPayload(mode, filter, listState) {
  if (mode === 'filter') {
    return { type: 'filter', payload: cleanFilter(filter) }
  }
  const { idType, bScope, idText, listLevel, listFilter } = listState
  const ids = idText.split('\n').map(s => s.trim()).filter(Boolean)
  return {
    type: 'list',
    payload: {
      is_list_query: true,
      id_type:       idType,
      b_scope:       bScope,
      ids,
      return_level:  listLevel,
      ...cleanFilter(listFilter),
    },
  }
}

// ─── Internal section label ───────────────────────────────────────────────────

function SectionLabel({ children }) {
  return (
    <div style={{
      fontSize: 10, fontWeight: 600, color: 'var(--text-3)',
      textTransform: 'uppercase', letterSpacing: '0.06em',
      marginTop: 14, marginBottom: 6,
      display: 'flex', alignItems: 'center', gap: 8,
    }}>
      {children}
      <div style={{ flex: 1, height: 1, background: 'var(--border-l)' }} />
    </div>
  )
}

// ─── Filter mode form ─────────────────────────────────────────────────────────

function FilterModeForm({ filter, onFilterChange, lockReturnLevel }) {
  const isScanLevel = filter.return_level === 'scan'

  const RETURN_LEVEL_OPTS = ['patient', 'submission', 'probe', 'block', 'scan']
    .map(v => [v, v.charAt(0).toUpperCase() + v.slice(1)])
  const HAS_SCAN_OPTS    = [['', 'Any'], ['true', 'Has scan'], ['false', 'No scan']]
  const MALIGNANCY_OPTS  = [['', 'Any'], ['true', 'Positive'], ['false', 'Negative']]

  return (
    <>
      <SectionLabel>Anatomy &amp; Tissue</SectionLabel>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <MultiSelect
          label="Topography description"
          selected={filter.topo_description_search}
          onChange={val => onFilterChange('topo_description_search', val)}
          loadOptions={val => api.lookup('topo_description', val)}
          placeholder="e.g. Colon, Lung…"
        />
        <MultiSelect
          label="Submission type"
          selected={filter.submission_types}
          onChange={val => onFilterChange('submission_types', val)}
          loadOptions={val => api.lookup('submission_type', val)}
          placeholder="e.g. Biopsy, Resection…"
        />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: lockReturnLevel ? '1fr' : '1fr 1fr', gap: 16, marginTop: 10 }}>
        <MultiSelect
          label="Topography SNOMED code"
          selected={filter.snomed_topo_codes}
          onChange={val => onFilterChange('snomed_topo_codes', val)}
          loadOptions={val => api.lookup('snomed_topo_code', val)}
          placeholder="e.g. T59600…"
        />
        {!lockReturnLevel && (
          <FormField label="Return level">
            <FormSelect
              value={filter.return_level}
              onChange={e => onFilterChange('return_level', e.target.value)}
            >
              {RETURN_LEVEL_OPTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </FormSelect>
          </FormField>
        )}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: lockReturnLevel ? '1fr' : '1fr 1fr', gap: 16, marginTop: 10 }}>
        <MultiSelect
          label="Morphology description"
          selected={filter.morph_description_search}
          onChange={val => onFilterChange('morph_description_search', val)}
          loadOptions={val => api.lookup('morph_description', val)}
          placeholder="e.g. adenocarcinoma…"
        />
        <MultiSelect
          label="Morphology SNOMED code"
          selected={filter.snomed_morph_codes}
          onChange={val => onFilterChange('snomed_morph_codes', val)}
          loadOptions={val => api.lookup('snomed_morph_code', val)}
          placeholder="e.g. M81403"
        />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: lockReturnLevel ? '1fr' : '1fr 1fr', gap: 16, marginTop: 10 }}>
        <MultiSelect
          label="Etiology description"
          selected={filter.etio_description_search}
          onChange={val => onFilterChange('etio_description_search', val)}
          loadOptions={val => api.lookup('etio_description', val)}
          placeholder="e.g. bacterium"
        />
        <MultiSelect
          label="Etiology SNOMED code"
          selected={filter.snomed_etio_codes}
          onChange={val => onFilterChange('snomed_etio_codes', val)}
          loadOptions={val => api.lookup('snomed_etio_code', val)}
          placeholder="e.g. E10000"
        />
      </div>

      <SectionLabel>Clinical</SectionLabel>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
        <FormField label="Report date from">
          <FormInput type="date" onChange={e => onFilterChange('submission_date_from', e.target.value)} />
        </FormField>
        <FormField label="Report date to">
          <FormInput type="date" onChange={e => onFilterChange('submission_date_to', e.target.value)} />
        </FormField>
        <FormField label="Malignancy">
          <FormSelect onChange={e => onFilterChange('malignancy_flag', e.target.value === '' ? null : e.target.value === 'true')}>
            {MALIGNANCY_OPTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </FormSelect>
        </FormField>
      </div>
      <FormField label="Patient consent" style={{ marginTop: 10 }}>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {CONSENT_OPTS.map(opt => {
          const active = (filter.consent_statuses || []).includes(opt.value)
            return (
            <button key={opt.value} type="button"
            onClick={() => onFilterChange('consent_statuses',
                active
              ? filter.consent_statuses.filter(v => v !== opt.value)
              : [...(filter.consent_statuses || []), opt.value]
                )}
                style={{
                padding: '4px 12px', borderRadius: 20, fontSize: 12,
                border: `1px solid ${active ? 'var(--navy)' : 'var(--border-l)'}`,
                background: active ? 'var(--navy-05)' : 'transparent',
                color: active ? 'var(--navy)' : 'var(--text-3)',
                fontWeight: active ? 600 : 400,
                cursor: 'pointer', transition: 'all 0.15s',
                fontFamily: 'var(--font-sans)',
                }}
            >{opt.label}</button>
            )
        })}
        {(filter.consent_statuses || []).length > 0 && (
          <button type="button" onClick={() => onFilterChange('consent_statuses', [])}
            style={{ padding: '4px 8px', borderRadius: 20, fontSize: 11,
                border: 'none', background: 'none', color: 'var(--text-3)',
                cursor: 'pointer', fontFamily: 'var(--font-sans)' }}
            >clear</button>
        )}
        </div>
    </FormField>

      <SectionLabel>Block</SectionLabel>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <FormField label="Block info contains">
          <FormInput
            placeholder="e.g. Tumor, Core 1…"
            onChange={e => onFilterChange('block_info_search', e.target.value)}
          />
        </FormField>
        <FormField label="Has scan">
          <FormSelect onChange={e => onFilterChange('has_scan', e.target.value === '' ? null : e.target.value === 'true')}>
            {HAS_SCAN_OPTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </FormSelect>
        </FormField>
      </div>

      <SectionLabel>Stain &amp; Scan</SectionLabel>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <MultiSelect
          label="Stain name"
          selected={filter.stain_names}
          onChange={val => onFilterChange('stain_names', val)}
          loadOptions={val => api.lookup('stain_name', val)}
          placeholder="e.g. H&amp;E, CD3…"
        />
        <MultiSelect
          label="Stain category"
          selected={filter.stain_categories}
          onChange={val => onFilterChange('stain_categories', val)}
          loadOptions={val => api.lookup('stain_category', val)}
          placeholder="e.g. HE, IHC…"
        />
      </div>
      {/* Scan-level fields — always shown when lockReturnLevel, or when user chose scan */}
      {(lockReturnLevel || isScanLevel) && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginTop: 10 }}>
          <MultiSelect
            label="File format"
            selected={filter.file_formats}
            onChange={val => onFilterChange('file_formats', val)}
            loadOptions={val => api.lookup('file_format', val)}
            placeholder="e.g. SVS, NDPI…"
          />
          <FormField label="Magnification ≥">
            <FormInput
              type="number" min={0} step={0.5} placeholder="e.g. 20"
              onChange={e => onFilterChange('magnification_min', e.target.value ? parseFloat(e.target.value) : null)}
            />
          </FormField>
          <FormField label="Magnification ≤">
            <FormInput
              type="number" min={0} step={0.5} placeholder="e.g. 40"
              onChange={e => onFilterChange('magnification_max', e.target.value ? parseFloat(e.target.value) : null)}
            />
          </FormField>
        </div>
      )}
    </>
  )
}

// ─── List mode form ───────────────────────────────────────────────────────────

function ListModeForm({ listState, onListStateChange, lockReturnLevel }) {
  const { idType, bScope, idText, listLevel, listFilter } = listState
  const fileInputRef = useRef(null)

  function setLF(key, val) {
    onListStateChange('listFilter', { ...listFilter, [key]: val === '' ? null : val })
  }

  function handleFileUpload(e) {
    const file = e.target.files[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = ev => {
      const text = ev.target.result
      const ids  = text.split('\n')
        .map(line => line.split(',')[0].trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean)
      const first = ids[0] || ''
      const looksLikeId = /^[Bb]\.?\d{4}\./.test(first) || /^\d+$/.test(first)
      onListStateChange('idText', (looksLikeId ? ids : ids.slice(1)).join('\n'))
    }
    reader.readAsText(file)
    e.target.value = ''
  }

  const RETURN_LEVEL_OPTS = ['patient', 'submission', 'probe', 'block', 'scan']
    .map(v => [v, v.charAt(0).toUpperCase() + v.slice(1)])
  const HAS_SCAN_OPTS   = [['', 'Any'], ['true', 'Has scan'], ['false', 'No scan']]
  const MALIGNANCY_OPTS = [['', 'Any'], ['true', 'Positive'], ['false', 'Negative']]
  const isScanLevel     = listLevel === 'scan'

  return (
    <>
      <FormField label="ID type">
        <SegmentedControl
          options={[['patient_code', 'Patient code'], ['b_number', 'B-number']]}
          value={idType}
          onChange={val => onListStateChange('idType', val)}
        />
      </FormField>

      {idType === 'b_number' && (
        <FormField label="Scope per B-number">
          <SegmentedControl
            options={[['all', 'All submissions from patient'], ['matched', 'Only matched submission']]}
            value={bScope}
            onChange={val => onListStateChange('bScope', val)}
          />
          <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-3)', marginTop: 5 }}>
            {bScope === 'all'
              ? 'Returns all tissue from the patient, regardless of which submission the B-number matched.'
              : 'Returns only the submission directly matched by this B-number.'}
          </div>
        </FormField>
      )}

      {!lockReturnLevel && (
        <FormField label="Return level">
          <FormSelect value={listLevel} onChange={e => onListStateChange('listLevel', e.target.value)} style={{ width: 200 }}>
            {RETURN_LEVEL_OPTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </FormSelect>
        </FormField>
      )}

      <FormField label={`Paste ${idType === 'b_number' ? 'B-numbers' : 'patient codes'} (one per line)`}>
        <FormTextarea
          value={idText}
          onChange={e => onListStateChange('idText', e.target.value)}
          placeholder={idType === 'b_number' ? 'B2019.14823\nB2015.00392' : '581561\n795492'}
          rows={7}
          style={{ fontFamily: 'var(--font-mono)' }}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 6 }}>
          <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-3)' }}>
            {idText.split('\n').filter(s => s.trim()).length} IDs&ensp;·&ensp;
            {new Set(idText.split('\n').filter(s => s.trim())).size} unique
          </span>
          <label
            style={{ cursor: 'pointer', fontSize: 12, color: 'var(--navy)', fontWeight: 500, display: 'flex', alignItems: 'center', gap: 4, marginLeft: 'auto' }}
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
              <path d="M.5 9.9a.5.5 0 01.5.5v2.5a1 1 0 001 1h12a1 1 0 001-1v-2.5a.5.5 0 011 0v2.5a2 2 0 01-2 2H2a2 2 0 01-2-2v-2.5a.5.5 0 01.5-.5z"/>
              <path d="M7.646 1.146a.5.5 0 01.708 0l3 3a.5.5 0 01-.708.708L8.5 2.707V11.5a.5.5 0 01-1 0V2.707L5.354 4.854a.5.5 0 11-.708-.708l3-3z"/>
            </svg>
            Import CSV / TXT
            <input ref={fileInputRef} type="file" accept=".csv,.txt" style={{ display: 'none' }} onChange={handleFileUpload} />
          </label>
        </div>
      </FormField>

      <SectionLabel>Anatomy &amp; Tissue</SectionLabel>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        <MultiSelect
          label="Topography"
          selected={listFilter.topo_description_search}
          onChange={val => setLF('topo_description_search', val)}
          loadOptions={val => api.lookup('topo_description', val)}
          placeholder="e.g. Colon, Lung…"
        />
        <MultiSelect
          label="Submission type"
          selected={listFilter.submission_types}
          onChange={val => setLF('submission_types', val)}
          loadOptions={val => api.lookup('submission_type', val)}
          placeholder="e.g. Biopsy, Resection…"
        />
      </div>
      <div style={{ marginTop: 10 }}>
        <MultiSelect
          label="SNOMED code"
          selected={listFilter.snomed_topo_codes}
          onChange={val => setLF('snomed_topo_codes', val)}
          loadOptions={val => api.lookup('snomed_topo_code', val)}
          placeholder="e.g. T59600…"
        />
      </div>

      <SectionLabel>Clinical</SectionLabel>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
        <FormField label="Report date from">
          <FormInput type="date" onChange={e => setLF('submission_date_from', e.target.value)} />
        </FormField>
        <FormField label="Report date to">
          <FormInput type="date" onChange={e => setLF('submission_date_to', e.target.value)} />
        </FormField>
        <FormField label="Malignancy">
          <FormSelect onChange={e => setLF('malignancy_flag', e.target.value === '' ? null : e.target.value === 'true')}>
            {MALIGNANCY_OPTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </FormSelect>
        </FormField>
        </div>
        <FormField label="Patient consent" style={{ marginTop: 10 }}>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {CONSENT_OPTS.map(opt => {
            const active = (listFilter.consent_statuses || []).includes(opt.value)
                return (
                <button key={opt.value} type="button"
              onClick={() => setLF('consent_statuses',
                    active
                ? listFilter.consent_statuses.filter(v => v !== opt.value)
                : [...(listFilter.consent_statuses || []), opt.value]
                    )}
                    style={{
                    padding: '4px 12px', borderRadius: 20, fontSize: 12,
                    border: `1px solid ${active ? 'var(--navy)' : 'var(--border-l)'}`,
                    background: active ? 'var(--navy-05)' : 'transparent',
                    color: active ? 'var(--navy)' : 'var(--text-3)',
                    fontWeight: active ? 600 : 400,
                    cursor: 'pointer', transition: 'all 0.15s',
                    fontFamily: 'var(--font-sans)',
                    }}
                >{opt.label}</button>
                )
            })}
          {(listFilter.consent_statuses || []).length > 0 && (
            <button type="button" onClick={() => setLF('consent_statuses', [])}
                style={{ padding: '4px 8px', borderRadius: 20, fontSize: 11,
                    border: 'none', background: 'none', color: 'var(--text-3)',
                    cursor: 'pointer', fontFamily: 'var(--font-sans)' }}
                >clear</button>
            )}
            </div>
        </FormField>
      
      <SectionLabel>Block</SectionLabel>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <FormField label="Block info contains">
          <FormInput placeholder="e.g. Tumor, Core 1…" onChange={e => setLF('block_info_search', e.target.value)} />
        </FormField>
        <FormField label="Has scan">
          <FormSelect onChange={e => setLF('has_scan', e.target.value === '' ? null : e.target.value === 'true')}>
            {HAS_SCAN_OPTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </FormSelect>
        </FormField>
      </div>

      {(lockReturnLevel || isScanLevel) && (
        <>
          <SectionLabel>Stain &amp; Scan</SectionLabel>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            <MultiSelect
              label="Stain name"
              selected={listFilter.stain_names}
              onChange={val => setLF('stain_names', val)}
              loadOptions={val => api.lookup('stain_name', val)}
              placeholder="e.g. H&amp;E, CD3…"
            />
            <MultiSelect
              label="Stain category"
              selected={listFilter.stain_categories}
              onChange={val => setLF('stain_categories', val)}
              loadOptions={val => api.lookup('stain_category', val)}
              placeholder="e.g. HE, IHC…"
            />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginTop: 10 }}>
            <MultiSelect
              label="File format"
              selected={listFilter.file_formats}
              onChange={val => setLF('file_formats', val)}
              loadOptions={val => api.lookup('file_format', val)}
              placeholder="e.g. SVS, NDPI…"
            />
            <FormField label="Magnification ≥">
              <FormInput type="number" min={0} step={0.5} placeholder="e.g. 20"
                onChange={e => setLF('magnification_min', e.target.value ? parseFloat(e.target.value) : null)} />
            </FormField>
            <FormField label="Magnification ≤">
              <FormInput type="number" min={0} step={0.5} placeholder="e.g. 40"
                onChange={e => setLF('magnification_max', e.target.value ? parseFloat(e.target.value) : null)} />
            </FormField>
          </div>
        </>
      )}
    </>
  )
}

// ─── Public component ─────────────────────────────────────────────────────────

export default function CohortFilterForm({
  mode,
  onModeChange,
  filter,
  onFilterChange,
  listState,
  onListStateChange,
  onRun,
  loading       = false,
  lockReturnLevel = false,
  compact       = false,
  runLabel      = 'Run query',
  hideRunButton = false,
}) {
  const canRun = mode === 'filter'
    ? true
    : listState.idText.trim().length > 0

  const inner = (
    <>
      <SegmentedControl
        options={[['filter', 'Filter mode'], ['list', 'List mode']]}
        value={mode}
        onChange={onModeChange}
        style={{ marginBottom: 16 }}
      />

      {mode === 'filter'
        ? <FilterModeForm filter={filter} onFilterChange={onFilterChange} lockReturnLevel={lockReturnLevel} />
        : <ListModeForm   listState={listState} onListStateChange={onListStateChange} lockReturnLevel={lockReturnLevel} />}

      {!hideRunButton && (
        <Btn
          variant="primary"
          style={{ marginTop: 'var(--space-5)' }}
          onClick={onRun}
          disabled={loading || !canRun}
        >
          {loading ? 'Running…' : runLabel}
        </Btn>
      )}
    </>
  )

  if (compact) return <div>{inner}</div>

  return <Panel title="Filters">{inner}</Panel>
}