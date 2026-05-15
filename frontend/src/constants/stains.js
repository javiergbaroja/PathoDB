export const STAIN_COLORS = {
  HE:            '#6ee7b7',
  IHC:           '#a78bfa',
  special_stain: '#fbbf24',
  FISH:          '#60a5fa',
  other:         '#94a3b8',
}

export const TYPE_COLORS = {
  patient:    { bg: 'var(--navy-10)',    text: 'var(--navy)' },
  submission: { bg: 'var(--crimson-10)', text: 'var(--crimson)' },
  probe:      { bg: '#e6f4ec',           text: '#0a6e3a' },
  block:      { bg: '#fef6e4',           text: '#7a4f00' },
}

export const TYPE_LABELS = {
  patient: 'Patient', submission: 'Submission', probe: 'Probe', block: 'Block'
}

export const PATHOLOGY_PALETTE = [
  '#f87171', '#fb923c', '#fbbf24', '#a3e635', '#4ade80', 
  '#34d399', '#2dd4bf', '#38bdf8', '#818cf8', '#a78bfa', 
  '#e879f9', '#f472b6', '#e11d48', '#0ea5e9', '#6ee7b7'
]