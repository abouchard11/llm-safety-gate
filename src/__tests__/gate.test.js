import { describe, it, expect, vi } from 'vitest';
import { createSafetyGate } from '../gate.js';

/**
 * Builds a classify() mock that plays back a fixed script of resolved
 * values (or thrown errors), one per call. Calling it more times than
 * scripted is a test-authoring bug, so it throws loudly instead of
 * silently repeating the last entry.
 */
function scriptedClassify(script) {
  let i = 0;
  return vi.fn(async () => {
    if (i >= script.length) {
      throw new Error(`classify() called more times than scripted (${script.length})`);
    }
    const step = script[i++];
    if (typeof step === 'function') return step();
    return step;
  });
}

describe('createSafetyGate: checkBatch (whole-batch majority vote)', () => {
  it('returns immediately on a clean first vote — exactly 1 classify call, no revote', async () => {
    const classify = scriptedClassify([
      { ok: true, perItem: [false, false, false] },
    ]);
    const gate = createSafetyGate({ classify });

    const result = await gate.checkBatch(['item-1', 'item-2', 'item-3']);

    expect(result).toEqual({ ok: true, flagged: false });
    expect(classify).toHaveBeenCalledTimes(1);
  });

  it('short-circuits the confirmation loop once quorum agreeing flag-votes are reached', async () => {
    const classify = scriptedClassify([
      { ok: true, perItem: [true] },
      { ok: true, perItem: [true] },
    ]);
    const gate = createSafetyGate({ classify });

    const result = await gate.checkBatch(['item-1']);

    expect(result).toEqual({ ok: true, flagged: true });
    expect(classify).toHaveBeenCalledTimes(2);
  });

  it('outvotes a single borderline flag when both revotes come back clean — spends the full 3 calls', async () => {
    const classify = scriptedClassify([
      { ok: true, perItem: [true] },
      { ok: true, perItem: [false] },
      { ok: true, perItem: [false] },
    ]);
    const gate = createSafetyGate({ classify });

    const result = await gate.checkBatch(['item-1']);

    expect(result).toEqual({ ok: true, flagged: false });
    expect(classify).toHaveBeenCalledTimes(3);
  });

  it('treats a structurally-failed revote as flag pressure, never toward clearing', async () => {
    const classify = scriptedClassify([
      { ok: true, perItem: [true] },
      { ok: false, reason: 'bad_flag' },
    ]);
    const gate = createSafetyGate({ classify });

    const result = await gate.checkBatch(['item-1']);

    expect(result).toEqual({ ok: true, flagged: true });
    expect(classify).toHaveBeenCalledTimes(2);
  });

  it('fails closed after exhausting first-call retries on persistent structural noise', async () => {
    const classify = scriptedClassify([
      { ok: false, reason: 'bad_item_count' },
      { ok: false, reason: 'bad_item_count' },
      { ok: false, reason: 'bad_item_count' },
    ]);
    const gate = createSafetyGate({ classify });

    const result = await gate.checkBatch(['item-1']);

    expect(result).toEqual({ ok: false, reason: 'bad_item_count' });
    expect(classify).toHaveBeenCalledTimes(3);
  });

  it('retries a single first-call parse-noise failure and accepts a clean second verdict', async () => {
    const classify = scriptedClassify([
      { ok: false, reason: 'bad_item_count' },
      { ok: true, perItem: [false, false] },
    ]);
    const gate = createSafetyGate({ classify });

    const result = await gate.checkBatch(['item-1', 'item-2']);

    expect(result).toEqual({ ok: true, flagged: false });
    expect(classify).toHaveBeenCalledTimes(2);
  });

  it('fails closed immediately on a block-signal, with zero retries', async () => {
    const classify = scriptedClassify([
      { ok: false, blocked: true },
    ]);
    const gate = createSafetyGate({ classify });

    const result = await gate.checkBatch(['item-1']);

    expect(result).toEqual({ ok: false, reason: 'blocked' });
    expect(classify).toHaveBeenCalledTimes(1);
  });

  it('fails closed immediately on a block-signal encountered mid-confirmation-loop', async () => {
    const classify = scriptedClassify([
      { ok: true, perItem: [true] },
      { ok: false, blocked: true },
    ]);
    const gate = createSafetyGate({ classify });

    const result = await gate.checkBatch(['item-1']);

    expect(result).toEqual({ ok: false, reason: 'blocked' });
    expect(classify).toHaveBeenCalledTimes(2);
  });

  it('converts a thrown classify error into a retryable noise reason', async () => {
    const classify = vi.fn(async () => {
      throw new Error('transport exploded');
    });
    const gate = createSafetyGate({ classify });

    const result = await gate.checkBatch(['item-1']);

    expect(result).toEqual({ ok: false, reason: 'error:transport exploded' });
    expect(classify).toHaveBeenCalledTimes(3);
  });

  it('converts a wrong-length perItem result into bad_item_count and retries it as noise', async () => {
    const classify = scriptedClassify([
      { ok: true, perItem: [false] }, // wrong length for a 2-item batch
      { ok: true, perItem: [false, false] },
    ]);
    const gate = createSafetyGate({ classify });

    const result = await gate.checkBatch(['item-1', 'item-2']);

    expect(result).toEqual({ ok: true, flagged: false });
    expect(classify).toHaveBeenCalledTimes(2);
  });

  it('rejects an empty items array before any classify call', async () => {
    const classify = vi.fn();
    const gate = createSafetyGate({ classify });

    const result = await gate.checkBatch([]);

    expect(result).toEqual({ ok: false, reason: 'empty' });
    expect(classify).not.toHaveBeenCalled();
  });

  it('honors a custom firstCallRetries of 0 — exactly 1 attempt, no retry on noise', async () => {
    const classify = scriptedClassify([
      { ok: false, reason: 'bad_flag' },
    ]);
    const gate = createSafetyGate({ classify, firstCallRetries: 0 });

    const result = await gate.checkBatch(['item-1']);

    expect(result).toEqual({ ok: false, reason: 'bad_flag' });
    expect(classify).toHaveBeenCalledTimes(1);
  });

  it('honors custom votes/quorum — short-circuits at the configured quorum', async () => {
    const classify = scriptedClassify([
      { ok: true, perItem: [true] },
      { ok: true, perItem: [true] },
      { ok: true, perItem: [true] },
    ]);
    const gate = createSafetyGate({ classify, votes: 5, quorum: 3, firstCallRetries: 1 });

    const result = await gate.checkBatch(['item-1']);

    expect(result).toEqual({ ok: true, flagged: true });
    expect(classify).toHaveBeenCalledTimes(3);
  });
});

