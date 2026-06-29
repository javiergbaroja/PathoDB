// frontend/src/pages/DataImport/index.jsx
import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { Navigate } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'
import Layout from '../../components/Layout'
import { Btn, Badge, Spinner, SegmentedControl } from '../../components/ui'
import { api } from '../../api'
import ScanCleanupReviewModal from './ScanCleanupReviewModal'
import ScanSyncReportModal from './ScanSyncReportModal'
import s from './DataImport.module.css'

// ── Constants ────────────────────────────────────────────────────────────────

const ACCEPTED_FILE_TYPES = '.csv,.xlsx,.xls,.tsv'

const JOB_TYPES = {
  submissions: {
    title: 'Submissions',
    desc: 'Import patients, submissions, and reports from a PathoWin CSV export.',
    columns: 'Patienten-ID, Einsendungsnr, Eingangsdatum, Geschlecht, Geburtsdatum, Malignität, Einverständnis, Diagnose, Makro',
    iconClass: 'cardIconSubmissions',
    mode: 'file',
  },
  blocks: {
    title: 'Blocks',
    desc: 'Import probes and blocks from a PathoWin CSV export. Probes are derived automatically. Requires matching submissions in the database.',
    columns: 'Einsendung, Probe, Block, Block-Nr, Block-Info, Gewebeanzahl, Art des Materials, Topographie - Code/Bezeichnung',
    iconClass: 'cardIconBlocks',
    mode: 'file',
  },
  scans: {
    title: 'Scans',
    desc: null, // ScansCard renders its own mode-specific description
    columns: null,
    iconClass: 'cardIconScans',
    mode: null, // unused — ScansCard manages its own sync/verify toggle
  },
}

const STATUS_DOT = {
  queued:    s.statusDotQueued,
  running:   s.statusDotRunning,
  done:      s.statusDotDone,
  failed:    s.statusDotFailed,
  cancelled: s.statusDotCancelled,
}

const STATUS_BADGE = {
  queued:    'muted',
  running:   'teal',
  done:      'green',
  failed:    'red',
  cancelled: 'muted',
}

const POLL_INTERVAL = 4000

// ── Icons ────────────────────────────────────────────────────────────────────

function UploadIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
      <path d="M.5 9.9a.5.5 0 01.5.5v2.5a1 1 0 001 1h12a1 1 0 001-1v-2.5a.5.5 0 011 0v2.5a2 2 0 01-2 2H2a2 2 0 01-2-2v-2.5a.5.5 0 01.5-.5z"/>
      <path d="M7.646 1.146a.5.5 0 01.708 0l3 3a.5.5 0 01-.708.708L8.5 2.707V11.5a.5.5 0 01-1 0V2.707L5.354 4.854a.5.5 0 11-.708-.708l3-3z"/>
    </svg>
  )
}

function FolderIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
      <path d="M.54 3.87L.5 3a2 2 0 012-2h3.672a2 2 0 011.414.586l.828.828A2 2 0 009.828 3H13.5a2 2 0 012 2v8a2 2 0 01-2 2H2.5a2 2 0 01-2-2V3.87z"/>
    </svg>
  )
}

function SubmissionsIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor">
      <path d="M8 8a3 3 0 100-6 3 3 0 000 6zm2-3a2 2 0 11-4 0 2 2 0 014 0zm4 8c0 1-1 1-1 1H3s-1 0-1-1 1-4 6-4 6 3 6 4zm-1-.004c-.001-.246-.154-.986-.832-1.664C11.516 10.68 10.289 10 8 10c-2.29 0-3.516.68-4.168 1.332-.678.678-.83 1.418-.832 1.664h10z"/>
    </svg>
  )
}

function BlocksIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor">
      <path d="M1 2.5A1.5 1.5 0 012.5 1h3A1.5 1.5 0 017 2.5v3A1.5 1.5 0 015.5 7h-3A1.5 1.5 0 011 5.5v-3zm8 0A1.5 1.5 0 0110.5 1h3A1.5 1.5 0 0115 2.5v3A1.5 1.5 0 0113.5 7h-3A1.5 1.5 0 019 5.5v-3zm-8 8A1.5 1.5 0 012.5 9h3A1.5 1.5 0 017 10.5v3A1.5 1.5 0 015.5 15h-3A1.5 1.5 0 011 13.5v-3zm8 0A1.5 1.5 0 0110.5 9h3a1.5 1.5 0 011.5 1.5v3a1.5 1.5 0 01-1.5 1.5h-3A1.5 1.5 0 019 13.5v-3z"/>
    </svg>
  )
}

function ScansIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor">
      <path d="M6.002 5.5a1.5 1.5 0 11-3 0 1.5 1.5 0 013 0z"/>
      <path d="M2.002 1a2 2 0 00-2 2v10a2 2 0 002 2h12a2 2 0 002-2V3a2 2 0 00-2-2h-12zm12 1a1 1 0 011 1v6.5l-3.777-1.947a.5.5 0 00-.577.093l-3.71 3.71-2.66-1.772a.5.5 0 00-.63.062L1.002 12V3a1 1 0 011-1h12z"/>
    </svg>
  )
}

function CloseIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
      <path d="M4.646 4.646a.5.5 0 01.708 0L8 7.293l2.646-2.647a.5.5 0 01.708.708L8.707 8l2.647 2.646a.5.5 0 01-.708.708L8 8.707l-2.646 2.647a.5.5 0 01-.708-.708L7.293 8 4.646 5.354a.5.5 0 010-.708z"/>
    </svg>
  )
}

const CARD_ICONS = {
  submissions: <SubmissionsIcon />,
  blocks: <BlocksIcon />,
  scans: <ScansIcon />,
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatTimestamp(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  return d.toLocaleDateString('de-CH', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

function formatSource(path) {
  if (!path) return '—'
  // Show just the filename for uploads, or last 2 path segments for folders
  const parts = path.replace(/\\/g, '/').split('/')
  if (parts.length <= 2) return path
  return '…/' + parts.slice(-2).join('/')
}

function buildSummaryChips(summary) {
  if (!summary) return null
  const chips = []
  const mapping = [
    ['patients_inserted',    'Patients'],
    ['submissions_inserted', 'Submissions'],
    ['reports_inserted',     'Reports'],
    ['probes_inserted',      'Probes'],
    ['blocks_inserted',      'Blocks'],
    ['scans_inserted',       'Scans'],
    ['stains_created',       'Stains (new)'],
    ['unlinked',             'Unlinked'],
    ['parse_failed',         'Parse failed'],
    ['scans_missing',        'Missing'],
    ['clean_count',          'Clean'],
    ['blocked_count',        'Blocked'],
    ['clean_deleted',        'Deleted (clean)'],
    ['force_deleted',        'Deleted (forced)'],
    ['force_annotations_deleted', 'Annotations removed'],
    ['duplicate_skipped',     'Already existed'],
  ]
  for (const [key, label] of mapping) {
    const val = summary[key]
    if (val !== undefined && val > 0) {
      chips.push({
        label, value: val,
        warn: key === 'unlinked' || key === 'parse_failed' || key === 'blocked_count' || key === 'force_annotations_deleted',
      })
    }
  }
  return chips
}

// ── File Drop Zone ──────────────────────────────────────────────────────────

function FileDropZone({ file, onFile, onClear, accept }) {
  const inputRef = useRef(null)
  const [dragOver, setDragOver] = useState(false)

  function handleDrop(e) {
    e.preventDefault()
    setDragOver(false)
    const dropped = e.dataTransfer.files?.[0]
    if (dropped) onFile(dropped)
  }

  if (file) {
    return (
      <div className={s.selectedFile}>
        <UploadIcon />
        <span className={s.selectedFileName}>{file.name}</span>
        <span style={{ fontSize: 11, color: 'var(--text-3)' }}>
          {(file.size / 1024).toFixed(0)} KB
        </span>
        <button className={s.clearFile} onClick={onClear} title="Remove file">
          <CloseIcon />
        </button>
      </div>
    )
  }

  return (
    <>
      <div
        className={`${s.dropZone} ${dragOver ? s.dropZoneActive : ''}`}
        onClick={() => inputRef.current?.click()}
        onDragOver={e => { e.preventDefault(); setDragOver(true) }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
      >
        <UploadIcon />
        Drop file here or click to browse
      </div>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        style={{ display: 'none' }}
        onChange={e => { if (e.target.files?.[0]) onFile(e.target.files[0]) }}
      />
    </>
  )
}

// ── Progress Bar ────────────────────────────────────────────────────────────

function ProgressBar({ percent, status }) {
  const fillClass = status === 'done' ? s.progressFillDone
    : status === 'failed' ? s.progressFillFailed
    : s.progressFillRunning

  return (
    <div className={s.progressWrap}>
      <div className={s.progressBar}>
        <div
          className={`${s.progressFill} ${fillClass}`}
          style={{ width: `${Math.max(percent, status === 'running' ? 3 : 0)}%` }}
        />
      </div>
      <span className={s.progressPct}>{percent}%</span>
    </div>
  )
}

// ── Import Card ─────────────────────────────────────────────────────────────

function ImportCard({ type, config, onSubmit, submitting }) {
  const [file, setFile] = useState(null)
  const [mode, setMode] = useState('preview')
  const [previewResult, setPreviewResult] = useState(null)
  const isFile = config.mode === 'file'

  function handleSubmit() {
    if (isFile && !file) return
    if (mode === 'preview') {
      onSubmit({
        jobType: type,
        mode: 'preview',
        file: isFile ? file : null,
      })
    } else {
      onSubmit({
        jobType: type,
        mode: 'commit',
        file: isFile ? file : null,
      })
    }
  }

  const canSubmit = isFile ? !!file : false

  return (
    <div className={s.card}>
      <div className={s.cardHeader}>
        <div className={`${s.cardIcon} ${s[config.iconClass]}`}>
          {CARD_ICONS[type]}
        </div>
        <span className={s.cardTitle}>{config.title}</span>
      </div>

      <div className={s.cardDesc}>{config.desc}</div>

      {config.columns && (
        <div className={s.cardColumns}>
          Expected columns: {config.columns}
        </div>
      )}

      <SegmentedControl
        small
        style={{ marginBottom: 8, marginTop: 4 }}
        options={[['preview', 'Preview (dry run)'], ['commit', 'Import directly']]}
        value={mode}
        onChange={setMode}
      />

      {mode === 'preview' && (
        <div style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 8 }}>
          Validates the file and reports what would be created or updated — nothing is written to the database.
        </div>
      )}
      {mode === 'commit' && (
        <div style={{ fontSize: 11, color: 'var(--warning)', marginBottom: 8 }}>
          Imports directly into the database. Consider running a preview first.
        </div>
      )}

      {isFile && (
        <FileDropZone
          file={file}
          onFile={setFile}
          onClear={() => setFile(null)}
          accept={ACCEPTED_FILE_TYPES}
        />
      )}

      <div className={s.cardActions}>
        <Btn
          variant={mode === 'commit' ? 'teal' : 'primary'}
          small
          disabled={!canSubmit || submitting}
          onClick={handleSubmit}
        >
          {submitting ? <Spinner size={14} color="var(--white)" /> : null}
          {mode === 'preview' ? 'Run Preview' : 'Upload & Import'}
        </Btn>
      </div>
    </div>
  )
}

// ── Scans Card (sync from folder, or verify existing scans) ────────────────

function ScansCard({ config, onSubmit, submitting }) {
  const [mode, setMode] = useState('sync')
  const [scanFolder, setScanFolder] = useState('')

  function handleSyncSubmit() {
    if (!scanFolder.trim()) return
    onSubmit({ jobType: 'scans', mode: 'sync', scanFolder: scanFolder.trim() })
    setScanFolder('')
  }

  function handlePreviewSubmit() {
    onSubmit({ jobType: 'scans', mode: 'preview' })
  }

  return (
    <div className={s.card}>
      <div className={s.cardHeader}>
        <div className={`${s.cardIcon} ${s[config.iconClass]}`}>
          {CARD_ICONS.scans}
        </div>
        <span className={s.cardTitle}>{config.title}</span>
      </div>

      <SegmentedControl
        small
        style={{ marginBottom: 2 }}
        options={[['sync', 'Sync from folder'], ['preview', 'Check for missing files']]}
        value={mode}
        onChange={setMode}
      />

      {mode === 'sync' ? (
        <>
          <div className={s.cardDesc}>
            Crawl a folder on the HPC for WSI files (.svs, .ndpi, .mrxs) and
            match them to existing blocks via B-number parsing.
          </div>
          <div className={s.folderInput}>
            <FolderIcon />
            <input
              className={s.folderPath}
              type="text"
              placeholder="/storage/research/…/slides"
              value={scanFolder}
              onChange={e => setScanFolder(e.target.value)}
            />
          </div>
          <div className={s.cardActions}>
            <Btn
              variant="teal"
              small
              disabled={!scanFolder.trim() || submitting}
              onClick={handleSyncSubmit}
            >
              {submitting ? <Spinner size={14} color="var(--white)" /> : null}
              Start Scan Crawl
            </Btn>
          </div>
        </>
      ) : (
        <>
          <div className={s.cardDesc}>
            Checks every existing scan's file path against the filesystem and
            reports what's missing. Nothing is deleted here — once it finishes,
            use the "Review" button in the history below to choose what to
            clean up.
          </div>
          <div className={s.cardActions}>
            <Btn
              variant="teal"
              small
              disabled={submitting}
              onClick={handlePreviewSubmit}
            >
              {submitting ? <Spinner size={14} color="var(--white)" /> : null}
              Run Check
            </Btn>
          </div>
        </>
      )}
    </div>
  )
}

// ── Job History Row ─────────────────────────────────────────────────────────

function JobRow({ job, onCancel, onReview, onReport }) {
  const chips = buildSummaryChips(job.summary_json)
  const canReview = job.job_type === 'scans' && job.config_json?.mode === 'preview' && job.status === 'done'
  const canViewReport = job.job_type === 'scans' && job.config_json?.mode === 'sync' && job.status === 'done' && job.summary_json?.report_csv

  return (
    <tr>
      <td>
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>
          #{job.id}
        </span>
      </td>
      <td>
        <Badge variant={
          job.job_type === 'submissions' ? 'teal'
          : job.job_type === 'blocks' ? 'navy'
          : 'warning'
        }>
          {job.job_type}
          {job.job_type === 'scans' && job.config_json?.mode ? ` · ${job.config_json.mode}` : ''}
        </Badge>
      </td>
      <td>
        <span className={STATUS_DOT[job.status] || ''} />
        {job.status}
      </td>
      <td>
        <ProgressBar percent={job.progress} status={job.status} />
      </td>
      <td>
        <span className={s.sourcePath} title={job.source_path}>
          {formatSource(job.source_path)}
        </span>
      </td>
      <td>
        {chips && chips.length > 0 ? (
          <div className={s.summaryChips}>
            {chips.map(c => (
              <span
                key={c.label}
                className={s.summaryChip}
                style={c.warn ? { background: 'var(--warning-bg)', color: 'var(--warning)' } : undefined}
              >
                {c.value} {c.label}
              </span>
            ))}
          </div>
        ) : job.error_message ? (
          <span style={{ fontSize: 12, color: 'var(--crimson)' }} title={job.error_message}>
            {job.error_message.length > 140 ? job.error_message.slice(0, 140) + '…' : job.error_message}
          </span>
        ) : '—'}
      </td>
      <td>{formatTimestamp(job.created_at)}</td>
      <td>
        <div style={{ display: 'flex', gap: 6 }}>
          {canReview && (
            <Btn variant="primary" small onClick={() => onReview(job)}>
              Review
            </Btn>
          )}
          {canViewReport && (
            <Btn variant="ghost" small onClick={() => onReport(job)}>
              Report
            </Btn>
          )}
          {(job.status === 'queued' || job.status === 'running') && (
            <Btn variant="ghost" small onClick={() => onCancel(job.id)}>
              Cancel
            </Btn>
          )}
        </div>
      </td>
    </tr>
  )
}

// ── Main Page ───────────────────────────────────────────────────────────────

export default function DataImport() {
  const { isAdmin } = useAuth()
  const [jobs, setJobs] = useState([])
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(null) // which job type is submitting
  const [error, setError] = useState('')
  const [reviewJob, setReviewJob] = useState(null) // completed preview job under review
  const [reportJob, setReportJob] = useState(null)
  const [historyFilter, setHistoryFilter] = useState('all')
  const pollRef = useRef(null)

  // Redirect non-admins
  if (!isAdmin) return <Navigate to="/dashboard" replace />

  const fetchJobs = useCallback(async () => {
    try {
      const data = await api.getEtlJobs()
      setJobs(data || [])
    } catch (e) {
      console.error('Failed to fetch ETL jobs:', e)
    } finally {
      setLoading(false)
    }
  }, [])

  // Initial load + polling (stops when no active jobs)
  useEffect(() => {
    fetchJobs()
    return () => clearInterval(pollRef.current)
  }, [fetchJobs])

  useEffect(() => {
    clearInterval(pollRef.current)
    if (hasActiveJobs) {
      pollRef.current = setInterval(fetchJobs, POLL_INTERVAL)
    }
    return () => clearInterval(pollRef.current)
  }, [hasActiveJobs, fetchJobs])

  async function handleSubmit({ jobType, mode, file, scanFolder }) {
    setSubmitting(jobType)
    setError('')
    try {
      await api.submitEtlJob({ jobType, mode, file, scanFolder })
      await fetchJobs()
    } catch (e) {
      setError(e.message || 'Failed to submit job')
    } finally {
      setSubmitting(null)
    }
  }

  async function handleCancel(jobId) {
    try {
      await api.cancelEtlJob(jobId)
      await fetchJobs()
    } catch (e) {
      setError(e.message || 'Failed to cancel job')
    }
  }

  const hasActiveJobs = jobs.some(j => j.status === 'queued' || j.status === 'running')

  const filteredJobs = useMemo(() => {
    const sorted = [...jobs].sort((a, b) =>
      new Date(b.created_at) - new Date(a.created_at)
    )
    if (historyFilter === 'all') return sorted
    return sorted.filter(j => j.job_type === historyFilter)
  }, [jobs, historyFilter])

  return (
    <Layout title="Data Import">
      <div className={s.headerRow}>
        <div>
          <p className={s.subtitle}>
            Upload PathoWin exports or crawl slide folders to populate the database.
            Each import runs as a SLURM job on the cluster.
          </p>
        </div>
        {hasActiveJobs && (
          <Badge variant="teal">
            <Spinner size={12} color="var(--teal)" />
            &nbsp;Jobs running
          </Badge>
        )}
      </div>

      {error && (
        <div style={{
          padding: '10px 14px', marginBottom: 16, borderRadius: 'var(--radius-md)',
          background: 'var(--danger-bg)', color: 'var(--danger)', fontSize: 13,
        }}>
          {error}
        </div>
      )}

      {/* ── Import cards ─────────────────────────────────────────────────── */}
      <div className={s.cardGrid}>
        <ImportCard
          type="submissions"
          config={JOB_TYPES.submissions}
          onSubmit={handleSubmit}
          submitting={submitting === 'submissions'}
        />
        <ImportCard
          type="blocks"
          config={JOB_TYPES.blocks}
          onSubmit={handleSubmit}
          submitting={submitting === 'blocks'}
        />
        <ScansCard
          config={JOB_TYPES.scans}
          onSubmit={handleSubmit}
          submitting={submitting === 'scans'}
        />
      </div>

      {/* ── Job history ──────────────────────────────────────────────────── */}
      <div className={s.historySection}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
          <div className={s.sectionTitle} style={{ marginBottom: 0 }}>Import History</div>
          <SegmentedControl
            small
            options={[
              ['all', 'All'],
              ['submissions', 'Submissions'],
              ['blocks', 'Blocks'],
              ['scans', 'Scans'],
            ]}
            value={historyFilter}
            onChange={setHistoryFilter}
          />
        </div>
        <div className={s.tableWrap}>
          <table className={s.table}>
            <thead>
              <tr>
                <th>ID</th>
                <th>Type</th>
                <th>Status</th>
                <th>Progress</th>
                <th>Source</th>
                <th>Result</th>
                <th>Started</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={8} className={s.emptyRow}>
                    <Spinner size={18} />
                  </td>
                </tr>
              ) : filteredJobs.length === 0 ? (
                <tr>
                  <td colSpan={8} className={s.emptyRow}>
                    {jobs.length === 0
                      ? 'No import jobs yet. Use the cards above to start one.'
                      : 'No jobs match this filter.'}
                  </td>
                </tr>
              ) : (
                filteredJobs.map(job => (
                  <JobRow key={job.id} job={job} onCancel={handleCancel} onReview={setReviewJob} onReport={setReportJob} />
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {reviewJob && (
        <ScanCleanupReviewModal
          job={reviewJob}
          onClose={() => setReviewJob(null)}
          onCommitted={() => { setReviewJob(null); fetchJobs() }}
        />
      )}
      {reportJob && (
        <ScanSyncReportModal job={reportJob} onClose={() => setReportJob(null)} />
      )}
    </Layout>
  )
}