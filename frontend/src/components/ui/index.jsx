/**
 * PathoDB UI Component Library
 * ==============================
 * Single source for all shared UI.
 * Styles live in ./ui.module.css. Design tokens (CSS variables) in /src/index.css.
 */

import React, { useState, useEffect, forwardRef } from 'react'
import s from './ui.module.css'

const cx = (...names) => names.filter(Boolean).join(' ')

// ============================================================
// BADGE
// ============================================================

const BADGE_CLASS = {
  red:     s.badgeRed,
  green:   s.badgeGreen,
  navy:    s.badgeNavy,
  muted:   s.badgeMuted,
  warning: s.badgeWarning,
  teal:    s.badgeTeal,
}

export function Badge({ variant = 'muted', children, style, className }) {
  return (
    <span className={cx(s.badge, BADGE_CLASS[variant], className)} style={style}>
      {children}
    </span>
  )
}

// ============================================================
// BUTTON
// ============================================================

const BTN_CLASS = {
  primary: s.btnPrimary,
  teal:    s.btnTeal,
  ghost:   s.btnGhost,
  danger:  s.btnDanger,
  link:    s.btnLink,
}

export function Btn({
  variant = 'ghost',
  onClick,
  children,
  disabled,
  style,
  className,
  type = 'button',
  small = false,
  icon = null,
  ...rest
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={cx(s.btn, BTN_CLASS[variant], small && s.btnSmall, className)}
      style={style}
      {...rest}
    >
      {icon && <span className={s.btnIcon}>{icon}</span>}
      {children}
    </button>
  )
}

// ============================================================
// SPINNER
// ============================================================

export function Spinner({ size = 20, color = 'var(--navy)', trackColor = 'var(--navy-20)' }) {
  return (
    <div
      className={s.spinner}
      style={{
        width: size,
        height: size,
        borderColor: trackColor,
        borderTopColor: color,
      }}
    />
  )
}

export function SpinnerPage() {
  return (
    <div className={s.spinnerPage}>
      <Spinner size={32} />
    </div>
  )
}

// ============================================================
// ERROR MESSAGE
// ============================================================

export function ErrorMsg({ message, onDismiss, className, style }) {
  if (!message) return null
  return (
    <div className={cx(s.errorMsg, className)} style={style}>
      <span className={s.errorMsgText}>{message}</span>
      {onDismiss && (
        <button onClick={onDismiss} className={s.errorMsgClose}>×</button>
      )}
    </div>
  )
}

// ============================================================
// PANEL
// ============================================================

export function Panel({ title, children, style, className, actions = null }) {
  return (
    <div className={cx(s.panel, className)} style={style}>
      {(title || actions) && (
        <div className={s.panelHeader}>
          {title && <div className={s.panelTitle}>{title}</div>}
          {actions}
        </div>
      )}
      {children}
    </div>
  )
}

// ============================================================
// STAT CARD
// ============================================================

export function StatCard({ label, value, sub, accent }) {
  return (
    <div
      className={s.statCard}
      style={accent ? { borderLeft: `3px solid ${accent}` } : undefined}
    >
      <div className={s.statCardLabel}>{label}</div>
      <div className={s.statCardValue} style={accent ? { color: accent } : undefined}>
        {value}
      </div>
      {sub && <div className={s.statCardSub}>{sub}</div>}
    </div>
  )
}

// ============================================================
// FORM PRIMITIVES
// Forward refs so react-hook-form `register` works seamlessly.
// Usage (controlled):
//   <FormInput value={...} onChange={...} />
// Usage (react-hook-form):
//   <FormInput {...register('email', { required: true })} aria-invalid={!!errors.email} />
// ============================================================

export function FormLabel({ children, htmlFor, className, style }) {
  return (
    <label htmlFor={htmlFor} className={cx(s.formLabel, className)} style={style}>
      {children}
    </label>
  )
}

export const FormInput = forwardRef(function FormInput({ className, style, ...props }, ref) {
  return (
    <input
      ref={ref}
      className={cx(s.formControl, className)}
      style={style}
      {...props}
    />
  )
})

export const FormSelect = forwardRef(function FormSelect({ className, style, children, ...props }, ref) {
  return (
    <select
      ref={ref}
      className={cx(s.formControl, s.formSelect, className)}
      style={style}
      {...props}
    >
      {children}
    </select>
  )
})

export const FormTextarea = forwardRef(function FormTextarea({ className, style, ...props }, ref) {
  return (
    <textarea
      ref={ref}
      className={cx(s.formControl, s.formTextarea, className)}
      style={style}
      {...props}
    />
  )
})

