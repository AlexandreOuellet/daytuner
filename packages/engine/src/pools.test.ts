import { describe, expect, it } from 'vitest';
import { advanceCursor, emptyBag, markDrawn, orderedPick, pickFromBag, type BagState } from './pools.js';
import { nextFloat, nextInt, seedFrom, shuffle } from './rng.js';

describe('rng', () => {
  it('replays: the same seed gives the same numbers', () => {
    const run = (seed: string) => {
      let s = seedFrom(seed);
      const out: number[] = [];
      for (let i = 0; i < 5; i++) { let v: number; [v, s] = nextFloat(s); out.push(v); }
      return out;
    };
    expect(run('the-funny-bone')).toEqual(run('the-funny-bone'));
    expect(run('the-funny-bone')).not.toEqual(run('the-serious-bone'));
  });
  it('pins its output so an accidental change is caught', () => {
    expect(nextFloat(seedFrom(1))[0]).toBeCloseTo(0.6270739405881613, 12);
  });
  it('keeps floats in [0, 1) and ints in range', () => {
    let s = seedFrom(42);
    for (let i = 0; i < 2000; i++) {
      let f: number; [f, s] = nextFloat(s);
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThan(1);
      let n: number; [n, s] = nextInt(s, 7);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThan(7);
    }
    expect(() => nextInt(1, 0)).toThrow(RangeError);
  });
  it('shuffles without losing or changing the input', () => {
    const input = ['a', 'b', 'c', 'd', 'e', 'f'];
    const [out] = shuffle(input, seedFrom('x'));
    expect([...out].sort()).toEqual(input);
    expect(input).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
  });
});

const pool = ['a', 'b', 'c', 'd', 'e'];
const all = () => true;

describe('the bag', () => {
  it('draws every program once before any repeats', () => {
    let bag = emptyBag();
    let rng = seedFrom('bag');
    const seen: string[] = [];
    for (let i = 0; i < 10; i++) {
      const r = pickFromBag(pool, bag, rng, all);
      expect(r.repeat).toBe(false);
      seen.push(r.pick!);
      bag = r.bag; rng = r.rng;
    }
    expect([...seen.slice(0, 5)].sort()).toEqual(pool);
    expect([...seen.slice(5)].sort()).toEqual(pool);
  });

  it('is deterministic for the same seed and state', () => {
    const a = pickFromBag(pool, emptyBag(), seedFrom('s'), all);
    const b = pickFromBag(pool, emptyBag(), seedFrom('s'), all);
    expect(a).toEqual(b);
  });

  it('takes a later program that fits and keeps the skipped ones for later', () => {
    const bag: BagState = { remaining: ['a', 'b', 'c'] };
    const r = pickFromBag(pool, bag, seedFrom('s'), (id) => id === 'c');
    expect(r).toMatchObject({ pick: 'c', skipped: 2, repeat: false });
    expect(r.bag.remaining).toEqual(['a', 'b']);
  });

  it('repeats a program already drawn this round when nothing left fits', () => {
    const bag: BagState = { remaining: ['a'] };
    const r = pickFromBag(pool, bag, seedFrom('s'), (id) => id === 'd');
    expect(r.pick).toBe('d');
    expect(r.repeat).toBe(true);
    expect(r.bag.remaining).toEqual(['a']);
  });

  it('returns no pick and counts what did not fit when nothing in the pool fits', () => {
    const r = pickFromBag(pool, emptyBag(), seedFrom('s'), () => false);
    expect(r.pick).toBeUndefined();
    expect(r.skipped).toBe(5);
  });

  it('drops programs that left the pool and refills when the bag is empty', () => {
    const r = pickFromBag(['x', 'y'], { remaining: ['gone'] }, seedFrom('s'), all);
    expect(['x', 'y']).toContain(r.pick);
    expect(r.bag.remaining).toHaveLength(1);
  });

  it('counts an explicit pick against the bag', () => {
    expect(markDrawn({ remaining: ['a', 'b', 'c'] }, 'b').remaining).toEqual(['a', 'c']);
    expect(markDrawn({ remaining: ['a'] }, 'zzz').remaining).toEqual(['a']);
  });
});

describe('an ordered pool', () => {
  const eps = ['s1e1', 's1e2', 's1e3'];
  it('never skips: it follows the list from the cursor', () => {
    expect(orderedPick(eps, 0)).toEqual({ id: 's1e1', index: 0 });
    expect(orderedPick(eps, 1, 1)).toEqual({ id: 's1e3', index: 2 });
  });
  it('wraps around when the list ends', () => {
    expect(orderedPick(eps, 2, 1)).toEqual({ id: 's1e1', index: 0 });
    expect(orderedPick(eps, 0, 7)).toEqual({ id: 's1e2', index: 1 });
  });
  it('has no pick for an empty list and rejects a bad cursor', () => {
    expect(orderedPick([], 0)).toBeUndefined();
    expect(() => orderedPick(eps, -1)).toThrow(RangeError);
    expect(() => orderedPick(eps, 0, 1.5)).toThrow(RangeError);
  });
  it('advances the cursor only by what has aired', () => {
    expect(advanceCursor(0, 0, 3)).toBe(0);
    expect(advanceCursor(1, 2, 3)).toBe(0);
    expect(advanceCursor(0, 7, 3)).toBe(1);
    expect(advanceCursor(5, 1, 0)).toBe(0);
  });
});
