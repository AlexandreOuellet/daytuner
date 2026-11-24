// Run slots (docs/run-slots.md): short items back to back, only the window on the grid, a bumper every N items, ads only at the end,
// and a closer that fills the rest without dead air or a long run of ads.

import { describe, expect, it } from 'vitest';
import type { Clip } from './clips.js';
import { fillCloser } from './closer.js';
import { freshState, local, ZONE } from './fixtures.js';
import { plan } from './plan.js';
import type { Item, Library, PlanResult, Schedule } from './schedule.js';
import { HOUR, MINUTE, SECOND } from './time.js';

const START = local(2026, 11, 9, 17); // Monday 17:00
const clip = (id: string, ms: number): Clip => ({ id, duration: ms });

/** 60 videos of 2:07 to 6:50, not on any grid. */
const videos = Array.from({ length: 60 }, (_, i) => `v${i}`);
function library(): Library {
  const programs: Library['programs'] = {};
  videos.forEach((id, i) => {
    programs[id] = { duration: (127 + ((i * 37) % 284)) * SECOND + ((i * 211) % 1000) };
  });
  return {
    programs,
    clips: {
      Bumpers: Array.from({ length: 10 }, (_, i) => clip(`b${i}`, (4 + (i % 2)) * SECOND + i * 13)),
      'Old Ads': Array.from({ length: 30 }, (_, i) => clip(`a${i}`, (15 + (i % 16)) * SECOND + i * 7)),
      Sessions: Array.from({ length: 12 }, (_, i) => clip(`s${i}`, (9 + i * 3) * MINUTE + i * 1000 + 17)),
    },
  };
}

function schedule(over: Partial<Schedule> = {}, lengthMinutes = 90): Schedule {
  return {
    grid: 30 * MINUTE,
    zone: ZONE,
    ads: { step: 15 * SECOND, ratio: { min: 0, max: 0.1 }, tail: { list: 'Old Ads', range: { min: 0, max: 5 * MINUTE } } },
    bumpers: { rotation: { list: 'Bumpers', every: { min: 3, max: 4 } }, tail: { list: 'Bumpers' } },
    interstitial: { list: 'Sessions', length: { min: 2 * MINUTE, max: 30 * MINUTE }, cooldown: 14 * 24 * HOUR, cut: true },
    pools: { punk: { order: 'shuffled', programs: videos } },
    week: [
      { day: 1, at: 17 * HOUR, pool: 'punk', run: true },
      { day: 1, at: 17 * HOUR + lengthMinutes * MINUTE, pool: 'punk', run: true },
    ],
    exceptions: [],
    ...over,
  };
}

const sum = (items: readonly Item[]) => items.reduce((a, i) => a + i.duration, 0);
const lib = library();
const run = (s: Schedule = schedule(), state = freshState(), to = START + 90 * MINUTE): PlanResult =>
  plan({ schedule: s, library: lib, state, from: START, to });

describe('a run slot', () => {
  const result = run();
  const slot = result.slots[0]!;

  it('starts and ends exactly on the window, whatever the videos last', () => {
    expect(slot.start).toBe(START);
    expect(slot.end).toBe(START + 90 * MINUTE);
    expect(sum(slot.items)).toBe(90 * MINUTE);
    for (const i of slot.items) {
      expect(Number.isInteger(i.duration)).toBe(true);
      expect(i.duration).toBeGreaterThan(0);
    }
  });

  it('plays the videos back to back: their starts are not on the grid', () => {
    let t = slot.start;
    const starts: number[] = [];
    for (const i of slot.items) {
      if (i.kind === 'content') starts.push(t);
      t += i.duration;
    }
    expect(starts.length).toBeGreaterThan(8);
    expect(starts.filter((s) => (s - START) % (30 * MINUTE) !== 0).length).toBeGreaterThan(starts.length - 3);
  });

  it('puts a bumper after every 3 or 4 videos, never at the start or twice in a row', () => {
    const kinds = slot.items.filter((i) => i.kind === 'content' || (i.kind === 'filler' && i.position === 'rotation'));
    expect(kinds[0]!.kind).toBe('content');
    let since = 0;
    let bumpers = 0;
    for (const i of kinds) {
      if (i.kind === 'content') since++;
      else {
        expect(since).toBeGreaterThanOrEqual(3);
        expect(since).toBeLessThanOrEqual(4);
        since = 0;
        bumpers++;
      }
    }
    expect(bumpers).toBeGreaterThan(1);
  });

  it('plays ads only after the last video, within the 10% cap', () => {
    const lastContent = slot.items.map((i) => i.kind).lastIndexOf('content');
    const ads = slot.items.map((i, k) => ({ i, k })).filter(({ i }) => i.kind === 'filler' && i.role === 'ad');
    for (const { k } of ads) expect(k).toBeGreaterThan(lastContent);
    expect(sum(ads.map(({ i }) => i))).toBeLessThanOrEqual(9 * MINUTE);
  });

  it('is exactly the same for the same seed', () => {
    expect(run().slots[0]!.items).toEqual(result.slots[0]!.items);
  });

  it('plays each video once before any repeats', () => {
    const second = run(schedule(), freshState(), START + 180 * MINUTE).slots;
    const all = second.flatMap((s) => s.programs);
    const firstRound = all.slice(0, videos.length);
    expect(new Set(firstRound).size).toBe(firstRound.length);
  });
});