// ── FormField: label + input + optional error message ─────────
export function FormField({ label, htmlFor, error, children, className, style }) {
  return (
    <div className={cx(s.formField, className)} style={style}>
      {label && <FormLabel htmlFor={htmlFor}>{label}</FormLabel>}
      {children}
      {error && <div className={s.formError}>{error}</div>}
    </div>
  )
}

// ============================================================
// TABLE PRIMITIVES
// ============================================================

export function Table({ children, style, className }) {
  return (
    <div className={cx(s.tableWrap, className)} style={style}>
      <table className={s.table}>{children}</table>
    </div>
  )
}

export function Th({ children, style, className }) {
  return <th className={cx(s.th, className)} style={style}>{children}</th>
}

export function Td({ children, mono = false, style, className }) {
  return (
    <td className={cx(s.td, mono && s.tdMono, className)} style={style}>
      {children}
    </td>
  )
}

export function Tr({ children, onClick, selected = false, style, className }) {
  return (
    <tr
      onClick={onClick}
      className={cx(s.tr, onClick && s.trClickable, selected && s.trSelected, className)}
      style={style}
    >
      {children}
    </tr>
  )
}

// ============================================================
// MODAL
// ============================================================

export function Modal({ isOpen, onClose, title, subtitle, children, width = 440 }) {
  if (!isOpen) return null
  return (
    <div onClick={onClose} className={s.modalOverlay}>
      <div onClick={e => e.stopPropagation()} className={s.modalCard} style={{ width }}>
        {(title || onClose) && (
          <div className={s.modalHeader}>
            <div>
              {title && <div className={s.modalTitle}>{title}</div>}
              {subtitle && <div className={s.modalSubtitle}>{subtitle}</div>}
            </div>
            {onClose && (
              <button onClick={onClose} className={s.modalClose}>×</button>
            )}
          </div>
        )}
        <div className={s.modalScroll}>{children}</div>
      </div>
    </div>
  )
}

Modal.Body = function ModalBody({ children, style, className }) {
  return <div className={cx(s.modalBody, className)} style={style}>{children}</div>
}

Modal.Footer = function ModalFooter({ children, className }) {
  return <div className={cx(s.modalFooter, className)}>{children}</div>
}

// ============================================================
// ID CELL
// ============================================================

export function IdCell({ children, className }) {
  return <span className={cx(s.idCell, className)}>{children}</span>
}

// ============================================================
// EMPTY STATE
// ============================================================

export function EmptyState({ icon, title, description, action }) {
  return (
    <div className={s.emptyState}>
      {icon && <div className={s.emptyStateIcon}>{icon}</div>}
      {title && <div className={s.emptyStateTitle}>{title}</div>}
      {description && <div className={s.emptyStateDesc}>{description}</div>}
      {action}
    </div>
  )
}

// ============================================================
// SECTION LABEL & SECTION HEADER
// ============================================================

export function SectionLabel({ children, style, className }) {
  return <div className={cx(s.sectionLabel, className)} style={style}>{children}</div>
}

// Use for in-page H2 titles ("1. Configuration", "Filters", etc.)
export function SectionHeader({ title, subtitle, actions, level = 2, className, style }) {
  const H = `h${level}`
  return (
    <div className={cx(s.pageSection, className)} style={style}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <H className={s.pageSectionTitle}>{title}</H>
          {subtitle && <div className={s.sectionHeaderSub}>{subtitle}</div>}
        </div>
        {actions}
      </div>
    </div>
  )
}

// ============================================================
// DIVIDER
// ============================================================

export function Divider({ vertical = false, style, className }) {
  return (
    <div
      className={cx(vertical ? s.dividerV : s.dividerH, className)}
      style={style}
    />
  )
}

// ============================================================
// PROGRESS BAR
// ============================================================

export function ProgressBar({ value = 0, max = 100, color = 'var(--teal)', height = 4, style, className }) {
  const pct = Math.min(100, Math.max(0, (value / max) * 100))
  return (
    <div className={cx(s.progressTrack, className)} style={{ height, ...style }}>
      <div className={s.progressFill} style={{ width: `${pct}%`, background: color }} />
    </div>
  )
}

// ============================================================
// STATUS DOT
// ============================================================

const STATUS_DOT_COLORS = {
  success: 'var(--teal)',
  warning: 'var(--warning-dot)',
  danger:  'var(--crimson)',
  neutral: 'rgba(255,255,255,0.2)',
  pending: 'var(--navy-20)',
}

export function StatusDot({ status = 'neutral', size = 8 }) {
  return (
    <div
      className={s.statusDot}
      style={{
        width: size,
        height: size,
        background: STATUS_DOT_COLORS[status] || STATUS_DOT_COLORS.neutral,
      }}
    />
  )
}

