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
