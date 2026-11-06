// The block builder: one program plus its pre, mid and post ads and its bumpers.
// Rules: docs/planning-rules.md, "Blocks". The first block of a planned slot also carries the slot's
// head, and the last block carries its tail, so that one water level covers all of them and the
// slot ends exactly where it should. Lengths only: the slot layer lays the items out.

import { planBreaks, type Range } from './breaks.js';
import { chooseEvenly, offerPoints, thinByMinGap, type Chapter, type OfferRule } from './offers.js';
import { assertMs, ceilToGrid, type Ms } from './time.js';

export interface BlockAds {
  /** Planned lengths are multiples of this (15 seconds). */
  step: Ms;
  /** Ads inside the block as a share of the program: 0.15 is 15%. Bumpers are not counted. */
  ratio: { min: number; max: number };
  pre?: Range;
  post?: Range;
  mid?: { range: Range; offers: OfferRule; minGap?: Ms };
}

/** The slot's head, planned with the first block: a bumper (already picked) then ads. */
export interface BlockHead {
  bumper: Ms;
  ads: Range;
}

/** The slot's tail, planned with the last block: ads then a bumper (already picked). */
export interface BlockTail {
  bumper: Ms;
  ads: Range;
  /** Where the slot ends, on the grid. The tail ends exactly here. */
  slotEnd: Ms;
}

export interface BlockInput {
  /** Where the block starts: the slot's start when it has a head, otherwise on the grid. */
  start: Ms;
  grid: Ms;
  gridOrigin?: Ms;
  /** The program's length. */
  content: Ms;
  chapters?: readonly Chapter[];
  /** Lengths of the bumper clips already picked: pre is right before the ad break, post right after. */
  bumpers?: { pre?: Ms; post?: Ms };
  ads: BlockAds;
  /** Set on the first block of a slot that has a head. */
  head?: BlockHead;
  /** Set on the last block of a slot that has a tail. The block then ends at `slotEnd`. */
  tail?: BlockTail;
}

export type BlockWarningCode =
  /** The positions cannot reach the ratio minimum, so the block holds the most they allow. */
  | 'ratio-min-unreachable'
  /** The required minimums are more than the ratio maximum allows. The minimums win. */
  | 'minimums-exceed-ratio-max';

export interface BlockWarning {
  code: BlockWarningCode;
  message: string;
}

export interface Block {
  start: Ms;
  /** On the grid, or the slot's end when the block has a tail. */
  end: Ms;
  content: Ms;
  bumperHead: Ms;
  adsHead: Ms;
  bumperPre: Ms;
  bumperPost: Ms;
  adsPre: Ms;
  adsPost: Ms;
  adsTail: Ms;
  bumperTail: Ms;
  /** Mid breaks in program order: `at` is content time, `length` is the ad time of the break. */
  midBreaks: { at: Ms; length: Ms }[];
  /** Time that no ad fills, for interstitials then dead air. It sits before the tail, if any. */
  gap: Ms;
  warnings: BlockWarning[];
}

// A share like 0.15 of an exact number of milliseconds can land a hair above a step boundary.
const EPSILON = 1e-9;
const ceilToStep = (x: number, step: Ms): Ms => Math.ceil(x / step - EPSILON) * step;
const floorToStep = (x: number, step: Ms): Ms => Math.floor(x / step + EPSILON) * step;

/** The block cannot fit before the slot ends. The slot layer picks another program. */
export class BlockDoesNotFit extends RangeError {
  constructor(readonly shortBy: Ms) {
    super(`the block needs ${shortBy} ms more than the slot has`);
    this.name = 'BlockDoesNotFit';
  }
}

