/**
 * createSafetyGate — a majority-vote content-safety gate wrapped around one
 * injected classifier call.
 *
 * The gate never inspects the items it is given; it only counts votes. All
 * "what counts as unsafe" policy lives in the caller-supplied classify()
 * implementation.
 *
 * classify(items) must resolve to one of:
 *   - { ok: true, perItem: boolean[] }        assessed; perItem[i] true = flagged
 *   - { ok: false, blocked: true }             the classifier itself refused —
 *                                               BLOCK-SIGNAL, never retried
 *   - { ok: false, reason: string }            structural/transport noise —
 *                                               retry-eligible
 * A thrown error, or a resolved perItem array of the wrong length, is
 * normalized by the gate itself (see normalizeVote below) rather than being
 * the classify() author's responsibility.
 */

/**
 * Wraps a raw classify() call, converting anything it throws or returns
 * outside the documented contract into the gate's internal vote shape:
 * { ok: true, perItem } | { ok: false, reason }.
 *
 * 'blocked' is folded into the reason string here so every other part of
 * the state machine only has to compare against a single field, but it is
 * produced ONLY from an explicit { ok:false, blocked:true } classify()
 * result — never inferred from a bare reason string.
 */
async function normalizeVote(classify, items) {
  let raw;
  try {
    raw = await classify(items);
  } catch (err) {
    const message = err && err.message != null ? err.message : String(err);
    return { ok: false, reason: 'error:' + message };
  }

  if (raw && raw.ok === true) {
    if (!Array.isArray(raw.perItem) || raw.perItem.length !== items.length) {
      return { ok: false, reason: 'bad_item_count' };
    }
    return { ok: true, perItem: raw.perItem };
  }

  if (raw && raw.blocked === true) {
    return { ok: false, reason: 'blocked' };
  }

  if (raw && typeof raw.reason === 'string') {
    return { ok: false, reason: raw.reason };
  }

  // classify() itself returned something outside its documented contract —
  // this is structural noise about the RESPONSE, not a verdict.
  return { ok: false, reason: 'empty' };
}

/**
 * The first vote goes through a bounded retry: up to `1 + firstCallRetries`
 * attempts on structural noise, returning immediately on success OR on a
 * block-signal (when the classifier refuses to assess at all, treat that
 * verdict-shaped refusal as meaningful; only response-format noise retries).
 */
async function firstVote(classify, items, firstCallRetries) {
  const maxAttempts = 1 + firstCallRetries;
  let last;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const vote = await normalizeVote(classify, items);
    if (vote.ok) return vote;
    if (vote.reason === 'blocked') return vote;
    last = vote;
  }
  return last;
}

function isEmptyItems(items) {
  return !Array.isArray(items) || items.length < 1;
}

export function createSafetyGate({
  classify,
  votes = 3,
  quorum = 2,
  firstCallRetries = 2,
} = {}) {
  /**
   * Whole-batch verdict via majority vote with early short-circuit.
   *
   * A clean first vote returns immediately (exactly 1 classify call, never
   * any revote). A flagged first vote enters a confirmation loop: each
   * additional revote is a bare (non-retried) call; a structurally-failed
   * revote counts as flag pressure exactly like an actual flagged verdict.
   * The loop stops the moment flagVotes reaches quorum.
   */
  async function checkBatch(items) {
    if (isEmptyItems(items)) return { ok: false, reason: 'empty' };

    const first = await firstVote(classify, items, firstCallRetries);
    if (!first.ok) return { ok: false, reason: first.reason };

    const firstFlagged = first.perItem.some(Boolean);
    if (!firstFlagged) {
      // Batch mode deliberately exposes only the batch-level verdict;
      // callers wanting per-item data use checkPerItem instead.
      return { ok: true, flagged: false };
    }

    let flagVotes = 1;
    let votesCast = 1;

    while (votesCast < votes && flagVotes < quorum) {
      const vote = await normalizeVote(classify, items);
      votesCast++;

      if (!vote.ok) {
        if (vote.reason === 'blocked') return { ok: false, reason: 'blocked' };
        flagVotes++; // errored confirmation votes add flag pressure, never publish pressure
        continue;
      }

      if (vote.perItem.some(Boolean)) flagVotes++;
    }

    return { ok: true, flagged: flagVotes >= quorum };
  }

  /**
   * Per-item verdict via majority vote — deliberately NO early short-circuit.
   * Once ANY item is flagged on the first vote, exactly `votes - 1` more
   * bare votes are always cast, regardless of how quickly a per-item
   * quorum would otherwise be reached.
   *
   * Per-item tally starts at the first vote's flags. Every SUCCESSFUL
   * revote adds its perItem flags for ALL items unconditionally (a
   * first-clean item can still accumulate flags from later revotes,
   * since each revote reassesses the whole batch, not just suspects).
   *
   * A structurally FAILED revote is stricter: it reinforces ONLY items
   * that were already flagged on the first vote — an item that started
   * clean gets nothing added, even though the revote failed for the
   * whole batch. This asymmetry with checkBatch's fail-closed rule is
   * intentional and load-bearing: copying the whole-batch rule here
   * would let classifier noise newly implicate items nobody suspected.
   */
  async function checkPerItem(items) {
    if (isEmptyItems(items)) return { ok: false, reason: 'empty' };

    const first = await firstVote(classify, items, firstCallRetries);
    if (!first.ok) return { ok: false, reason: first.reason };

    const n = items.length;
    const suspects = first.perItem;
    const anyFlagged = suspects.some(Boolean);

    if (!anyFlagged) {
      return { ok: true, flags: new Array(n).fill(false) };
    }

    const tally = suspects.map((flagged) => (flagged ? 1 : 0));
    let votesCast = 1;

    while (votesCast < votes) {
      const vote = await normalizeVote(classify, items);
      votesCast++;

      if (!vote.ok) {
        if (vote.reason === 'blocked') return { ok: false, reason: 'blocked' };
        for (let i = 0; i < n; i++) {
          if (suspects[i]) tally[i]++;
        }
        continue;
      }

      for (let i = 0; i < n; i++) {
        if (vote.perItem[i]) tally[i]++;
      }
    }

    return { ok: true, flags: tally.map((t) => t >= quorum) };
  }

  return { checkBatch, checkPerItem };
}
