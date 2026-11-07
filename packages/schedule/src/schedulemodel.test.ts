import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseScheduleFile } from './file.js';
import { applyScheduleModel, formatTimeOfDay, scheduleModelOf } from './schedulemodel.js';

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
      week: [...m.week.slice(1), { ...first, at: first.at + 15 * 60_000 }, { day: 6, at: 21 * 3_600_000, pool: 'late-shows' }],
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
    const week = m.week.filter((s) => s.day !== 3);
    const used = new Set(week.map((s) => s.pool));
    const pools = Object.fromEntries(Object.entries(m.pools).filter(([name]) => used.has(name)));
    const text = applyScheduleModel(EXAMPLE, { week, pools });
    const back = scheduleModelOf(parseScheduleFile(text));
    expect(back.week.some((s) => s.day === 3)).toBe(false);
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
