// Turns the engine's planned slots into the items Tunarr's manual lineup accepts, and works out the
// alignment needed to append to a lineup whose end is not on the grid.
// Shapes: docs/tunarr-api.md. Every duration written here is a whole number of milliseconds.

import type { Item, PlannedSlot } from '@daytuner/engine';

export type LineupItem =
  | { type: 'content'; id: string; startOffsetMs: number; duration: number }
  | { type: 'filler'; id: string; fillerListId: string; fillerType: FillerType; duration: number }
  | { type: 'flex'; duration: number };

export type FillerType = 'head' | 'pre' | 'mid' | 'post' | 'tail' | 'fallback';

function whole(n: number, what: string): number {
  if (!Number.isSafeInteger(n) || n <= 0) throw new RangeError(`${what} must be a positive whole number of milliseconds, got ${n}`);
  return n;
}

function offset(n: number): number {
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError(`start offset must be a whole number of milliseconds from 0, got ${n}`);
  return n;
}

/**
 * @param fillerListIds Tunarr's id for each clip list name the engine used.
 * The interstitial position (`gap`) is Tunarr's `fallback`.
 */
export function toLineupItems(slots: readonly PlannedSlot[], fillerListIds: Readonly<Record<string, string>>): LineupItem[] {
  const out: LineupItem[] = [];
  for (const slot of slots) {
    for (const item of slot.items) out.push(convert(item, fillerListIds));
  }
  return out;
}

function convert(item: Item, fillerListIds: Readonly<Record<string, string>>): LineupItem {
  switch (item.kind) {
    case 'content':
      return {
        type: 'content',
        id: item.programId,
        startOffsetMs: offset(item.startOffset),
        duration: whole(item.duration, 'content duration'),
      };
    case 'filler': {
      const fillerListId = fillerListIds[item.list];
      if (fillerListId === undefined) throw new RangeError(`no Tunarr filler list is known for "${item.list}"`);
      return {
        type: 'filler',
        id: item.clipId,
        fillerListId,
        fillerType: item.position === 'gap' ? 'fallback' : item.position,
        duration: whole(item.duration, 'filler duration'),
      };
    }
    case 'flex':
      return { type: 'flex', duration: whole(item.duration, 'flex duration') };
  }
}

/** The total of a list of items, in whole milliseconds. */
export function totalDuration(items: readonly LineupItem[]): number {
  return items.reduce((a, i) => a + i.duration, 0);
}

export interface Alignment {
  /** The first grid line at or after the end of the lineup. Planning starts here. */
  from: number;
  /** Flex to append first to reach it (whole milliseconds), or 0 when the end is already on the grid. */
  flex: number;
}

/**
 * Where to start planning when appending to a lineup that ends at `edge` (the channel's start time
 * plus its duration, which may carry a fraction from older, fractional durations). The flex is
 * rounded to whole milliseconds, so the lineup is within half a millisecond of the grid from there on.
 */
export function alignToGrid(edge: number, grid: number): Alignment {
  if (!Number.isFinite(edge)) throw new RangeError('the end of the lineup must be a number');
  if (!Number.isSafeInteger(grid) || grid <= 0) throw new RangeError('grid must be a positive whole number of milliseconds');
  const from = Math.ceil(edge / grid) * grid;
  const flex = Math.round(from - edge);
  return { from, flex };
}
