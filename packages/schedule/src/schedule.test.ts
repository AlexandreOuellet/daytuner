import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { plan, emptyPlanState, toLocalForTest } from './testing.js';
import { parseScheduleFile, ScheduleFileError } from './file.js';
import { resolveSchedule, ResolveError, same, takeTurns } from './resolve.js';
import { fakeSource } from './testing.js';

const EXAMPLE = readFileSync(new URL('../../../schedules/example.yaml', import.meta.url), 'utf8');

describe('the example channel file', () => {
  const file = parseScheduleFile(EXAMPLE);

  it('parses', () => {
    expect(file.channel).toBe('the-funny-bone');
    expect(file.timezone).toBe('America/Toronto');
    expect(file.grid).toBe(900_000);
    expect(file.ads.ratio.min).toBeCloseTo(0.15);
    expect(file.ads.mid).toMatchObject({ list: 'Old Ads', every: 480_000, tailBuffer: 60_000, length: { min: 120_000, max: 180_000 } });
    expect(file.ads.post?.length).toEqual({ min: 0, max: 300_000 });
    expect(file.week.sun?.map((s) => s.pool)).toEqual(['office-hours', 'comedy-movies-up-to-117']);
  });

  it('resolves against a library into what the engine takes', async () => {
    const r = await resolveSchedule(file, fakeSource());
    expect(r.schedule.pools['office-hours']!.order).toBe('ordered');
    expect(r.schedule.pools['kids-movies']!.order).toBe('shuffled');
    // Genre and length filters: only comedies of at most 117 minutes.
    expect([...r.schedule.pools['comedy-movies-up-to-117']!.programs].sort()).toEqual(['mov-comedy-100', 'mov-comedy-90']);
    // Head and pre have length 0, so they are not positions at all.
    expect(r.schedule.ads.head).toBeUndefined();
    expect(r.schedule.ads.pre).toBeUndefined();
    expect(r.schedule.ads.tail).toEqual({ list: 'Old Ads', range: { min: 0, max: 1_500_000 } });
    expect(r.fillerListIds['Old Ads']).toBe('fl-ads');
    expect(r.schedule.exceptions).toHaveLength(2);
    expect(r.schedule.exceptions[0]).toMatchObject({ on: { month: 10, day: 31 }, at: 72_000_000 });
    expect(r.library.programs[r.schedule.exceptions[0]!.programId]).toBeDefined();
  });

  it('gives every program a readable title', async () => {
    const r = await resolveSchedule(file, fakeSource());
    expect(r.titles['office-1']).toBe('The Office S1E1 "Episode 1"');
    expect(r.titles['mov-comedy-90']).toBe('Short Laughs');
    for (const id of Object.keys(r.library.programs)) expect(r.titles[id]).toBeTruthy();
  });

  it('plans a Sunday end to end with the engine', async () => {
    const r = await resolveSchedule(file, fakeSource());
    const from = toLocalForTest(2026, 11, 8, 0);
    const result = plan({ schedule: r.schedule, library: r.library, state: emptyPlanState(1), from, to: toLocalForTest(2026, 11, 8, 13) });
    expect(result.slots).toHaveLength(1);
    const s = result.slots[0]!;
    expect(s.items.reduce((a, i) => a + i.duration, 0)).toBe(13 * 3_600_000);
    expect(s.programs.length).toBeGreaterThan(10);
  });
});

describe('title matching', () => {
  it('ignores case, spacing and curly quotes', () => {
    expect(same("Schitt's Creek", 'Schitt\u2019s  creek ')).toBe(true);
    expect(same('The Office', 'the office')).toBe(true);
    expect(same('The Office', 'The Office (US)')).toBe(false);
  });
});

describe('ordered pools of several shows', () => {
  it('take turns, and a show that runs out drops out', () => {
    expect(takeTurns([['a1', 'a2', 'a3'], ['b1'], ['c1', 'c2']])).toEqual(['a1', 'b1', 'c1', 'a2', 'c2', 'a3']);
    expect(takeTurns([])).toEqual([]);
  });

  it('use the turns order in the resolved pool', async () => {
    const r = await resolveSchedule(parseScheduleFile(EXAMPLE), fakeSource());
    expect(r.schedule.pools['office-hours']!.programs.slice(0, 4)).toEqual(['office-1', 'parks-1', 'rock-1', 'office-2']);
  });
});

describe('mistakes are reported clearly', () => {
  const withEdit = (from: string, to: string) => EXAMPLE.replace(from, to);

  it('rejects unknown keys', () => {
    expect(() => parseScheduleFile(withEdit('grid: 15m', 'grid: 15m\ngrdi: 5m'))).toThrow(ScheduleFileError);
  });
  it('says where a bad value is', () => {
    expect(() => parseScheduleFile(withEdit('grid: 15m', 'grid: fifteen'))).toThrow(/grid: .*not a duration/);
  });
  it('rejects a slot that uses an unknown pool', () => {
    expect(() => parseScheduleFile(withEdit('pool: office-hours', 'pool: nope'))).toThrow(/unknown pool "nope"/);
  });
  it('rejects overflow and lateness above zero, which are not supported yet', () => {
    expect(() => parseScheduleFile(withEdit('overflow: 0', 'overflow: 5'))).toThrow(ScheduleFileError);
  });
  it('rejects invalid YAML', () => {
    expect(() => parseScheduleFile('a: [1, 2')).toThrow(/not valid YAML/);
  });
  it('rejects ads in a position with no list', () => {
    expect(() => parseScheduleFile(withEdit('head: { length: 0 }', 'head: { length: 1m }'))).toThrow(/needs a list/);
  });
  it('reports a missing list, show, episode and empty pool when resolving', async () => {
    const file = parseScheduleFile(EXAMPLE);
    await expect(resolveSchedule({ ...file, interstitial: { list: 'Nope' } }, fakeSource())).rejects.toThrow(/no filler list named "Nope"/);
    await expect(resolveSchedule({ ...file, pools: { ...file.pools, 'office-hours': { shows: ['Ghost Show'] } } }, fakeSource())).rejects.toThrow(/no show named "Ghost Show"/);
    await expect(resolveSchedule({ ...file, pools: { ...file.pools, 'kids-movies': { movies: { genre: 'Western' } } } }, fakeSource())).rejects.toThrow(ResolveError);
    const badEx = { ...file, exceptions: [{ ...file.exceptions[0]!, play: { show: 'Doctor Who', title: 'Nope' } }] };
    await expect(resolveSchedule(badEx, fakeSource())).rejects.toThrow(/no episode titled "Nope"/);
  });
});
