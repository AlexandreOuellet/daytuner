// Geometry for the staging editor: which local days the staged slots touch, and which pieces of which slots are drawn in a day.
// Dates are "YYYY-MM-DD" in the channel's own time zone.

import type { StagedSlot } from './api';

export const HOUR = 3_600_000;

const parts = (zone: string, ms: number): { y: number; m: number; d: number; h: number; min: number } => {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(ms));
  const g = (t: string): number => Number(p.find((x) => x.type === t)?.value);
  return { y: g('year'), m: g('month'), d: g('day'), h: g('hour'), min: g('minute') };
};

/** The local date of an instant, "2026-11-18". */
export function localDate(zone: string, ms: number): string {
  const p = parts(zone, ms);
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

/** The instant at which `date` begins in `zone`. */
export function dayStart(zone: string, date: string): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const target = Date.UTC(y, m - 1, d);
  let t = target;
  for (let i = 0; i < 3; i++) {
    const p = parts(zone, t);
    t -= Date.UTC(p.y, p.m - 1, p.d, p.h, p.min) - target;
  }
  return t;
}

export const addDays = (date: string, n: number): string => {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};

/** Every local date that some staged slot touches, in order. */
export function stagedDays(zone: string, slots: readonly StagedSlot[]): string[] {
  const out = new Set<string>();
  for (const s of slots) {
    for (let d = localDate(zone, s.start); d <= localDate(zone, s.end - 1); d = addDays(d, 1)) out.add(d);
  }
  return [...out].sort();
}

export interface DaySeg {
  slot: StagedSlot;
  /** Milliseconds after the day's start. */
  from: number;
  to: number;
  /** The slot began before this day. */
  carry: boolean;
  /** The slot goes on after this day. */
  continues: boolean;
}

/** The pieces of staged slots drawn in a day (its start to the next day's start). */
export function daySegs(slots: readonly StagedSlot[], start: number, end: number): DaySeg[] {
  return slots
    .filter((s) => s.end > start && s.start < end)
    .map((s) => ({ slot: s, from: Math.max(s.start, start) - start, to: Math.min(s.end, end) - start, carry: s.start < start, continues: s.end > end }))
    .sort((a, b) => a.from - b.from);
}

/** "20:00" for an instant in the zone. */
export function timeOf(zone: string, ms: number): string {
  const p = parts(zone, ms);
  return `${String(p.h).padStart(2, '0')}:${String(p.min).padStart(2, '0')}`;
}

/** What `zone`'s wall clock is ahead of UTC at an instant, in milliseconds (a whole number of seconds). */
const offsetAt = (zone: string, ms: number): number => {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(ms));
  const g = (t: string): number => Number(p.find((x) => x.type === t)?.value);
  return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second')) - Math.floor(ms / 1000) * 1000;
};

/**
 * An instant as its wall clock in `zone`, written as if the wall clock were UTC. A grid that only knows UTC then draws the
 * channel's own hours (20:00 in Toronto sits on the 20:00 line). Across a daylight saving change the two differ by an hour.
 */
export const wallOf = (zone: string, ms: number): number => ms + offsetAt(zone, ms);

/** The instant whose wall clock in `zone` reads `wall` (the inverse of `wallOf`). */
export function msOf(zone: string, wall: number): number {
  let t = wall;
  for (let i = 0; i < 3; i++) t = wall - offsetAt(zone, t);
  return t;
}
