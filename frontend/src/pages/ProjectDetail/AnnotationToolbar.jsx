// frontend/src/pages/ProjectDetail/AnnotationToolbar.jsx
import { useViewerStore } from '../../store/viewerStore'

const TOOLS = [
  {
    id: 'polygon',
    label: 'Polygon',
    shortcut: 'G',
    icon: (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
        <polygon points="8,1.5 14,5.5 12,14 4,14 2,5.5" />
        <circle cx="8"  cy="1.5" r="1.5" fill="currentColor" stroke="none"/>
        <circle cx="14" cy="5.5" r="1.5" fill="currentColor" stroke="none"/>
        <circle cx="4"  cy="14"  r="1.5" fill="currentColor" stroke="none"/>
      </svg>
    ),
  },
  {
    id: 'rectangle',
    label: 'Rectangle',
    shortcut: 'R',
    icon: (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
        <rect x="1" y="3" width="14" height="10" rx="1" />
      </svg>
    ),
  },
  {
    id: 'ellipse',
    label: 'Ellipse',
    shortcut: 'E',
    icon: (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
        <ellipse cx="8" cy="8" rx="7" ry="5" />
      </svg>
    ),
  },
  {
    id: 'point',
    label: 'Point',
    shortcut: 'P',
    icon: (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
        <circle cx="8" cy="8" r="3.5" />
        <line x1="8" y1="1" x2="8" y2="4" stroke="currentColor" strokeWidth="1.5"/>
        <line x1="8" y1="12" x2="8" y2="15" stroke="currentColor" strokeWidth="1.5"/>
        <line x1="1" y1="8" x2="4" y2="8" stroke="currentColor" strokeWidth="1.5"/>
        <line x1="12" y1="8" x2="15" y2="8" stroke="currentColor" strokeWidth="1.5"/>
      </svg>
    ),
  },
  {
    id: 'brush',
    label: 'Brush',
    shortcut: 'B',
    icon: (
      <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
        <path d="M15.825.12a.5.5 0 01.132.584c-1.53 3.43-4.743 8.17-7.095 10.64a6.067 6.067 0 01-2.373 1.534c-.018.227-.06.538-.16.868-.201.659-.667 1.479-1.708 1.74a8.118 8.118 0 01-3.078.132 3.659 3.659 0 01-.562-.135 1.382 1.382 0 01-.466-.247.714.714 0 01-.204-.288.622.622 0 01.004-.443c.095-.245.316-.38.461-.452.394-.197.625-.453.867-.826.095-.144.184-.297.287-.472l.117-.198c.151-.255.326-.54.546-.848.528-.739 1.201-.925 1.746-.896.126.007.243.025.348.048.062-.172.142-.38.238-.608.261-.637.73-1.494 1.513-2.208C9.592 4.876 14.815 1.395 15.432.12a.5.5 0 01.393 0z"/>
      </svg>
    ),
  },
]

