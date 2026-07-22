import { describe, test, expect } from 'vitest';
import { validateVerdict, classifyFailure } from '../verdict.js';

describe('validateVerdict', () => {
  test('accepts exactly one boolean row per index and returns an ordered perItem array', () => {
    const result = validateVerdict(
      {
        items: [
          { index: 0, flagged: false },
          { index: 1, flagged: true },
        ],
      },
      2,
    );
    expect(result).toEqual({ ok: true, perItem: [false, true] });
  });

  test('rejects when the row count does not match the expected item count', () => {
    const result = validateVerdict({ items: [{ index: 0, flagged: false }] }, 2);
    expect(result).toEqual({ ok: false, reason: 'bad_item_count' });
  });

  test('rejects when items is missing entirely', () => {
    const result = validateVerdict({}, 2);
    expect(result).toEqual({ ok: false, reason: 'bad_item_count' });
  });

  test('rejects when items is not an array', () => {
    const result = validateVerdict({ items: 'nope' }, 2);
    expect(result).toEqual({ ok: false, reason: 'bad_item_count' });
  });

  test('rejects an out-of-range index', () => {
    const result = validateVerdict(
      {
        items: [
          { index: 0, flagged: false },
          { index: 5, flagged: false },
        ],
      },
      2,
    );
    expect(result).toEqual({ ok: false, reason: 'bad_index' });
  });

  test('rejects a negative index', () => {
    const result = validateVerdict(
      {
        items: [
          { index: -1, flagged: false },
          { index: 1, flagged: false },
        ],
      },
      2,
    );
    expect(result).toEqual({ ok: false, reason: 'bad_index' });
  });

  test('rejects a non-integer index', () => {
    const result = validateVerdict(
      {
        items: [
          { index: 0.5, flagged: false },
          { index: 1, flagged: false },
        ],
      },
      2,
    );
    expect(result).toEqual({ ok: false, reason: 'bad_index' });
  });

  test('rejects a duplicate index even when the row count matches', () => {
    const result = validateVerdict(
      {
        items: [
          { index: 0, flagged: false },
          { index: 0, flagged: true },
        ],
      },
      2,
    );
    expect(result).toEqual({ ok: false, reason: 'bad_index' });
  });

  test('rejects a non-boolean flag field', () => {
    const result = validateVerdict(
      {
        items: [
          { index: 0, flagged: 'true' },
          { index: 1, flagged: false },
        ],
      },
      2,
    );
    expect(result).toEqual({ ok: false, reason: 'bad_flag' });
  });

  test('index validity is checked before the flag type, per row', () => {
    // A row with BOTH a bad index and a bad flag must report bad_index —
    // preserving the original validator's per-row check order.
    const result = validateVerdict(
      {
        items: [
          { index: 0, flagged: false },
          { index: 9, flagged: 'nope' },
        ],
      },
      2,
    );
    expect(result).toEqual({ ok: false, reason: 'bad_index' });
  });

  test('the row-count gate is checked before any per-row index/flag check', () => {
    // Row count mismatch must win even when the rows present would otherwise
    // trip bad_index or bad_flag — the original validator bails out on the
    // count check before ever entering the per-row loop.
    const result = validateVerdict(
      {
        items: [{ index: 9, flagged: 'nope' }],
      },
      2,
    );
    expect(result).toEqual({ ok: false, reason: 'bad_item_count' });
  });

  test('accumulates a full ordered perItem array across more than two items', () => {
    const result = validateVerdict(
      {
        items: [
          { index: 2, flagged: true },
          { index: 0, flagged: false },
          { index: 1, flagged: false },
        ],
      },
      3,
    );
    expect(result).toEqual({ ok: true, perItem: [false, false, true] });
  });

  test('an all-clean verdict returns an all-false perItem array', () => {
    const result = validateVerdict(
      {
        items: [
          { index: 0, flagged: false },
          { index: 1, flagged: false },
          { index: 2, flagged: false },
        ],
      },
      3,
    );
    expect(result).toEqual({ ok: true, perItem: [false, false, false] });
  });

  test('success contract carries no extra fields beyond ok and perItem', () => {
    const result = validateVerdict(
      {
        items: [{ index: 0, flagged: true }],
      },
      1,
    );
    expect(Object.keys(result).sort()).toEqual(['ok', 'perItem']);
  });
});

describe('classifyFailure', () => {
  test('maps blocked to refusal', () => {
    expect(classifyFailure('blocked')).toBe('refusal');
  });

  test('maps every structural/transport reason to noise', () => {
    expect(classifyFailure('empty')).toBe('noise');
    expect(classifyFailure('bad_item_count')).toBe('noise');
    expect(classifyFailure('bad_index')).toBe('noise');
    expect(classifyFailure('missing_index')).toBe('noise');
    expect(classifyFailure('bad_flag')).toBe('noise');
    expect(classifyFailure('error:request_failed')).toBe('noise');
  });

  test('maps an unrecognized reason to noise (only blocked is refusal)', () => {
    expect(classifyFailure('something_unexpected')).toBe('noise');
  });
});
