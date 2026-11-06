import { describe, expect, it } from 'vitest';
import { EDGE_ORDER, planBreaks, type BreakInput } from './breaks.js';
import { MINUTE, SECOND } from './time.js';

const m = (n: number) => n * MINUTE;

describe('rising water level', () => {
  it('raises the shortest first, with tail, post, pre, head, mid on ties', () => {
    // 1-minute step. Minimums 4 minutes (two mid breaks of 2), so 6 minutes of water to spend.
    const plan = planBreaks({
      step: m(1), budget: m(10),
      edges: { tail: { min: 0, max: m(25) }, post: { min: 0, max: m(5) } },
      mid: { count: 2, range: { min: m(2), max: m(3) } },
    });
    expect(plan.edges).toEqual({ tail: m(3), post: m(3) });
    expect(plan.mid).toEqual([m(2), m(2)]);
    expect(plan.leftover).toBe(0);
  });

  it('lets the mid breaks rise together once the others have caught up', () => {
    const plan = planBreaks({
      step: m(1), budget: m(14),
      edges: { tail: { min: 0, max: m(25) }, post: { min: 0, max: m(5) } },
      mid: { count: 2, range: { min: m(2), max: m(3) } },
    });
    expect(plan.mid).toEqual([m(3), m(3)]);
    expect(plan.used + plan.leftover).toBe(m(14));
  });

  it('drops a position that reached its maximum and gives its share to the others', () => {
    const plan = planBreaks({
      step: m(1), budget: m(20),
      edges: { post: { min: 0, max: m(2) }, tail: { min: 0, max: m(25) } },
    });
    expect(plan.edges).toEqual({ post: m(2), tail: m(18) });
  });

  it('gives single mid breaks the leftover steps when a whole round does not fit', () => {
    const plan = planBreaks({ step: m(1), budget: m(8), edges: {}, mid: { count: 3, range: { min: m(2), max: m(3) } } });
    expect(plan.mid).toEqual([m(3), m(3), m(2)]);
    expect(plan.leftover).toBe(0);
  });

  it('keeps every minimum, even a position that must not stay empty', () => {
    const plan = planBreaks({ step: 15 * SECOND, budget: m(3), edges: { post: { min: m(1), max: m(5) } } });
    expect(plan.edges.post).toBe(m(3));
  });

  it('leaves the rest unspent when every position is at its maximum', () => {
    const plan = planBreaks({ step: m(1), budget: m(30), edges: { post: { min: 0, max: m(2) } } });
    expect(plan).toMatchObject({ used: m(2), leftover: m(28) });
  });

  it('leaves less than one step when the budget is not a multiple of the step', () => {
    const plan = planBreaks({ step: 15 * SECOND, budget: m(2) + 10 * SECOND, edges: { tail: { min: 0, max: m(25) } } });
    expect(plan.edges.tail).toBe(m(2));
    expect(plan.leftover).toBe(10 * SECOND);
  });

  it('plans nothing when there is nothing to plan', () => {
    expect(planBreaks({ step: m(1), budget: m(5), edges: {} })).toEqual({ edges: {}, mid: [], used: 0, leftover: m(5) });
  });
});

describe('bad input', () => {
  it('rejects minimums that do not fit the budget', () => {
    expect(() => planBreaks({ step: m(1), budget: m(1), edges: { post: { min: m(2), max: m(5) } } })).toThrow(RangeError);
  });
  it('rejects ranges that are not multiples of the step, or reversed', () => {
    expect(() => planBreaks({ step: 15 * SECOND, budget: m(5), edges: { post: { min: 10 * SECOND, max: m(1) } } })).toThrow(RangeError);
    expect(() => planBreaks({ step: m(1), budget: m(5), edges: { post: { min: m(2), max: m(1) } } })).toThrow(RangeError);
  });
  it('rejects a fractional budget', () => {
    expect(() => planBreaks({ step: m(1), budget: 1.5, edges: {} })).toThrow(RangeError);
  });
});

describe('properties over many generated inputs', () => {
  // A small seeded generator, so the test is deterministic.
  let seed = 12345;
  const rnd = (n: number) => {
    seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
    return seed % n;
  };
  it('always stays inside the ranges and the budget, and never wastes a step it could spend', () => {
    for (let i = 0; i < 500; i++) {
      const step = 15 * SECOND;
      const edges: BreakInput['edges'] = {};
      let minTotal = 0;
      for (const name of EDGE_ORDER) {
        if (rnd(3) === 0) continue;
        const min = rnd(4) * step;
        edges[name] = { min, max: min + rnd(40) * step };
        minTotal += min;
      }
      const count = rnd(5);
      const midMin = rnd(6) * step;
      const mid = count > 0 ? { count, range: { min: midMin, max: midMin + rnd(8) * step } } : undefined;
      minTotal += count * midMin;
      const budget = minTotal + rnd(200) * step + rnd(step);
      const plan = planBreaks({ step, budget, edges, ...(mid ? { mid } : {}) });

      expect(plan.used + plan.leftover).toBe(budget);
      expect(plan.used).toBeLessThanOrEqual(budget);
      for (const name of EDGE_ORDER) {
        const r = edges[name];
        const v = plan.edges[name];
        if (!r) { expect(v).toBeUndefined(); continue; }
        expect(v! % step).toBe(0);
        expect(v!).toBeGreaterThanOrEqual(r.min);
        expect(v!).toBeLessThanOrEqual(r.max);
      }
      for (const l of plan.mid) {
        expect(l % step).toBe(0);
        expect(l).toBeGreaterThanOrEqual(mid!.range.min);
        expect(l).toBeLessThanOrEqual(mid!.range.max);
      }
      const canStillRise =
        EDGE_ORDER.some((n) => edges[n] && plan.edges[n]! < edges[n]!.max) || plan.mid.some((l) => l < mid!.range.max);
      if (canStillRise) expect(plan.leftover).toBeLessThan(step);
      expect(planBreaks({ step, budget, edges, ...(mid ? { mid } : {}) })).toEqual(plan);
    }
  });
});
