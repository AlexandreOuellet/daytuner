import { describe, expect, it } from 'vitest';
import { diffSlots } from './slotdiff.js';
import type { PlannedSlot } from './schedule.js';

const slot = (start: number, end: number, programs: string[], flex = 0, clip = 'a'): PlannedSlot => ({
  slotId: `s${start}`, start, end, pool: 'p', programs, blocks: [], exception: false,
  items: [{ kind: 'filler', role: 'ad', position: 'mid', list: 'Ads', clipId: clip, duration: 1000 }, ...(flex ? [{ kind: 'flex' as const, duration: flex }] : [])],
});

describe('diffSlots', () => {
  it('reports nothing when the plans are the same', () => {
    expect(diffSlots([slot(0, 10, ['x'])], [slot(0, 10, ['x'])])).toEqual([]);
  });
  it('tells new, removed, changed and ads-only slots apart, in time order, with dead air', () => {
    const before = [slot(0, 10, ['a'], 25_000), slot(10, 20, ['b']), slot(20, 30, ['c']), slot(30, 40, ['d'])];
    const after = [slot(0, 10, ['a2']), slot(10, 20, ['b'], 0, 'other'), slot(20, 35, ['c']), slot(50, 60, ['e'])];
    const c = diffSlots(before, after);
    expect(c.map((x) => [x.start, x.kind])).toEqual([[0, 'changed'], [10, 'ads-only'], [20, 'changed'], [30, 'removed'], [50, 'new']]);
    expect(c[0]).toMatchObject({ before: ['a'], after: ['a2'], deadAirBefore: 25_000, deadAirAfter: 0 });
    expect(c[2]).toMatchObject({ endBefore: 30, end: 35 });
  });
});
