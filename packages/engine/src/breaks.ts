// The break planner: splits an ad budget across the positions with a rising water level.
// Rules: docs/planning-rules.md, "Ad positions". Pure: lengths in, lengths out.
// It plans lengths only. Choosing the clips that fill each length is a later step.

import { assertMs, type Ms } from './time.js';

export interface Range {
  min: Ms;
  max: Ms;
}

/** The single-slot positions, listed in tie order: on equal length the first one rises first. */
export const EDGE_ORDER = ['tail', 'post', 'pre', 'head'] as const;
export type EdgePosition = (typeof EDGE_ORDER)[number];

export interface BreakInput {
  /** Planned lengths are multiples of this (15 seconds), because ad clips are 15 to 30 seconds. */
  step: Ms;
  /** The most ad time the positions may use together. */
  budget: Ms;
  /** The positions that apply here. A position left out gets no ads. */
  edges: Partial<Record<EdgePosition, Range>>;
  /** The mid breaks: `count` breaks that share one range. Rank after every edge position on ties. */
  mid?: { count: number; range: Range };
}

export interface BreakPlan {
  edges: Partial<Record<EdgePosition, Ms>>;
  /** One length per mid break, in the order the breaks fall in the program. */
  mid: Ms[];
  used: Ms;
  /** Budget not spent: less than one step, or every position is at its maximum. */
  leftover: Ms;
}

function checkRange(name: string, r: Range, step: Ms): void {
  assertMs(r.min, `${name} minimum`);
  assertMs(r.max, `${name} maximum`);
  if (r.min < 0 || r.max < r.min) throw new RangeError(`${name} range ${r.min} to ${r.max} is not valid`);
  if (r.min % step !== 0 || r.max % step !== 0) {
    throw new RangeError(`${name} range must be multiples of the ${step} ms step`);
  }
}

/**
 * Reserve every minimum, then raise all positions together one step at a time, always the shortest
 * first. A position that reaches its maximum drops out. The mid breaks rise together as one group
 * (every break gains a step). When only the mid breaks can still rise and a whole round does not fit,
 * single mid breaks take the leftover steps, earliest break first, so some are one step longer.
 */
export function planBreaks(input: BreakInput): BreakPlan {
  const { step, budget } = input;
  assertMs(step, 'step');
  assertMs(budget, 'budget');
  if (step <= 0) throw new RangeError('step must be positive');
  if (budget < 0) throw new RangeError('budget must not be negative');

  const edges: Partial<Record<EdgePosition, Ms>> = {};
  let spent = 0;
  for (const name of EDGE_ORDER) {
    const r = input.edges[name];
    if (!r) continue;
    checkRange(name, r, step);
    edges[name] = r.min;
    spent += r.min;
  }

  const count = input.mid?.count ?? 0;
  if (!Number.isInteger(count) || count < 0) throw new RangeError(`mid count must be a whole number, got ${count}`);
  const midRange = input.mid?.range;
  if (count > 0 && midRange) checkRange('mid', midRange, step);
  const mid: Ms[] = count > 0 && midRange ? Array<Ms>(count).fill(midRange.min) : [];
  spent += mid.reduce((a, b) => a + b, 0);

  if (spent > budget) {
    throw new RangeError(`the minimums need ${spent} ms but the budget is ${budget} ms`);
  }

  const rank = (name: EdgePosition): number => EDGE_ORDER.indexOf(name);

  for (;;) {
    const remaining = budget - spent;
    if (remaining < step) break;

    // Candidates that can still rise and fit, with their cost and their tie rank.
    let best: { length: Ms; rank: number; edge?: EdgePosition } | undefined;
    for (const name of EDGE_ORDER) {
      const r = input.edges[name];
      const length = edges[name];
      if (!r || length === undefined || length >= r.max) continue;
      const cand = { length, rank: rank(name), edge: name };
      if (!best || cand.length < best.length || (cand.length === best.length && cand.rank < best.rank)) best = cand;
    }
    const midLength = mid[0];
    const groupCanRise = midRange !== undefined && midLength !== undefined && mid.every((l) => l === midLength) && midLength < midRange.max;
    if (groupCanRise && count * step <= remaining) {
      const cand = { length: midLength, rank: EDGE_ORDER.length };
      if (!best || cand.length < best.length || (cand.length === best.length && cand.rank < best.rank)) best = cand;
    }

    if (best?.edge) {
      edges[best.edge] = best.length + step;
      spent += step;
    } else if (best) {
      for (let i = 0; i < count; i++) mid[i] = best.length + step;
      spent += count * step;
    } else {
      // No edge position can rise and a whole round of mid breaks does not fit.
      const i = midRange ? mid.findIndex((l) => l < midRange.max) : -1;
      if (i < 0) break;
      mid[i] = mid[i]! + step;
      spent += step;
    }
  }

  return { edges, mid, used: spent, leftover: budget - spent };
}
