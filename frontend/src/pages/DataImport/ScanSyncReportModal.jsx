// frontend/src/pages/DataImport/ScanSyncReportModal.jsx
import { useState } from 'react'
import { Modal, Btn, ErrorMsg } from '../../components/ui'
import { api } from '../../api'
import s from './DataImport.module.css'

export default function ScanSyncReportModal({ job, onClose }) {
  const summary = job?.summary_json || {}
  const [downloading, setDownloading] = useState(false)
  const [error, setError] = useState('')

  async function handleDownload() {
    setDownloading(true)
    setError('')
    try {
      await api.downloadEtlReport(job.id)
    } catch (e) {
      setError(e.message || 'Failed to download report')
    } finally {
      setDownloading(false)
    }
  }

  const insertedSample    = summary.inserted_sample || []
  const parseFailedSample = summary.parse_failed_sample || []
  const unlinkedSample    = summary.unlinked_sample || []

  return (
    <Modal isOpen onClose={onClose} title="Scan sync report" subtitle={`Job #${job.id}`} width={620}>
      <Modal.Body>
        <ErrorMsg message={error} onDismiss={() => setError('')} />

        <div className={s.reviewSummary}>
          <div className={s.reviewSummaryItem}>
            <span className={s.reviewSummaryValue}>{summary.files_found ?? '—'}</span>
            <span className={s.reviewSummaryLabel}>Found</span>
          </div>
          <div className={s.reviewSummaryItem}>
            <span className={s.reviewSummaryValue}>{summary.scans_inserted ?? 0}</span>
            <span className={s.reviewSummaryLabel}>Inserted</span>
          </div>
          <div className={s.reviewSummaryItem}>
            <span className={s.reviewSummaryValue}>{summary.duplicate_skipped ?? 0}</span>
            <span className={s.reviewSummaryLabel}>Already existed</span>
          </div>
          <div className={s.reviewSummaryItem}>
            <span className={s.reviewSummaryValue}>{summary.unlinked ?? 0}</span>
            <span className={s.reviewSummaryLabel}>Unlinked</span>
          </div>
          <div className={s.reviewSummaryItem}>
            <span className={s.reviewSummaryValue}>{summary.parse_failed ?? 0}</span>
            <span className={s.reviewSummaryLabel}>Parse failed</span>
          </div>
        </div>

        <p style={{ fontSize: 12, color: 'var(--text-3)', marginBottom: 16 }}>
          Showing up to 25 examples per category below. Download the full CSV for every file processed in this run.
        </p>

        {insertedSample.length > 0 && (
          <ReportSection title={`Inserted (showing ${insertedSample.length} of ${summary.scans_inserted})`}>
            {insertedSample.map((f, i) => (
              <div key={i} className={s.blockedRowPath} style={{ marginBottom: 4 }}>{f}</div>
            ))}
          </ReportSection>
        )}

        {unlinkedSample.length > 0 && (
          <ReportSection title={`Unlinked (showing ${unlinkedSample.length} of ${summary.unlinked})`}>
            {unlinkedSample.map((row, i) => (
              <div key={i} style={{ marginBottom: 6 }}>
                <div className={s.blockedRowPath}>{row.filename}</div>
                <div style={{ fontSize: 11, color: 'var(--warning)' }}>{row.reason}</div>
              </div>
            ))}
          </ReportSection>
        )}

        {parseFailedSample.length > 0 && (
          <ReportSection title={`Parse failed (showing ${parseFailedSample.length} of ${summary.parse_failed})`}>
            {parseFailedSample.map((f, i) => (
              <div key={i} className={s.blockedRowPath} style={{ marginBottom: 4 }}>{f}</div>
            ))}
          </ReportSection>
        )}
      </Modal.Body>

      <Modal.Footer>
        <Btn variant="ghost" onClick={onClose}>Close</Btn>
        <Btn variant="primary" onClick={handleDownload} disabled={downloading}>
          {downloading ? 'Preparing…' : 'Download full CSV'}
        </Btn>
      </Modal.Footer>
    </Modal>
  )
}

function ReportSection({ title, children }) {
  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-1)', marginBottom: 6 }}>
        {title}
      </div>
      <div style={{ maxHeight: 160, overflowY: 'auto', padding: '4px 8px', background: 'var(--navy-05)', borderRadius: 'var(--radius-md)' }}>
        {children}
      </div>
    </div>
  )
}