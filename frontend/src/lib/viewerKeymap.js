// frontend/src/lib/viewerKeymap.js
// ─────────────────────────────────────────────────────────────────────────────
// Single source of truth for viewer keyboard shortcuts.
//
// Consumed by BOTH viewer shells:
//   - pages/SlideViewer/index.jsx      (read / measure viewer)
//   - pages/ProjectDetail/index.jsx    (annotation workspace)
// …and by their help surfaces, which render from SHORTCUT_GROUPS:
//   - pages/SlideViewer/Toolbar.jsx        (ShortcutsOverlay)
//   - pages/ProjectDetail/ClassPanel.jsx   (ShortcutLegend)
//
// Because behaviour AND the legends both derive from this file, a binding can
// never silently drift from what the legend advertises (Audit Findings 1 + 5).
//
// Design: TOOL keys occupy the letter namespace; PANEL/VIEW keys live in a
// separate set so a drawing-tool key can never collide with a panel toggle
// (this was the root of the Slide-Viewer ↔ Project-Detail conflict — e.g. `R`
// meant "ruler" in one shell and "rectangle" in the other).
//
// NOTE ON RECONCILIATION: the annotation workspace (the heavier, more frequent
// tool) keeps almost all of its existing tool letters; the lighter read viewer
// absorbs the changes. See BATCH1_integration_guide.md for the full diff of
// which bindings changed.
// ─────────────────────────────────────────────────────────────────────────────

// ── Tools (letter namespace) ────────────────────────────────────────────────
export const TOOL_KEYS = {
  v: 'select',     // was `M` in ProjectDetail
  p: 'point',      // unchanged in ProjectDetail; in SlideViewer `P` (polygon) → `G`
  g: 'polygon',    // unchanged in ProjectDetail; new home for SlideViewer polygon
  r: 'rectangle',  // unchanged in ProjectDetail; SlideViewer ruler (`R`) → `L`
  e: 'ellipse',    // unchanged
  b: 'brush',      // unchanged in ProjectDetail; SlideViewer brightness (`B`) → `D`
  l: 'ruler',      // "Length" — was `R` in SlideViewer
}

// ── Panels / overlays (separate namespace) ──────────────────────────────────
export const PANEL_KEYS = {
  i: 'clinical',   // Clinical info panel (unchanged in SlideViewer)
  a: 'models',     // Analysis / AI models (was `M` in SlideViewer)
  d: 'adjust',     // Image aDjust: brightness/contrast/gamma
                   //   (was `B` in SlideViewer, `A` in ProjectDetail)
}

// ── Display toggles (Project Detail only — not a tool, not a panel) ────────
export const TOGGLE_KEYS = {
  h: 'toggleAnnotations',   // show/hide all annotations
  o: 'toggleFill',          // fill vs outline-only rendering
}
export function toggleForEvent(e) { return TOGGLE_KEYS[normKey(e)] || null }

// ── View / global ───────────────────────────────────────────────────────────
export const VIEW_KEYS = {
  ' ':      'home',    // Reset view (home)
  '?':      'help',    // Toggle shortcut help
  Escape:   'cancel',  // Cancel active tool / close panel / deselect
}

// ── Editable-target guard (Audit Finding 11) ────────────────────────────────
// One predicate for both shells so the guard can never drift. Covers native
// form controls AND contenteditable regions.
const EDITABLE_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT'])
export function isEditableTarget(el = document.activeElement) {
  if (!el) return false
  if (EDITABLE_TAGS.has(el.tagName)) return true
  if (el.isContentEditable) return true
  return false
}

// ── Event → action resolvers ────────────────────────────────────────────────
// Letters are matched case-insensitively; Space / Escape / ? pass through.
function normKey(e) {
  return e.key && e.key.length === 1 ? e.key.toLowerCase() : e.key
}
export function toolForEvent(e)  { return TOOL_KEYS[normKey(e)]  || null }
export function panelForEvent(e) { return PANEL_KEYS[normKey(e)] || null }
export function viewForEvent(e)  { return VIEW_KEYS[e.key]       || null }

