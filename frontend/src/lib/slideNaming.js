// frontend/src/lib/slideNaming.js

// Older LIS eras carry the full B-number on the probe, making the submission id redundant.
export function formatHierarchy(scan) {
  const sub = scan?.lis_submission_id || '';
  const prb = scan?.lis_probe_id || '';
  const blk = scan?.block_label || '';

  const parts = [];
  const isFullBNumber = /^B\d{4}/i.test(prb);

  if (isFullBNumber) {
    parts.push(prb);
  } else {
    if (sub) parts.push(sub);
    if (prb && prb !== '1') parts.push(prb);
  }

  if (blk) parts.push(blk);

  return parts.join(' › ') || '—';
}

// Block labels use spreadsheet-column-style lettering (A, B, ..., Z, AA, AB, ...
// or the era-1 variant A..Y, ZA..ZY, ZZA...). Plain alphabetical compare puts
// "AA" before "B", which is wrong: more letters always means a later block.
// For pure-letter labels, sort by length first, then alphabetically — this
// orders both eras correctly. Anything else (accession-style ids, etc.) falls
// back to the previous numeric-aware locale compare.
export function compareBlockLabels(a, b) {
  const la = a || '';
  const lb = b || '';
  const isAlphaA = /^[A-Za-z]+$/.test(la);
  const isAlphaB = /^[A-Za-z]+$/.test(lb);
  if (isAlphaA && isAlphaB) {
    if (la.length !== lb.length) return la.length - lb.length;
    return la.localeCompare(lb, undefined, { sensitivity: 'base' });
  }
  return la.localeCompare(lb, undefined, { numeric: true, sensitivity: 'base' });
}
