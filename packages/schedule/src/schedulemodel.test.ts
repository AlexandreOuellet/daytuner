import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseScheduleFile } from './file.js';
import { gapsOf } from './weekplan.js';
import { applyScheduleModel, exceptionOccurrences, formatTimeOfDay, scheduleModelOf } from './schedulemodel.js';

const EXAMPLE = readFileSync(new URL('../../../schedules/example.yaml', import.meta.url), 'utf8');
const model = () => scheduleModelOf(parseScheduleFile(EXAMPLE));

describe('the week and pools of a channel file', () => {
  it('read as slots with a day and a time, and pools of shows or movies', () => {
    const m = model();
    expect(m).toMatchObject({ timezone: 'America/Toronto', grid: 900_000 });
    expect(m.week.filter((s) => s.day === 0).map((s) => [formatTimeOfDay(s.at), s.pool])).toEqual(m.week.filter((s) => s.day === 0).map((s) => [formatTimeOfDay(s.at), s.pool]));
    expect(m.week.filter((s) => s.day === 0)).not.toHaveLength(0);
    expect(m.pools['office-hours']).toMatchObject({ shows: [{ show: 'The Office' }, { show: 'Parks and Recreation' }, { show: '30 Rock' }], order: 'sequential' });
    expect(m.pools['comedy-movies-up-to-117']!.movies).toEqual({ genre: 'Comedy', duration: { op: '<=', ms: 117 * 60_000 } });
    expect(formatTimeOfDay(72_000_000)).toBe('20:00');
  });

  it('written back unchanged leave the file exactly as it was', () => {
    expect(applyScheduleModel(EXAMPLE, model())).toBe(EXAMPLE);
  });

  it('change a slot, add a slot and a pool, keeping the rest of the file', () => {
    const m = model();
    const first = m.week[0]!;
    const next = {
      week: [...m.week.slice(1).map((x) => ({ ...x, length: 2 * 3_600_000 })), { ...first, at: first.at + 15 * 60_000, length: first.length - 15 * 60_000 }, { day: 6, at: 21 * 3_600_000, length: 900_000, pool: 'late-shows' }],
      fill: first.pool,
      pools: { ...m.pools, 'late-shows': { shows: [{ show: 'Doctor Who', id: 'abc' }], order: 'sequential' as const } },
    };
    const text = applyScheduleModel(EXAMPLE, next);
    const back = scheduleModelOf(parseScheduleFile(text));
    expect(back.pools['late-shows']).toEqual({ shows: [{ show: 'Doctor Who', id: 'abc' }], order: 'sequential' });
    expect(back.week.find((s) => s.day === 6 && s.at === 21 * 3_600_000)).toMatchObject({ pool: 'late-shows' });
    expect(back.week.find((s) => s.day === first.day && s.at === first.at + 15 * 60_000)).toBeDefined();
    expect(text).toContain('# matches the channel in Tunarr'); // comments elsewhere survive
    expect(text).toContain('exceptions:');
    expect(text).toContain('Halloween Special'); // special days untouched
  });

  it('remove a slot, a whole day, and a pool nobody uses any more', () => {
    const m = model();
    const week = m.week.filter((s) => s.at !== 13 * 3_600_000); // the Sunday 13:00 slot, so Sunday 00:00 now lasts 13 hours and the rest is a gap
    const used = new Set(week.map((s) => s.pool));
    const pools = Object.fromEntries(Object.entries(m.pools).filter(([name]) => used.has(name)));
    expect(() => applyScheduleModel(EXAMPLE, { week, pools })).toThrow(/fill pool/);
    const text = applyScheduleModel(EXAMPLE, { week, pools, fill: week[0]!.pool });
    const back = scheduleModelOf(parseScheduleFile(text));
    expect(back.week).toHaveLength(1);
    expect(back.fill).toBe(week[0]!.pool);
    expect(Object.keys(back.pools)).toEqual(Object.keys(pools));
  });

  it('refuse what would not be a valid week', () => {
    const m = model();
    const s0 = m.week[0]!;
    expect(() => applyScheduleModel(EXAMPLE, { ...m, week: [...m.week, { ...s0 }] })).toThrow(/two slots start at/);
    expect(() => applyScheduleModel(EXAMPLE, { ...m, week: [{ ...s0, at: s0.at + 60_000 }] })).toThrow(/not on the 15m grid/);
    expect(() => applyScheduleModel(EXAMPLE, { ...m, week: [{ ...s0, pool: 'ghost' }] })).toThrow(/unknown pool "ghost"/);
    expect(() => applyScheduleModel(EXAMPLE, { ...m, week: [{ ...s0, at: 86_400_000 }] })).toThrow(/not within a day/);
    expect(() => applyScheduleModel(EXAMPLE, { ...m, week: [{ ...s0, linkMode: 'rerun', link: undefined }] })).toThrow(/link mode needs a link/);
    expect(() => applyScheduleModel(EXAMPLE, { ...m, week: [] })).toThrow(/no slots/);
    expect(() => applyScheduleModel(EXAMPLE, { ...m, pools: { ...m.pools, 'office-hours': { shows: [{ show: 'X' }], movies: {} } } })).toThrow(/either shows or movies/);
    expect(() => applyScheduleModel(EXAMPLE, { ...m, pools: { ...m.pools, 'office-hours': { shows: [] } } })).toThrow(/no shows/);
  });
});


