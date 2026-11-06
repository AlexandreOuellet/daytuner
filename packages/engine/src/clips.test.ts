import { describe, expect, it } from 'vitest';
import { fillBreaks, fillWithClips, pickClip, type Clip } from './clips.js';
import { emptyBag } from './pools.js';
import { seedFrom } from './rng.js';
import { SECOND } from './time.js';

const clip = (id: string, seconds: number): Clip => ({ id, duration: seconds * SECOND });
const total = (cs: readonly Clip[]) => cs.reduce((a, c) => a + c.duration, 0);
const rng = seedFrom('clips');

describe('fillWithClips', () => {
  it('finds the combination that fills the room where the first clip would strand a gap', () => {
    // 30 s first would leave 15 s, which no clip can fill. 25 + 20 fills the 45 s exactly.
    const list = [clip('a', 30), clip('b', 25), clip('c', 20)];
    const r = fillWithClips(45 * SECOND, list, { remaining: ['a', 'b', 'c'] }, rng);
    expect(r.clips.map((c) => c.id)).toEqual(['b', 'c']);
    expect(r.shortfall).toBe(0);
    expect(r.bag.remaining).toEqual(['a']);
  });

  it('prefers the earlier clips of the bag when several combinations fill equally', () => {
    const list = [clip('a', 15), clip('b', 15), clip('c', 15)];
    const r = fillWithClips(15 * SECOND, list, { remaining: ['c', 'a', 'b'] }, rng);
    expect(r.clips.map((c) => c.id)).toEqual(['c']);
  });

  it('never exceeds the room and leaves less than the shortest clip', () => {
    const list = [clip('a', 15), clip('b', 22), clip('c', 30), clip('d', 17)];
    for (let room = 0; room <= 200; room += 7) {
      const r = fillWithClips(room * SECOND, list, emptyBag(), seedFrom(`r${room}`));
      expect(total(r.clips)).toBeLessThanOrEqual(room * SECOND);
      expect(r.shortfall).toBe(room * SECOND - total(r.clips));
      expect(r.shortfall).toBeLessThan(15 * SECOND);
    }
  });

  it('plays every clip once before any repeats, across breaks', () => {
    const list = ['a', 'b', 'c', 'd', 'e'].map((id) => clip(id, 15));
    let bag = emptyBag();
    let state = rng;
    const seen: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = fillWithClips(30 * SECOND, list, bag, state);
      seen.push(...r.clips.map((c) => c.id));
      bag = r.bag;
      state = r.rng;
    }
    expect([...seen.slice(0, 5)].sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(seen).toHaveLength(10);
  });

  it('repeats a clip already drawn when the rest cannot fit', () => {
    const list = [clip('short', 15), clip('long', 60)];
    const r = fillWithClips(15 * SECOND, list, { remaining: ['long'] }, rng);
    expect(r.clips.map((c) => c.id)).toEqual(['short']);
    expect(r.bag.remaining).toEqual(['long']);
  });

  it('leaves the whole room unfilled for an empty list or no room', () => {
    expect(fillWithClips(60 * SECOND, [], emptyBag(), rng)).toMatchObject({ clips: [], shortfall: 60 * SECOND });
    expect(fillWithClips(0, [clip('a', 15)], emptyBag(), rng)).toMatchObject({ clips: [], shortfall: 0 });
  });

  it('is deterministic', () => {
    const list = ['a', 'b', 'c', 'd', 'e', 'f'].map((id, i) => clip(id, 15 + i * 3));
    expect(fillWithClips(100 * SECOND, list, emptyBag(), rng)).toEqual(fillWithClips(100 * SECOND, list, emptyBag(), rng));
  });

  it('rejects bad clips', () => {
    expect(() => fillWithClips(10, [{ id: 'x', duration: 0 }], emptyBag(), rng)).toThrow(RangeError);
    expect(() => fillWithClips(10, [{ id: 'x', duration: 1.5 }], emptyBag(), rng)).toThrow(RangeError);
    expect(() => fillWithClips(10, [clip('x', 1), clip('x', 2)], emptyBag(), rng)).toThrow(RangeError);
  });
});

describe('fillBreaks', () => {
  it('carries what one break cannot fill into the next', () => {
    const list = [clip('a', 20), clip('b', 20), clip('c', 20), clip('d', 20)];
    // Rooms of 50 s: the first break fits two clips (40 s) and carries 10 s, so the second has 60 s.
    const r = fillBreaks([50 * SECOND, 50 * SECOND], list, { remaining: ['a', 'b', 'c', 'd'] }, rng);
    expect(r.breaks.map((b) => b.length)).toEqual([2, 3]);
    expect(r.shortfall).toBe(0);
  });
  it('reports what the last break could not fill', () => {
    const r = fillBreaks([25 * SECOND], [clip('a', 20)], emptyBag(), rng);
    expect(r.shortfall).toBe(5 * SECOND);
  });
});

describe('pickClip', () => {
  it('draws a bumper from the bag without a length limit', () => {
    const list = [clip('a', 5), clip('b', 8)];
    const first = pickClip(list, emptyBag(), rng);
    const second = pickClip(list, first.bag, first.rng);
    expect([first.clip!.id, second.clip!.id].sort()).toEqual(['a', 'b']);
  });
  it('has no clip for an empty list', () => {
    expect(pickClip([], emptyBag(), rng).clip).toBeUndefined();
  });
});