export default function AnnotationToolbar({
  activeTool,
  setActiveTool,
  brushRadius,
  setBrushRadius,
  readOnly,
  // image adjustment
  brightness, contrast, gamma,
  setBrightness, setContrast, setGamma, resetAdjustments,
  showAdjust, setShowAdjust,
  // ruler
  isRulerActive, setIsRulerActive,
}) {
  function toggleTool(id) {
    if (readOnly) return
    setActiveTool(prev => (prev === id ? null : id))
    // ruler and annotation tools are mutually exclusive
    if (id !== 'ruler') setIsRulerActive(false)
  }

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 4,
      padding: '10px 8px',
      background: 'rgba(3,8,25,0.97)',
      borderRight: '1px solid rgba(255,255,255,0.07)',
      alignItems: 'center',
      zIndex: 20,
    }}>
      {/* Annotation tools */}
      {TOOLS.map(t => (
        <ToolBtn
          key={t.id}
          active={activeTool === t.id}
          disabled={readOnly}
          title={`${t.label} (${t.shortcut})`}
          onClick={() => toggleTool(t.id)}
          accentColor="#ffd700"
        >
          {t.icon}
        </ToolBtn>
      ))}

      <Divider />

      {/* Ruler */}
      <ToolBtn
        active={isRulerActive}
        title="Ruler (L)"
        onClick={() => {
          setIsRulerActive(r => !r)
          setActiveTool(null)
        }}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
          <path d="M.5 1a.5.5 0 00-.5.5v13a.5.5 0 00.5.5H2a.5.5 0 00.5-.5V13H3a.5.5 0 000-1h-.5v-1H4a.5.5 0 000-1H2.5V9H3a.5.5 0 000-1h-.5V7H4a.5.5 0 000-1H2.5V5H3a.5.5 0 000-1h-.5v-1H4a.5.5 0 000-1H2.5V1.5A.5.5 0 002 1H.5zm7 0a.5.5 0 00-.5.5v13a.5.5 0 00.5.5h7a.5.5 0 00.5-.5v-13A.5.5 0 0015.5 1h-7z"/>
        </svg>
      </ToolBtn>

      {/* Image adjust */}
      <div style={{ position: 'relative' }}>
        <ToolBtn
          active={showAdjust}
          title="Image adjust (A)"
          onClick={() => setShowAdjust(s => !s)}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
            <path d="M8 11a3 3 0 110-6 3 3 0 010 6zm0 1a4 4 0 100-8 4 4 0 000 8zM8 0a.5.5 0 01.5.5v2a.5.5 0 01-1 0v-2A.5.5 0 018 0zm0 13a.5.5 0 01.5.5v2a.5.5 0 01-1 0v-2A.5.5 0 018 13zm8-5a.5.5 0 01-.5.5h-2a.5.5 0 010-1h2a.5.5 0 01.5.5zM3 8a.5.5 0 01-.5.5h-2a.5.5 0 010-1h2A.5.5 0 013 8z"/>
          </svg>
        </ToolBtn>
        {showAdjust && (
          <div style={{
            position: 'absolute', left: 'calc(100% + 8px)', top: 0, zIndex: 300,
            background: 'rgba(3,8,25,0.98)',
            border: '1px solid rgba(255,255,255,0.14)',
            borderRadius: 8, padding: '12px 14px', width: 200,
          }}>
            <Slider label="Brightness" value={brightness} min={50} max={200} step={1} unit="%" onChange={setBrightness} />
            <Slider label="Contrast"   value={contrast}   min={50} max={200} step={1} unit="%" onChange={setContrast} />
            <Slider label="Gamma"      value={gamma}      min={0.2} max={3.0} step={0.05} format={v => v.toFixed(2)} onChange={setGamma} />
            <button onClick={resetAdjustments}
              style={{ marginTop: 6, width: '100%', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 4, color: 'rgba(255,255,255,0.45)', fontSize: 11, padding: '4px 0', cursor: 'pointer' }}>
              Reset
            </button>
          </div>
        )}
      </div>

      {/* Brush radius (only when brush is active) */}
      {activeTool === 'brush' && (
        <>
          <Divider />
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
            <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              Size
            </span>
            <input type="range" min={10} max={500} step={5} value={brushRadius}
              onChange={e => setBrushRadius(Number(e.target.value))}
              style={{ writingMode: 'vertical-lr', direction: 'rtl', height: 80, accentColor: '#ffd700' }} />
            <span style={{ fontSize: 9, fontFamily: 'monospace', color: 'rgba(255,255,255,0.55)' }}>
              {brushRadius}px
            </span>
          </div>
        </>
      )}
    </div>
  )
}

function ToolBtn({ active, disabled, title, onClick, children, accentColor = '#1b998b' }) {
  const activeStyle = active
    ? { background: `rgba(${hexToRgb(accentColor)}, 0.18)`, borderColor: accentColor, color: accentColor }
    : {}
  return (
    <button
      title={title}
      disabled={disabled}
      onClick={onClick}
      style={{
        width: 34, height: 34,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(255,255,255,0.04)',
        border: '1px solid rgba(255,255,255,0.1)',
        borderRadius: 6, cursor: disabled ? 'not-allowed' : 'pointer',
        color: 'rgba(255,255,255,0.6)', opacity: disabled ? 0.35 : 1,
        transition: 'all 0.15s',
        ...activeStyle,
      }}
    >
      {children}
    </button>
  )
}

function Divider() {
  return <div style={{ width: 24, height: 1, background: 'rgba(255,255,255,0.07)', margin: '4px 0' }} />
}

function Slider({ label, value, min, max, step, unit = '', format, onChange }) {
  const display = format ? format(value) : value
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
        <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.45)' }}>{label}</span>
        <span style={{ fontSize: 11, fontFamily: 'monospace', color: 'rgba(255,255,255,0.65)' }}>{display}{unit}</span>
      </div>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(parseFloat(e.target.value))}
        style={{ width: '100%', accentColor: '#1b998b', cursor: 'pointer' }} />
    </div>
  )
}

function hexToRgb(hex) {
  const r = parseInt(hex.slice(1,3),16)
  const g = parseInt(hex.slice(3,5),16)
  const b = parseInt(hex.slice(5,7),16)
  return `${r},${g},${b}`
}