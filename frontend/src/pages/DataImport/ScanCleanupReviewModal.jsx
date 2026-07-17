// frontend/src/pages/DataImport/ScanCleanupReviewModal.jsx
import { useState, useMemo } from 'react'
import { Modal, Btn, ConfirmDialog, ErrorMsg } from '../../components/ui'
import { api } from '../../api'
import SummaryStats from './SummaryStats'
import s from './DataImport.module.css'

export default function ScanCleanupReviewModal({ job, onClose, onCommitted }) {
  const summary = job?.summary_json || {}
  const cleanCount = summary.clean_count || 0
  const cleanScanIds = summary.clean_scan_ids || []
  const blockedScans = summary.blocked_scans || []
  const blockedTruncated = summary.blocked_scans_truncated || 0

  const [selected, setSelected] = useState(new Set())
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  function toggle(scanId) {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(scanId)) next.delete(scanId)
      else next.add(scanId)
      return next
    })
  }

  const selectedDetails = useMemo(
    () => blockedScans.filter(b => selected.has(b.scan_id)),
    [blockedScans, selected]
  )

  const totalAnnotations   = selectedDetails.reduce((sum, b) => sum + (b.annotation_count || 0), 0)
  const totalAnalysisJobs  = selectedDetails.reduce((sum, b) => sum + (b.analysis_job_count || 0), 0)
  const totalProjectLinks  = selectedDetails.reduce((sum, b) => sum + (b.project_scan_count || 0), 0)

  const nothingToCommit = cleanCount === 0 && selected.size === 0

  async function handleCommit() {
    setConfirmOpen(false)
    setSubmitting(true)
    setError('')
    try {
      await api.submitEtlJob({
        jobType: 'scans',
        mode: 'commit',
        deleteScanIds: cleanScanIds,
        forceScanIds: Array.from(selected),
      })
      onCommitted()
    } catch (e) {
      setError(e.message || 'Failed to submit cleanup')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal isOpen onClose={onClose} title="Review scan cleanup" subtitle="Step 2 of 2 — choose what to delete" width={620}>
      <Modal.Body>
        <ErrorMsg message={error} onDismiss={() => setError('')} />

        <SummaryStats
          items={[
            { label: 'Checked', value: summary.scans_checked ?? '—' },
            { label: 'Missing', value: summary.scans_missing ?? 0 },
            { label: 'Clean',   value: cleanCount },
            { label: 'In use',  value: `${blockedScans.length}${blockedTruncated > 0 ? '+' : ''}` },
          ]}
        />

        {cleanCount > 0 && (
          <div className={s.cleanBanner}>
            {cleanCount} scan{cleanCount !== 1 ? 's' : ''} {cleanCount !== 1 ? 'have' : 'has'} nothing else
            attached — {cleanCount !== 1 ? 'these' : 'this'} will be deleted automatically when you apply.
          </div>
        )}

        {blockedScans.length === 0 ? (
          cleanCount === 0 && (
            <p style={{ fontSize: 13, color: 'var(--text-3)' }}>
              Nothing missing — every scan's file is where it should be.
            </p>
          )
        ) : (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-1)' }}>
                Still in use — review and choose which to force-delete
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <Btn variant="link" small onClick={() => setSelected(new Set(blockedScans.map(b => b.scan_id)))}>
                  Select all
                </Btn>
                <Btn variant="link" small onClick={() => setSelected(new Set())}>
                  Select none
                </Btn>
              </div>
            </div>

            <div>
              {blockedScans.map(b => (
                <label key={b.scan_id} className={s.blockedRow}>
                  <input
                    type="checkbox"
                    className={s.blockedRowCheckbox}
                    checked={selected.has(b.scan_id)}
                    onChange={() => toggle(b.scan_id)}
                  />
                  <div className={s.blockedRowBody}>
                    <div className={s.blockedRowPath} title={b.file_path}>
                      {b.file_path || `scan id ${b.scan_id}`}
                    </div>
                    <div className={s.summaryChips}>
                      {b.annotation_count > 0 && (
                        <span className={s.summaryChip} style={{ background: 'var(--warning-bg)', color: 'var(--warning)' }}>
                          {b.annotation_count} annotation{b.annotation_count !== 1 ? 's' : ''}
                          {b.annotation_projects?.length ? ` — ${b.annotation_projects.join(', ')}` : ''}
                        </span>
                      )}
                      {b.project_scan_count > 0 && (
                        <span className={s.summaryChip}>
                          {b.project_scan_count} project link{b.project_scan_count !== 1 ? 's' : ''}
                          {b.project_names?.length ? ` — ${b.project_names.join(', ')}` : ''}
                        </span>
                      )}
                      {b.analysis_job_count > 0 && (
                        <span className={s.summaryChip}>
                          {b.analysis_job_count} analysis run{b.analysis_job_count !== 1 ? 's' : ''}
                        </span>
                      )}
                    </div>
                  </div>
                </label>
              ))}
            </div>

            {blockedTruncated > 0 && (
              <p style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 8 }}>
                ... and {blockedTruncated} more not shown. Re-run the check after this batch if you need them too.
              </p>
            )}
          </>
        )}
      </Modal.Body>

      <Modal.Footer>
        <Btn variant="ghost" onClick={onClose} disabled={submitting}>Close</Btn>
        <Btn
          variant="danger"
          disabled={nothingToCommit || submitting}
          onClick={() => setConfirmOpen(true)}
        >
          {submitting
            ? 'Applying…'
            : `Apply: delete ${cleanCount + selected.size} scan${(cleanCount + selected.size) !== 1 ? 's' : ''}`}
        </Btn>
      </Modal.Footer>

      <ConfirmDialog
        isOpen={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={handleCommit}
        title="Confirm permanent deletion"
        message={
          selected.size > 0
            ? `This permanently deletes ${cleanCount} clean scan(s), plus ${selected.size} scan(s) along with ${totalAnnotations} annotation(s), ${totalProjectLinks} project link(s), and ${totalAnalysisJobs} analysis run(s) attached to them. This cannot be undone.`
            : `This permanently deletes ${cleanCount} scan(s) with nothing else attached. This cannot be undone.`
        }
        confirmLabel="Delete permanently"
        loading={submitting}
      />
    </Modal>
  )
}