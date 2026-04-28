// frontend/src/pages/SlideViewer/ClinicalPanel.jsx

export default function ClinicalPanel({ displayInfo, compareMode, hasRight, panelSide, setPanelSide, reportOpen, setReportOpen }) {
  const hasMacro = !!displayInfo.report_macro
  const hasMicro = !!displayInfo.report_microscopy
  return (
    <div style={{ width: 296, flexShrink: 0, background: 'rgba(2,5,18,0.98)', borderLeft: '1px solid rgba(255,255,255,0.07)', overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: '9px 14px', borderBottom: '1px solid rgba(255,255,255,0.05)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
        <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.50)', textTransform: 'uppercase', letterSpacing: '0.1em', fontWeight: 600 }}>Clinical information</span>
        {compareMode && hasRight && (
          <div style={{ display: 'flex', gap: 4 }}>
            {['left', 'right'].map(side => (
              <button key={side} onClick={() => setPanelSide(side)} style={{ padding: '2px 8px', fontSize: 10, fontWeight: 600, background: panelSide === side ? 'rgba(27,153,139,0.2)' : 'rgba(255,255,255,0.04)', border: `1px solid ${panelSide === side ? '#1b998b' : 'rgba(255,255,255,0.1)'}`, borderRadius: 4, color: panelSide === side ? '#6ee7b7' : 'rgba(255,255,255,0.35)', cursor: 'pointer' }}>
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
        <PanelRow label="ID"         value={displayInfo.lis_submission_id} mono />
        <PanelRow label="Report date" value={displayInfo.report_date} />
        <PanelRow label="Malignancy" value={displayInfo.malignancy_flag === true ? 'Yes' : displayInfo.malignancy_flag === false ? 'No' : null} accent={displayInfo.malignancy_flag ? '#ff8099' : null} />
      </PanelSection>

      <PanelSection label="Probe">
        <PanelRow label="ID"         value={displayInfo.lis_probe_id} mono />
        <PanelRow label="Topography" value={displayInfo.topo_description} />
        <PanelRow label="SNOMED"     value={displayInfo.snomed_topo_code} mono />
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
        <PanelRow label="Size"     value={(displayInfo.width && displayInfo.height) ? `${displayInfo.width.toLocaleString()} × ${displayInfo.height.toLocaleString()} px` : null} />
      </PanelSection>

      {(hasMacro || hasMicro) && (
        <div style={{ borderTop: '1px solid rgba(255,255,255,0.05)' }}>
          <button onClick={() => setReportOpen(o => !o)} style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', background: 'none', border: 'none', cursor: 'pointer', color: 'rgba(255,255,255,0.55)', fontFamily: 'sans-serif' }}>
            <span style={{ fontSize: 9, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.1em' }}>
              Reports {hasMacro && hasMicro ? '(macro + micro)' : hasMacro ? '(macro)' : '(micro)'}
            </span>
            <span style={{ fontSize: 12 }}>{reportOpen ? '▾' : '▸'}</span>
          </button>
          {reportOpen && (
            <div style={{ padding: '0 14px 14px', display: 'flex', flexDirection: 'column', gap: 10 }}>
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
    <div style={{ padding: '9px 14px', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
      <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.45)', textTransform: 'uppercase', letterSpacing: '0.1em', fontWeight: 600, marginBottom: 6 }}>{label}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>{children}</div>
    </div>
  )
}

function PanelRow({ label, value, mono, accent }) {
  if (value === null || value === undefined || value === '') return null
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
      <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.50)', minWidth: 72, flexShrink: 0 }}>{label}</span>
      <span style={{ fontSize: 12, color: accent || 'rgba(255,255,255,0.72)', fontFamily: mono ? 'monospace' : 'sans-serif', wordBreak: 'break-word', lineHeight: 1.4 }}>{value}</span>
    </div>
  )
}

function ReportBlock({ label, text }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.50)', textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: 11.5, color: text ? 'rgba(255,255,255,0.62)' : 'rgba(255,255,255,0.18)', lineHeight: 1.65, whiteSpace: 'pre-wrap', background: 'rgba(255,255,255,0.03)', borderRadius: 5, padding: '7px 9px', fontStyle: text ? 'normal' : 'italic' }}>
        {text || 'Not available'}
      </div>
    </div>
  )
}