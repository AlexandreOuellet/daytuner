import { describe, expect, it } from 'vitest';
import type { PlannedSlot } from '@daytuner/engine';
import { TunarrClient, type FetchLike } from './client.js';
import { alignToGrid, snapToGrid, toLineupItems, totalDuration, type LineupItem } from './lineup.js';

const slot = (items: PlannedSlot['items']): PlannedSlot => ({
  slotId: '1@0', start: 0, end: items.reduce((a, i) => a + i.duration, 0), pool: 'p', programs: ['prog'], blocks: [], exception: false, items,
});
const lists = { 'Old Ads': 'list-ads', Idents: 'list-idents', Fillers: 'list-fill' };

describe('toLineupItems', () => {
  it('converts content pieces, ads, bumpers, interstitials and dead air', () => {
    const items = toLineupItems(
      [slot([
        { kind: 'filler', role: 'bumper', position: 'head', list: 'Idents', clipId: 'b1', duration: 7000 },
        { kind: 'content', programId: 'prog', startOffset: 0, duration: 480_000 },
        { kind: 'filler', role: 'ad', position: 'mid', list: 'Old Ads', clipId: 'a1', duration: 30_000 },
        { kind: 'content', programId: 'prog', startOffset: 480_000, duration: 840_000 },
        { kind: 'filler', role: 'interstitial', position: 'gap', list: 'Fillers', clipId: 'f1', duration: 200_000 },
        { kind: 'flex', duration: 1234 },
        { kind: 'filler', role: 'bumper', position: 'tail', list: 'Idents', clipId: 'b2', duration: 6000 },
      ])],
      lists,
    );
    expect(items).toEqual([
      { type: 'filler', id: 'b1', fillerListId: 'list-idents', fillerType: 'head', duration: 7000 },
      { type: 'content', id: 'prog', startOffsetMs: 0, duration: 480_000 },
      { type: 'filler', id: 'a1', fillerListId: 'list-ads', fillerType: 'mid', duration: 30_000 },
      { type: 'content', id: 'prog', startOffsetMs: 480_000, duration: 840_000 },
      { type: 'filler', id: 'f1', fillerListId: 'list-fill', fillerType: 'fallback', duration: 200_000 },
      { type: 'flex', duration: 1234 },
      { type: 'filler', id: 'b2', fillerListId: 'list-idents', fillerType: 'tail', duration: 6000 },
    ]);
  });

  it('keeps the total exactly equal to the slots', () => {
    const s = slot([
      { kind: 'content', programId: 'p', startOffset: 0, duration: 1_321_431 },
      { kind: 'flex', duration: 568_569 },
    ]);
    expect(totalDuration(toLineupItems([s], lists))).toBe(s.end - s.start);
  });

  it('refuses fractional or empty durations and unknown lists', () => {
    expect(() => toLineupItems([slot([{ kind: 'flex', duration: 1.5 }])], lists)).toThrow(RangeError);
    expect(() => toLineupItems([slot([{ kind: 'flex', duration: 0 }])], lists)).toThrow(RangeError);
    expect(() => toLineupItems([slot([{ kind: 'filler', role: 'ad', position: 'mid', list: 'Nope', clipId: 'x', duration: 1000 }])], lists)).toThrow(/Nope/);
    expect(() => toLineupItems([slot([{ kind: 'content', programId: 'p', startOffset: -5, duration: 1000 }])], lists)).toThrow(RangeError);
  });
});

describe('alignToGrid', () => {
  const G = 15 * 60_000;
  it('needs no flex when the end is already on the grid', () => {
    expect(alignToGrid(3 * G, G)).toEqual({ from: 3 * G, flex: 0 });
  });
  it('rounds the flex to whole milliseconds when the end carries a fraction', () => {
    const a = alignToGrid(3 * G - 1234.478, G);
    expect(a.from).toBe(3 * G);
    expect(a.flex).toBe(1234);
    expect(Number.isInteger(a.flex)).toBe(true);
  });
  it('rejects a bad grid', () => {
    expect(() => alignToGrid(1, 0)).toThrow(RangeError);
    expect(() => alignToGrid(Number.NaN, G)).toThrow(RangeError);
  });
});

