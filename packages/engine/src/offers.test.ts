import { describe, expect, it } from 'vitest';
import { chooseEvenly, offerPoints, thinByMinGap, type Chapter } from './offers.js';
import { MINUTE } from './time.js';

const m = (n: number) => n * MINUTE;
const rule = { every: m(8), tailBuffer: m(1) };

describe('offerPoints', () => {
  it('offers one every N minutes, none within the tail buffer', () => {
    expect(offerPoints(m(22), rule)).toEqual([m(8), m(16)]);
    // 24 minutes: 8, 16, and 24 is the end, so not offered.
    expect(offerPoints(m(24), rule)).toEqual([m(8), m(16)]);
    // 25 minutes: 24 is 1 minute from the end, which the buffer allows.
    expect(offerPoints(m(25), rule)).toEqual([m(8), m(16), m(24)]);
    expect(offerPoints(m(24.5), rule)).toEqual([m(8), m(16)]);
  });
  it('never offers the start or the very end, even with no buffer', () => {
    expect(offerPoints(m(16), { every: m(8), tailBuffer: 0 })).toEqual([m(8)]);
    expect(offerPoints(m(5), rule)).toEqual([]);
  });
  const chapters: Chapter[] = [
    { start: 0, end: m(10), type: 'intro' },
    { start: m(10), end: m(20), type: 'chapter' },
    { start: m(20), end: m(35), type: 'break' },
    { start: m(35), end: m(44), type: 'chapter' },
    { start: m(44), end: m(46), type: 'outro' },
  ];
  it('uses the end of each eligible chapter when the program has them', () => {
    expect(offerPoints(m(46), rule, chapters)).toEqual([m(20), m(35), m(44)]);
  });
  it('drops a chapter end inside the tail buffer or at the very end', () => {
    expect(offerPoints(m(44.5), rule, chapters)).toEqual([m(20), m(35)]);
    expect(offerPoints(m(44), rule, chapters)).toEqual([m(20), m(35)]);
  });
  it('honours the eligible types', () => {
    expect(offerPoints(m(46), { ...rule, chapterTypes: ['break'] }, chapters)).toEqual([m(35)]);
  });
  it('falls back to the interval when no chapter is eligible', () => {
    expect(offerPoints(m(46), { ...rule, chapterTypes: ['recap'] }, chapters)).toEqual([m(8), m(16), m(24), m(32), m(40)]);
    expect(offerPoints(m(22), rule, [{ start: 0, end: m(22), type: 'intro' }])).toEqual([m(8), m(16)]);
  });
  it('rejects bad input', () => {
    expect(() => offerPoints(0, rule)).toThrow(RangeError);
    expect(() => offerPoints(m(20), { every: 0, tailBuffer: 0 })).toThrow(RangeError);
    expect(() => offerPoints(m(20), { every: m(8), tailBuffer: -1 })).toThrow(RangeError);
  });
});

describe('thinByMinGap', () => {
  it('drops offers too close to the previous break or the start', () => {
    expect(thinByMinGap([m(1), m(9), m(10), m(18)], m(5))).toEqual([m(9), m(18)]);
    expect(thinByMinGap([m(8), m(16)], 0)).toEqual([m(8), m(16)]);
  });
});

describe('chooseEvenly', () => {
  const offers = [m(5), m(10), m(15), m(20), m(25), m(30), m(35)];
  it('keeps all offers when the count allows', () => {
    expect(chooseEvenly(offers, 7, m(40))).toEqual(offers);
    expect(chooseEvenly(offers, 99, m(40))).toEqual(offers);
  });
  it('takes none for a count of 0', () => {
    expect(chooseEvenly(offers, 0, m(40))).toEqual([]);
  });
  it('picks the middle of the program for one break', () => {
    expect(chooseEvenly(offers, 1, m(40))).toEqual([m(20)]);
  });
  it('picks equal gaps when they exist', () => {
    expect(chooseEvenly(offers, 3, m(40))).toEqual([m(10), m(20), m(30)]);
  });
  it('is deterministic and breaks ties toward the earlier offers', () => {
    const tie = [m(10), m(20)];
    expect(chooseEvenly(tie, 1, m(30))).toEqual([m(10)]);
    expect(chooseEvenly(tie, 1, m(30))).toEqual(chooseEvenly(tie, 1, m(30)));
  });
  it('returns offers in order, from the offers given', () => {
    const odd = [m(3), m(7), m(8), m(21), m(22), m(30)];
    const picked = chooseEvenly(odd, 3, m(33));
    expect(picked).toHaveLength(3);
    expect([...picked].sort((a, b) => a - b)).toEqual(picked);
    for (const t of picked) expect(odd).toContain(t);
  });
  it('rejects a bad count', () => {
    expect(() => chooseEvenly(offers, -1, m(40))).toThrow(RangeError);
    expect(() => chooseEvenly(offers, 1.5, m(40))).toThrow(RangeError);
  });
});
