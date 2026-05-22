// frontend/src/pages/TMADetail/index.jsx
import { useState, useEffect, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../api'
import { useOSDViewer } from '../../hooks/useOSDViewer'
import SlideTray from '../ProjectDetail/SlideTray' // Reusing your existing component
import TMAUploadWizard from './TMAUploadWizard'
import TMAGridPanel from './TMAGridPanel' // We will define a simple grid below

export default function TMADetail() {
  const { tmaId } = useParams()
  const navigate = useNavigate()
  const token = localStorage.getItem('pathodb_token')
  const [wizardClosed, setWizardClosed] = useState(false)
  const [activeScanId, setActiveScanId] = useState(null)
  const containerRef = useRef(null)
  const osdRef = useRef(null)

  // ─── Data Fetching ───
  const { data: tma, isLoading: tmaLoading } = useQuery({
    queryKey: ['tma', tmaId],
    queryFn: () => api.getTMA(Number(tmaId)),
  })

  const { data: tmaScans = [], refetch: refetchScans } = useQuery({
    queryKey: ['tma-scans', tmaId],
    queryFn: () => api.getProjectScans(Number(tmaId)),
    enabled: !!tma,
  })

  const { data: tmaCores = [], refetch: refetchCores } = useQuery({
    queryKey: ['tma-cores', tmaId],
    queryFn: () => api.getTMACores(Number(tmaId)),
    enabled: !!tma,
  })

  useEffect(() => {
    if (tmaScans.length > 0 && !activeScanId) {
      setActiveScanId(tmaScans[0].scan_id)
    }
  }, [tmaScans]) // eslint-disable-line

  const { data: slideInfo } = useQuery({
    queryKey: ['slide', activeScanId, 'info'],
    queryFn: () => api.getSlideInfo(activeScanId, token),
    enabled: !!activeScanId && !!token,
  })

  // ─── OSD Setup ───
  useOSDViewer({
    containerRef,
    scanId: activeScanId,
    slideInfo,
    token,
    osdRef,
    disableDblClickZoom: false,
  })

  if (tmaLoading) return <div style={{ width:'100vw', height:'100vh', background:'#111827', display:'flex', alignItems:'center', justifyContent:'center', color:'rgba(255,255,255,0.4)' }}>Loading TMA...</div>

  const needsSetup = tmaScans.length === 0 && tmaCores.length === 0 && !wizardClosed;

  // If no scans exist, show the Wizard instead of the viewer
  if (needsSetup) {
    return (
      <div style={{ width: '100vw', height: '100vh', display: 'flex', flexDirection: 'column' }}>
        <div style={{ height: 48, background: 'rgba(3,8,25,0.97)', borderBottom: '1px solid rgba(255,255,255,0.07)', display: 'flex', alignItems: 'center', padding: '0 14px' }}>
          <button onClick={() => navigate('/tmas')} style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.65)', cursor: 'pointer', fontSize: 12 }}>← Back to TMAs</button>
          <div style={{ width: 1, height: 18, background: 'rgba(255,255,255,0.08)', margin: '0 12px' }} />
          <span style={{ fontSize: 13, fontWeight: 500, color: 'rgba(255,255,255,0.8)' }}>{tma?.name} - Initial Setup</span>
        </div>
        
        {/* 4. Refetch BOTH and force the UI to advance */}
        <TMAUploadWizard tmaId={tmaId} onComplete={() => {
            refetchScans();
            refetchCores();
            setWizardClosed(true);
        }} />
      </div>
    )
  }

  return (
    <div style={{ width: '100vw', height: '100vh', background: '#111827', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      
      {/* ── Topbar ── */}
      <div style={{ height: 48, flexShrink: 0, background: 'rgba(3,8,25,0.97)', borderBottom: '1px solid rgba(255,255,255,0.07)', display: 'flex', alignItems: 'center', gap: 10, padding: '0 14px' }}>
        <button onClick={() => navigate('/tmas')} style={{ display:'flex', alignItems:'center', gap:6, padding:'4px 10px', borderRadius:6, background:'rgba(255,255,255,0.05)', border:'1px solid rgba(255,255,255,0.12)', color:'rgba(255,255,255,0.65)', cursor:'pointer', fontSize:12 }}>
          ← TMAs
        </button>
        <div style={{ width: 1, height: 18, background: 'rgba(255,255,255,0.08)' }} />
        <span style={{ fontSize: 13, fontWeight: 500, color: 'rgba(255,255,255,0.8)' }}>{tma?.name}</span>
        <span style={{ fontSize: 9, padding: '2px 8px', borderRadius: 20, background: 'rgba(167,139,250,0.15)', color: '#a78bfa', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          Tissue Microarray
        </span>
      </div>

      {/* ── Body ── */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden', minHeight: 0 }}>
        
        {/* Left: Shared Slide Tray */}
        <SlideTray
          scans={tmaScans}
          activeScanId={activeScanId}
          onSelect={setActiveScanId}
          token={token}
        />

        {/* Center: Viewer */}
        <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
          <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
        </div>

        {/* Right: TMA Logical Grid Panel */}
        <TMAGridPanel cores={tmaCores} />

      </div>
    </div>
  )
}