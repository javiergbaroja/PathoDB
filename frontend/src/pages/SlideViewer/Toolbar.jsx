// frontend/src/pages/SlideViewer/Toolbar.jsx
import { useViewerStore } from '../../store/viewerStore'
import { STAIN_COLORS } from '../../constants/stains'
import { ImageAdjustPopover, ToolBtn } from '../../components/ui'
import { shortcutGroupsFor, SLIDE_VIEWER_ACTIONS } from '../../lib/viewerKeymap'
import { formatHierarchy } from '../../lib/slideNaming'

export default function Toolbar({ handleBack, leftInfo, rightInfo, compareMode, leftZoom, rightZoom, handleCompareToggle }) {
  const {
    isRulerActive,    setIsRulerActive,
    isPolygonActive,  setIsPolygonActive,
    polygons,         clearPolygons,
    showBrightness,   setShowBrightness, brightness, contrast, gamma, setBrightness, setContrast, setGamma, resetAdjustments,
    showModels,       setShowModels,
    panelOpen,        setPanelOpen,
    showShortcuts,    setShowShortcuts,
  } = useViewerStore()

  function handleRulerClick() {
    if (isPolygonActive) setIsPolygonActive(false)
    setIsRulerActive(o => !o)
  }

  function handlePolygonClick() {
    if (isRulerActive) setIsRulerActive(false)
    setIsPolygonActive(o => !o)
  }

  return (
    <>
      <div style={{ height: 48, flexShrink: 0, background: 'rgba(3,8,25,0.97)', borderBottom: '1px solid var(--border-dark)', display: 'flex', alignItems: 'center', gap: 10, padding: '0 14px' }}>

        {/* Back + logo */}
        <ToolBtn onClick={handleBack} title="Back">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M15 8a.5.5 0 00-.5-.5H2.707l3.147-3.146a.5.5 0 10-.708-.708l-4 4a.5.5 0 000 .708l4 4a.5.5 0 00.708-.708L2.707 8.5H14.5A.5.5 0 0015 8z"/></svg>
        </ToolBtn>
        <div style={{ width: 1, height: 18, background: 'var(--border-dark)', flexShrink: 0 }} />
        <span style={{ fontFamily: 'var(--font-serif)', fontSize: 13, color: 'var(--text-dark-3)', letterSpacing: '0.03em', flexShrink: 0 }}>PathoDB</span>
        <div style={{ width: 1, height: 18, background: 'var(--border-dark)', flexShrink: 0 }} />

        {/* Scan info */}
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 8, overflow: 'hidden' }}>
          {leftInfo && (
            <>
              <span
                title={formatHierarchy(leftInfo)}
                style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-dark-3)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
              >
                {formatHierarchy(leftInfo)}
              </span>
              <StainBadge name={leftInfo.stain_name} category={leftInfo.stain_category} side={compareMode ? 'L' : null} zoom={leftZoom} />
              {compareMode && rightInfo && <StainBadge name={rightInfo.stain_name} category={rightInfo.stain_category} side="R" zoom={rightZoom} />}
              {leftInfo.malignancy_flag && (
                <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--viewer-red)', background: 'rgba(230,0,46,0.18)', padding: '2px 8px', borderRadius: 20, letterSpacing: '0.06em', textTransform: 'uppercase', flexShrink: 0 }}>
                  Malignant
                </span>
              )}
            </>
          )}
        </div>

        {/* Tools */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0 }}>

          {/* Ruler */}
          <ToolBtn active={isRulerActive} onClick={handleRulerClick} title="Ruler (L)">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M.5 1a.5.5 0 00-.5.5v13a.5.5 0 00.5.5H2a.5.5 0 00.5-.5V13H3a.5.5 0 000-1h-.5v-1H4a.5.5 0 000-1H2.5V9H3a.5.5 0 000-1h-.5V7H4a.5.5 0 000-1H2.5V5H3a.5.5 0 000-1h-.5v-1H4a.5.5 0 000-1H2.5V1.5A.5.5 0 002 1H.5zm7 0a.5.5 0 00-.5.5v13a.5.5 0 00.5.5h7a.5.5 0 00.5-.5v-13A.5.5 0 0015.5 1h-7z"/></svg>
          </ToolBtn>

          {/* Polygon ROI tool */}
          <ToolBtn
            active={isPolygonActive}
            onClick={handlePolygonClick}
            title="Draw polygon ROI (G)"
            accentColor="var(--viewer-gold)"
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
              <polygon points="8,1.5 14,5.5 12,14 4,14 2,5.5" />
              <circle cx="8"  cy="1.5" r="1.5" fill="currentColor" stroke="none"/>
              <circle cx="14" cy="5.5" r="1.5" fill="currentColor" stroke="none"/>
              <circle cx="4"  cy="14"  r="1.5" fill="currentColor" stroke="none"/>
            </svg>
          </ToolBtn>

          {/* Live ROI indicator + clear */}
          {polygons.length > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 5, background: 'var(--viewer-gold-bg)', border: `1px solid rgba(255,215,0,0.35)`, borderRadius: 5, padding: '3px 8px' }}>
              <span style={{ fontSize: 10, color: 'var(--viewer-gold)', fontWeight: 600 }}>
                {polygons.length} ROI{polygons.length > 1 ? 's' : ''}
              </span>
              <button
                onClick={clearPolygons}
                title="Clear all ROI polygons"
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'rgba(255,215,0,0.65)', fontSize: 13, lineHeight: 1, padding: '0 2px' }}
              >
                ×
              </button>
            </div>
          )}

          {/* Brightness / Contrast */}
          <div style={{ position: 'relative' }}>
            <ToolBtn active={showBrightness} onClick={() => setShowBrightness(o => !o)} title="Brightness / contrast (D)">
              <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M8 11a3 3 0 110-6 3 3 0 010 6zm0 1a4 4 0 100-8 4 4 0 000 8zM8 0a.5.5 0 01.5.5v2a.5.5 0 01-1 0v-2A.5.5 0 018 0zm0 13a.5.5 0 01.5.5v2a.5.5 0 01-1 0v-2A.5.5 0 018 13zm8-5a.5.5 0 01-.5.5h-2a.5.5 0 010-1h2a.5.5 0 01.5.5zM3 8a.5.5 0 01-.5.5h-2a.5.5 0 010-1h2A.5.5 0 013 8zm10.657-5.657a.5.5 0 010 .707l-1.414 1.415a.5.5 0 11-.707-.708l1.414-1.414a.5.5 0 01.707 0zm-9.193 9.193a.5.5 0 010 .707L3.05 13.657a.5.5 0 01-.707-.707l1.414-1.414a.5.5 0 01.707 0zm9.193 2.121a.5.5 0 01-.707 0l-1.414-1.414a.5.5 0 00.707-.707l1.414 1.414a.5.5 0 010 .707zM4.464 4.465a.5.5 0 01-.707 0L2.343 3.05a.5.5 0 11.707-.707l1.414 1.414a.5.5 0 010 .708z"/></svg>
            </ToolBtn>
            {showBrightness && (
              <ImageAdjustPopover
                brightness={brightness} contrast={contrast} gamma={gamma}
                onBrightness={setBrightness} onContrast={setContrast} onGamma={setGamma}
                onReset={resetAdjustments}
                style={{ top: 'calc(100% + 6px)', right: 0, width: 210, background: 'rgba(3,8,25,0.98)' }}
              />
            )}
          </div>

          <div style={{ width: 1, height: 18, background: 'var(--border-dark)' }} />

          {/* Compare */}
          <ToolBtn active={compareMode} onClick={handleCompareToggle} title="Compare two slides side by side">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M0 3a2 2 0 012-2h5a2 2 0 012 2v10a2 2 0 01-2 2H2a2 2 0 01-2-2V3zm9 0a2 2 0 012-2h3a2 2 0 012 2v10a2 2 0 01-2 2h-3a2 2 0 01-2-2V3z"/></svg>
          </ToolBtn>

          {/* Models */}
          <ToolBtn active={showModels} onClick={() => setShowModels(o => !o)} title="Analysis models (A))">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M2 2a2 2 0 012-2h8a2 2 0 012 2v12a2 2 0 01-2 2H4a2 2 0 01-2-2V2zm2 0v12h8V2H4zm1 2h2a.5.5 0 010 1H5a.5.5 0 010-1zm0 2h6a.5.5 0 010 1H5a.5.5 0 010-1zm0 2h6a.5.5 0 010 1H5a.5.5 0 010-1zm0 2h4a.5.5 0 010 1H5a.5.5 0 010-1z"/></svg>
          </ToolBtn>

          <div style={{ width: 1, height: 18, background: 'var(--border-dark)' }} />

          {/* Clinical info */}
          <ToolBtn active={panelOpen} onClick={() => setPanelOpen(o => !o)} title="Clinical info panel (I)">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor"><path d="M8 15A7 7 0 108 1a7 7 0 000 14zm0 1A8 8 0 118 0a8 8 0 010 16z"/><path d="M5.255 5.786a.237.237 0 00.241.247h.825c.138 0 .248-.113.266-.25.09-.656.54-1.134 1.342-1.134.686 0 1.314.343 1.314 1.168 0 .635-.374.927-.965 1.371-.673.489-1.206 1.06-1.168 1.987l.003.217a.25.25 0 00.25.246h.811a.25.25 0 00.25-.25v-.105c0-.718.273-.927 1.01-1.486.609-.463 1.244-.977 1.244-2.056 0-1.511-1.276-2.241-2.673-2.241-1.267 0-2.655.59-2.75 2.286zm1.557 5.763c0 .533.425.927 1.01.927.609 0 1.028-.394 1.028-.927 0-.552-.42-.94-1.029-.94-.584 0-1.009.388-1.009.94z"/></svg>
          </ToolBtn>

          {/* Shortcuts */}
          <ToolBtn active={showShortcuts} onClick={() => setShowShortcuts(o => !o)} title="Keyboard shortcuts (?)">
            <span style={{ fontWeight: 700 }}>?</span>
          </ToolBtn>
        </div>
      </div>

      {showShortcuts && <ShortcutsOverlay onClose={() => setShowShortcuts(false)} />}
    </>
  )
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function StainBadge({ name, category, side, zoom }) {
  const color = STAIN_COLORS[category] || STAIN_COLORS.other
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0 }}>
      <div style={{ width: 6, height: 6, borderRadius: '50%', background: color, flexShrink: 0 }} />
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 600, color }}>{name}{side ? ` (${side})` : ''}</span>
      {zoom && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-dark-3)', background: 'rgba(255,255,255,0.05)', padding: '1px 5px', borderRadius: 3 }}>{zoom}×</span>}
    </div>
  )
}