// Convenience: action → display key, for tooltips ("Brush (B)") and badges.
export const KEY_FOR = (() => {
  const m = {}
  for (const [k, a] of Object.entries(TOOL_KEYS))  m[a] = k.toUpperCase()
  for (const [k, a] of Object.entries(PANEL_KEYS)) m[a] = k.toUpperCase()
  m.home = 'Space'; m.help = '?'; m.cancel = 'Esc'
  return m
})()

// ── Display model for help overlays / legends (Audit Finding 5) ─────────────
// `action` lets a shell filter rows down to the tools it actually has, via
// shortcutGroupsFor(). Rows without an `action` (modifier combos) always show.
export const SHORTCUT_GROUPS = [
  {
    title: 'Tools',
    items: [
      { action: 'select',    keys: ['V'], label: 'Select / move' },
      { action: 'point',     keys: ['P'], label: 'Point' },
      { action: 'polygon',   keys: ['G'], label: 'Polygon' },
      { action: 'rectangle', keys: ['R'], label: 'Rectangle' },
      { action: 'ellipse',   keys: ['E'], label: 'Ellipse' },
      { action: 'brush',     keys: ['B'], label: 'Brush' },
      { action: 'ruler',     keys: ['L'], label: 'Ruler / measure' },
    ],
  },
  {
    title: 'Panels & view',
    items: [
      { action: 'clinical', keys: ['I'],     label: 'Clinical info' },
      { action: 'models',   keys: ['A'],     label: 'Analysis models' },
      { action: 'adjust',   keys: ['D'],     label: 'Image adjust' },
      { action: 'home',     keys: ['Space'], label: 'Reset view' },
      { action: 'help',     keys: ['?'],     label: 'This help' },
      { action: 'cancel',   keys: ['Esc'],   label: 'Cancel / close / deselect' },
      { action: 'toggleAnnotations', keys: ['H'], label: 'Show/hide annotations' },
      { action: 'toggleFill',        keys: ['O'], label: 'Toggle fill / outline' },
    ],
  },
  {
    // Annotation-only — actions tagged so this group filters OUT of the
    // read-only Slide Viewer (which has nothing to select/undo/delete).
    title: 'Selection & editing',
    items: [
      { action: 'multiselect',   keys: ['⇧', 'Click'],      label: 'Multi-select' },
      { action: 'selectclass',   keys: ['Alt', 'Click'],    label: 'Select all of class' },
      { action: 'selectoverlap', keys: ['Ctrl', 'Click'],   label: 'Select overlapping' },
      { action: 'undo',          keys: ['Ctrl', 'Z'],       label: 'Undo' },
      { action: 'redo',          keys: ['Ctrl', '⇧', 'Z'],  label: 'Redo' },
      { action: 'delete',        keys: ['Del'],             label: 'Delete selected' },
    ],
  },
]

// Filter the display model to the actions a given shell supports.
//   e.g. shortcutGroupsFor(SLIDE_VIEWER_ACTIONS)   // drops annotation rows
// Any row whose `action` isn't in the set is removed; empty groups drop out.
export function shortcutGroupsFor(availableActions) {
  if (!availableActions) return SHORTCUT_GROUPS
  const set = new Set(availableActions)
  return SHORTCUT_GROUPS
    .map(g => ({
      ...g,
      items: g.items.filter(i => !i.action || set.has(i.action)),
    }))
    .filter(g => g.items.length > 0)
}

// Action sets each shell advertises (use with shortcutGroupsFor).
export const SLIDE_VIEWER_ACTIONS = [
  'polygon', 'ruler', 'clinical', 'models', 'adjust', 'home', 'help', 'cancel',
]
export const PROJECT_DETAIL_ACTIONS = [
  'select', 'point', 'polygon', 'rectangle', 'ellipse', 'brush', 'ruler',
  'adjust', 'help', 'cancel',
  'multiselect', 'selectclass', 'selectoverlap', 'undo', 'redo', 'delete',
  'toggleAnnotations', 'toggleFill',
]