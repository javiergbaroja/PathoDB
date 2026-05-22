// frontend/src/pages/TMADetail/index.jsx
import { useState, useEffect, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../api'
import { useOSDViewer } from '../../hooks/useOSDViewer'
import { ConfirmDialog } from '../../components/ui'
import SlideTray    from '../ProjectDetail/SlideTray'
import TMAGridPanel from './TMAGridPanel'
import TMAManageModal from './TMAManageModal'

export default function TMADetail() {
  const { tmaId }    = useParams()
  const navigate     = useNavigate()
  const queryClient  = useQueryClient()
  const token        = localStorage.getItem('pathodb_token')

  const [activeScanId,   setActiveScanId]   = useState(null)
  const [showManage,     setShowManage]     = useState(false)
  const [showDelete,     setShowDelete]     = useState(false)
  const [deleting,       setDeleting]       = useState(false)

  const containerRef = useRef(null)
  const osdRef       = useRef(null)

  // ── Data fetching ──────────────────────────────────────────────────────────

  const { data: tma, isLoading: tmaLoading } = useQuery({
    queryKey: ['tma', tmaId],
    queryFn:  () => api.getTMA(Number(tmaId)),
  })

  const { data: tmaScans = [], refetch: refetchScans } = useQuery({
    queryKey: ['tma-scans', tmaId],
    queryFn:  () => api.getProjectScans(Number(tmaId)),
    enabled:  !!tmaId,
  })

  const { data: tmaCores = [], refetch: refetchCores } = useQuery({
    queryKey: ['tma-cores', tmaId],
    queryFn:  () => api.getTMACores(Number(tmaId)),
    enabled:  !!tmaId,
  })

  const { data: slideInfo } = useQuery({
    queryKey: ['slide', activeScanId, 'info'],
    queryFn:  () => api.getSlideInfo(activeScanId, token),
    enabled:  !!activeScanId && !!token,
  })

  // ── Auto-select first scan ─────────────────────────────────────────────────
  useEffect(() => {
    if (tmaScans.length > 0 && !activeScanId) {
      setActiveScanId(tmaScans[0].scan_id)
    }
  }, [tmaScans]) // eslint-disable-line

  // ── OSD viewer ─────────────────────────────────────────────────────────────
  useOSDViewer({
    containerRef,
    scanId:    activeScanId,
    slideInfo,
    token,
    osdRef,
    disableDblClickZoom: false,
  })

  // ── Auto-open manage modal if no data yet ─────────────────────────────────
  // Only fires once when the TMA is first loaded and has no data
  const autoOpenedRef = useRef(false)
  useEffect(() => {
    if (autoOpenedRef.current) return
    if (!tmaLoading && tmaScans.length === 0 && tmaCores.length === 0) {
      autoOpenedRef.current = true
      setShowManage(true)
    }
  }, [tmaLoading, tmaScans.length, tmaCores.length])

  // ── Delete ─────────────────────────────────────────────────────────────────
  async function handleDelete() {
    setDeleting(true)
    try {
      await api.deleteTMA(Number(tmaId))
      navigate('/tmas')
    } catch (e) {
      console.error(e)
      setDeleting(false)
      setShowDelete(false)
    }
  }

  // ── Open selected scan in viewer ───────────────────────────────────────────
  function handleOpenInViewer() {
    if (activeScanId) navigate(`/viewer/${activeScanId}`)
  }

  // ── Derived stats ──────────────────────────────────────────────────────────
  const matchedCores   = tmaCores.filter(c => c.core_type === 'tissue' && c.donor_block_id).length
  const unmatchedCores = tmaCores.filter(c => c.core_type === 'tissue' && !c.donor_block_id).length

  if (tmaLoading) {
    return (
      <div style={{
        width: '100vw', height: '100vh', background: 'var(--surface-dark)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: 'rgba(255,255,255,0.4)', fontSize: 14,
      }}>
        Loading TMA…
      </div>
    )
  }

  return (
    <div style={{ width: '100vw', height: '100vh', background: 'var(--surface-dark)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

      {/* ── Topbar ── */}
      <div style={{
        height: 48, flexShrink: 0,
        background: 'rgba(3,8,25,0.97)',
        borderBottom: '1px solid var(--border-dark)',
        display: 'flex', alignItems: 'center', gap: 10, padding: '0 14px',
      }}>
        {/* Back */}
        <button
          onClick={() => navigate('/tmas')}
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '4px 10px', borderRadius: 6,
            background: 'rgba(255,255,255,0.05)',
            border: '1px solid rgba(255,255,255,0.12)',
            color: 'rgba(255,255,255,0.65)', cursor: 'pointer', fontSize: 12,
            fontFamily: 'var(--font-sans)',
          }}
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
            <path d="M15 8a.5.5 0 00-.5-.5H2.707l3.147-3.146a.5.5 0 10-.708-.708l-4 4a.5.5 0 000 .708l4 4a.5.5 0 00.708-.708L2.707 8.5H14.5A.5.5 0 0015 8z"/>
          </svg>
          TMAs
        </button>

        <div style={{ width: 1, height: 18, background: 'var(--border-dark)', flexShrink: 0 }} />

        {/* Name */}
        <span style={{ fontSize: 13, fontWeight: 500, color: 'rgba(255,255,255,0.85)' }}>
          {tma?.name}
        </span>

        {/* Type badge */}
        <span style={{
          fontSize: 9, padding: '2px 8px', borderRadius: 20,
          background: 'rgba(167,139,250,0.15)', color: '#a78bfa',
          fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', flexShrink: 0,
        }}>
          TMA
        </span>

        {/* Stats */}
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <StatChip value={tmaScans.length} label="scans" />
          {tmaCores.length > 0 && (
            <>
              <StatChip value={matchedCores}   label="matched"   color="var(--teal)" />
              {unmatchedCores > 0 && (
                <StatChip value={unmatchedCores} label="unmatched" color="rgba(255,255,255,0.35)" />
              )}
            </>
          )}
        </div>

        <div style={{ flex: 1 }} />

        {/* Open in viewer */}
        {activeScanId && (
          <button
            onClick={handleOpenInViewer}
            style={{
              display: 'flex', alignItems: 'center', gap: 5,
              padding: '5px 10px', borderRadius: 6, fontSize: 11,
              background: 'rgba(27,153,139,0.12)',
              border: '1px solid rgba(27,153,139,0.3)',
              color: 'var(--viewer-teal-light)', cursor: 'pointer',
              fontFamily: 'var(--font-sans)',
            }}
          >
            <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor">
              <path d="M1.5 1h5a.5.5 0 010 1h-5a.5.5 0 01-.5-.5v-5a.5.5 0 011 0v3.793L13.146.146a.5.5 0 01.708.708L1.5 13.146V1zM14.5 15h-13a.5.5 0 010-1h13a.5.5 0 010 1z"/>
            </svg>
            Open in Viewer
          </button>
        )}

        {/* Manage */}
        <button
          onClick={() => setShowManage(true)}
          style={{
            display: 'flex', alignItems: 'center', gap: 5,
            padding: '5px 10px', borderRadius: 6, fontSize: 11,
            background: 'rgba(255,255,255,0.05)',
            border: '1px solid rgba(255,255,255,0.15)',
            color: 'rgba(255,255,255,0.7)', cursor: 'pointer',
            fontFamily: 'var(--font-sans)',
          }}
        >
          <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor">
            <path d="M8 4.754a3.246 3.246 0 100 6.492 3.246 3.246 0 000-6.492zM5.754 8a2.246 2.246 0 114.492 0 2.246 2.246 0 01-4.492 0z"/>
            <path d="M9.796 1.343c-.527-1.79-3.065-1.79-3.592 0l-.094.319a.873.873 0 01-1.255.52l-.292-.16c-1.64-.892-3.433.902-2.54 2.541l.159.292a.873.873 0 01-.52 1.255l-.319.094c-1.79.527-1.79 3.065 0 3.592l.319.094a.873.873 0 01.52 1.255l-.16.292c-.892 1.64.901 3.434 2.541 2.54l.292-.159a.873.873 0 011.255.52l.094.319c.527 1.79 3.065 1.79 3.592 0l.094-.319a.873.873 0 011.255-.52l.292.16c1.64.893 3.434-.902 2.54-2.541l-.159-.292a.873.873 0 01.52-1.255l.319-.094c1.79-.527 1.79-3.065 0-3.592l-.319-.094a.873.873 0 01-.52-1.255l.16-.292c.893-1.64-.902-3.433-2.541-2.54l-.292.159a.873.873 0 01-1.255-.52l-.094-.319z"/>
          </svg>
          Manage Data
        </button>

        {/* Delete */}
        <button
          onClick={() => setShowDelete(true)}
          title="Delete TMA"
          style={{
            width: 32, height: 32, borderRadius: 6,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'rgba(230,0,46,0.08)',
            border: '1px solid rgba(230,0,46,0.2)',
            color: 'var(--viewer-red)', cursor: 'pointer',
          }}
        >
          <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
            <path d="M5.5 5.5A.5.5 0 016 6v6a.5.5 0 01-1 0V6a.5.5 0 01.5-.5zm2.5 0a.5.5 0 01.5.5v6a.5.5 0 01-1 0V6a.5.5 0 01.5-.5zm3 .5a.5.5 0 00-1 0v6a.5.5 0 001 0V6z"/>
            <path fillRule="evenodd" d="M14.5 3a1 1 0 01-1 1H13v9a2 2 0 01-2 2H5a2 2 0 01-2-2V4h-.5a1 1 0 01-1-1V2a1 1 0 011-1H6a1 1 0 011-1h2a1 1 0 011 1h3.5a1 1 0 011 1v1zM4.118 4L4 4.059V13a1 1 0 001 1h6a1 1 0 001-1V4.059L11.882 4H4.118zM2.5 3V2h11v1h-11z"/>
          </svg>
        </button>
      </div>

      {/* ── Body ── */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden', minHeight: 0 }}>

        {/* Left: Slide Tray */}
        <SlideTray
          scans={tmaScans}
          activeScanId={activeScanId}
          onSelect={setActiveScanId}
          token={token}
        />

        {/* Center: Viewer */}
        <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
          {/* Empty state overlay when no scans */}
          {tmaScans.length === 0 && (
            <div style={{
              position: 'absolute', inset: 0, zIndex: 10,
              display: 'flex', flexDirection: 'column',
              alignItems: 'center', justifyContent: 'center',
              gap: 12, color: 'rgba(255,255,255,0.4)',
              background: 'var(--surface-dark)',
            }}>
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" style={{ opacity: 0.25 }}>
                <rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>
              </svg>
              <div style={{ fontSize: 14, fontWeight: 500 }}>No WSI scans uploaded yet</div>
              <div style={{ fontSize: 12, opacity: 0.7 }}>Upload scan paths using the Manage Data panel</div>
              <button
                onClick={() => setShowManage(true)}
                style={{
                  marginTop: 4, padding: '8px 16px', borderRadius: 6, fontSize: 12,
                  background: 'rgba(27,153,139,0.15)',
                  border: '1px solid rgba(27,153,139,0.3)',
                  color: 'var(--viewer-teal-light)', cursor: 'pointer',
                  fontFamily: 'var(--font-sans)',
                }}
              >
                Open Manage Data
              </button>
            </div>
          )}
          <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
        </div>

        {/* Right: Grid Panel */}
        <TMAGridPanel cores={tmaCores} />
      </div>

      {/* ── Modals ── */}
      <TMAManageModal
        isOpen={showManage}
        onClose={() => setShowManage(false)}
        tmaId={tmaId}
        coreCount={tmaCores.length}
        scanCount={tmaScans.length}
        onCoresUpdated={() => {
          queryClient.invalidateQueries({ queryKey: ['tma-cores', tmaId] })
          queryClient.invalidateQueries({ queryKey: ['tma', tmaId] })
          refetchCores()
        }}
        onScansUpdated={() => {
          queryClient.invalidateQueries({ queryKey: ['tma-scans', tmaId] })
          queryClient.invalidateQueries({ queryKey: ['tma', tmaId] })
          refetchScans()
        }}
      />

      <ConfirmDialog
        isOpen={showDelete}
        onClose={() => setShowDelete(false)}
        onConfirm={handleDelete}
        title="Delete TMA?"
        message={`This will permanently delete "${tma?.name}" and all its core mappings and scan associations. The original slide files are not affected.`}
        confirmLabel="Delete TMA"
        loading={deleting}
      />
    </div>
  )
}

function StatChip({ value, label, color }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 4,
      fontSize: 10, color: color || 'rgba(255,255,255,0.4)',
      background: 'rgba(255,255,255,0.05)',
      border: '1px solid rgba(255,255,255,0.08)',
      borderRadius: 20, padding: '2px 8px',
    }}>
      <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, color: color || 'rgba(255,255,255,0.7)' }}>
        {value}
      </span>
      {label}
    </div>
  )
}