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
 * The interstitial position (`gap`) is Tunarr's `fallback`, and a run slot's `rotation` bumper is `mid`.
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
        fillerType: item.position === 'gap' ? 'fallback' : item.position === 'rotation' ? 'mid' : item.position,
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
  // An end up to a few milliseconds past a grid line is that line: Tunarr counts clips at their real lengths, so a lineup written to end
  // on the line can read back a fraction of a millisecond past it, and that must not cost a whole grid step.
  const from = Math.ceil((edge - LATE_MS) / grid) * grid;
  const flex = Math.max(0, Math.round(from - edge));
  return { from, flex };
}

/** How far past a grid line an end or a start still counts as on it. */
export const LATE_MS = 3;

export interface SnapOptions {
  /** Where the first item starts on the grid (a grid line). */
  from: number;
  grid: number;
  /** Where Tunarr will really count the first item to start (the lineup's real end, plus any flex already added). */
  startReal: number;
  /** An item's length as Tunarr counts it, with its fraction. */
  real: (item: LineupItem) => number;
}

/**
 * Keeps the lineup on the grid as Tunarr counts it. Tunarr plays and counts each clip at its real length (29976.961 ms) and the
 * last piece of a program at the program's real length, while DayTuner writes whole milliseconds, so the two timelines part by a
 * fraction of a millisecond per break and the difference adds up over days. This walks the items as Tunarr will count them and,
 * wherever an item is planned to start on a grid line, makes it start there: a flex of the difference (rounded up, so it starts
 * on the line or less than a millisecond after it, never before) when it would start early, and a shorter flex before it when it
 * would start late. The end is held within a millisecond of the last line. The plan itself is not changed; only flex is added or
 * trimmed, and the result is still whole milliseconds.
 */
export function snapToGrid(items: readonly LineupItem[], o: SnapOptions): LineupItem[] {
  const out: LineupItem[] = [];
  let planned = o.from;
  let real = o.startReal;
  let anchor = 0; // where the current stretch since the last grid line began, in `out`
  const settle = (strict: boolean): void => {
    const e = real - planned;
    if (e < -1e-6 && (strict || e <= -1)) {
      const add = strict ? Math.ceil(-e - 1e-6) : Math.floor(-e);
      if (add > 0) { out.push({ type: 'flex', duration: add }); real += add; }
    } else if (e >= 1) {
      // Take the time back from the latest flex since the last grid line (items between it and here start that much earlier,
      // and none of them is planned to be on a line).
      for (let j = out.length - 1; j >= anchor && Math.floor(real - planned) >= 1; j--) {
        const f = out[j]!;
        if (f.type !== 'flex') continue;
        const cut = Math.min(f.duration, Math.floor(real - planned));
        if (cut === f.duration) out.splice(j, 1); else out[j] = { type: 'flex', duration: f.duration - cut };
        real -= cut;
      }
    }
  };
  for (const item of items) {
    if (planned % o.grid === 0) { settle(true); anchor = out.length; }
    out.push(item);
    real += o.real(item);
    planned += item.duration;
  }
  if (planned % o.grid === 0) settle(false);
  return out;
}

export interface AppendReport {
  ok: boolean;
  itemsBefore: number;
  itemsAfter: number;
  /** Where the channel's lineup ended before and after (start time plus duration). */
  edgeBefore: number;
  edgeAfter: number;
  /** What differed, if anything. */
  problems: string[];
}

interface Appender {
  channel(id: string): Promise<{ startTime: number; duration: number }>;
  lineup(id: string): Promise<Record<string, unknown>[]>;
  appendLineup(id: string, lineup: readonly unknown[]): Promise<void>;
}

/**
 * Appends items and then reads the lineup back, checking that Tunarr stored exactly what was sent:
 * the same number of items, in the same order, with the same ids, types and durations, and that the
 * channel grew by exactly their total.
 */
export async function appendVerified(client: Appender, channelId: string, items: readonly LineupItem[]): Promise<AppendReport> {
  const before = await client.channel(channelId);
  const itemsBefore = (await client.lineup(channelId)).length;
  await client.appendLineup(channelId, items);
  const after = await client.channel(channelId);
  const stored = (await client.lineup(channelId)).slice(itemsBefore);

  const problems: string[] = [];
  if (stored.length !== items.length) problems.push(`Tunarr stored ${stored.length} new items but ${items.length} were sent`);
  const n = Math.min(stored.length, items.length);
  for (let i = 0; i < n; i++) {
    const s = stored[i]!;
    const sent = items[i]!;
    const same =
      s['type'] === sent.type &&
      Math.round(Number(s['duration'])) === sent.duration &&
      (sent.type === 'flex' || s['id'] === sent.id) &&
      (sent.type !== 'content' || Number(s['startOffsetMs'] ?? 0) === sent.startOffsetMs) &&
      (sent.type !== 'filler' || (s['fillerListId'] === sent.fillerListId && s['fillerType'] === sent.fillerType));
    if (!same) {
      problems.push(`item ${i} differs from what was sent`);
      if (problems.length >= 5) break;
    }
  }
  const grew = Math.round(after.duration) - Math.round(before.duration);
  if (Math.abs(grew - totalDuration(items)) > 1) problems.push(`the channel grew by ${grew} ms but ${totalDuration(items)} ms were sent`);
  if (after.startTime !== before.startTime) problems.push('the channel start time changed');

  return {
    ok: problems.length === 0,
    itemsBefore,
    itemsAfter: itemsBefore + stored.length,
    edgeBefore: before.startTime + before.duration,
    edgeAfter: after.startTime + after.duration,
    problems,
  };
}