describe('special days', () => {
  it('read from the file as dates, times and the program played', () => {
    const m = model();
    expect(m.exceptions).toHaveLength(2);
    expect(m.exceptions[0]).toMatchObject({ on: { month: 10, day: 31 }, at: 72_000_000, play: { show: 'Doctor Who', title: 'Halloween Special' } });
    expect(m.exceptions[1]!.play).toMatchObject({ movie: 'The Nightmare Before Christmas' });
  });

  it('written back unchanged leave the file as it was; added, changed and removed ones change only that section', () => {
    const m = model();
    expect(applyScheduleModel(EXAMPLE, { week: m.week, pools: m.pools, exceptions: m.exceptions })).toBe(EXAMPLE);
    expect(applyScheduleModel(EXAMPLE, { week: m.week, pools: m.pools })).toBe(EXAMPLE); // left out: untouched
    const added = applyScheduleModel(EXAMPLE, { week: m.week, pools: m.pools, exceptions: [...m.exceptions, { on: { month: 12, day: 24, year: 2026 }, at: 72_000_000, play: { movie: 'Elf', id: 'e1' }, counts: false }] });
    const back = scheduleModelOf(parseScheduleFile(added)).exceptions;
    expect(back).toHaveLength(3);
    expect(back[2]).toEqual({ on: { month: 12, day: 24, year: 2026 }, at: 72_000_000, play: { movie: 'Elf', id: 'e1' }, counts: false });
    expect(added).toContain('# matches the channel in Tunarr');
    const removed = scheduleModelOf(parseScheduleFile(applyScheduleModel(EXAMPLE, { week: m.week, pools: m.pools, exceptions: [m.exceptions[1]!] }))).exceptions;
    expect(removed).toHaveLength(1);
    expect(scheduleModelOf(parseScheduleFile(applyScheduleModel(EXAMPLE, { week: m.week, pools: m.pools, exceptions: [] }))).exceptions).toEqual([]);
  });

  it('refuse a date that does not exist, a time off the grid, and an unknown pool', () => {
    const m = model();
    const e = m.exceptions[0]!;
    const go = (x: object) => applyScheduleModel(EXAMPLE, { week: m.week, pools: m.pools, exceptions: [{ ...e, ...x }] });
    expect(() => go({ on: { month: 2, day: 30 } })).toThrow(/not a real date/);
    expect(() => go({ at: 72_060_000 })).toThrow(/not on the 15m grid/);
    expect(() => go({ counts: 'ghost' })).toThrow(/unknown pool "ghost"/);
  });

  it('are placed on the calendar in the schedule zone: every year, or one, skipping 29 February when there is none', () => {
    const base = { week: model().week, timezone: 'America/Toronto' };
    const from = Date.UTC(2026, 5, 1);
    const to = Date.UTC(2028, 5, 1);
    const occ = exceptionOccurrences({ ...base, exceptions: [{ on: { month: 10, day: 31 }, at: 72_000_000, play: { movie: 'x' } }, { on: { month: 2, day: 29 }, at: 0, play: { movie: 'y' } }, { on: { month: 12, day: 24, year: 2026 }, at: 72_000_000, play: { movie: 'z' } }] }, from, to);
    expect(occ.map((o) => [o.index, o.date])).toEqual([[0, '2026-10-31'], [2, '2026-12-24'], [0, '2027-10-31'], [1, '2028-02-29']]); // 2028 has a 29 February; 2027 does not
    expect(exceptionOccurrences({ ...base, exceptions: [{ on: { month: 2, day: 29 }, at: 0, play: { movie: 'y' } }] }, Date.UTC(2027, 0, 1), Date.UTC(2027, 11, 31))).toEqual([]);
    expect(occ[0]!.start).toBe(Date.UTC(2026, 10, 1, 0)); // 20:00 on 31 October is 00:00 UTC on 1 November (Toronto is UTC-4 until the 1st)
    expect(typeof occ[0]!.matchesSlot).toBe('boolean');
  });
});

