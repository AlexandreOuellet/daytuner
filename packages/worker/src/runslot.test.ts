// A run slot has no block boundaries on the grid, so the layout check must not reject it (docs/run-slots.md).
import { emptyPlanState, plan, toEpoch, type Schedule } from '@daytuner/engine';
import { describe, expect, it } from 'vitest';
import { layoutProblems } from './worker.js';

const MIN = 60_000;
const clip = (id: string, ms: number) => ({ id, duration: ms });
const videos = Array.from({ length: 40 }, (_, i) => `v${i}`);
const schedule: Schedule = {
  grid: 30 * MIN, zone: 'America/Toronto',
  ads: { step: 15_000, ratio: { min: 0, max: 0.1 } },
  bumpers: { rotation: { list: 'B', every: { min: 3, max: 4 } } },
  pools: { p: { order: 'shuffled', programs: videos } },
  week: [{ day: 1, at: 17 * 60 * MIN, pool: 'p', run: true }, { day: 1, at: 18.5 * 60 * MIN, pool: 'p' }],
  exceptions: [],
};

describe('layoutProblems and run slots', () => {
  it('accepts a run slot whose items are off the grid, and still catches a slot that is', () => {
    const from = toEpoch('America/Toronto', { year: 2026, month: 11, day: 9, hour: 17, minute: 0 });
    const library = {
      programs: Object.fromEntries(videos.map((id, i) => [id, { duration: (130 + i * 7) * 1000 + i }])),
      clips: { B: [clip('b1', 5000), clip('b2', 4000)] },
    };
    const r = plan({ schedule, library, state: emptyPlanState(5), from, to: from + 90 * MIN });
    expect(r.slots[0]!.run).toBe(true);
    expect(layoutProblems(r.slots, from, 30 * MIN)).toEqual([]);
    const bad = { ...r.slots[0]!, end: r.slots[0]!.end - 1000 };
    expect(layoutProblems([bad], from, 30 * MIN).length).toBeGreaterThan(0);
  });
});
