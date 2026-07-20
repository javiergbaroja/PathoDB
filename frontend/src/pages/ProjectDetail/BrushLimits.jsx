/**
 * BrushLimits.jsx
 *
 * SVG analogue of QuPath's BrushLimits JavaFX Group.
 * Renders two concentric ellipses centred on the current mouse position:
 *   • outer ring — light (white, semi-transparent)
 *   • inner ring — dark (black outline)
 *
 * Props:
 *   cx, cy   — centre in SVG/viewer-element space (pixels)
 *   radius   — radius in SVG/viewer-element space (pixels)
 *   subtract — true when in erase/subtract mode (shows red tint)
 *   visible  — hide when mouse is outside the canvas
 */
export default function BrushLimits({ cx, cy, radius, subtract, visible }) {
  if (!visible || radius <= 0) return null

  const strokeOuter = subtract ? 'var(--transparent-crimson-7)' : 'var(--transparent-white-7)' // light ring
  const strokeInner = subtract ? 'var(--transparent-crimsonh-7)'   : 'var(--transparent-black-8)' // dark ring
  return (
    <g style={{ pointerEvents: 'none' }}>
      {/* outer — light ring */}
      <ellipse
        cx={cx} cy={cy} rx={radius} ry={radius}
        fill="none"
        stroke={strokeOuter}
        strokeWidth={2}
      />
      {/* inner — dark ring (1 px inset for contrast) */}
      <ellipse
        cx={cx} cy={cy} rx={Math.max(1, radius - 1)} ry={Math.max(1, radius - 1)}
        fill="none"
        stroke={strokeInner}
        strokeWidth={1}
      />
    </g>
  )
}