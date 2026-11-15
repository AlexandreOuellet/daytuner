// Pools: where a slot's programs come from. A shuffled pool is a bag, an ordered pool has a cursor.
// Rules: docs/planning-rules.md, "Picking programs". Pure: state in, state out. Programs are ids.

import { shuffle, type RngState } from './rng.js';

/** What a shuffled pool remembers: the programs not yet drawn this round, in the order they will come. */
export interface BagState {
  remaining: string[];
}

export const emptyBag = (): BagState => ({ remaining: [] });

export interface BagPick {
  /** The program picked, or undefined when nothing in the pool fits. */
  pick: string | undefined;
  bag: BagState;
  rng: RngState;
  /** Programs passed over because they did not fit, for the warning ("20 movies won't fit this slot"). */
  skipped: number;
  /** True when every program that fits had already been drawn this round, so the pick is a repeat. */
  repeat: boolean;
}

/**
 * Draws from the bag. Each program is drawn once before any repeats. Fit-aware: if the next one does
 * not fit, a later one that does is taken, and the skipped ones stay in the bag for later. When
 * nothing left in the bag fits, a program already drawn this round that does fit is repeated. When
 * nothing in the pool fits, there is no pick.
 */
export function pickFromBag(
  pool: readonly string[],
  bag: BagState,
  rng: RngState,
  fits: (id: string) => boolean,
): BagPick {
  const inPool = new Set(pool);
  let remaining = bag.remaining.filter((id) => inPool.has(id));
  let state = rng;
  if (remaining.length === 0) [remaining, state] = shuffle([...inPool], state);

  let skipped = 0;
  for (let i = 0; i < remaining.length; i++) {
    if (fits(remaining[i]!)) {
      return { pick: remaining[i], bag: { remaining: remaining.filter((_, j) => j !== i) }, rng: state, skipped, repeat: false };
    }
    skipped++;
  }

  // Nothing left in this round fits: repeat one that was already drawn, if it fits.
  const left = new Set(remaining);
  let drawn: string[];
  [drawn, state] = shuffle([...inPool].filter((id) => !left.has(id)), state);
  for (const id of drawn) {
    if (fits(id)) return { pick: id, bag: { remaining }, rng: state, skipped, repeat: true };
    skipped++;
  }
  return { pick: undefined, bag: { remaining }, rng: state, skipped, repeat: false };
}

/** An explicit pick counts against the bag: it is marked as drawn, so it is not repeated soon. */
export function markDrawn(bag: BagState, id: string): BagState {
  return { remaining: bag.remaining.filter((x) => x !== id) };
}

export interface OrderedPick {
  id: string;
  /** Position in the list. */
  index: number;
}

/**
 * The next program of an ordered pool. `cursor` is the position of the next episode to air, and
 * `ahead` is how many have already been planned in this run but have not aired. Ordered shows never
 * skip, and the list wraps around when it ends.
 */
export function orderedPick(list: readonly string[], cursor: number, ahead = 0): OrderedPick | undefined {
  if (list.length === 0) return undefined;
  if (!Number.isInteger(cursor) || cursor < 0) throw new RangeError(`cursor must be a whole number from 0, got ${cursor}`);
  if (!Number.isInteger(ahead) || ahead < 0) throw new RangeError(`ahead must be a whole number from 0, got ${ahead}`);
  const index = (cursor + ahead) % list.length;
  return { id: list[index]!, index };
}

/** The cursor after `aired` episodes of the sequence have aired. Planned or staged ones do not count. */
export function advanceCursor(cursor: number, aired: number, length: number): number {
  if (length <= 0) return 0;
  if (!Number.isInteger(aired) || aired < 0) throw new RangeError(`aired must be a whole number from 0, got ${aired}`);
  return (cursor + aired) % length;
}

/** A manual move of an ordered show's place: rewind by k episodes, or set to a given episode. */
export type CursorAdjustment = { kind: 'rewind'; by: number } | { kind: 'set'; index: number };

/**
 * The position after a manual adjustment. The list wraps in both directions, so rewinding from the
 * first episode lands on the last one (a series that has looped has just aired its last episode).
 */
export function adjustPosition(position: number, adjustment: CursorAdjustment, length: number): number {
  if (!Number.isInteger(length) || length <= 0) throw new RangeError(`length must be a positive integer, got ${length}`);
  if (!Number.isInteger(position) || position < 0) throw new RangeError(`position must be a whole number from 0, got ${position}`);
  if (adjustment.kind === 'set') {
    if (!Number.isInteger(adjustment.index) || adjustment.index < 0 || adjustment.index >= length) {
      throw new RangeError(`episode ${adjustment.index} is not in a list of ${length}`);
    }
    return adjustment.index;
  }
  if (!Number.isInteger(adjustment.by) || adjustment.by < 0) throw new RangeError(`rewind must be a whole number from 0, got ${adjustment.by}`);
  const back = adjustment.by % length;
  return (position - back + length) % length;
}

/**
 * Where an ordered pool stands. `position` is the head: the next episode to plan. `history` is how
 * many episodes lie behind it that have aired, which is what a rerun slot may replay.
 */
export interface SequenceState {
  position: number;
  history: number;
  /**
   * The last episode taken (planned and committed). The show's list changes when episodes arrive or go, so the number alone can
   * point at the wrong episode; the next one is whatever follows this one in the list as it is now.
   */
  last?: string;
}

export interface PlaceCheck {
  seq: SequenceState;
  /** What changed, for a note: the place moved because the list changed, or the last episode is gone from it. */
  note?: { kind: 'moved' | 'lost'; from: number; to: number };
}

/** The place in the list as it stands now: right after the last episode taken when that is still in the list. */
export function placeInList(seq: SequenceState, list: readonly string[]): PlaceCheck {
  if (seq.last === undefined || list.length === 0) return { seq };
  const at = list.indexOf(seq.last);
  if (at < 0) return { seq: { position: seq.position, history: seq.history }, note: { kind: 'lost', from: seq.position, to: seq.position } };
  const position = (at + 1) % list.length;
  if (position === seq.position % list.length) return { seq };
  return { seq: { ...seq, position }, note: { kind: 'moved', from: seq.position, to: position } };
}

/** The sequence after `taken` more episodes starting at its place: its place, history and last episode. */
export function advanceSequence(seq: SequenceState, list: readonly string[], taken: number): SequenceState {
  if (taken <= 0 || list.length === 0) return seq;
  const position = (seq.position + taken) % list.length;
  return { position, history: seq.history + taken, last: list[(seq.position + taken - 1) % list.length]! };
}

/** A manual adjustment also changes how much history lies behind the head. */
export function adjustSequence(seq: SequenceState, adjustment: CursorAdjustment, length: number, list?: readonly string[]): SequenceState {
  const position = adjustPosition(seq.position, adjustment, length);
  const back = adjustment.kind === 'rewind' ? adjustment.by : Math.max(0, seq.position - position);
  const history = Math.max(0, seq.history - back);
  const last = list && !(position === 0 && history === 0) ? list[(position - 1 + length) % length] : undefined;
  return { position, history, ...(last !== undefined ? { last } : {}) };
}
