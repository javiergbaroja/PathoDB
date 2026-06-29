// frontend/src/pages/SlideViewer/ClinicalPanel.jsx
import s from './ClinicalPanel.module.css'
import { Badge } from '../../components/ui'

const cx = (...names) => names.filter(Boolean).join(' ')

function CodeBadgeList({ items, variant }) {
  if (!items?.length) return null
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
      {items.map(c => (
        <Badge key={c.code} variant={variant} title={c.code}>
          {c.description || c.code}
        </Badge>
      ))}
    </div>
  )
}

export default function ClinicalPanel({ displayInfo, compareMode, hasRight, panelSide, setPanelSide, reportOpen, setReportOpen }) {
  const hasMacro = !!displayInfo.report_macro
  const hasMicro = !!displayInfo.report_microscopy

  return (
    <div className={s.panel}>
      <div className={s.header}>
        <span className={s.headerTitle}>Clinical information</span>
        {compareMode && hasRight && (
          <div className={s.sideBtns}>
            {['left', 'right'].map(side => (
              <button
                key={side}
                onClick={() => setPanelSide(side)}
                className={cx(s.sideBtn, panelSide === side && s.sideBtnActive)}
              >
                {side === 'left' ? 'L' : 'R'}
              </button>
            ))}
          </div>
        )}
      </div>

      <PanelSection label="Patient">
        <PanelRow label="Code" value={displayInfo.patient_code} mono />
        <PanelRow label="DOB"  value={displayInfo.date_of_birth} />
        <PanelRow label="Sex"  value={displayInfo.patient_sex} />
      </PanelSection>

      <PanelSection label="Submission">
        <PanelRow label="ID"          value={displayInfo.lis_submission_id} mono />
        <PanelRow label="Report date" value={displayInfo.report_date} />
        <PanelRow
          label="Malignancy"
          value={displayInfo.malignancy_flag === true ? 'Yes' : displayInfo.malignancy_flag === false ? 'No' : null}
          accent="var(--viewer-red)"
        />
      </PanelSection>

      <PanelSection label="Probe">
        <PanelRow label="ID"         value={displayInfo.lis_probe_id} mono />
        <PanelRow label="Topography" value={displayInfo.topo_description} />
        <PanelRow label="SNOMED Topo"     value={displayInfo.snomed_topo_code} mono />
        {displayInfo.snomed_morph_codes?.length > 0 && (
          <PanelRow label="Morphology" value={<CodeBadgeList items={displayInfo.snomed_morph_codes} variant="navy" />} />
        )}
        {displayInfo.snomed_etio_codes?.length > 0 && (
          <PanelRow label="Etiology" value={<CodeBadgeList items={displayInfo.snomed_etio_codes} variant="teal" />} />
        )}
        <PanelRow label="Type"       value={displayInfo.submission_type} />
        <PanelRow label="Location"   value={displayInfo.location_additional} />
      </PanelSection>

      <PanelSection label="Block">
        <PanelRow label="Label"  value={displayInfo.block_label ? `Block ${displayInfo.block_label}` : null} />
        <PanelRow label="Info"   value={displayInfo.block_info} />
        <PanelRow label="Tissue" value={displayInfo.tissue_count != null ? `×${displayInfo.tissue_count}` : null} />
      </PanelSection>

      <PanelSection label="Scan">
        <PanelRow label="Stain"    value={displayInfo.stain_name} />
        <PanelRow label="Category" value={displayInfo.stain_category} />
        <PanelRow label="Format"   value={displayInfo.file_format} />
        <PanelRow label="Power"    value={displayInfo.objective_power ? `${displayInfo.objective_power}×` : null} />
        <PanelRow label="MPP"      value={displayInfo.mpp_x ? `${parseFloat(displayInfo.mpp_x).toFixed(4)} µm/px` : null} />
        <PanelRow label="Vendor"   value={displayInfo.vendor} />
        <PanelRow
          label="Size"
          value={(displayInfo.width && displayInfo.height)
            ? `${displayInfo.width.toLocaleString()} × ${displayInfo.height.toLocaleString()} px`
            : null}
        />
      </PanelSection>

      {(hasMacro || hasMicro) && (
        <div className={s.reportToggle}>
          <button onClick={() => setReportOpen(o => !o)} className={s.reportToggleBtn}>
            <span className={s.reportToggleLabel}>
              Reports {hasMacro && hasMicro ? '(macro + micro)' : hasMacro ? '(macro)' : '(micro)'}
            </span>
            <span className={s.reportToggleChevron}>{reportOpen ? '▾' : '▸'}</span>
          </button>
          {reportOpen && (
            <div className={s.reportBody}>
              {hasMacro && <ReportBlock label="Macroscopy" text={displayInfo.report_macro} />}
              {hasMicro && <ReportBlock label="Microscopy" text={displayInfo.report_microscopy} />}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function PanelSection({ label, children }) {
  return (
    <div className={s.section}>
      <div className={s.sectionLabel}>{label}</div>
      <div className={s.rows}>{children}</div>
    </div>
  )
}

function PanelRow({ label, value, mono, accent }) {
  if (value === null || value === undefined || value === '') return null
  return (
    <div className={s.row}>
      <span className={s.rowLabel}>{label}</span>
      <span
        className={cx(s.rowValue, mono && s.rowValueMono)}
        style={accent ? { color: accent } : undefined}
      >
        {value}
      </span>
    </div>
  )
}

function ReportBlock({ label, text }) {
  return (
    <div className={s.reportBlock}>
      <div className={s.reportBlockLabel}>{label}</div>
      <div className={cx(s.reportText, !text && s.reportTextEmpty)}>
        {text || 'Not available'}
      </div>
    </div>
  )
}