// ============================================================
// SLIDER ROW
// ============================================================

export function SliderRow({ label, value, min, max, step = 1, onChange, unit = '', format }) {
  const display = format ? format(value) : value
  return (
    <div className={s.sliderRow}>
      <div className={s.sliderHeader}>
        <span className={s.sliderLabel}>{label}</span>
        <span className={s.sliderValue}>{display}{unit}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={e => onChange(parseFloat(e.target.value))}
        className={s.sliderInput}
      />
    </div>
  )
}

// Brightness / contrast / gamma popover shared by both viewer toolbars.
// `style` controls placement (top/left/right) and any width/background overrides.
export function ImageAdjustPopover({
  brightness, contrast, gamma,
  onBrightness, onContrast, onGamma, onReset,
  style,
}) {
  return (
    <div style={{
      position: 'absolute', zIndex: 300,
      background: 'var(--surface-dark-card)',
      border: '1px solid var(--border-dark)',
      borderRadius: 'var(--radius-lg)', padding: '12px 14px', width: 200,
      ...style,
    }}>
      <SliderRow label="Brightness" value={brightness} min={50}  max={200} step={1}    unit="%" onChange={onBrightness} />
      <SliderRow label="Contrast"   value={contrast}   min={50}  max={200} step={1}    unit="%" onChange={onContrast} />
      <SliderRow label="Gamma"      value={gamma}      min={0.2} max={3.0} step={0.05} format={v => v.toFixed(2)} onChange={onGamma} />
      <button
        onClick={onReset}
        style={{ marginTop: 6, width: '100%', background: 'rgba(255,255,255,0.05)', border: '1px solid var(--border-dark)', borderRadius: 'var(--radius-sm)', color: 'var(--text-dark-3)', fontSize: 11, padding: '4px 0', cursor: 'pointer' }}
      >
        Reset
      </button>
    </div>
  )
}

// ============================================================
// ELAPSED TIMER
// ============================================================