function ShortcutsOverlay({ onClose }) {
  const groups = shortcutGroupsFor(SLIDE_VIEWER_ACTIONS)
  return (
    <div onClick={onClose} style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200 }}>
      <div onClick={e => e.stopPropagation()} style={{ background: 'rgba(3,8,25,0.98)', border: '1px solid var(--border-dark)', borderRadius: 'var(--radius-xl)', padding: '18px 22px', minWidth: 240 }}>
        <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-dark-2)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 14 }}>Keyboard shortcuts</div>

        {groups.map(group => (
          <div key={group.title} style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 9, fontWeight: 600, color: 'var(--text-dark-3)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 8 }}>{group.title}</div>
            {group.items.map(item => (
              <div key={item.label} style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 9 }}>
                <span style={{ display: 'flex', gap: 4 }}>
                  {item.keys.map(k => (
                    <kbd key={k} style={{ fontSize: 11, fontFamily: 'var(--font-mono)', background: 'rgba(255,255,255,0.07)', border: '1px solid var(--border-dark)', borderRadius: 'var(--radius-sm)', padding: '2px 8px', color: 'var(--text-dark-1)', minWidth: 24, textAlign: 'center' }}>{k}</kbd>
                  ))}
                </span>
                <span style={{ fontSize: 12, color: 'var(--text-dark-2)' }}>{item.label}</span>
              </div>
            ))}
          </div>
        ))}

        <button onClick={onClose} style={{ marginTop: 6, width: '100%', background: 'rgba(255,255,255,0.04)', border: '1px solid var(--border-dark)', borderRadius: 'var(--radius-sm)', color: 'var(--text-dark-3)', fontSize: 11, padding: '5px 0', cursor: 'pointer' }}>Close</button>
      </div>
    </div>
  )
}