export function buildBlock(input: BlockInput): Block {
  const { start, grid, content, ads } = input;
  const gridOrigin = input.gridOrigin ?? 0;
  assertMs(start, 'start');
  assertMs(content, 'content length');
  if (content <= 0) throw new RangeError('content length must be positive');
  const bumperPre = input.bumpers?.pre ?? 0;
  const bumperPost = input.bumpers?.post ?? 0;
  assertMs(bumperPre, 'pre bumper');
  assertMs(bumperPost, 'post bumper');
  if (ads.ratio.min < 0 || ads.ratio.max < ads.ratio.min) {
    throw new RangeError(`ads ratio ${ads.ratio.min} to ${ads.ratio.max} is not valid`);
  }

  const step = ads.step;
  const head = input.head;
  const tail = input.tail;
  const headAds = head?.ads ?? { min: 0, max: 0 };
  const tailAds = tail?.ads ?? { min: 0, max: 0 };
  const bumperHead = head?.bumper ?? 0;
  const bumperTail = tail?.bumper ?? 0;
  assertMs(bumperHead, 'head bumper');
  assertMs(bumperTail, 'tail bumper');
  const pre = ads.pre ?? { min: 0, max: 0 };
  const post = ads.post ?? { min: 0, max: 0 };
  const warnings: BlockWarning[] = [];

  let offers: Ms[] = [];
  if (ads.mid) {
    offers = offerPoints(content, ads.mid.offers, input.chapters ?? []);
    if (ads.mid.minGap) offers = thinByMinGap(offers, ads.mid.minGap);
  }
  const midRange = ads.mid?.range ?? { min: 0, max: 0 };

  const fixed = content + bumperPre + bumperPost + bumperHead + bumperTail;
  const minAds = ceilToStep(content * ads.ratio.min, step);
  const capAds = floorToStep(content * ads.ratio.max, step);
  const edgeMin = headAds.min + pre.min + post.min + tailAds.min;
  const edgeMax = headAds.max + pre.max + post.max + tailAds.max;
  const offered = offers.length;

  // The mid breaks the ratio minimum forces: the fewest that let the positions reach it. Every other
  // offered break is optional, and a break is taken only if the room pays for it.
  let forced = 0;
  while (forced < offered && edgeMax + forced * midRange.max < minAds) forced++;
  const reachable = edgeMax + forced * midRange.max;
  let needed = Math.max(edgeMin + forced * midRange.min, minAds);
  if (needed > reachable) {
    needed = Math.max(edgeMin + forced * midRange.min, reachable);
    warnings.push({
      code: 'ratio-min-unreachable',
      message: `the positions allow ${reachable} ms of ads but the ratio minimum is ${minAds} ms`,
    });
  }

  let end: Ms;
  if (tail) {
    end = tail.slotEnd;
    if (start + fixed + needed > end) throw new BlockDoesNotFit(start + fixed + needed - end);
  } else {
    end = ceilToGrid(start + fixed + needed, grid, gridOrigin);
  }
  const room = end - start - fixed;

  // The budget is the room the block already has, within the ratio maximum. The optional breaks take
  // what is left after every fixed minimum, so they never make the block longer.
  let budget = Math.min(room, capAds);
  let breaks = offered;
  while (breaks > forced && edgeMin + breaks * midRange.min > budget) breaks--;
  if (edgeMin + breaks * midRange.min > budget) {
    budget = edgeMin + breaks * midRange.min;
    warnings.push({
      code: 'minimums-exceed-ratio-max',
      message: `the minimum ads (${budget} ms) are more than the ratio maximum allows (${capAds} ms)`,
    });
  }

  const plan = planBreaks({
    step,
    budget,
    edges: {
      pre,
      post,
      ...(head ? { head: headAds } : {}),
      ...(tail ? { tail: tailAds } : {}),
    },
    ...(breaks > 0 ? { mid: { count: breaks, range: midRange } } : {}),
  });

  const chosen = chooseEvenly(offers, breaks, content);
  return {
    start,
    end,
    content,
    bumperHead,
    adsHead: plan.edges.head ?? 0,
    bumperPre,
    bumperPost,
    adsPre: plan.edges.pre ?? 0,
    adsPost: plan.edges.post ?? 0,
    adsTail: plan.edges.tail ?? 0,
    bumperTail,
    midBreaks: chosen.map((at, i) => ({ at, length: plan.mid[i]! })).filter((b) => b.length > 0),
    gap: room - plan.used,
    warnings,
  };
}
