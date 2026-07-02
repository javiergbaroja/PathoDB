// frontend/src/components/ModelParamRow.jsx
//
// Shared per-model parameter control (a segmented option row, or a range
// slider) used by both AI-submission panels. Merges the two previously
// separate, nearly-identical ParamRow implementations from ModelsPanel.jsx
// and ProjectModelsPanel.jsx — this version is their superset: it supports
// `disabled` (needed by Project Detail while a job is running; harmless and
// unused-by-default in the Slide Viewer, which never disabled params before).

export default function ModelParamRow({ param, value, onChange, disabled = false }) {
  if (param.options) {
    return (
      <div style={{ marginBottom: 8 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
          <span style={{ fontSize: 10, color: 'var(--text-dark-2)' }}>{param.label}</span>
          <span style={{ fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--text-dark-1)' }}>
            {param.type === 'float' ? parseFloat(value).toFixed(2) : value}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          {param.options.map(opt => (
            <button
              key={opt}
              disabled={disabled}
              onClick={() => onChange(opt)}
              style={{
                flex: 1, fontSize: 10, padding: '3px 0', borderRadius: 3,
                cursor: disabled ? 'default' : 'pointer',
                border: `1px solid ${value === opt ? 'var(--transparent-teal-4)' : 'var(--transparent-white-1)'}`,
                background: value === opt ? 'var(--transparent-teal-2)' : 'transparent',
                color: value === opt ? 'var(--viewer-teal-light)' : 'var(--text-dark-2)',
              }}
            >
              {opt}
            </button>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
        <span style={{ fontSize: 10, color: 'var(--text-dark-2)' }}>{param.label}</span>
        <span style={{ fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--text-dark-1)' }}>
          {param.type === 'float' ? parseFloat(value).toFixed(2) : value}
        </span>
      </div>
      <input
        type="range"
        min={param.min}
        max={param.max}
        step={param.step || 1}
        value={value}
        disabled={disabled}
        onChange={e => onChange(param.type === 'float' ? parseFloat(e.target.value) : parseInt(e.target.value))}
        style={{ width: '100%', accentColor: 'var(--viewer-teal)', cursor: disabled ? 'default' : 'pointer' }}
      />
    </div>
  )
}