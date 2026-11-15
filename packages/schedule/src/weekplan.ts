// A week of slots that each have a start and may have a length. A slot without a length lasts until the next slot
// starts (the week wraps); a slot with one may leave a gap, which a channel's `fill` pool covers. The planner knows only
// slot starts, so `expandWeek` turns a week with gaps into one where each gap is a slot of the fill pool.

const DAY = 86_400_000;
const WEEK = 7 * DAY;

export interface SpanSlot {
  /** 0 is Sunday. */
  day: number;
  /** Milliseconds after local midnight. */
  at: number;
  /** Milliseconds; left out means "until the next slot starts". */
  length?: number;
}

/** The name the slots that cover gaps share, so they keep one place in the fill pool between them. */
export const FILL_LINK = '~fill';

const absolute = (s: SpanSlot): number => s.day * DAY + s.at;

/** Each slot's length when it has none: the distance to the next start, round the week. Keyed `day@at`. */
export function implicitLengths(slots: readonly SpanSlot[]): Map<string, number> {
  const all = [...slots].sort((a, b) => absolute(a) - absolute(b));
  const out = new Map<string, number>();
  all.forEach((s, i) => {
    const next = all[(i + 1) % all.length]!;
    const len = absolute(next) - absolute(s);
    out.set(`${s.day}@${s.at}`, len > 0 ? len : len + WEEK);
  });
  return out;
}

/** The slot's length as it will play: its own, or until the next start. */
export function lengthOf(slots: readonly SpanSlot[], slot: SpanSlot): number {
  return slot.length ?? implicitLengths(slots).get(`${slot.day}@${slot.at}`) ?? WEEK;
}

export interface Gap {
  day: number;
  at: number;
  length: number;
}

/**
 * The stretches of the week no slot covers. Throws a RangeError when two slots overlap, naming them. Does not check
 * the grid or the pools.
 */
export function gapsOf(slots: readonly SpanSlot[]): Gap[] {
  const all = [...slots].sort((a, b) => absolute(a) - absolute(b));
  const implicit = implicitLengths(slots);
  const gaps: Gap[] = [];
  for (const s of all) {
    const full = implicit.get(`${s.day}@${s.at}`)!;
    const len = s.length ?? full;
    if (len > full) throw new RangeError(`the slot at day ${s.day} ${s.at} ms lasts ${len} ms but the next slot starts after ${full} ms`);
    if (len < full) {
      const start = (absolute(s) + len) % WEEK;
      gaps.push({ day: Math.floor(start / DAY), at: start % DAY, length: full - len });
    }
  }
  return gaps;
}

export interface Placed {
  day: number;
  at: number;
}

/** The slots with a start-only slot of `fill` added at the start of each gap. Throws when there is a gap and no fill pool. */
export function expandWeek<T extends Placed & SpanSlot>(slots: readonly T[], fill: string | undefined, make: (g: Gap) => T): T[] {
  const gaps = gapsOf(slots);
  if (gaps.length === 0) return [...slots];
  if (!fill) throw new RangeError('the week has gaps (time no slot covers), so the file needs a "fill" pool to play in them');
  return [...slots, ...gaps.map(make)];
}
