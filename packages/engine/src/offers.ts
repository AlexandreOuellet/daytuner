// Mid-break offers: the places in a program where a break may go, and the choice of which to use.
// Rules: docs/planning-rules.md, "Ad positions". Times are content time: milliseconds from the
// start of the program, with ads and bumpers not counted.

import { assertMs, type Ms } from './time.js';

export type ChapterType = 'chapter' | 'intro' | 'outro' | 'break' | 'recap';

/** A chapter marker of a program, in milliseconds from the start of the program. */
export interface Chapter {
  start: Ms;
  end: Ms;
  type: ChapterType;
}

export interface OfferRule {
  /** Used when the program has no eligible chapters: an offer at every multiple of this. */
  every: Ms;
  /** No offer closer than this to the end of the program. */
  tailBuffer: Ms;
  /** Which chapter markers are eligible. Defaults to `break` and `chapter`. */
  chapterTypes?: readonly ChapterType[];
}

const DEFAULT_CHAPTER_TYPES: readonly ChapterType[] = ['break', 'chapter'];

/** An offer must lie inside the program, and at least `tailBuffer` before its end. */
function isOfferable(t: Ms, content: Ms, tailBuffer: Ms): boolean {
  return t > 0 && t < content && t <= content - tailBuffer;
}

/**
 * Where breaks may go, earliest first. A break goes at the end of each eligible chapter. A program
 * with no eligible chapters gets one every `every`. Never at the start or at the very end.
 */
export function offerPoints(content: Ms, rule: OfferRule, chapters: readonly Chapter[] = []): Ms[] {
  assertMs(content, 'content length');
  assertMs(rule.every, 'offer interval');
  assertMs(rule.tailBuffer, 'tail buffer');
  if (content <= 0) throw new RangeError('content length must be positive');
  if (rule.every <= 0) throw new RangeError('offer interval must be positive');
  if (rule.tailBuffer < 0) throw new RangeError('tail buffer must not be negative');

  const types = rule.chapterTypes ?? DEFAULT_CHAPTER_TYPES;
  const eligible = chapters.filter((c) => types.includes(c.type));
  const raw: Ms[] = [];
  if (eligible.length > 0) {
    for (const c of eligible) raw.push(c.end);
  } else {
    for (let t = rule.every; t < content; t += rule.every) raw.push(t);
  }
  const sorted = [...new Set(raw)].sort((a, b) => a - b);
  return sorted.filter((t) => isOfferable(t, content, rule.tailBuffer));
}

/** Drops each offer closer than `minGap` to the previous kept offer, or to the start. */
export function thinByMinGap(offers: readonly Ms[], minGap: Ms): Ms[] {
  const kept: Ms[] = [];
  let previous = 0;
  for (const t of offers) {
    if (t - previous < minGap) continue;
    kept.push(t);
    previous = t;
  }
  return kept;
}

/**
 * Chooses `count` of the offers, with the gaps between breaks (counting the start and the end of the
 * program) as close to equal as possible. All of them when `count` is at least the number of offers.
 * Ties go to the earlier offers, so the answer is always the same.
 */
export function chooseEvenly(offers: readonly Ms[], count: number, content: Ms): Ms[] {
  if (!Number.isInteger(count) || count < 0) throw new RangeError(`count must be a whole number, got ${count}`);
  const n = offers.length;
  if (count >= n) return [...offers];
  if (count === 0) return [];

  const ideal = content / (count + 1);
  const cost = (gap: Ms): number => (gap - ideal) ** 2;
  // best[j][i]: least cost of a chain of j+1 breaks that ends with offer i, counting the gaps before it.
  const best: number[][] = [];
  const from: number[][] = [];
  for (let j = 0; j < count; j++) {
    best.push(Array<number>(n).fill(Infinity));
    from.push(Array<number>(n).fill(-1));
  }
  for (let i = 0; i < n; i++) best[0]![i] = cost(offers[i]!);
  for (let j = 1; j < count; j++) {
    for (let i = j; i < n; i++) {
      for (let p = j - 1; p < i; p++) {
        const c = best[j - 1]![p]! + cost(offers[i]! - offers[p]!);
        if (c < best[j]![i]!) {
          best[j]![i] = c;
          from[j]![i] = p;
        }
      }
    }
  }
  let end = -1;
  let endCost = Infinity;
  for (let i = count - 1; i < n; i++) {
    const c = best[count - 1]![i]! + cost(content - offers[i]!);
    if (c < endCost) {
      endCost = c;
      end = i;
    }
  }
  const chosen: Ms[] = [];
  for (let j = count - 1, i = end; j >= 0; i = from[j]![i]!, j--) chosen.unshift(offers[i]!);
  return chosen;
}
