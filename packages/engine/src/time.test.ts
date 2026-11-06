import { describe, expect, it } from 'vitest';
import { ceilToGrid, floorToGrid, isOnGrid, MINUTE, roundWithCarry, splitEvenly, HOUR } from './time.js';

const G = 15 * MINUTE;

describe('grid', () => {
  it('rounds up to the next grid line and leaves a grid line alone', () => {
    expect(ceilToGrid(0, G)).toBe(0);
    expect(ceilToGrid(1, G)).toBe(G);
    expect(ceilToGrid(G, G)).toBe(G);
    expect(ceilToGrid(G + 1, G)).toBe(2 * G);
  });
  it('rounds down to the previous grid line', () => {
    expect(floorToGrid(G - 1, G)).toBe(0);
    expect(floorToGrid(G, G)).toBe(G);
  });
  it('handles negative instants and an origin', () => {
    expect(ceilToGrid(-1, G)).toBe(0);
    expect(floorToGrid(-1, G)).toBe(-G);
    expect(ceilToGrid(10, G, 5)).toBe(5 + G);
    expect(isOnGrid(5 + 2 * G, G, 5)).toBe(true);
  });
  it('gives the 2h15 block for a 117-minute movie with 15% ads', () => {
    const content = 117 * MINUTE;
    const withAds = content + Math.ceil(content * 0.15 / 1000) * 1000;
    expect(ceilToGrid(withAds, G)).toBe(2 * HOUR + 15 * MINUTE);
  });
  it('rejects fractions and bad grids', () => {
    expect(() => ceilToGrid(1.5, G)).toThrow(RangeError);
    expect(() => ceilToGrid(1, 0)).toThrow(RangeError);
    expect(() => ceilToGrid(1, -G)).toThrow(RangeError);
  });
});

describe('roundWithCarry', () => {
  it('keeps the total exact where independent rounding drifts', () => {
    const values = Array.from({ length: 1000 }, () => 333.4);
    const independent = values.map(Math.round).reduce((a, b) => a + b, 0);
    const carried = roundWithCarry(values);
    expect(independent).toBe(333_000);
    expect(carried.reduce((a, b) => a + b, 0)).toBe(333_400);
    expect(carried.every(Number.isInteger)).toBe(true);
  });
  it('never lets a prefix drift by more than half a millisecond', () => {
    const values = [0.6, 0.6, 0.6, 0.6, 0.6];
    let exact = 0;
    let got = 0;
    for (const [i, v] of roundWithCarry(values).entries()) {
      exact += values[i]!;
      got += v;
      expect(Math.abs(got - exact)).toBeLessThanOrEqual(0.5 + 1e-9);
    }
  });
  it('rejects negatives and non-numbers', () => {
    expect(() => roundWithCarry([1, -1])).toThrow(RangeError);
    expect(() => roundWithCarry([Number.NaN])).toThrow(RangeError);
  });
});

describe('splitEvenly', () => {
  it('sums to the total with pieces that differ by at most 1', () => {
    const parts = splitEvenly(100_000, 7);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(100_000);
    expect(Math.max(...parts) - Math.min(...parts)).toBeLessThanOrEqual(1);
  });
  it('handles one part, zero total and bad input', () => {
    expect(splitEvenly(5, 1)).toEqual([5]);
    expect(splitEvenly(0, 3)).toEqual([0, 0, 0]);
    expect(() => splitEvenly(5, 0)).toThrow(RangeError);
    expect(() => splitEvenly(-1, 2)).toThrow(RangeError);
  });
});
