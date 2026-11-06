// The schedule's clock: its own time zone and daylight-saving rules, owned by this project.
// The engine never reads the system time. Anything that needs "now" is handed a `Clock`.

import { DAY, type Ms } from './time.js';

/** Injected wherever "now" matters. The engine itself never calls `Date.now()`. */
export interface Clock {
  now(): Ms;
}

/** A wall-clock reading in a time zone: `month` is 1 to 12, `day` is 1 to 31, `hour` is 0 to 23. */
export interface LocalTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second?: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(zone: string): Intl.DateTimeFormat {
  let f = formatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(zone, f);
  }
  return f;
}

function utcOf(l: LocalTime): Ms {
  return Date.UTC(l.year, l.month - 1, l.day, l.hour, l.minute, l.second ?? 0);
}

/** The wall-clock reading in `zone` at the instant `epoch`, to the second. */
export function toLocal(zone: string, epoch: Ms): Required<LocalTime> {
  const parts = formatterFor(zone).formatToParts(new Date(epoch));
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
}

/** Offset of `zone` from UTC at `epoch`, in milliseconds (Toronto in winter is -5 hours). */
export function offsetAt(zone: string, epoch: Ms): Ms {
  const wholeSeconds = Math.floor(epoch / 1000) * 1000;
  return utcOf(toLocal(zone, wholeSeconds)) - wholeSeconds;
}

/**
 * The instant at which `zone` shows the wall-clock reading `local`.
 *
 * Daylight saving makes two cases ambiguous, and both are decided here, once:
 * - A reading that happens twice (clocks go back) is the first of the two.
 * - A reading that never happens (clocks go forward) is moved ahead by the length of the gap, so
 *   02:30 on the spring day is 03:30. Nothing is skipped and nothing is repeated.
 */
export function toEpoch(zone: string, local: LocalTime): Ms {
  const guess = utcOf(local);
  const candidates = new Set<Ms>();
  for (const probe of [guess - DAY, guess + DAY]) {
    const offset = offsetAt(zone, probe);
    const t = guess - offset;
    if (offsetAt(zone, t) === offset) candidates.add(t);
  }
  if (candidates.size > 0) return Math.min(...candidates);
  // In the gap: use the offset in force before it, which lands just after the gap.
  return guess - offsetAt(zone, guess - DAY);
}

/** The instant at which the local day containing `epoch` began (usually midnight). */
export function startOfLocalDay(zone: string, epoch: Ms): Ms {
  const l = toLocal(zone, epoch);
  return toEpoch(zone, { year: l.year, month: l.month, day: l.day, hour: 0, minute: 0 });
}

/** The local calendar day after the one containing `epoch`, at its start. */
export function startOfNextLocalDay(zone: string, epoch: Ms): Ms {
  const l = toLocal(zone, epoch);
  // Date.UTC rolls day 32 over into the next month.
  const next = new Date(Date.UTC(l.year, l.month - 1, l.day + 1));
  return toEpoch(zone, {
    year: next.getUTCFullYear(),
    month: next.getUTCMonth() + 1,
    day: next.getUTCDate(),
    hour: 0,
    minute: 0,
  });
}

/** True when the local day containing `epoch` is not 24 hours long (a daylight-saving change). */
export function isDstChangeDay(zone: string, epoch: Ms): boolean {
  return startOfNextLocalDay(zone, epoch) - startOfLocalDay(zone, epoch) !== DAY;
}

/** Day of the week in `zone` at `epoch`: 0 is Sunday, as in the schedule format. */
export function dayOfWeek(zone: string, epoch: Ms): number {
  const l = toLocal(zone, epoch);
  return new Date(Date.UTC(l.year, l.month - 1, l.day)).getUTCDay();
}

/** Throws unless `zone` is a time zone the runtime knows. */
export function assertZone(zone: string): void {
  try {
    formatterFor(zone);
  } catch {
    throw new RangeError(`unknown time zone: ${zone}`);
  }
}
