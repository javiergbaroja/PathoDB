/**
 * Consent status shield icons.
 *
 * Three variants — all share the same 16×16 shield silhouette:
 *   • ConsentGranted  — teal tick   (consented / informed)
 *   • ConsentRefused  — crimson ×   (refused)
 *   • ConsentUnknown  — grey ?      (unknown / null)
 *
 * Usage:
 *   <ConsentIcon status="consented" />   // renders ConsentGranted
 *   <ConsentIcon status={null} />        // renders ConsentUnknown
 */
import React from 'react'

const SIZE = 14

// ── Shared shield outline path (fill provided by parent color) ───────────────
const SHIELD = "M8 0c-.69 0-1.843.265-2.928.56C3.978.88 2.748 1.137 2 1.137V7c0 3.738 2.35 6.345 5.648 7.886a.774.774 0 00.704 0C11.65 13.345 14 10.738 14 7V1.137c-.748 0-1.978-.257-3.072-.577C9.843.265 8.69 0 8 0z"

export function ConsentGranted({ size = SIZE, style, title = 'Consented' }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} style={style} role="img" aria-label={title}>
      <title>{title}</title>
      <path d={SHIELD} fill="var(--teal)" opacity="0.18" />
      <path d={SHIELD} fill="none" stroke="var(--teal)" strokeWidth="0.8" />
      {/* Tick — matches the cross weight */}
      <path d="M5.5 8.2l1.8 1.8 3.2-3.6" fill="none" stroke="var(--teal)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function ConsentRefused({ size = SIZE, style, title = 'Refused' }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} style={style} role="img" aria-label={title}>
      <title>{title}</title>
      <path d={SHIELD} fill="var(--crimson)" opacity="0.12" />
      <path d={SHIELD} fill="none" stroke="var(--crimson)" strokeWidth="0.8" />
      {/* Cross — two diagonal strokes, same weight as the tick */}
      <path d="M6 5.5l4 5M10 5.5l-4 5" fill="none" stroke="var(--crimson)" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

export function ConsentUnknown({ size = SIZE, style, title = 'Unknown / not recorded' }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} style={style} role="img" aria-label={title}>
      <title>{title}</title>
      <path d={SHIELD} fill="var(--text-3)" opacity="0.12" />
      <path d={SHIELD} fill="none" stroke="var(--text-3)" strokeWidth="0.8" />
      {/* Question mark */}
      <text x="8" y="10.5" textAnchor="middle" fontSize="7.5" fontWeight="700" fontFamily="var(--font-sans)" fill="var(--text-3)">?</text>
    </svg>
  )
}

/**
 * Convenience mapper — renders the right shield for a consent value.
 * Accepts the raw DB string (consented | informed | refused | unknown | null).
 */
export function ConsentIcon({ status, size = SIZE, style }) {
  switch (status) {
    case 'consented':
    case 'informed':
      return <ConsentGranted size={size} style={style} title={status === 'informed' ? 'Informed' : 'Consented'} />
    case 'refused':
      return <ConsentRefused size={size} style={style} />
    default:
      return <ConsentUnknown size={size} style={style} />
  }
}