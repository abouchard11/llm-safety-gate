import { describe, test, expect } from 'vitest';
import { planPublish } from '../plan-publish.js';

// planPublish — the pure decision behind graceful per-item publish planning.
// flags is [primaryFlag, ...otherFlags] by default (primaryIndex defaults to 0).
// All fixtures below are fully synthetic boolean arrays; no item content or
// classifier is involved — this is pure array/decision-table logic.

describe('planPublish', () => {
  test('nothing flagged -> publish all, drop none, keep chosen primary', () => {
    const p = planPublish([false, false, false, false, false, false], { minItems: 3 }); // primary + 5 others
    expect(p).toEqual({
      ok: true,
      keptIdx: [0, 1, 2, 3, 4],
      dropped: 0,
      primaryFlagged: false,
      promotedFrom: null,
    });
  });

  test('one flagged non-primary item is dropped, the rest publish', () => {
    const p = planPublish([false, false, true, false, false, false], { minItems: 3 });
    expect(p).toEqual({
      ok: true,
      keptIdx: [0, 2, 3, 4],
      dropped: 1,
      primaryFlagged: false,
      promotedFrom: null,
    });
  });

  test('kicks back when fewer than the floor survive', () => {
    const p = planPublish([false, true, true, true, false, false], { minItems: 3 });
    expect(p).toEqual({
      ok: false,
      keptIdx: [3, 4],
      dropped: 3,
      primaryFlagged: false,
      promotedFrom: null,
    });
  });

  test('flagged primary is replaced by the first clean non-primary item', () => {
    const p = planPublish([true, false, false, false, false, false], { minItems: 3 });
    expect(p).toEqual({
      ok: true,
      keptIdx: [0, 1, 2, 3, 4],
      dropped: 0,
      primaryFlagged: true,
      promotedFrom: 0,
    });
  });

  test('flagged primary with too few clean non-primary items kicks back', () => {
    const p = planPublish([true, true, true, true, false], { minItems: 3 });
    expect(p).toEqual({
      ok: false,
      keptIdx: [3],
      dropped: 3,
      primaryFlagged: true,
      promotedFrom: 3,
    });
  });

  test('flagged primary with zero clean non-primary items -> no primary to promote -> kickback', () => {
    const p = planPublish([true, true, true, true], { minItems: 3 });
    expect(p).toEqual({
      ok: false,
      keptIdx: [],
      dropped: 3,
      primaryFlagged: true,
      promotedFrom: null,
    });
  });

  test('exactly the floor survives -> still publishes (inclusive threshold)', () => {
    const p = planPublish([false, false, false, false, true, true], { minItems: 3 });
    expect(p).toEqual({
      ok: true,
      keptIdx: [0, 1, 2],
      dropped: 2,
      primaryFlagged: false,
      promotedFrom: null,
    });
  });

  test('defaults: primaryIndex=0 and minItems=3 apply when options are omitted', () => {
    const p = planPublish([false, true, true, true, false, false]);
    expect(p).toEqual({
      ok: false,
      keptIdx: [3, 4],
      dropped: 3,
      primaryFlagged: false,
      promotedFrom: null,
    });
  });

  test('honors a non-default primaryIndex, renumbering surviving non-primary items in original relative order', () => {
    // primary lives at index 2; non-primary items are indices [0,1,3,4,5] in that order,
    // all clean, so nothing is dropped and the promoted primary is the first of them.
    const p = planPublish([false, false, true, false, false, false], { primaryIndex: 2, minItems: 3 });
    expect(p).toEqual({
      ok: true,
      keptIdx: [0, 1, 2, 3, 4],
      dropped: 0,
      primaryFlagged: true,
      promotedFrom: 0,
    });
  });

  test('honors a custom minItems floor lower than the default', () => {
    const p = planPublish([false, true, true, false], { minItems: 1 });
    expect(p).toEqual({
      ok: true,
      keptIdx: [2],
      dropped: 2,
      primaryFlagged: false,
      promotedFrom: null,
    });
  });
});