describe('appending', () => {
  const recorder = () => {
    const sent: { method?: string; url: string; body: unknown }[] = [];
    const f: FetchLike = async (url, init) => {
      sent.push({ ...(init?.method ? { method: init.method } : {}), url, body: init?.body ? JSON.parse(init.body) : undefined });
      return { ok: true, status: 200, text: async () => 'null' };
    };
    return { f, sent };
  };

  it('is off unless writing was asked for', async () => {
    const { f, sent } = recorder();
    await expect(new TunarrClient('http://t', f).appendLineup('c1', [{ type: 'flex', duration: 1 }])).rejects.toThrow(/allowWrites/);
    expect(sent).toEqual([]);
  });

  it('always appends and never replaces', async () => {
    const { f, sent } = recorder();
    await new TunarrClient('http://t', f, true).appendLineup('c1', [{ type: 'flex', duration: 1000 }]);
    expect(sent).toEqual([{
      method: 'POST', url: 'http://t/api/channels/c1/programming',
      body: { type: 'manual', lineup: [{ type: 'flex', duration: 1000 }], append: true },
    }]);
  });

  it('sends nothing for an empty lineup', async () => {
    const { f, sent } = recorder();
    await new TunarrClient('http://t', f, true).appendLineup('c1', []);
    expect(sent).toEqual([]);
  });
});

describe('snapToGrid', () => {
  const G = 15 * 60_000;
  const clip = (id: string, duration: number): LineupItem => ({ type: 'filler', id, fillerListId: 'l', fillerType: 'mid', duration });
  const show = (duration: number): LineupItem => ({ type: 'content', id: 'p', startOffsetMs: 0, duration });
  const flex = (duration: number): LineupItem => ({ type: 'flex', duration });
  // Tunarr counts 'a' at 30000.4 ms and 'b' at 29999.6 ms; both were written as 30000.
  const lengths: Record<string, number> = { a: 30000.4, b: 29999.6 };
  const real = (i: LineupItem): number => (i.type === 'filler' ? lengths[i.id] ?? i.duration : i.duration);
  /** The real start of the first item of each block, found by the marker clip 'first'. */
  const blockStarts = (items: readonly LineupItem[]): number[] => {
    let t = 0; const out: number[] = [];
    for (const i of items) { if (i.type === 'filler' && i.id === 'first') out.push(t); t += real(i); }
    return out;
  };
  const withMarker = (id: 'a' | 'b'): LineupItem => clip(id, 30000);
  void withMarker;

  it('starts every block on its grid line when the clips read shorter, block after block', () => {
    lengths['first'] = 29999.6;
    const block = [clip('first', 30000), show(G - 30000)];
    const items: LineupItem[] = []; for (let n = 0; n < 50; n++) items.push(...block);
    const out = snapToGrid(items, { from: 0, grid: G, startReal: 0, real });
    const starts = blockStarts(out);
    expect(starts).toHaveLength(50);
    starts.forEach((t, n) => { expect(t - n * G).toBeGreaterThanOrEqual(-1e-6); expect(t - n * G).toBeLessThan(1); });
    for (const i of out) expect(Number.isInteger(i.duration)).toBe(true);
    // the whole run ends within a millisecond of its last line
    const end = out.reduce((a, i) => a + real(i), 0);
    expect(Math.abs(end - 50 * G)).toBeLessThan(1);
  });

  it('trims a flex when the clips read longer, so the blocks do not creep late', () => {
    lengths['first'] = 30000.4;
    const block = [clip('first', 30000), flex(5000), show(G - 35000)];
    const items: LineupItem[] = []; for (let n = 0; n < 50; n++) items.push(...block);
    const out = snapToGrid(items, { from: 0, grid: G, startReal: 0, real });
    blockStarts(out).forEach((t, n) => { expect(t - n * G).toBeGreaterThanOrEqual(-1e-6); expect(t - n * G).toBeLessThan(1.5); });
    expect(out.some((i) => i.type === 'flex' && i.duration < 5000)).toBe(true);
  });

  it('starts the first item on the line when the lineup it follows ended a fraction early', () => {
    lengths['first'] = 30000;
    const out = snapToGrid([clip('first', 30000), show(G - 30000)], { from: G, grid: G, startReal: G - 0.3, real });
    expect(out[0]).toEqual({ type: 'flex', duration: 1 });
  });

  it('counts the last piece of a program at the program real length', () => {
    const piece = (offset: number, duration: number): LineupItem => ({ type: 'content', id: 'p', startOffsetMs: offset, duration });
    const r = (i: LineupItem): number => (i.type === 'content' && i.startOffsetMs === 600000 ? i.duration + 0.5 : i.duration);
    // the last piece of the program runs half a millisecond long in Tunarr, so the next block starts a flex later... or on the line
    const out = snapToGrid([piece(0, 600000), piece(600000, G - 600000), clip('first', 30000), show(G - 30000)], { from: 0, grid: G, startReal: 0, real: r });
    expect(out.length).toBeGreaterThanOrEqual(4);
  });

  it('leaves a lineup that is already exact alone', () => {
    const items: LineupItem[] = [clip('x', 30000), show(G - 30000), show(G)];
    expect(snapToGrid(items, { from: 0, grid: G, startReal: 0, real })).toEqual(items);
  });
});
