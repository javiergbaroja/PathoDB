// frontend/src/pages/SlideViewer/Filmstrip.jsx
import { useMemo, useRef, useEffect } from 'react'
import { STAIN_COLORS } from '../../constants/stains'

export default function Filmstrip({ scans, leftScanId, rightScanId, token, navigate, setIsDragging, scrollRef, activeChipRef, levelPopover, setLevelPopover, submissionId }) {
  const groupedData = useMemo(() => {
    const probeMap = {}
    scans.forEach(scan => {
      if (!probeMap[scan.probe_id]) {
        probeMap[scan.probe_id] = {
          probe_id:        scan.probe_id,
          lis_probe_id:    scan.lis_probe_id || String(scan.probe_id),
          topo_description: scan.topo_description || 'Unknown site',
          blocks: {},
        }
      }
      const probe = probeMap[scan.probe_id]
      if (!probe.blocks[scan.block_id]) {
        probe.blocks[scan.block_id] = { block_id: scan.block_id, block_label: scan.block_label, stains: {} }
      }
      const block = probe.blocks[scan.block_id]
      if (!block.stains[scan.stain_name]) block.stains[scan.stain_name] = []
      block.stains[scan.stain_name].push(scan)
    })

    return Object.values(probeMap)
      .sort((a, b) => a.probe_id - b.probe_id)
      .map(probe => ({
        ...probe,
        blocks: Object.values(probe.blocks)
          .sort((a, b) => a.block_label.localeCompare(b.block_label, undefined, { numeric: true }))
          .map(block => ({
            ...block,
            stainGroups: Object.entries(block.stains)
              .sort(([a], [b]) => {
                const catA = block.stains[a][0]?.stain_category || 'other'
                const catB = block.stains[b][0]?.stain_category || 'other'
                if (catA === 'HE' && catB !== 'HE') return -1
                if (catB === 'HE' && catA !== 'HE') return  1
                return a.localeCompare(b)
              })
              .map(([name, scans]) => ({ name, scans })),
          })),
      }))
  }, [scans])

  if (!scans.length) return null

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', padding: '4px 14px', borderBottom: '1px solid rgba(255,255,255,0.04)', gap: 12, flexShrink: 0 }}>
        <span style={{ fontSize: 9, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.6)', flexShrink: 0 }}>
          {submissionId || 'Case'} · {scans.length} scan{scans.length !== 1 ? 's' : ''}
        </span>
        <div style={{ display: 'flex', gap: 10 }}>
          {[['HE','H&E'], ['IHC','IHC'], ['special_stain','Special'], ['FISH','FISH']].map(([cat, lbl]) =>
            scans.some(s => s.stain_category === cat) ? (
              <div key={cat} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <div style={{ width: 6, height: 6, borderRadius: '50%', background: STAIN_COLORS[cat] }} />
                <span style={{ fontSize: 9, color: 'rgba(255,255,255,0.55)' }}>{lbl}</span>
              </div>
            ) : null
          )}
        </div>
      </div>

      <div ref={scrollRef} style={{ flex: 1, overflowX: 'auto', overflowY: 'clip', display: 'flex', alignItems: 'flex-start', padding: '8px 14px 8px', gap: 0 }}>
        {groupedData.map((probe, pi) => (
          <div key={probe.probe_id} style={{ display: 'flex', alignItems: 'flex-start', flexShrink: 0 }}>
            {pi > 0 && <div style={{ width: 1, alignSelf: 'stretch', background: 'rgba(255,255,255,0.07)', margin: '0 14px' }} />}
            <div style={{ display: 'flex', flexDirection: 'column', flexShrink: 0 }}>
              <div style={{ fontSize: 10, fontWeight: 600, color: 'rgba(255,255,255,0.70)', letterSpacing: '0.04em', textTransform: 'uppercase', paddingBottom: 5, maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {probe.lis_probe_id} · {probe.topo_description}
              </div>
              <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                {probe.blocks.map((block, bi) => (
                  <div key={block.block_id} style={{ display: 'flex', flexDirection: 'column', flexShrink: 0 }}>
                    {probe.blocks.length > 1 && (
                      <div style={{ fontSize: 9, fontWeight: 600, color: 'rgba(255,255,255,0.55)', textAlign: 'center', paddingBottom: 4 }}>
                        Block {block.block_label}
                      </div>
                    )}
                    <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
                      {block.stainGroups.map(({ name: sName, scans: sScans }) => (
                        <StainChip
                          key={sName} stainName={sName} stainScans={sScans} blockId={block.block_id}
                          leftScanId={leftScanId} rightScanId={rightScanId} token={token} navigate={navigate}
                          setIsDragging={setIsDragging} activeChipRef={activeChipRef}
                          levelPopover={levelPopover} setLevelPopover={setLevelPopover}
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function StainChip({ stainName, stainScans, blockId, leftScanId, rightScanId, token, navigate, setIsDragging, activeChipRef, levelPopover, setLevelPopover }) {
  const hasMultiple  = stainScans.length > 1
  const isLeftActive  = stainScans.some(s => s.scan_id === leftScanId)
  const isRightActive = stainScans.some(s => s.scan_id === rightScanId)
  const repScan  = stainScans.find(s => s.scan_id === leftScanId) || stainScans.find(s => s.scan_id === rightScanId) || stainScans[0]
  const color    = STAIN_COLORS[repScan.stain_category] || STAIN_COLORS.other
  const borderColor = isLeftActive ? '#1b998b' : isRightActive ? '#e69a00' : 'rgba(255,255,255,0.09)'
  const bg = isLeftActive ? 'rgba(27,153,139,0.1)' : isRightActive ? 'rgba(230,154,0,0.1)' : 'rgba(255,255,255,0.02)'
  const popoverOpen = levelPopover?.blockId === blockId && levelPopover?.stainName === stainName

  function handleClick() {
    if (hasMultiple) {
      setLevelPopover(popoverOpen ? null : { blockId, stainName })
    } else if (!isLeftActive) {
      navigate(`/viewer/${stainScans[0].scan_id}`)
    }
  }

  return (
    <div style={{ position: 'relative', flexShrink: 0 }}>
      <div
        ref={isLeftActive ? activeChipRef : null}
        className={`sv-scan-chip${isLeftActive ? ' sv-active-l' : isRightActive ? ' sv-active-r' : ''}`}
        draggable onDragStart={e => { e.dataTransfer.setData('scanId', String(repScan.scan_id)); setIsDragging(true) }}
        onDragEnd={() => setIsDragging(false)} onClick={handleClick}
        title={`${stainName}${hasMultiple ? ` (${stainScans.length} levels)` : ''}`}
        style={{ width: 84, border: `1.5px solid ${borderColor}`, borderRadius: 6, overflow: 'hidden', cursor: isLeftActive && !hasMultiple ? 'default' : 'pointer', background: bg, userSelect: 'none' }}
      >
        <div style={{ height: 3, background: color }} />
        <div style={{ height: 70, background: '#0d1623', position: 'relative', overflow: 'hidden' }}>
          <img src={`/api/slides/${repScan.scan_id}/thumbnail?width=128&token=${token}`} alt={stainName} loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
          {hasMultiple && <div style={{ position: 'absolute', top: 3, right: 3, background: 'rgba(0,0,0,0.75)', color: 'white', fontSize: 9, fontWeight: 700, padding: '1px 5px', borderRadius: 3 }}>{stainScans.length}</div>}
          {isLeftActive  && <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: 2, background: '#1b998b' }} />}
          {isRightActive && !isLeftActive && <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: 2, background: '#e69a00' }} />}
        </div>
        <div style={{ padding: '3px 6px 5px' }}>
          <div style={{ fontSize: 10, fontWeight: 600, color: 'rgba(255,255,255,0.78)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{stainName}</div>
          <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.55)', marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {repScan.stain_category}{repScan.magnification ? ` · ${repScan.magnification}×` : ''}{hasMultiple ? ` · ${stainScans.length} lvl` : ''}
          </div>
        </div>
      </div>
      {popoverOpen && <LevelPopover scans={stainScans} stainName={stainName} leftScanId={leftScanId} rightScanId={rightScanId} token={token} navigate={navigate} setIsDragging={setIsDragging} onClose={() => setLevelPopover(null)} />}
    </div>
  )
}

function LevelPopover({ scans, stainName, leftScanId, rightScanId, token, navigate, setIsDragging, onClose }) {
  const ref = useRef(null)
  useEffect(() => {
    function handler(e) { if (ref.current && !ref.current.contains(e.target)) onClose() }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose])

  return (
    <div ref={ref} style={{ position: 'absolute', bottom: 'calc(100% + 6px)', left: 0, zIndex: 200, background: 'rgba(3,8,25,0.98)', border: '1px solid rgba(255,255,255,0.14)', borderRadius: 8, padding: '8px', display: 'flex', gap: 6, alignItems: 'flex-end', boxShadow: '0 8px 24px rgba(0,0,0,0.6)' }}>
      <div style={{ fontSize: 9, fontWeight: 600, color: 'rgba(255,255,255,0.60)', textTransform: 'uppercase', letterSpacing: '0.08em', alignSelf: 'center', marginRight: 4, flexShrink: 0 }}>{stainName}</div>
      {scans.map((scan, i) => {
        const isLeft  = scan.scan_id === leftScanId
        const isRight = scan.scan_id === rightScanId
        return (
          <div
            key={scan.scan_id} draggable onDragStart={e => { e.dataTransfer.setData('scanId', String(scan.scan_id)); setIsDragging(true) }}
            onDragEnd={() => setIsDragging(false)} onClick={() => { if (!isLeft) { navigate(`/viewer/${scan.scan_id}`); onClose() } }}
            style={{ width: 72, cursor: isLeft ? 'default' : 'pointer', border: `1.5px solid ${isLeft ? '#1b998b' : isRight ? '#e69a00' : 'rgba(255,255,255,0.1)'}`, borderRadius: 5, overflow: 'hidden', background: isLeft ? 'rgba(27,153,139,0.1)' : 'rgba(255,255,255,0.02)', flexShrink: 0 }}
          >
            <div style={{ height: 56, background: '#0d1623', position: 'relative' }}>
              <img src={`/api/slides/${scan.scan_id}/thumbnail?width=96&token=${token}`} alt={`Level ${i + 1}`} loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
              {isLeft && <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: 2, background: '#1b998b' }} />}
            </div>
            <div style={{ padding: '3px 5px 4px', fontSize: 9, color: 'rgba(255,255,255,0.55)', textAlign: 'center' }}>Level {i + 1}</div>
          </div>
        )
      })}
    </div>
  )
}