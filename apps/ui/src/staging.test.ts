import { describe, expect, it } from 'vitest';
import type { StagedSlot } from './api';
import { addDays, dayStart, daySegs, HOUR, localDate, stagedDays, timeOf } from './staging';

const Z = 'America/Toronto';
const slot = (start: number, end: number): StagedSlot => ({ start, end, slotId: '1@0', pool: 'p', pins: {}, locked: false, edited: false, programs: [], blocks: [] });

describe('staging geometry', () => {
  it('finds a local date, the start of a local day (also on a daylight-saving day), and day arithmetic', () => {
    expect(localDate(Z, Date.UTC(2026, 10, 1, 3, 30))).toBe('2026-10-31'); // 23:30 on the 31st, Toronto
    expect(dayStart(Z, '2026-10-31')).toBe(Date.UTC(2026, 9, 31, 4));
    expect(dayStart(Z, '2026-11-02')).toBe(Date.UTC(2026, 10, 2, 5)); // after the clocks went back
    expect(dayStart(Z, '2027-03-14') - dayStart(Z, '2027-03-13')).toBe(24 * HOUR);
    expect(dayStart(Z, '2027-03-15') - dayStart(Z, '2027-03-14')).toBe(23 * HOUR); // spring forward on the 14th
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(timeOf(Z, Date.UTC(2026, 10, 1, 1, 15))).toBe('21:15'); // still summer time on the evening of 31 October
  });

  it('lists the days staged slots touch, including the day a slot ends in', () => {
    const d = dayStart(Z, '2026-11-18');
    expect(stagedDays(Z, [slot(d + 20 * HOUR, d + 32 * HOUR), slot(d + 32 * HOUR, d + 44 * HOUR)])).toEqual(['2026-11-18', '2026-11-19']);
  });

  it('cuts slots into the pieces drawn in a day, marking those that carry in or go on', () => {
    const d = dayStart(Z, '2026-11-18');
    const e = d + 24 * HOUR;
    const slots = [slot(d - 4 * HOUR, d + 8 * HOUR), slot(d + 8 * HOUR, d + 20 * HOUR), slot(d + 20 * HOUR, d + 32 * HOUR)];
    expect(daySegs(slots, d, e).map((s) => [s.from / HOUR, s.to / HOUR, s.carry, s.continues])).toEqual([[0, 8, true, false], [8, 20, false, false], [20, 24, false, true]]);
    expect(daySegs(slots, e, e + 24 * HOUR).map((s) => [s.from / HOUR, s.to / HOUR, s.carry])).toEqual([[0, 8, true]]);
  });
});
