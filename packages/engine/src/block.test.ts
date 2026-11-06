import { describe, expect, it } from 'vitest';
import { BlockDoesNotFit, buildBlock, type BlockAds, type BlockInput } from './block.js';
import { HOUR, MINUTE, SECOND } from './time.js';

const m = (n: number) => n * MINUTE;
const G = m(15);

const funnyBone: BlockAds = {
  step: 15 * SECOND,
  ratio: { min: 0.15, max: 0.6 },
  post: { min: 0, max: m(5) },
  mid: { range: { min: m(2), max: m(3) }, offers: { every: m(8), tailBuffer: m(1) } },
};
const make = (over: Partial<BlockInput> = {}): BlockInput => ({ start: 0, grid: G, content: m(22), ads: funnyBone, ...over });
const total = (b: ReturnType<typeof buildBlock>) =>
  b.adsHead + b.adsPre + b.adsPost + b.adsTail + b.midBreaks.reduce((a, x) => a + x.length, 0);
const bumpers = (b: ReturnType<typeof buildBlock>) => b.bumperHead + b.bumperPre + b.bumperPost + b.bumperTail;

describe('buildBlock', () => {
  it('gives a 22-minute show a 30-minute block with two mid breaks', () => {
    const b = buildBlock(make());
    expect(b.end).toBe(m(30));
    expect(b.midBreaks.map((x) => x.at)).toEqual([m(8), m(16)]);
    expect(b.midBreaks.every((x) => x.length >= m(2) && x.length <= m(3))).toBe(true);
    expect(b.warnings).toEqual([]);
  });

  it('accounts for every millisecond of the block', () => {
    const b = buildBlock(make());
    expect(b.end - b.start).toBe(b.content + bumpers(b) + total(b) + b.gap);
    expect(b.gap).toBeLessThan(15 * SECOND);
  });

  it('gives a 117-minute movie with 15% ads the 2h15 block', () => {
    const b = buildBlock(make({ content: m(117), ads: { ...funnyBone, mid: undefined } }));
    expect(b.end).toBe(2 * HOUR + m(15));
  });

  it('adds bumpers to the length but not to the ads ratio', () => {
    const plain = buildBlock(make({ content: m(26), ads: { ...funnyBone, mid: undefined } }));
    const bumped = buildBlock(make({ content: m(26), bumpers: { pre: 20 * SECOND, post: 20 * SECOND }, ads: { ...funnyBone, mid: undefined } }));
    expect(bumped.bumperPre + bumped.bumperPost).toBe(40 * SECOND);
    expect(bumped.end - bumped.start).toBe(bumped.content + bumpers(bumped) + total(bumped) + bumped.gap);
    // 26 min + 15% = 29.9 min: fits 30 on its own, but the bumpers push it to the next grid line.
    expect(plain.end).toBe(m(30));
    expect(bumped.end).toBe(m(45));
  });

  it('ends on the grid even when it starts off it (the first block after a head)', () => {
    const b = buildBlock(make({ start: m(3) + 10 * SECOND }));
    expect(b.end % G).toBe(0);
    expect(b.end).toBe(m(30));
  });

  it('keeps fewer mid breaks when the ratio maximum does not pay for them all', () => {
    const b = buildBlock(make({ ads: { ...funnyBone, ratio: { min: 0.1, max: 0.15 } } }));
    expect(b.midBreaks).toHaveLength(1);
    expect(b.warnings.map((w) => w.code)).toContain('mid-breaks-reduced');
    expect(total(b)).toBeLessThanOrEqual(m(3) + 15 * SECOND);
  });

  it('warns and plans what is allowed when the positions cannot reach the ratio minimum', () => {
    const b = buildBlock(make({ content: m(60), ads: { step: 15 * SECOND, ratio: { min: 0.15, max: 0.6 }, post: { min: 0, max: m(1) } } }));
    expect(b.warnings.map((w) => w.code)).toEqual(['ratio-min-unreachable']);
    expect(b.adsPost).toBe(m(1));
    expect(b.end).toBe(m(75));
    expect(b.gap).toBe(m(14));
  });

  it('lets the minimums win over the ratio maximum, with a warning', () => {
    const b = buildBlock(make({ content: m(10), ads: { step: 15 * SECOND, ratio: { min: 0, max: 0.1 }, post: { min: m(3), max: m(5) } } }));
    expect(b.adsPost).toBeGreaterThanOrEqual(m(3));
    expect(b.warnings.map((w) => w.code)).toContain('minimums-exceed-ratio-max');
  });

  it('uses chapters for the break points when the program has them', () => {
    const b = buildBlock(make({ content: m(46), chapters: [
      { start: 0, end: m(20), type: 'chapter' },
      { start: m(20), end: m(35), type: 'chapter' },
      { start: m(35), end: m(46), type: 'chapter' },
    ] }));
    expect(b.midBreaks.map((x) => x.at)).toEqual([m(20), m(35)]);
  });

  it('plans a block with no ads at all when nothing is configured and the ratio minimum is 0', () => {
    const b = buildBlock(make({ ads: { step: 15 * SECOND, ratio: { min: 0, max: 0 } } }));
    expect(b.end).toBe(m(30));
    expect(b.gap).toBe(m(8));
    expect(b.midBreaks).toEqual([]);
  });

  it('rejects a program of no length and a bad ratio', () => {
    expect(() => buildBlock(make({ content: 0 }))).toThrow(RangeError);
    expect(() => buildBlock(make({ ads: { ...funnyBone, ratio: { min: 0.5, max: 0.1 } } }))).toThrow(RangeError);
  });
});