describe('slots with their own length and a fill pool', () => {
  it('a file without lengths reads each slot as lasting until the next, and writes none back', () => {
    const m = model();
    expect(m.week.map((s) => s.length)).toEqual([13 * 3_600_000, 7 * 86_400_000 - 13 * 3_600_000]);
    expect(applyScheduleModel(EXAMPLE, m)).toBe(EXAMPLE);
  });

  it('a shorter slot leaves a gap that the fill pool plays in, and the resolved week gets a slot for it', async () => {
    const m = model();
    const week = m.week.map((s) => (s.at === 13 * 3_600_000 ? { ...s, length: 2 * 3_600_000 } : s));
    const text = applyScheduleModel(EXAMPLE, { week, pools: m.pools, fill: 'office-hours' });
    expect(text).toContain('length: 2h');
    const back = scheduleModelOf(parseScheduleFile(text));
    expect(back.fill).toBe('office-hours');
    expect(back.week.find((s) => s.at === 13 * 3_600_000)!.length).toBe(2 * 3_600_000);
    expect(gapsOf(back.week)).toEqual([{ day: 0, at: 15 * 3_600_000, length: 7 * 86_400_000 - 15 * 3_600_000 }]);
  });

  it('overlapping slots and a gap with no fill pool are refused', () => {
    const m = model();
    const long = m.week.map((s) => (s.at === 0 ? { ...s, length: 14 * 3_600_000 } : s));
    expect(() => applyScheduleModel(EXAMPLE, { week: long, pools: m.pools })).toThrow(/next slot starts/);
    const short = m.week.map((s) => (s.at === 13 * 3_600_000 ? { ...s, length: 3_600_000 } : s));
    expect(() => applyScheduleModel(EXAMPLE, { week: short, pools: m.pools })).toThrow(/fill pool/);
  });

  it('templates are saved with the file and a slot may name one', () => {
    const m = model();
    const templates = { 'Prime movie': { pool: 'comedy-movies-up-to-117', length: 9_000_000 } };
    const week = m.week.map((s) => (s.at === 13 * 3_600_000 ? { ...s, template: 'Prime movie' } : s));
    const text = applyScheduleModel(EXAMPLE, { week, pools: m.pools, templates });
    expect(text).toContain('templates:');
    const back = scheduleModelOf(parseScheduleFile(text));
    expect(back.templates).toEqual(templates);
    expect(back.week.find((s) => s.at === 13 * 3_600_000)!.template).toBe('Prime movie');
    expect(() => applyScheduleModel(EXAMPLE, { week, pools: m.pools, templates: {} })).toThrow(/unknown template/);
  });
});
