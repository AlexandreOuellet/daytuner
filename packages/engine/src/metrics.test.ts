import { describe, expect, it } from 'vitest';
import { episodes, fixtureLibrary, fixtureSchedule, freshState, local, MONDAY_18, TUESDAY_00, ZONE } from './fixtures.js';
import { computeMetrics, distribution } from './metrics.js';
import { plan } from './plan.js';
import type { PlannedSlot } from './schedule.js';
import { HOUR, MINUTE, SECOND } from './time.js';

const G = 15 * MINUTE;

describe('distribution', () => {
  it('uses nearest-rank percentiles', () => {
    const d = distribution([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(d).toEqual({ count: 10, median: 5, p90: 9, p99: 10, max: 10 });
  });
  it('is all zeros for no data', () => {
    expect(distribution([])).toEqual({ count: 0, median: 0, p90: 0, p99: 0, max: 0 });
  });
});

/** A hand-made slot, so every number can be checked by eye. */
const handmade = (): PlannedSlot => {
  const items: PlannedSlot['items'] = [
    { kind: 'filler', role: 'ad', position: 'pre', list: 'a', clipId: 'p', duration: 30 * SECOND },
    { kind: 'content', programId: 'x', startOffset: 0, duration: 10 * MINUTE },
    { kind: 'filler', role: 'ad', position: 'mid', list: 'a', clipId: 'm', duration: 2 * MINUTE },
    { kind: 'content', programId: 'x', startOffset: 10 * MINUTE, duration: 10 * MINUTE },
    { kind: 'filler', role: 'ad', position: 'post', list: 'a', clipId: 'q', duration: 3 * MINUTE },
    { kind: 'flex', duration: 20 * SECOND },
    { kind: 'content', programId: 'y', startOffset: 0, duration: 5 * MINUTE },
    { kind: 'flex', duration: 4 * MINUTE + 30 * SECOND - 20 * SECOND + 0 },
  ];
  const end = items.reduce((a, i) => a + i.duration, 0);
  return { slotId: 's', start: local(2026, 5, 4, 12), end: local(2026, 5, 4, 12) + end, pool: 'p', programs: ['x', 'y'], blocks: [], exception: false, items };
};

describe('computeMetrics on a hand-made slot', () => {
  const m = computeMetrics([handmade()], { grid: G, zone: ZONE });

  it('measures ratios inside each show', () => {
    expect(m.midRollRatio.count).toBe(2);
    expect(m.midRollRatio.max).toBeCloseTo(2 / 20);
    expect(m.adLoadRatio.max).toBeCloseTo((0.5 + 2 + 3) / 20);
  });
  it('measures where a viewer waits', () => {
    expect(m.beginningOfSlotMinutes.median).toBeCloseTo(0.5);
    expect(m.betweenProgramsMinutes.median).toBeCloseTo(3 + 20 / 60);
    expect(m.endOfSlotMinutes.median).toBeCloseTo(4.5 - 20 / 60 + 0);
    expect(m.slotEndsOver10).toBe(0);
  });
  it('counts ads, dead air and shows with no ads or no mid break', () => {
    expect(m.adShare.byPosition['mid']).toBeGreaterThan(0);
    expect(m.deadAirGaps.under1m).toBe(1);
    expect(m.deadAirGaps.under5m).toBe(1);
    expect(m.blocksWithNoAds).toBe(1); // program y has no ads
    expect(m.longShowsWithoutMidBreak).toBe(0);
    expect(m.longestRunOfFillerMinutes).toBeCloseTo(3);
  });
});

describe('computeMetrics on a planned evening', () => {
  const lib = fixtureLibrary();
  const result = plan({ schedule: fixtureSchedule(), library: lib, state: freshState(), from: MONDAY_18, to: TUESDAY_00 });
  const m = computeMetrics(result.slots, { grid: G, zone: ZONE });

  it('finds the plan on the grid, to the millisecond', () => {
    expect(m.gridAccuracy.share).toBe(1);
    expect(m.gridAccuracy.checked).toBeGreaterThan(6);
    expect(m.gridAccuracy.worstMissMs).toBe(0);
  });
  it('has sensible shares', () => {
    expect(m.airTime).toBe(6 * HOUR);
    expect(m.adShare.total).toBeGreaterThan(0.1);
    expect(m.adShare.total).toBeLessThan(0.6);
    expect(m.deadAirShare).toBeLessThan(0.05);
    expect(m.midRollRatio.median).toBeGreaterThan(0);
  });
  it('counts the reruns as repeats', () => {
    // ep2, ep3 and ep4 air in the 18:00 slot and again as the rerun.
    expect(m.repeatedProgramAirings).toBeGreaterThanOrEqual(3);
    expect(episodes(4)).toHaveLength(4);
  });
});

describe('daylight-saving days are left out', () => {
  it('excludes the 23-hour day from the measures', () => {
    const daily = fixtureSchedule({ week: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, at: 0, pool: 'movies' })) });
    const r = plan({ schedule: daily, library: fixtureLibrary(), state: freshState(), from: local(2026, 3, 7), to: local(2026, 3, 10) });
    const m = computeMetrics(r.slots, { grid: G, zone: ZONE });
    expect(m.excludedDstDays).toBe(1);
    expect(m.slots).toBe(2);
  });
});