describe('createSafetyGate: checkPerItem (per-item majority vote, no short-circuit)', () => {
  it('returns all-false flags in exactly 1 call on a clean first vote', async () => {
    const classify = scriptedClassify([
      { ok: true, perItem: [false, false, false] },
    ]);
    const gate = createSafetyGate({ classify });

    const result = await gate.checkPerItem(['item-1', 'item-2', 'item-3']);

    expect(result).toEqual({ ok: true, flags: [false, false, false] });
    expect(classify).toHaveBeenCalledTimes(1);
  });

  it('drops only the consistently-flagged item and keeps the clean ones', async () => {
    const classify = scriptedClassify([
      { ok: true, perItem: [false, true, false] },
      { ok: true, perItem: [false, true, false] },
      { ok: true, perItem: [false, true, false] },
    ]);
    const gate = createSafetyGate({ classify });

    const result = await gate.checkPerItem(['item-1', 'item-2', 'item-3']);

    expect(result).toEqual({ ok: true, flags: [false, true, false] });
    expect(classify).toHaveBeenCalledTimes(3);
  });

  it('spends exactly 3 calls once anything is flagged — even when that flag is later outvoted (no short-circuit)', async () => {
    const classify = scriptedClassify([
      { ok: true, perItem: [false, true] },
      { ok: true, perItem: [false, false] },
      { ok: true, perItem: [false, false] },
    ]);
    const gate = createSafetyGate({ classify });

    const result = await gate.checkPerItem(['item-1', 'item-2']);

    expect(result).toEqual({ ok: true, flags: [false, false] });
    expect(classify).toHaveBeenCalledTimes(3);
  });

  it('fails closed for the whole operation after persistent first-call structural failure', async () => {
    const classify = scriptedClassify([
      { ok: false, reason: 'missing_index' },
      { ok: false, reason: 'missing_index' },
      { ok: false, reason: 'missing_index' },
    ]);
    const gate = createSafetyGate({ classify });

    const result = await gate.checkPerItem(['item-1', 'item-2']);

    expect(result).toEqual({ ok: false, reason: 'missing_index' });
    expect(classify).toHaveBeenCalledTimes(3);
  });

  it('a failed revote reinforces ONLY the item already suspected on the first vote, never a first-clean item', async () => {
    const classify = scriptedClassify([
      { ok: true, perItem: [true, false] },
      { ok: false, reason: 'bad_flag' },
      { ok: false, reason: 'bad_flag' },
    ]);
    const gate = createSafetyGate({ classify });

    const result = await gate.checkPerItem(['item-1', 'item-2']);

    expect(result).toEqual({ ok: true, flags: [true, false] });
    expect(classify).toHaveBeenCalledTimes(3);
  });

  it('a successful revote can newly implicate an item that was clean on the first vote', async () => {
    // Item 0 clean on the first vote, but votes 2 and 3 both flag it — full
    // per-item confirmation reassesses the whole batch, not just suspects.
    const classify = scriptedClassify([
      { ok: true, perItem: [false, true] },
      { ok: true, perItem: [true, true] },
      { ok: true, perItem: [true, true] },
    ]);
    const gate = createSafetyGate({ classify });

    const result = await gate.checkPerItem(['item-1', 'item-2']);

    expect(result).toEqual({ ok: true, flags: [true, true] });
    expect(classify).toHaveBeenCalledTimes(3);
  });

  it('retries first-call parse noise, then a real flag still goes through full per-item confirmation', async () => {
    const classify = scriptedClassify([
      { ok: false, reason: 'missing_index' },
      { ok: true, perItem: [false, true] },
      { ok: true, perItem: [false, true] },
      { ok: true, perItem: [false, true] },
    ]);
    const gate = createSafetyGate({ classify });

    const result = await gate.checkPerItem(['item-1', 'item-2']);

    expect(result).toEqual({ ok: true, flags: [false, true] });
    expect(classify).toHaveBeenCalledTimes(4);
  });

  it('treats a wrong-length perItem result as noise, retried like any other structural failure', async () => {
    const classify = scriptedClassify([
      { ok: true, perItem: [false] }, // wrong length for a 2-item batch
      { ok: true, perItem: [true, false] },
      { ok: true, perItem: [true, false] },
      { ok: true, perItem: [true, false] },
    ]);
    const gate = createSafetyGate({ classify });

    const result = await gate.checkPerItem(['item-1', 'item-2']);

    expect(result).toEqual({ ok: true, flags: [true, false] });
    expect(classify).toHaveBeenCalledTimes(4);
  });

  it('fails closed immediately on a block-signal encountered during confirmation, with no further calls', async () => {
    const classify = scriptedClassify([
      { ok: true, perItem: [true, false] },
      { ok: false, blocked: true },
    ]);
    const gate = createSafetyGate({ classify });

    const result = await gate.checkPerItem(['item-1', 'item-2']);

    expect(result).toEqual({ ok: false, reason: 'blocked' });
    expect(classify).toHaveBeenCalledTimes(2);
  });

  it('fails closed immediately on a block-signal on the very first call', async () => {
    const classify = scriptedClassify([
      { ok: false, blocked: true },
    ]);
    const gate = createSafetyGate({ classify });

    const result = await gate.checkPerItem(['item-1', 'item-2']);

    expect(result).toEqual({ ok: false, reason: 'blocked' });
    expect(classify).toHaveBeenCalledTimes(1);
  });

  it('rejects an empty items array before any classify call', async () => {
    const classify = vi.fn();
    const gate = createSafetyGate({ classify });

    const result = await gate.checkPerItem([]);

    expect(result).toEqual({ ok: false, reason: 'empty' });
    expect(classify).not.toHaveBeenCalled();
  });
});
