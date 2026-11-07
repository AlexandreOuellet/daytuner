// The geometry of a week of slots. A slot lasts until the next slot starts, and the week wraps: the last slot of
// Saturday runs on into Sunday's first.

import type { SlotModel } from './api';

export const HOUR = 3_600_000;
export const DAY = 86_400_000;
const WEEK = 7 * DAY;

export const keyOf = (s: Pick<SlotModel, 'day' | 'at'>): string => `${s.day}@${s.at}`;
const absolute = (s: Pick<SlotModel, 'day' | 'at'>): number => s.day * DAY + s.at;

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

/** The slots in the order they air, wrapping. */
const ordered = (week: readonly SlotModel[]): SlotModel[] => [...week].sort((a, b) => absolute(a) - absolute(b));

/** How long a slot lasts: until the next slot starts, wrapping round the week. A lone slot lasts the whole week. */
export function slotLength(week: readonly SlotModel[], slot: SlotModel): number {
  const all = ordered(week);
  const i = all.findIndex((s) => keyOf(s) === keyOf(slot));
  if (i < 0) return 0;
  const next = all[(i + 1) % all.length]!;
  const len = absolute(next) - absolute(slot);
  return len > 0 ? len : len + WEEK;
}

/** The pieces drawn in one day's column, in time order. */
export function daySegments(week: readonly SlotModel[], day: number): Seg[] {
  const out: Seg[] = [];
  const lo = day * DAY;
  const hi = lo + DAY;
  for (const s of ordered(week)) {
    const len = slotLength(week, s);
    // The slot as it sits in the week, and one week earlier, so a slot that wraps shows in the first days.
    for (const shift of [0, -WEEK]) {
      const a = absolute(s) + shift;
      const b = a + len;
      if (b <= lo || a >= hi) continue;
      out.push({ slot: s, from: Math.max(a, lo) - lo, to: Math.min(b, hi) - lo, carry: a < lo, continues: b > hi });
    }
  }
  return out.sort((x, y) => x.from - y.from);
}

export const snap = (ms: number, grid: number): number => Math.round(ms / grid) * grid;

/** Where a slot may start: after the slot before it in the same day, and before the one after it, one grid step clear of each. */
export function startRange(week: readonly SlotModel[], slot: SlotModel, grid: number): { min: number; max: number } {
  const sameDay = week.filter((s) => s.day === slot.day && keyOf(s) !== keyOf(slot));
  const before = Math.max(-grid, ...sameDay.filter((s) => s.at < slot.at).map((s) => s.at));
  const after = Math.min(DAY, ...sameDay.filter((s) => s.at > slot.at).map((s) => s.at));
  return { min: before + grid, max: Math.min(DAY - grid, after - grid) };
}

/** "Mon" and so on. */
export const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
