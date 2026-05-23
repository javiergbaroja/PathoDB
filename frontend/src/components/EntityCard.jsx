import { useState } from 'react'

// Shared media card for list pages (Projects, TMAs, …): a clickable card with a
// thumbnail (with fallback icon + overlay slot), title/description, an arbitrary
// body, and a footer action row. Visual shell is identical across pages; the
// variable parts are passed in.
export default function EntityCard({
  onClick,
  thumbnailSrc,
  thumbnailHeight = 140,
  thumbnailAlt = '',
  fallbackIcon,
  thumbnailOverlay,
  title,
  description,
  children,
  footer,
  footerStyle,
}) {
  const [imgError, setImgError] = useState(false)

  return (
    <div
      onClick={onClick}
      style={{
        background: 'var(--white)', borderRadius: 10, overflow: 'hidden',
        border: '1px solid var(--border-l)', cursor: 'pointer',
        boxShadow: 'var(--shadow-s)', transition: 'all 0.15s',
        display: 'flex', flexDirection: 'column',
      }}
      onMouseEnter={e => { e.currentTarget.style.boxShadow = 'var(--shadow-m)'; e.currentTarget.style.transform = 'translateY(-2px)' }}
      onMouseLeave={e => { e.currentTarget.style.boxShadow = 'var(--shadow-s)'; e.currentTarget.style.transform = 'translateY(0)' }}
    >
      {/* Thumbnail */}
      <div style={{ height: thumbnailHeight, background: 'var(--surface-dark-2)', position: 'relative', overflow: 'hidden', flexShrink: 0 }}>
        {thumbnailSrc && !imgError ? (
          <img
            src={thumbnailSrc}
            alt={thumbnailAlt}
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
            onError={() => setImgError(true)}
          />
        ) : (
          <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            {fallbackIcon}
          </div>
        )}
        {thumbnailOverlay}
      </div>

      {/* Body */}
      <div style={{ padding: '12px 14px', flex: 1, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--navy)', marginBottom: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {title}
          </div>
          {description && (
            <div style={{ fontSize: 11, color: 'var(--text-3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {description}
            </div>
          )}
        </div>
        {children}
      </div>

      {/* Footer actions */}
      {footer && (
        <div onClick={e => e.stopPropagation()} style={{ padding: '10px 14px', borderTop: '1px solid var(--border-l)', display: 'flex', alignItems: 'center', ...footerStyle }}>
          {footer}
        </div>
      )}
    </div>
  )
}
