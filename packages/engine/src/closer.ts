// The closer: the clips that fill the time left before the tail, so a slot ends on the grid.
// Rules: docs/run-slots.md, "Filling the gap: the closer". Pure: state in, state out.
//
// Order, stopping at the first step that works: (1) clips of the bag, the best fit, never repeating one that already
// played this round; (2) if time is left, the next clip of the bag cut off at the window's end; a cut clip stays in the bag,
// so it plays whole next time. A cooldown keeps recently aired clips out of both steps; when every clip is in its cooldown,
// they are used anyway and the caller is told.

import { fillWithClips, type Clip } from './clips.js';
import type { BagState } from './pools.js';
import { shuffle, type RngState } from './rng.js';
import type { Interstitial } from './schedule.js';
import { MINUTE, type Ms } from './time.js';

/** A cut is only worth showing from this long: under it the remainder is left to dead air. */
export const MIN_CUT: Ms = MINUTE;

export interface CloserPiece {
  clip: Clip;
  /** The clip's length, or less when it is cut at the window's end. */
  duration: Ms;
  cut: boolean;
}

export interface CloserFill {
  pieces: CloserPiece[];
  /** Room the pieces could not fill. */
  shortfall: Ms;
  bag: BagState;
  rng: RngState;
  /** Every clip was inside its cooldown, so some had to repeat. */
  cooldownExhausted: boolean;
}

/** True when the interstitial asks for any of the closer's rules. Without them the list behaves as it always has. */
export const isCloser = (cfg: Interstitial): boolean => cfg.length !== undefined || cfg.cooldown !== undefined || cfg.cut === true;

/**
 * Fills `room` for the closer list. `playedAt` maps a clip id to when it last aired and `now` is when this window starts.
 * Without any closer rule it is plain best-fit filling, as before.
 */
export function fillCloser(
  room: Ms,
  list: readonly Clip[],
  cfg: Interstitial,
  bag: BagState,
  rng: RngState,
  playedAt: Readonly<Record<string, Ms>>,
  now: Ms,
  tags?: readonly string[],
): CloserFill {
  const suits = (c: Clip): boolean => !tags || tags.length === 0 || !c.tags || c.tags.length === 0 || c.tags.some((t) => tags.includes(t));
  if (!isCloser(cfg)) {
    const f = fillWithClips(room, tags && tags.length > 0 ? list.filter(suits) : list, bag, rng);
    return { pieces: f.clips.map((clip) => ({ clip, duration: clip.duration, cut: false })), shortfall: f.shortfall, bag: f.bag, rng: f.rng, cooldownExhausted: false };
  }
  const inRange = (cfg.length ? list.filter((c) => c.duration >= cfg.length!.min && c.duration <= cfg.length!.max) : [...list]).filter(suits);
  const cooled = (c: Clip): boolean => cfg.cooldown === undefined || playedAt[c.id] === undefined || now - playedAt[c.id]! >= cfg.cooldown;
  let usable = inRange.filter(cooled);
  let cooldownExhausted = false;
  if (usable.length === 0 && inRange.length > 0) {
    usable = inRange;
    cooldownExhausted = true;
  }
  if (usable.length === 0 || room <= 0) return { pieces: [], shortfall: Math.max(room, 0), bag, rng, cooldownExhausted: false };

  const f = fillWithClips(room, usable, bag, rng, { replay: false });
  const pieces: CloserPiece[] = f.clips.map((clip) => ({ clip, duration: clip.duration, cut: false }));
  let left = f.shortfall;
  let b = f.bag;
  let r = f.rng;

  if (cfg.cut === true && left >= MIN_CUT) {
    // Whatever is left is shorter than every usable clip, so the next clip of the bag is always longer than it.
    const ids = new Set(usable.map((c) => c.id));
    const used = new Set(pieces.map((p) => p.clip.id));
    let order = b.remaining.filter((id) => ids.has(id) && !used.has(id));
    if (order.length === 0) {
      let shuffled: string[];
      [shuffled, r] = shuffle(usable.filter((c) => !used.has(c.id)).map((c) => c.id), r);
      order = shuffled;
      b = { remaining: [...order] };
    }
    const next = usable.find((c) => c.id === order[0]);
    if (next && next.duration > left) {
      pieces.push({ clip: next, duration: left, cut: true });
      left = 0;
    }
  }
  return { pieces, shortfall: left, bag: b, rng: r, cooldownExhausted };
}
