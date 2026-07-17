// frontend/src/pages/DataImport/SummaryStats.jsx
// Shared summary-stat header used by the scan review + report modals.
import s from './DataImport.module.css'

/**
 * @param {{ items: { label: string, value: React.ReactNode }[] }} props
 */
export default function SummaryStats({ items }) {
  return (
    <div className={s.reviewSummary}>
      {items.map(({ label, value }) => (
        <div key={label} className={s.reviewSummaryItem}>
          <span className={s.reviewSummaryValue}>{value}</span>
          <span className={s.reviewSummaryLabel}>{label}</span>
        </div>
      ))}
    </div>
  )
}
