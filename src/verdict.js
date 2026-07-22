// Pure verdict validation and reason classification.
//
// validateVerdict is a generic port of the original per-item safety-verdict
// parser: it enforces that a classifier's parsed output carries exactly one
// row per expected item index, with a boolean flag on every row, before the
// caller can trust the resulting perItem array at all.
//
// The per-row check order is load-bearing and intentionally preserved:
// index validity (including duplicate detection) is checked BEFORE the flag
// type on every row, so a row that is bad in both ways always reports
// bad_index. The row-count check runs before the per-row loop even starts,
// so a count mismatch always wins over anything the (mismatched) rows
// themselves contain.
//
// The trailing "did we see every index" check is preserved verbatim from the
// original even though, given the row-count gate above it, it can only ever
// be reached with seen.size already equal to itemCount (a row-count match
// with all-unique in-range indices necessarily covers 0..itemCount-1). It is
// kept for exact parity with the source validator rather than pruned as
// dead code.
export function validateVerdict(parsed, itemCount) {
  const rows = parsed?.items;
  if (!Array.isArray(rows) || rows.length !== itemCount) {
    return { ok: false, reason: 'bad_item_count' };
  }

  const seen = new Set();
  const perItem = new Array(itemCount).fill(false);

  for (const row of rows) {
    const idx = row?.index;
    if (!Number.isInteger(idx) || idx < 0 || idx >= itemCount || seen.has(idx)) {
      return { ok: false, reason: 'bad_index' };
    }
    if (typeof row?.flagged !== 'boolean') {
      return { ok: false, reason: 'bad_flag' };
    }
    seen.add(idx);
    perItem[idx] = row.flagged;
  }

  if (seen.size !== itemCount) {
    return { ok: false, reason: 'missing_index' };
  }

  return { ok: true, perItem };
}

// Two-way failure taxonomy: 'blocked' means the classifier itself declined
// to assess the content at all; the refusal itself is meaningful and is
// never retried. Every other reason is structural/transport noise (a
// malformed or empty response, a transport error, a shape mismatch) — a
// retry-worthy glitch, not a verdict.
export function classifyFailure(reason) {
  return reason === 'blocked' ? 'refusal' : 'noise';
}
