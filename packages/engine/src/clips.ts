// Clip filling: turns a planned length into real clips. The planners work in lengths; Tunarr plays
// whole clips (15 to 30 seconds), so a break rarely adds up exactly. Rules: docs/planning-rules.md.
// Clips come from a bag per list (each plays once before any repeats), with a best-fit effort.

import { pickFromBag, type BagState } from './pools.js';
import { shuffle, type RngState } from './rng.js';
import { assertMs, type Ms } from './time.js';

export interface Clip {
  id: string;
  duration: Ms;
  /** The length with its fraction, as Tunarr counts it (see Program.exact). */
  exact?: number;
}

export interface Fill {
  clips: Clip[];
  /** Room the clips could not fill: less than the shortest clip, unless the list is empty. */
  shortfall: Ms;
  bag: BagState;
  rng: RngState;
}

/** How many clips of the bag are considered together when looking for the best fit. */
const WINDOW = 8;

function indexClips(list: readonly Clip[]): Map<string, Clip> {
  const byId = new Map<string, Clip>();
  for (const c of list) {
    assertMs(c.duration, `duration of clip ${c.id}`);
    if (c.duration <= 0) throw new RangeError(`clip ${c.id} has no length`);
    if (byId.has(c.id)) throw new RangeError(`clip ${c.id} is listed twice`);
    byId.set(c.id, c);
  }
  return byId;
}

/** One round: the best combination from the next clips of the bag. May be empty. */
function round(
  room: Ms,
  byId: ReadonlyMap<string, Clip>,
  bag: BagState,
  rng: RngState,
): { ids: string[]; sum: Ms; bag: BagState; rng: RngState } {
  let state = rng;
  let remaining = bag.remaining.filter((id) => byId.has(id));
  if (remaining.length === 0) [remaining, state] = shuffle([...byId.keys()], state);
  const left = new Set(remaining);
  let drawn: string[];
  [drawn, state] = shuffle([...byId.keys()].filter((id) => !left.has(id)), state);

  const full = [...remaining, ...drawn];
  const order = full.slice(0, WINDOW);
  const durations = order.map((id) => byId.get(id)!.duration);

  let best: number[] = [];
  let bestSum = 0;
  const path: number[] = [];
  const search = (from: number, sum: number): void => {
    if (sum > bestSum) {
      bestSum = sum;
      best = [...path];
    }
    for (let i = from; i < order.length; i++) {
      const next = sum + durations[i]!;
      if (next > room) continue;
      path.push(i);
      search(i + 1, next);
      path.pop();
      if (bestSum === room) return;
    }
  };
  search(0, 0);

  let ids = best.map((i) => order[i]!);
  if (ids.length === 0) {
    // None of the next clips fits: take the first clip anywhere in the bag that does.
    const any = full.find((id) => byId.get(id)!.duration <= room);
    if (any !== undefined) {
      ids = [any];
      bestSum = byId.get(any)!.duration;
    }
  }
  const used = new Set(ids);
  return { ids, sum: bestSum, bag: { remaining: remaining.filter((id) => !used.has(id)) }, rng: state };
}

/**
 * Fills `room` with whole clips, never exceeding it. Each round takes the next clips of the bag and
 * picks the combination that leaves the least unfilled, preferring earlier clips on ties. Clips used
 * are removed from the bag. A long room from a short list goes round the bag again, so a repeat only
 * happens once every clip has played. The result is less than the shortest clip short.
 */
export function fillWithClips(room: Ms, list: readonly Clip[], bag: BagState, rng: RngState): Fill {
  assertMs(room, 'room');
  if (room < 0) throw new RangeError('room must not be negative');
  const byId = indexClips(list);
  const shortest = Math.min(...[...byId.values()].map((c) => c.duration));

  const clips: Clip[] = [];
  let left = room;
  let b = bag;
  let r = rng;
  while (byId.size > 0 && left >= shortest) {
    const step = round(left, byId, b, r);
    b = step.bag;
    r = step.rng;
    if (step.ids.length === 0) break;
    for (const id of step.ids) clips.push(byId.get(id)!);
    left -= step.sum;
  }
  return { clips, shortfall: left, bag: b, rng: r };
}

export interface BreaksFill {
  /** The clips of each break, in the order given. */
  breaks: Clip[][];
  /** What the last break could not fill. The caller turns it into interstitials, then dead air. */
  shortfall: Ms;
  bag: BagState;
  rng: RngState;
}

/**
 * Fills a run of breaks in the order they air. Whatever one break cannot fill is added to the room
 * of the next, so the small gaps do not pile up in every break.
 */
export function fillBreaks(rooms: readonly Ms[], list: readonly Clip[], bag: BagState, rng: RngState): BreaksFill {
  const breaks: Clip[][] = [];
  let carry = 0;
  let b = bag;
  let r = rng;
  for (const room of rooms) {
    const fill = fillWithClips(room + carry, list, b, r);
    breaks.push(fill.clips);
    carry = fill.shortfall;
    b = fill.bag;
    r = fill.rng;
  }
  return { breaks, shortfall: carry, bag: b, rng: r };
}

/** One clip with no length constraint, for a bumper. Undefined when the list is empty. */
export function pickClip(list: readonly Clip[], bag: BagState, rng: RngState): { clip: Clip | undefined; bag: BagState; rng: RngState } {
  const byId = indexClips(list);
  const r = pickFromBag([...byId.keys()], bag, rng, () => true);
  return { clip: r.pick === undefined ? undefined : byId.get(r.pick), bag: r.bag, rng: r.rng };
}
