import { describe, expect, it } from 'vitest';
import {
  assertZone, dayOfWeek, isDstChangeDay, offsetAt, startOfLocalDay, startOfNextLocalDay, toEpoch, toLocal,
} from './clock.js';
import { DAY, HOUR } from './time.js';

const TZ = 'America/Toronto';
const at = (year: number, month: number, day: number, hour: number, minute = 0) =>
  toEpoch(TZ, { year, month, day, hour, minute });

describe('offsets', () => {
  it('is -5h in winter and -4h in summer', () => {
    expect(offsetAt(TZ, Date.UTC(2026, 0, 15))).toBe(-5 * HOUR);
    expect(offsetAt(TZ, Date.UTC(2026, 6, 15))).toBe(-4 * HOUR);
  });
});

describe('toEpoch and toLocal', () => {
  it('round-trips an ordinary reading', () => {
    const t = at(2026, 5, 4, 13, 0);
    expect(t).toBe(Date.UTC(2026, 4, 4, 17, 0));
    expect(toLocal(TZ, t)).toMatchObject({ year: 2026, month: 5, day: 4, hour: 13, minute: 0 });
  });
  it('moves a reading inside the spring gap ahead by the gap (2026-03-08, 02:30 -> 03:30)', () => {
    expect(at(2026, 3, 8, 2, 30)).toBe(at(2026, 3, 8, 3, 30));
  });
  it('takes the first of a reading that happens twice (2026-11-01, 01:30)', () => {
    const first = at(2026, 11, 1, 1, 30);
    expect(first).toBe(Date.UTC(2026, 10, 1, 5, 30)); // still daylight time, UTC-4
  });
  it('reads midnight and 13:00 correctly on both sides of the change', () => {
    expect(at(2026, 3, 8, 13, 0)).toBe(Date.UTC(2026, 2, 8, 17, 0));
    expect(at(2026, 11, 1, 13, 0)).toBe(Date.UTC(2026, 10, 1, 18, 0));
  });
});

describe('local days', () => {
  it('is 23 hours long when clocks go forward and 25 when they go back', () => {
    expect(startOfNextLocalDay(TZ, at(2026, 3, 8, 12)) - startOfLocalDay(TZ, at(2026, 3, 8, 12))).toBe(23 * HOUR);
    expect(startOfNextLocalDay(TZ, at(2026, 11, 1, 12)) - startOfLocalDay(TZ, at(2026, 11, 1, 12))).toBe(25 * HOUR);
  });
  it('flags only the change days', () => {
    expect(isDstChangeDay(TZ, at(2026, 3, 8, 12))).toBe(true);
    expect(isDstChangeDay(TZ, at(2026, 11, 1, 12))).toBe(true);
    expect(isDstChangeDay(TZ, at(2026, 11, 2, 12))).toBe(false);
    expect(startOfNextLocalDay(TZ, at(2026, 6, 10, 12)) - startOfLocalDay(TZ, at(2026, 6, 10, 12))).toBe(DAY);
  });
  it('rolls over month and year ends', () => {
    expect(startOfNextLocalDay(TZ, at(2026, 12, 31, 20))).toBe(at(2027, 1, 1, 0));
  });
  it('knows the day of the week (2026-11-06 is a Friday)', () => {
    expect(dayOfWeek(TZ, at(2026, 11, 6, 20))).toBe(5);
    expect(dayOfWeek(TZ, at(2026, 11, 8, 0, 30))).toBe(0);
  });
});

describe('zones', () => {
  it('rejects an unknown zone', () => {
    expect(() => assertZone('Mars/Olympus')).toThrow(RangeError);
    expect(() => assertZone(TZ)).not.toThrow();
  });
  it('keeps a quarter-hour zone on a 15-minute grid (Asia/Kathmandu, +5:45)', () => {
    expect(offsetAt('Asia/Kathmandu', Date.UTC(2026, 0, 1)) % (15 * 60_000)).toBe(0);
  });
});
