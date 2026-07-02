// frontend/src/components/ScopeOptionList.jsx
//
// Shared presentational "vertical list of clickable option rows" used for
// analysis-scope selection in both AI-submission panels. This is purely a
// renderer — it does NOT know what a "scope" means or where ROI data comes
// from. Each context (Slide Viewer: ad-hoc drawn polygons; Project Detail:
// the AI Model ROI annotation class) builds its own `options` array from its
// own state and passes it in, since those two ROI sources are genuinely
// different, not just styled differently (see PathoDB audit Finding 3).
//
// options: [{
//   value,             // string, matches the controlled `value` prop
//   label,             // string
//   desc,              // optional string, shown under the label
//   descColor,         // optional color for `desc`
//   enabled,           // optional bool, default true — false disables the row
//   disabledTitle,     // optional tooltip shown when disabled
//   badge,             // optional ReactNode shown at the row's right edge
// }]

export default function ScopeOptionList({ options, value, onChange }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {options.map(opt => {
        const isActive = value === opt.value
        const enabled  = opt.enabled !== false

        let bg, border, color, cursor
        if (!enabled) {
          bg = 'var(--transparent-white-0)'; border = '1px solid var(--transparent-white-0)'
          color = 'var(--transparent-white-2)'; cursor = 'not-allowed'
        } else if (isActive) {
          bg = 'var(--transparent-teal-2)'; border = '1px solid var(--transparent-teal-4)'
          color = 'var(--viewer-teal-light)'; cursor = 'pointer'
        } else {
          bg = 'var(--transparent-white-0)'; border = '1px solid var(--transparent-white-1)'
          color = 'var(--text-dark-2)'; cursor = 'pointer'
        }

        return (
          <button
            key={opt.value}
            disabled={!enabled}
            onClick={() => enabled && onChange(opt.value)}
            title={!enabled ? opt.disabledTitle : undefined}
            style={{
              display: 'flex', alignItems: 'flex-start', gap: 8,
              padding: '7px 10px', borderRadius: 5,
              background: bg, border, color, cursor,
              fontSize: 11, fontFamily: 'var(--font-sans)', textAlign: 'left',
              transition: 'var(--transition-base)',
            }}
          >
            <div style={{
              width: 7, height: 7, borderRadius: '50%', flexShrink: 0, marginTop: 2,
              background: isActive ? 'var(--viewer-teal-light)' : enabled ? 'var(--transparent-white-2)' : 'var(--transparent-white-1)',
            }} />
            <div style={{ flex: 1 }}>
              <div>{opt.label}</div>
              {opt.desc && (
                <div style={{ fontSize: 10, color: opt.descColor || 'var(--transparent-white-3)', marginTop: 1, lineHeight: 1.4 }}>
                  {opt.desc}
                </div>
              )}
            </div>
            {opt.badge}
          </button>
        )
      })}
    </div>
  )
}