describe('a block with a head and a tail', () => {
  const withEdges = (over: Partial<BlockInput> = {}): BlockInput =>
    make({
      head: { bumper: 10 * SECOND, ads: { min: 0, max: m(1) } },
      tail: { bumper: 10 * SECOND, ads: { min: 0, max: m(25) }, slotEnd: m(30) },
      ...over,
    });

  it('ends exactly at the slot end and accounts for every millisecond', () => {
    const b = buildBlock(withEdges());
    expect(b.end).toBe(m(30));
    expect(b.end - b.start).toBe(b.content + bumpers(b) + total(b) + b.gap);
    expect(b.adsTail).toBeGreaterThan(0);
    expect(b.bumperHead).toBe(10 * SECOND);
    expect(b.bumperTail).toBe(10 * SECOND);
  });

  it('counts the head and tail ads toward the ratio maximum', () => {
    const b = buildBlock(withEdges({ ads: { ...funnyBone, ratio: { min: 0.1, max: 0.2 } } }));
    expect(total(b)).toBeLessThanOrEqual(m(4) + 15 * SECOND); // 20% of 22 minutes, in steps
    // The room the ads may not use stays between the last block and the tail.
    expect(b.gap).toBeGreaterThan(m(3));
  });

  it('counts the head and tail minimums toward the ratio minimum', () => {
    const b = buildBlock(withEdges({
      content: m(60),
      ads: { step: 15 * SECOND, ratio: { min: 0.1, max: 0.6 } },
      head: { bumper: 0, ads: { min: m(3), max: m(5) } },
      tail: { bumper: 0, ads: { min: m(3), max: m(5) }, slotEnd: m(75) },
    }));
    expect(b.adsHead).toBeGreaterThanOrEqual(m(3));
    expect(b.adsTail).toBeGreaterThanOrEqual(m(3));
    expect(b.warnings).toEqual([]);
  });

  it('can have only a head: the block still ends on the grid', () => {
    const b = buildBlock(make({ head: { bumper: 10 * SECOND, ads: { min: m(1), max: m(2) } } }));
    expect(b.end % G).toBe(0);
    expect(b.adsHead).toBeGreaterThanOrEqual(m(1));
    expect(b.end - b.start).toBe(b.content + bumpers(b) + total(b) + b.gap);
  });

  it('refuses a block that cannot fit before the slot ends', () => {
    expect(() => buildBlock(withEdges({ tail: { bumper: 0, ads: { min: 0, max: m(5) }, slotEnd: m(24) } }))).toThrow(BlockDoesNotFit);
    try {
      buildBlock(withEdges({ tail: { bumper: 0, ads: { min: 0, max: m(5) }, slotEnd: m(24) } }));
    } catch (e) {
      expect((e as BlockDoesNotFit).shortBy).toBeGreaterThan(0);
    }
  });
});

describe('properties', () => {
  it('always ends on the grid and accounts for every millisecond, over many program lengths', () => {
    for (let minutes = 5; minutes <= 180; minutes += 1) {
      for (const start of [0, 20 * SECOND, m(2)]) {
        const b = buildBlock(make({ content: m(minutes) + 7_000, start, bumpers: { pre: 8 * SECOND, post: 12 * SECOND } }));
        expect(b.end % G).toBe(0);
        expect(b.end - b.start).toBe(b.content + bumpers(b) + total(b) + b.gap);
        expect(b.gap).toBeGreaterThanOrEqual(0);
        expect(Number.isInteger(b.end)).toBe(true);
      }
    }
  });
});

describe('properties with a head and a tail', () => {
  it('always ends at the slot end and accounts for every millisecond', () => {
    for (let minutes = 5; minutes <= 120; minutes += 1) {
      const content = m(minutes) + 3_000;
      const slotEnd = Math.ceil((content * 1.4 + m(10)) / G) * G;
      const b = buildBlock(make({
        content,
        bumpers: { pre: 5 * SECOND, post: 6 * SECOND },
        head: { bumper: 7 * SECOND, ads: { min: 0, max: m(2) } },
        tail: { bumper: 8 * SECOND, ads: { min: 0, max: m(20) }, slotEnd },
      }));
      expect(b.end).toBe(slotEnd);
      expect(b.end - b.start).toBe(b.content + bumpers(b) + total(b) + b.gap);
      expect(b.gap).toBeGreaterThanOrEqual(0);
    }
  });
});
