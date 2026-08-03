// frontend/src/lib/modality.js
//
// Modality (histology / cytology / autopsy) is NOT stored as a column — it is
// encoded in the Bern LIS accession prefix, and is only meaningful for INTERNAL
// data (patients.source_id IS NULL):
//
//   B<year>.<n>  → Histology   (surgical pathology / biopsy)
//   Z<year>.<n>  → Cytology    (Zytologie)
//   S<year>.<n>  → Autopsy     (Sektion / post-mortem)
//
// External cohorts (SP / SR / T / TCGA …) carry their own prefixes and surface
// provenance via the ExternalSourceBanner, so they intentionally fall through to
// null here — no modality monogram is drawn for them.
//
// Colours are deliberately ORTHOGONAL to the two status channels already on the
// Patient Detail page: crimson = malignancy, teal = has-scans. Modality
// therefore uses navy / purple / amber, so all three signals coexist on one row
// without fighting. `fg`/`bg` are tuned for a legible tinted monogram chip;
// `solid` is the full-strength hue for accents (rings, tallies).

export const MODALITIES = {
  B: { key: 'B', letter: 'B', label: 'Histology', fg: 'var(--navy)',        bg: 'var(--navy-10)',   solid: 'var(--navy)'    },
  Z: { key: 'Z', letter: 'Z', label: 'Cytology',  fg: 'var(--purple-dark)', bg: 'var(--purple-20)', solid: 'var(--purple)'  },
  S: { key: 'S', letter: 'S', label: 'Autopsy',   fg: 'var(--warning)',     bg: 'var(--amber-20)',  solid: 'var(--amber-h)' },
}

// Stable order for tallies / legends: histology, cytology, autopsy.
export const MODALITY_ORDER = ['B', 'Z', 'S']

// Descriptor for a submission's accession id, or null for external / unknown
// prefixes. The letter must be immediately followed by a digit (the Bern
// "B/Z/S20YY.nnnn" format) — this is what keeps external SP-…/SR…/T…/TCGA-…
// ids (letter followed by a non-digit) from being mis-read as Autopsy ('S').
export function getModality(lisId) {
  const m = /^([BZS])\d/i.exec(lisId || '')
  return m ? MODALITIES[m[1].toUpperCase()] : null
}
