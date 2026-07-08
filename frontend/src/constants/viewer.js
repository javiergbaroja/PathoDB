export const VIEWER_CONFIG = {
  DEFAULT_ZOOM: 1,
  MAX_ZOOM: 40, // 40x magnification
  MIN_ZOOM: 0.1,
  TILE_SIZE: 256,
};

export const TOOLS = {
  PAN: 'pan',
  ANNOTATE: 'annotate',
  MEASURE: 'measure',
};

export const CATEGORY_COLORS = {
  Segmentation: 'var(--teal-light)',
  Detection:    'var(--purple-80)',
  'Feature Extraction': 'var(--blue-40)',
  Scoring:      'var(--amber)',
  other:        '#94a3b8',
}