// The geometry of a week of slots. Every slot has a start and a length of its own; time no slot covers is a gap. The
// week wraps: a slot that starts late on Saturday can run on into Sunday.

import type { SlotModel, TemplateModel } from './api';

export const HOUR = 3_600_000;
export const DAY = 86_400_000;
export const WEEK = 7 * DAY;

export const keyOf = (s: Pick<SlotModel, 'day' | 'at'>): string => `${s.day}@${s.at}`;
export const absolute = (s: Pick<SlotModel, 'day' | 'at'>): number => s.day * DAY + s.at;
const fromAbsolute = (abs: number): { day: number; at: number } => {
  const a = ((abs % WEEK) + WEEK) % WEEK;
  return { day: Math.floor(a / DAY), at: a % DAY };
};

export interface Seg {
  slot: SlotModel;
  /** From and to, in milliseconds after midnight of the day this piece is drawn in. */
  from: number;
  to: number;
  /** True for the piece that carries on from the previous day (it does not start here). */
  carry: boolean;
  /** True when the slot goes on past the end of this day. */
  continues: boolean;
}

export const slotLength = (_week: readonly SlotModel[], slot: SlotModel): number => slot.length;

/** The pieces of slots drawn in one day's column, in time order. */
export function daySegments(week: readonly SlotModel[], day: number): Seg[] {
  const out: Seg[] = [];
  const lo = day * DAY;
  const hi = lo + DAY;
  for (const s of week) {
    // The slot as it sits in the week, and one week earlier, so a slot that wraps shows in the first days.
    for (const shift of [0, -WEEK]) {
      const a = absolute(s) + shift;
      const b = a + s.length;
      if (b <= lo || a >= hi) continue;
      out.push({ slot: s, from: Math.max(a, lo) - lo, to: Math.min(b, hi) - lo, carry: a < lo, continues: b > hi });
    }
  }
  return out.sort((x, y) => x.from - y.from);
}

export interface GapSeg {
  from: number;
  to: number;
}

/** The stretches of the week no slot covers, as pieces of each day (a gap over midnight is two pieces). */
export function gapSegments(week: readonly SlotModel[], day: number): GapSeg[] {
  const covered = daySegments(week, day).map((s) => [s.from, s.to] as const).sort((a, b) => a[0] - b[0]);
  const out: GapSeg[] = [];
  let at = 0;
  for (const [from, to] of covered) {
    if (from > at) out.push({ from: at, to: from });
    at = Math.max(at, to);
  }
  if (at < DAY) out.push({ from: at, to: DAY });
  return out;
}

/** True when some part of the week is covered by no slot. */
export const hasGaps = (week: readonly SlotModel[]): boolean => Array.from({ length: 7 }, (_, d) => gapSegments(week, d).length > 0).some(Boolean);

export const snap = (ms: number, grid: number): number => Math.round(ms / grid) * grid;

/** Is a slot (other than `except`) playing at this moment of the week? */
function occupant(week: readonly SlotModel[], abs: number, except?: string): SlotModel | undefined {
  const t = ((abs % WEEK) + WEEK) % WEEK;
  return week.find((o) => keyOf(o) !== except && (((t - absolute(o)) % WEEK) + WEEK) % WEEK < o.length);
}

/** How far a slot starting at `abs` could last before the next slot (other than `except`) starts, at most a week. */
export function roomFrom(week: readonly SlotModel[], abs: number, except?: string): number {
  const t = ((abs % WEEK) + WEEK) % WEEK;
  let room = WEEK;
  for (const o of week) {
    if (keyOf(o) === except) continue;
    const d = (((absolute(o) - t) % WEEK) + WEEK) % WEEK;
    if (d > 0) room = Math.min(room, d);
    else return 0;
  }
  return room;
}

/** A new slot from a template (or a pool and length) at a moment, cut short to fit before the next slot. Undefined when that moment is taken. */
export function place(week: readonly SlotModel[], what: TemplateModel & { name?: string }, day: number, at: number, grid: number): SlotModel | undefined {
  const abs = day * DAY + snap(at, grid);
  const start = fromAbsolute(abs);
  if (occupant(week, abs)) return undefined;
  const room = roomFrom(week, abs);
  const length = Math.min(what.length, room);
  if (length < grid) return undefined;
  return {
    day: start.day, at: start.at, length, pool: what.pool,
    ...(what.link ? { link: what.link, ...(what.linkMode ? { linkMode: what.linkMode } : {}) } : {}),
    ...(what.run ? { run: true as const } : {}),
    ...(what.tags ? { tags: what.tags } : {}),
    ...(what.name ? { template: what.name } : {}),
  };
}

/** The slot moved to a new start, keeping its length unless the next slot is in the way. Undefined when the new start is taken. */
export function moveTo(week: readonly SlotModel[], slot: SlotModel, day: number, at: number, grid: number): SlotModel | undefined {
  const abs = day * DAY + snap(at, grid);
  const start = fromAbsolute(abs);
  if (occupant(week, abs, keyOf(slot))) return undefined;
  const room = roomFrom(week, abs, keyOf(slot));
  const length = Math.min(slot.length, room);
  if (length < grid) return undefined;
  return { ...slot, day: start.day, at: start.at, length };
}

/** The slot with a new length, kept between one grid step and the start of the next slot. */
export function resizeTo(week: readonly SlotModel[], slot: SlotModel, length: number, grid: number): SlotModel {
  const room = roomFrom(week, absolute(slot), keyOf(slot));
  return { ...slot, length: Math.max(grid, Math.min(snap(length, grid), room)) };
}

/** "Mon" and so on. */
export const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
