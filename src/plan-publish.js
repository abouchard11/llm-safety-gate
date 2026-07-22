// planPublish — pure, zero-I/O decision step over a FINAL per-item flag array
// (typically the output of checkPerItem from gate.js). It has no knowledge of
// classifiers, votes, or retries; it only decides what to do with a settled
// verdict.
//
// Given flags = [primaryFlag, ...otherFlags] (primaryIndex defaults to 0):
//   - every flagged non-primary item is dropped
//   - if the primary item is flagged, the first surviving (clean) non-primary
//     item is promoted to take its place, so a flagged item never appears
//     anywhere in the published output
//   - publishing proceeds only if a primary is resolvable (it was never
//     flagged, or a promotion candidate exists) AND at least minItems
//     non-primary items survive
//
// keptIdx and promotedFrom are indices into the non-primary items in their
// original relative order (i.e. the primary's own position is not counted;
// removing it never renumbers the rest, it just isn't part of this index
// space at all).
//
// This function never throws and always returns the full plan object, even
// when ok is false, so callers can surface a structured kickback (dropped
// count, kept count, floor) rather than a bare error.
export function planPublish(flags, { primaryIndex = 0, minItems = 3 } = {}) {
  const primaryFlagged = flags[primaryIndex] === true;
  const otherFlags = flags.filter((_, i) => i !== primaryIndex);

  const keptIdx = [];
  for (let i = 0; i < otherFlags.length; i++) {
    if (!otherFlags[i]) keptIdx.push(i);
  }
  const dropped = otherFlags.length - keptIdx.length;

  const promotedFrom = primaryFlagged ? (keptIdx.length ? keptIdx[0] : null) : null;
  const primaryResolved = !primaryFlagged || promotedFrom !== null;
  const ok = primaryResolved && keptIdx.length >= minItems;

  return { ok, keptIdx, dropped, primaryFlagged, promotedFrom };
}
