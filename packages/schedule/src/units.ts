import { toEpoch } from '@daytuner/engine';

// Parsing the small units a schedule file uses: durations, ranges, percentages, times of day.
// Every parser returns whole milliseconds (or a plain fraction for a percentage) or throws a
// message that says what was wrong.

const UNIT_MS: Record<string, number> = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1_000 };

/** "7d", "15m", "30s", "1h", "1h30m", or "0". */
export function parseDuration(text: string): number {
  const t = text.trim();
  if (t === '0') return 0;
  const m = /^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(t);
  if (!m || t === '') throw new Error(`"${text}" is not a duration (use 7d, 15m, 30s, 1h30m)`);
  return Number(m[1] ?? 0) * UNIT_MS['d']! + Number(m[2] ?? 0) * UNIT_MS['h']! + Number(m[3] ?? 0) * UNIT_MS['m']! + Number(m[4] ?? 0) * UNIT_MS['s']!;
}

export interface MsRange {
  min: number;
  max: number;
}

/** "2m-3m", "0-5m", "2m" (the same minimum and maximum), "0" or the number 0. */
export function parseRange(value: string | number): MsRange {
  if (typeof value === 'number') {
    if (value === 0) return { min: 0, max: 0 };
    throw new Error(`"${value}" needs a unit, for example ${value}m`);
  }
  const parts = value.split('-');
  if (parts.length === 1) {
    const ms = parseDuration(parts[0]!);
    return { min: ms, max: ms };
  }
  if (parts.length !== 2) throw new Error(`"${value}" is not a range (use 2m-3m)`);
  const min = parseDuration(parts[0]!);
  const max = parseDuration(parts[1]!);
  if (max < min) throw new Error(`"${value}" has a maximum below its minimum`);
  return { min, max };
}

/** "15%" is 0.15. */
export function parsePercent(text: string): number {
  const m = /^(\d+(?:\.\d+)?)%$/.exec(text.trim());
  if (!m) throw new Error(`"${text}" is not a percentage (use 15%)`);
  return Number(m[1]) / 100;
}

export interface DurationFilter {
  op: '<=' | '<' | '>=' | '>' | '=';
  ms: number;
}

/** "<=117m", ">90m", "=22m". */
export function parseDurationFilter(text: string): DurationFilter {
  const m = /^(<=|>=|<|>|=)\s*(.+)$/.exec(text.trim());
  if (!m) throw new Error(`"${text}" is not a duration filter (use <=117m)`);
  return { op: m[1] as DurationFilter['op'], ms: parseDuration(m[2]!) };
}

export function matchesFilter(ms: number, f: DurationFilter): boolean {
  switch (f.op) {
    case '<=': return ms <= f.ms;
    case '<': return ms < f.ms;
    case '>=': return ms >= f.ms;
    case '>': return ms > f.ms;
    case '=': return ms === f.ms;
  }
}

/** "20:00" is 72,000,000 ms after local midnight. */
export function parseTimeOfDay(text: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new Error(`"${text}" is not a time of day (use 20:00)`);
  return Number(m[1]) * UNIT_MS['h']! + Number(m[2]) * UNIT_MS['m']!;
}

export interface MonthDay {
  month: number;
  day: number;
  year?: number;
}

/** "10-31" (every year) or "2026-10-31" (one year). */
export function parseMonthDay(text: string): MonthDay {
  const m = /^(?:(\d{4})-)?(\d{1,2})-(\d{1,2})$/.exec(text.trim());
  if (!m) throw new Error(`"${text}" is not a date (use 10-31 or 2026-10-31)`);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) throw new Error(`"${text}" is not a real date`);
  return { month, day, ...(m[1] ? { year: Number(m[1]) } : {}) };
}

/**
 * A local date or date and time in `zone`: "2026-10-31" is that day at midnight, "2026-10-31T20:00" an
 * exact local time. Returns the instant. Rejects anything else, and dates that do not exist.
 */
export function parseLocalDateTime(zone: string, text: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/.exec(text.trim());
  if (!m) throw new Error(`"${text}" is not a date (use 2026-10-31 or 2026-10-31T20:00, in the channel's time zone)`);
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const [hour, minute] = [Number(m[4] ?? 0), Number(m[5] ?? 0)];
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day || hour > 23 || minute > 59) {
    throw new Error(`"${text}" is not a real date`);
  }
  return toEpoch(zone, { year, month, day, hour, minute });
}