describe('the closer', () => {
  const sessions = library().clips['Sessions']!;
  const cfg = { list: 'Sessions', length: { min: 2 * MINUTE, max: 30 * MINUTE }, cooldown: 14 * 24 * HOUR, cut: true } as const;

  it('fills a gap that the ads cannot take, with no dead air, cutting the last clip if it must', () => {
    const noAds = schedule({ ads: { step: 15 * SECOND, ratio: { min: 0, max: 0.1 } }, bumpers: { rotation: { list: 'Bumpers', every: { min: 3, max: 4 } } } });
    for (let seed = 1; seed <= 12; seed++) {
      const slot = run(noAds, freshState(seed)).slots[0]!;
      expect(sum(slot.items)).toBe(90 * MINUTE);
      const dead = slot.items.filter((i) => i.kind === 'flex').reduce((a, i) => a + i.duration, 0);
      expect(dead).toBeLessThan(MINUTE); // under the smallest cut worth showing
    }
  });

  it('never replays a clip because it fits: with a bag it takes unplayed clips first', () => {
    const f = fillCloser(40 * MINUTE, sessions, cfg, { remaining: [] }, 5, {}, START);
    const ids = f.pieces.map((p) => p.clip.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(f.pieces.reduce((a, p) => a + p.duration, 0) + f.shortfall).toBe(40 * MINUTE);
  });

  it('cuts the next clip of the bag, and leaves it in the bag to play whole next time', () => {
    // 5 minutes remain and every clip is longer than 8: the clip is cut at 5 minutes.
    const onlyLong = sessions.filter((c) => c.duration > 20 * MINUTE);
    const f = fillCloser(5 * MINUTE, onlyLong, { ...cfg, length: { min: 2 * MINUTE, max: 60 * MINUTE } }, { remaining: [] }, 9, {}, START);
    expect(f.pieces).toHaveLength(1);
    expect(f.pieces[0]!.cut).toBe(true);
    expect(f.pieces[0]!.duration).toBe(5 * MINUTE);
    expect(f.bag.remaining).toContain(f.pieces[0]!.clip.id);
    expect(f.shortfall).toBe(0);
  });

  it('does not cut when cut is off, and leaves the remainder', () => {
    const onlyLong = sessions.filter((c) => c.duration > 20 * MINUTE);
    const f = fillCloser(5 * MINUTE, onlyLong, { ...cfg, cut: false, length: { min: 2 * MINUTE, max: 60 * MINUTE } }, { remaining: [] }, 9, {}, START);
    expect(f.pieces).toHaveLength(0);
    expect(f.shortfall).toBe(5 * MINUTE);
  });

  it('keeps a clip inside its cooldown out, and uses it anyway only when every clip is in its cooldown', () => {
    const playedAll = Object.fromEntries(sessions.map((c) => [c.id, START - HOUR]));
    const some = { ...playedAll, s0: START - 30 * 24 * HOUR };
    const f1 = fillCloser(60 * MINUTE, sessions, cfg, { remaining: [] }, 3, some, START);
    expect(f1.pieces.every((p) => p.clip.id === 's0')).toBe(true);
    expect(f1.cooldownExhausted).toBe(false);
    const f2 = fillCloser(60 * MINUTE, sessions, cfg, { remaining: [] }, 3, playedAll, START);
    expect(f2.cooldownExhausted).toBe(true);
    expect(f2.pieces.length).toBeGreaterThan(0);
  });

  it('only uses clips in the length range', () => {
    const f = fillCloser(90 * MINUTE, sessions, { ...cfg, length: { min: 20 * MINUTE, max: 30 * MINUTE } }, { remaining: [] }, 4, {}, START);
    for (const p of f.pieces.filter((x) => !x.cut)) {
      expect(p.clip.duration).toBeGreaterThanOrEqual(20 * MINUTE);
      expect(p.clip.duration).toBeLessThanOrEqual(30 * MINUTE);
    }
  });

  it('remembers what aired for the cooldown, across slots', () => {
    const r = run(schedule({ ads: { step: 15 * SECOND, ratio: { min: 0, max: 0.1 } } }), freshState(11), START + 180 * MINUTE);
    const keys = Object.keys(r.state.played ?? {});
    const closers = r.slots.flatMap((s) => s.items.filter((i) => i.kind === 'filler' && i.role === 'interstitial' && !i.cut));
    expect(keys.length).toBe(new Set(closers.map((c) => (c as { clipId: string }).clipId)).size);
  });
});

describe('validation', () => {
  it('rejects a run slot over an ordered pool', () => {
    const s = schedule({ pools: { punk: { order: 'ordered', programs: videos } } });
    expect(() => run(s)).toThrow(/must be shuffled/);
  });
  it('rejects a rotation range below 1', () => {
    const s = schedule({ bumpers: { rotation: { list: 'Bumpers', every: { min: 0, max: 2 } } } });
    expect(() => run(s)).toThrow(/rotation/);
  });
  it('rejects an unknown rotation list', () => {
    const s = schedule({ bumpers: { rotation: { list: 'Nope', every: { min: 3, max: 4 } } } });
    expect(() => run(s)).toThrow(/unknown clip list/);
  });
});

describe('closer tags', () => {
  const tagged = [
    { ...clip('m1', 10 * MINUTE), tags: ['Metal'] },
    { ...clip('m2', 12 * MINUTE), tags: ['Metal', 'Prog & Virtuoso'] },
    { ...clip('p1', 11 * MINUTE), tags: ['Punk & Ska'] },
    { ...clip('any', 9 * MINUTE) },
  ];
  const cfg = { list: 'Sessions', length: { min: 2 * MINUTE, max: 30 * MINUTE }, cooldown: 14 * 24 * HOUR, cut: true } as const;

  it('takes clips with one of the asked tags, or with none', () => {
    const f = fillCloser(60 * MINUTE, tagged, cfg, { remaining: [] }, 3, {}, START, ['Metal']);
    const ids = f.pieces.map((p) => p.clip.id);
    expect(ids).not.toContain('p1');
    expect(ids.every((id) => ['m1', 'm2', 'any'].includes(id))).toBe(true);
  });

  it('takes any clip when no tags are asked for', () => {
    const f = fillCloser(120 * MINUTE, tagged, cfg, { remaining: [] }, 3, {}, START);
    expect(f.pieces.map((p) => p.clip.id)).toContain('p1');
  });

  it('a slot with tags plans its closer from the matching clips', () => {
    const s = schedule({
      ads: { step: 15 * SECOND, ratio: { min: 0, max: 0.1 } },
      bumpers: {},
      week: [{ day: 1, at: 17 * HOUR, pool: 'punk', run: true, tags: ['Metal'] }, { day: 1, at: 18 * HOUR + 30 * MINUTE, pool: 'punk', run: true }],
    });
    const l: Library = { ...lib, clips: { ...lib.clips, Sessions: tagged } };
    for (let seed = 1; seed <= 8; seed++) {
      const r = plan({ schedule: s, library: l, state: freshState(seed), from: START, to: START + 90 * MINUTE });
      const closers = r.slots[0]!.items.filter((i) => i.kind === 'filler' && i.role === 'interstitial');
      for (const c of closers) expect(['m1', 'm2', 'any']).toContain((c as { clipId: string }).clipId);
    }
  });
});

describe('a run slot and the grid rules', () => {
  it('is marked as a run, and its metrics count only its own edges against the grid', async () => {
    const { computeMetrics } = await import('./metrics.js');
    const r = run(schedule(), freshState(), START + 180 * MINUTE);
    expect(r.slots.every((s) => s.run === true)).toBe(true);
    const m = computeMetrics(r.slots, { grid: 30 * MINUTE, zone: ZONE });
    expect(m.gridAccuracy.share).toBe(1);
    expect(m.gridAccuracy.checked).toBe(r.slots.length * 2);
  });
  it('keeps its blocks back to back from the start of the window to its end', () => {
    const slot = run().slots[0]!;
    expect(slot.blocks[0]!.start).toBe(slot.start);
    expect(slot.blocks[slot.blocks.length - 1]!.end).toBe(slot.end);
    for (let i = 1; i < slot.blocks.length; i++) expect(slot.blocks[i]!.start).toBe(slot.blocks[i - 1]!.end);
  });
});
