import { describe, expect, it } from 'vitest';
import { matchesFilter, parseDuration, parseDurationFilter, parseMonthDay, parsePercent, parseRange, parseTimeOfDay } from './units.js';

describe('units', () => {
  it('reads durations', () => {
    expect(parseDuration('15m')).toBe(900_000);
    expect(parseDuration('30s')).toBe(30_000);
    expect(parseDuration('1h30m')).toBe(5_400_000);
    expect(parseDuration('7d')).toBe(604_800_000);
    expect(parseDuration('1d12h')).toBe(129_600_000);
    expect(parseDuration('0')).toBe(0);
    for (const bad of ['', '15', 'abc', '1.5m', '-5m']) expect(() => parseDuration(bad)).toThrow(/not a duration/);
  });
  it('reads ranges', () => {
    expect(parseRange('2m-3m')).toEqual({ min: 120_000, max: 180_000 });
    expect(parseRange('0-5m')).toEqual({ min: 0, max: 300_000 });
    expect(parseRange('2m')).toEqual({ min: 120_000, max: 120_000 });
    expect(parseRange(0)).toEqual({ min: 0, max: 0 });
    expect(() => parseRange('5m-2m')).toThrow(/maximum below/);
    expect(() => parseRange(5)).toThrow(/needs a unit/);
  });
  it('reads percentages, filters, times and dates', () => {
    expect(parsePercent('15%')).toBeCloseTo(0.15);
    expect(() => parsePercent('15')).toThrow();
    const f = parseDurationFilter('<=117m');
    expect(matchesFilter(117 * 60_000, f)).toBe(true);
    expect(matchesFilter(117 * 60_000 + 1, f)).toBe(false);
    expect(matchesFilter(5, parseDurationFilter('>1m'))).toBe(false);
    expect(parseTimeOfDay('20:00')).toBe(72_000_000);
    expect(() => parseTimeOfDay('25:00')).toThrow();
    expect(parseMonthDay('10-31')).toEqual({ month: 10, day: 31 });
    expect(parseMonthDay('2026-10-31')).toEqual({ month: 10, day: 31, year: 2026 });
    expect(() => parseMonthDay('13-40')).toThrow();
  });
});