export function ElapsedTimer({ since, status }) {
  const [elapsed, setElapsed] = useState(0)

  useEffect(() => {
    const isTerminal = ['done', 'failed', 'cancelled'].includes(status)
    if (isTerminal) return
    const start = new Date(since).getTime()
    const tick = () => setElapsed(Math.floor((Date.now() - start) / 1000))
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [since, status])

  const isTerminal = ['done', 'failed', 'cancelled'].includes(status)
  if (isTerminal) return <span>—</span>

  const m = Math.floor(elapsed / 60)
  const sec = String(elapsed % 60).padStart(2, '0')
  return <span>{m}m {sec}s</span>
}

// ============================================================
// JOB STATUS BADGE
// ============================================================

const JOB_STATUS_MAP = {
  queued:    { label: 'Queued',    variant: 'muted' },
  running:   { label: 'Running',   cls: s.jobBadgeRunning },
  done:      { label: 'Done',      cls: s.jobBadgeDone },
  failed:    { label: 'Failed',    variant: 'red' },
  cancelled: { label: 'Cancelled', cls: s.jobBadgeCancelled },
}

export function JobStatusBadge({ status }) {
  if (!status) return null
  const cfg = JOB_STATUS_MAP[status] || JOB_STATUS_MAP.queued
  if (cfg.variant) return <Badge variant={cfg.variant}>{cfg.label}</Badge>
  return <span className={cx(s.jobBadge, cfg.cls)}>{cfg.label}</span>
}

// ============================================================
// THUMBNAIL
// ============================================================

export function SlideThumbnail({ scanId, token, width = 128, height = 70, alt = 'Slide', style, className }) {
  const [errored, setErrored] = useState(false)
  return (
    <div className={cx(s.thumb, className)} style={{ height, ...style }}>
      {!errored ? (
        <img
          src={`/api/slides/${scanId}/thumbnail?width=${width}&token=${token}`}
          alt={alt}
          loading="lazy"
          className={s.thumbImg}
          onError={() => setErrored(true)}
        />
      ) : (
        <span className={s.thumbFallback}>No preview</span>
      )}
    </div>
  )
}

// ============================================================
// CONFIRM DIALOG
// ============================================================

export function ConfirmDialog({ isOpen, onClose, onConfirm, title, message, confirmLabel = 'Delete', loading = false }) {
  return (
    <Modal isOpen={isOpen} onClose={onClose} title={title} width={380}>
      <Modal.Body>
        <p style={{ fontSize: 'var(--text-base)', color: 'var(--text-2)', lineHeight: 1.6 }}>
          {message}
        </p>
      </Modal.Body>
      <Modal.Footer>
        <Btn variant="ghost" onClick={onClose} disabled={loading}>Cancel</Btn>
        <Btn variant="danger" onClick={onConfirm} disabled={loading}>
          {loading ? 'Deleting…' : confirmLabel}
        </Btn>
      </Modal.Footer>
    </Modal>
  )
}

// ============================================================
// CIRCULAR PROGRESS
// ============================================================

export function CircularProgress({ progress = 0, size = 24, strokeWidth = 3, color = 'var(--warning-dot)', trackColor = 'var(--navy-10)' }) {
  const radius = (size - strokeWidth) / 2
  const circumference = radius * 2 * Math.PI
  const offset = circumference - (progress / 100) * circumference

  return (
    <div style={{ position: 'relative', width: size, height: size, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
      <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
        <circle cx={size / 2} cy={size / 2} r={radius} stroke={trackColor} strokeWidth={strokeWidth} fill="none" />
        <circle
          cx={size / 2} cy={size / 2} r={radius}
          stroke={color} strokeWidth={strokeWidth} fill="none"
          strokeDasharray={circumference} strokeDashoffset={offset}
          strokeLinecap="round"
          style={{ transition: 'stroke-dashoffset 0.3s ease' }}
        />
      </svg>
    </div>
  )
}

// ============================================================
// SEGMENTED CONTROL
// Supports: dark theme (for viewer chrome), small size.
// Each option: [value, label] or { value, label, icon }
// ============================================================

export function SegmentedControl({ options, value, onChange, dark = false, small = false, className, style }) {
  const normalized = options.map(o => Array.isArray(o) ? { value: o[0], label: o[1] } : o)
  return (
    <div
      className={cx(s.segmented, dark && s.segmentedDark, small && s.segmentedSmall, className)}
      style={style}
      role="tablist"
    >
      {normalized.map(opt => (
        <button
          key={opt.value}
          type="button"
          role="tab"
          aria-selected={value === opt.value}
          onClick={() => onChange(opt.value)}
          className={cx(s.segmentedBtn, value === opt.value && s.segmentedBtnActive)}
        >
          {opt.icon && <span style={{ marginRight: 6, display: 'inline-flex' }}>{opt.icon}</span>}
          {opt.label}
        </button>
      ))}
    </div>
  )
}

// ============================================================
// KEY-VALUE ROW
// For metadata displays (ClinicalPanel, SummaryPanel, etc.)
// ============================================================

export function KeyValueRow({ label, value, mono = false, dark = false, border = true, className, style }) {
  return (
    <div
      className={cx(s.kvRow, border && s.kvRowBorder, dark && s.kvRowDark, className)}
      style={style}
    >
      <span className={cx(s.kvLabel, dark && s.kvLabelDark)}>{label}</span>
      <span className={cx(s.kvValue, dark && s.kvValueDark, mono && s.kvValueMono)}>
        {value ?? '—'}
      </span>
    </div>
  )
}

// ============================================================
// MULTI-SELECT AUTOCOMPLETE
// ============================================================

export function MultiSelect({ label, selected, onChange, placeholder, loadOptions }) {
  const [query,       setQuery]       = useState('')
  const [suggestions, setSuggestions] = useState([])
  const [show,        setShow]        = useState(false)
  const wrapperRef = React.useRef(null)

  useEffect(() => {
    function handler(e) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) setShow(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  async function fetchSuggestions(val) {
    setQuery(val)
    if (val.length > 0) {
      try {
        const res = await loadOptions(val)
        setSuggestions(res.filter(item => !selected?.includes(item)))
        setShow(true)
      } catch {
        /* swallow */
      }
    } else {
      setSuggestions([])
      setShow(false)
    }
  }

  function add(item) {
    if (!selected?.includes(item)) onChange([...(selected || []), item])
  }
  function remove(item) { onChange(selected.filter(i => i !== item)) }

  return (
    <div ref={wrapperRef} className={s.multi}>
      {label && <FormLabel>{label}</FormLabel>}
      <div className={s.multiBox}>
        {selected?.map(item => (
          <span key={item} className={s.multiChip}>
            {item}
            <b className={s.multiChipRemove} onClick={() => remove(item)}>×</b>
          </span>
        ))}
        <input
          className={s.multiInput}
          placeholder={selected?.length ? '' : placeholder}
          value={query}
          onChange={e => fetchSuggestions(e.target.value)}
          onFocus={() => query && setShow(true)}
        />
        {query && (
          <button onClick={() => { setQuery(''); setShow(false) }} className={s.multiClear}>×</button>
        )}
      </div>
      {show && suggestions.length > 0 && (
        <div className={s.multiDropdown}>
          {suggestions.map(item => (
            <div key={item} onClick={() => add(item)} className={s.multiOption}>
              {item}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ============================================================
// TOOL BUTTON (Dark Mode)
// ============================================================

export function ToolBtn({ active, disabled, title, onClick, children, accentColor = 'var(--viewer-teal-light)' }) {
  const activeStyle = active
    ? { background: `${accentColor}2e`, borderColor: accentColor, color: accentColor }
    : undefined
  return (
    <button
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={s.toolBtn}
      style={activeStyle}
    >
      {children}
    </button>
  )
}

// ============================================================
// LIST-PAGE PRIMITIVES
// ============================================================

// Responsive auto-fill card grid shared by the list/index pages.
export function CardGrid({ minColWidth = 280, gap = 16, children, style }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: `repeat(auto-fill, minmax(${minColWidth}px, 1fr))`, gap, ...style }}>
      {children}
    </div>
  )
}

// Primary "New X" action button with the standard plus glyph.
export function CreateButton({ label, onClick }) {
  return (
    <Btn variant="primary" onClick={onClick}>
      <svg width="12" height="12" viewBox="0 0 16 16" fill="white"><path d="M8 2a.5.5 0 01.5.5v5h5a.5.5 0 010 1h-5v5a.5.5 0 01-1 0v-5h-5a.5.5 0 010-1h5v-5A.5.5 0 018 2z"/></svg>
      {label}
    </Btn>
  )
}

// ============================================================
// FORM MODAL / FILE DROP / RADIO CARDS
// ============================================================

// Modal + body + standard Cancel/submit footer + error banner. Wraps the
// common "fill a form and submit" dialog shape.
export function FormModal({
  isOpen, onClose, title, subtitle, width,
  onSubmit, submitLabel = 'Save', loadingLabel, submitVariant = 'primary',
  loading = false, canSubmit = true, error, children,
}) {
  return (
    <Modal isOpen={isOpen} onClose={onClose} title={title} subtitle={subtitle} width={width}>
      <Modal.Body>
        <ErrorMsg message={error} />
        {children}
      </Modal.Body>
      <Modal.Footer>
        <Btn variant="ghost" onClick={onClose} disabled={loading}>Cancel</Btn>
        <Btn variant={submitVariant} onClick={onSubmit} disabled={loading || !canSubmit}>
          {loading ? (loadingLabel || submitLabel) : submitLabel}
        </Btn>
      </Modal.Footer>
    </Modal>
  )
}

// Dashed click-or-drag file picker. `hint` is shown when no file is selected.
export function FileDropZone({ file, onSelect, accept, hint, disabled, padding = 24, iconSize = 24, style }) {
  return (
    <div style={{
      border: `2px dashed ${file ? 'var(--teal)' : 'var(--border)'}`,
      borderRadius: 'var(--radius-lg)', padding, textAlign: 'center',
      background: file ? 'var(--teal-10)' : 'rgba(0,0,0,0.02)',
      transition: 'var(--transition-base)', position: 'relative',
      cursor: disabled ? 'not-allowed' : 'pointer', ...style,
    }}>
      <input
        type="file"
        accept={accept}
        disabled={disabled}
        onChange={e => onSelect(e.target.files[0])}
        style={{ position: 'absolute', inset: 0, opacity: 0, cursor: disabled ? 'not-allowed' : 'pointer' }}
      />
      {file ? (
        <div style={{ color: 'var(--teal)', fontSize: 13, fontWeight: 500 }}>
          <div style={{ fontSize: iconSize, marginBottom: 6 }}>📄</div>
          {file.name}
        </div>
      ) : (
        <div style={{ color: 'var(--text-3)', fontSize: 13 }}>{hint}</div>
      )}
    </div>
  )
}

// Vertical list of radio "cards" (radio + title + description).
export function RadioCardGroup({ name, value, onChange, options, disabled, accentColor = 'var(--teal)', gap = 12 }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap }}>
      {options.map(opt => (
        <label key={opt.value} style={{
          display: 'flex', gap: 10, alignItems: 'flex-start',
          cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1,
        }}>
          <input
            type="radio" name={name} value={opt.value}
            checked={value === opt.value}
            onChange={e => onChange(e.target.value)}
            disabled={disabled}
            style={{ accentColor, marginTop: 2 }}
          />
          <div>
            <div style={{ fontSize: 13, color: 'var(--text-1)', fontWeight: 500 }}>{opt.title}</div>
            <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-3)', marginTop: 2 }}>{opt.desc}</div>
          </div>
        </label>
      ))}
    </div>
  )
}
