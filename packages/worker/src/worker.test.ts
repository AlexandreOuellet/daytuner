import { beforeEach, describe, expect, it } from 'vitest';
import { emptyPlanState } from '@daytuner/engine';
import { Store } from '@daytuner/store';
import { FakeTunarr, TunarrClient } from '@daytuner/tunarr-client';
import { CHAPTER_CACHE_LIFETIME_MS } from './chapters.js';
import { evaluateHealth } from './health.js';
import { isDue, runAndRecord, scheduledInstant } from './scheduler.js';
import { stageReset, adjustCursor, adoptHistory, revisionImpact, stageCheck, stageDiff, stageEdit, stageGenerate, stageRefresh, ConsistencyError, listSequences, resync, topUp, type WorkerDeps } from './worker.js';

const DAY = 86_400_000;
const MIN = 60_000;
const NOW0 = Date.UTC(2026, 10, 6, 12, 0, 0); // 2026-11-06 12:00 UTC, on the grid

const YAML = `
channel: Test
timezone: America/Toronto
grid: 15m
ads:
  step: 15s
  ratio: { min: 15%, max: 60% }
  mid:  { list: Ads, every: 8m, length: 2m-3m, tailBuffer: 1m }
  post: { list: Ads, length: 0-5m }
  tail: { list: Ads, length: 0-25m }
interstitial: { list: Fillers }
pools:
  sitcoms: { shows: [Show A] }
  movies:  { movies: { genre: Comedy, duration: "<=117m" } }
week:
  sun: [ { at: "08:00", pool: sitcoms, link: a }, { at: "20:00", pool: movies } ]
  mon: [ { at: "08:00", pool: sitcoms, link: a }, { at: "20:00", pool: movies } ]
  tue: [ { at: "08:00", pool: sitcoms, link: a }, { at: "20:00", pool: movies } ]
  wed: [ { at: "08:00", pool: sitcoms, link: a }, { at: "20:00", pool: movies } ]
  thu: [ { at: "08:00", pool: sitcoms, link: a }, { at: "20:00", pool: movies } ]
  fri: [ { at: "08:00", pool: sitcoms, link: a }, { at: "20:00", pool: movies } ]
  sat: [ { at: "08:00", pool: sitcoms, link: a }, { at: "20:00", pool: movies } ]
`;

const clips = (prefix: string, n: number, base: number) => Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, duration: base + (i % 7) * 1000 + i * 13 }));

function setup(aheadMs = 3 * DAY) {
  const startTime = NOW0 - 10 * DAY;
  const fake = new FakeTunarr({
    shows: [{
      id: 'show-a', title: 'Show A',
      episodes: Array.from({ length: 400 }, (_, i) => ({ id: `ep${i + 1}`, title: `Ep ${i + 1}`, duration: 22 * MIN + 1000, season: 1 + Math.floor(i / 20), episode: (i % 20) + 1 })),
    }],
    movies: Array.from({ length: 12 }, (_, i) => ({ id: `mov${i}`, title: `Movie ${i}`, duration: (85 + i * 2) * MIN, genres: ['Comedy'] })),
    fillerLists: [
      { id: 'fl-ads', name: 'Ads', clips: clips('ad', 40, 15_000) },
      { id: 'fl-fill', name: 'Fillers', clips: clips('fl', 10, 180_000) },
    ],
    channel: { id: 'chan-1', number: 1, name: 'Test', startTime },
    lineup: [{ type: 'flex', duration: NOW0 + aheadMs - startTime }],
  });
  const store = Store.open(':memory:');
  store.addChannel({
    name: 'Test', tunarrId: 'chan-1', floorMs: 7 * DAY, stepMs: DAY, schedule: YAML,
    state: emptyPlanState(5), edge: startTime + (NOW0 + aheadMs - startTime),
  });
  const clock = { t: NOW0, now() { return this.t; } };
  const deps: WorkerDeps = { store, client: new TunarrClient('http://tunarr.test', fake.fetch, true), clock };
  return { fake, store, clock, deps };
}

describe('topUp', () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => { s = setup(); });

  it('tops the lineup up to the floor plus one step, whole slots at a time', async () => {
    const r = await topUp(s.deps, 'Test');
    expect(r.action).toBe('appended');
    expect(r.aheadBefore).toBe(3 * DAY);
    const tun = s.fake.data.channel.startTime + s.fake.duration;
    expect(tun - NOW0).toBeGreaterThanOrEqual(8 * DAY);
    expect(tun - NOW0).toBeLessThan(8 * DAY + DAY); // overshoots by less than one window
    expect(s.store.channel('Test')!.edge).toBe(tun);
    expect(s.store.commits(s.store.channel('Test')!.id)[0]).toMatchObject({ status: 'done', items: r.items });
  });

  it('does nothing when the lineup already reaches far enough', async () => {
    await topUp(s.deps, 'Test');
    const before = s.fake.lineup.length;
    const r = await topUp(s.deps, 'Test');
    expect(r.action).toBe('none');
    expect(s.fake.lineup).toHaveLength(before);
  });

  it('adds about a day when run a day later, continuing the order of the show', async () => {
    await topUp(s.deps, 'Test');
    const firstCommit = s.store.commits(s.store.channel('Test')!.id)[0]!;
    s.clock.t += DAY;
    const r = await topUp(s.deps, 'Test');
    expect(r.action).toBe('appended');
    const log = s.store.commits(s.store.channel('Test')!.id);
    expect(log).toHaveLength(2);
    const lastEpisode = (c: typeof firstCommit) => c.slots.flatMap((x) => x.programs).filter((p) => p.startsWith('ep')).map((p) => Number(p.slice(2)));
    const a = lastEpisode(firstCommit);
    const b = lastEpisode(log[0]!);
    expect(b[0]).toBe(a[a.length - 1]! + 1); // no episode skipped or repeated across runs
    expect(log[0]!.fromEdge).toBe(firstCommit.toEdge);
  });

  it('catches up after an outage in one run', async () => {
    s.clock.t += 2 * DAY;
    const r = await topUp(s.deps, 'Test');
    expect(r.action).toBe('appended');
    expect(s.fake.data.channel.startTime + s.fake.duration - s.clock.t).toBeGreaterThanOrEqual(8 * DAY);
  });

  it('keeps the new lineup on the grid, to the millisecond', async () => {
    await topUp(s.deps, 'Test');
    const c = s.store.commits(s.store.channel('Test')!.id)[0]!;
    for (const slot of c.slots) {
      expect(slot.end % (15 * MIN)).toBe(0);
      expect(slot.start % (15 * MIN)).toBe(0);
    }
  });
});

describe('it refuses to write when it should not', () => {
  it('refuses when someone changed the channel outside DayTuner', async () => {
    const s = setup();
    s.fake.appendExternally([{ type: 'flex', duration: 5 * MIN }]);
    const before = s.fake.lineup.length;
    await expect(topUp(s.deps, 'Test')).rejects.toBeInstanceOf(ConsistencyError);
    await expect(topUp(s.deps, 'Test')).rejects.toThrow(/outside DayTuner/);
    expect(s.fake.lineup).toHaveLength(before);
  });

  it('refuses when the lineup has already run out', async () => {
    const s = setup(-2 * DAY);
    await expect(topUp(s.deps, 'Test')).rejects.toThrow(/already run out/);
    expect(s.fake.lineup).toHaveLength(1);
  });

  it('refuses an unknown channel', async () => {
    await expect(topUp(setup().deps, 'Nope')).rejects.toThrow(/no channel named/);
  });
});

describe('a crash cannot leave the store and Tunarr disagreeing', () => {
  it('settles a commit when the connection drops after Tunarr stored the items', async () => {
    const s = setup();
    s.fake.crashAfterNextAppend = true;
    await expect(topUp(s.deps, 'Test')).rejects.toThrow();
    const ch = s.store.channel('Test')!;
    expect(s.store.pendingCommit(ch.id)).toBeUndefined();
    expect(s.store.commits(ch.id)[0]!.status).toBe('done');
    expect(ch.edge).toBe(s.fake.data.channel.startTime + s.fake.duration);
    expect((await topUp(s.deps, 'Test')).action).toBe('none'); // and the next run carries on
  });

  it('drops a commit when the append never reached Tunarr, and the retry plans the same thing', async () => {
    const s = setup();
    const lineupBefore = s.fake.lineup.length;
    s.fake.dropNextAppend = true;
    await expect(topUp(s.deps, 'Test')).rejects.toThrow();
    const ch = s.store.channel('Test')!;
    expect(s.store.commits(ch.id)[0]!.status).toBe('abandoned');
    expect(s.fake.lineup).toHaveLength(lineupBefore);
    expect(ch.state).toEqual(emptyPlanState(5)); // the state did not move
    const retry = await topUp(s.deps, 'Test');
    expect(retry.action).toBe('appended');
    const log = s.store.commits(ch.id);
    expect(log.map((c) => c.status)).toEqual(['done', 'abandoned']);
    expect(log[0]!.slots).toEqual(log[1]!.slots); // deterministic: the same plan as the lost attempt
  });

  it('resolves a commit left pending by a crashed process, on the next run', async () => {
    const s = setup();
    // Run once, then pretend the process died before confirming: put the commit back to pending.
    s.fake.crashAfterNextAppend = true;
    await expect(topUp(s.deps, 'Test')).rejects.toThrow();
    const ch = s.store.channel('Test')!;
    const done = s.store.commits(ch.id)[0]!;
    const fresh = Store.open(':memory:');
    fresh.addChannel({ name: 'Test', tunarrId: 'chan-1', floorMs: 7 * DAY, stepMs: DAY, schedule: YAML, state: emptyPlanState(5), edge: done.fromEdge });
    const id = fresh.channel('Test')!.id;
    fresh.beginCommit({ channelId: id, fromEdge: done.fromEdge, toEdge: done.toEdge, state: done.state, items: done.items, totalMs: done.totalMs, slots: done.slots, at: 1 });
    const r = await topUp({ ...s.deps, store: fresh }, 'Test');
    expect(r.recovered).toBe('completed');
    expect(fresh.channel('Test')!.state).toEqual(done.state);
  });

  it('reports a pending commit that matches neither end, and writes nothing', async () => {
    const s = setup();
    const ch = s.store.channel('Test')!;
    s.store.beginCommit({ channelId: ch.id, fromEdge: ch.edge - 2 * DAY, toEdge: ch.edge + 5 * DAY, state: emptyPlanState(9), items: 1, totalMs: 7 * DAY, slots: [], at: 1 });
    const before = s.fake.lineup.length;
    await expect(topUp(s.deps, 'Test')).rejects.toThrow(/neither where it began/);
    expect(s.fake.lineup).toHaveLength(before);
  });
});

describe('a dry run', () => {
  it('plans and reports without writing to Tunarr or the store', async () => {
    const s = setup();
    const r = await topUp(s.deps, 'Test', { dryRun: true });
    expect(r.action).toBe('would-append');
    expect(r.slots).toBeGreaterThan(5);
    expect(r.planned?.length).toBe(r.slots);
    expect(s.fake.lineup).toHaveLength(1);
    expect(s.store.channel('Test')!.state).toEqual(emptyPlanState(5));
    expect(s.store.commits(s.store.channel('Test')!.id)).toEqual([]);
    expect(s.fake.requests.some((x) => x.startsWith('POST /api/channels'))).toBe(false);
  });

  it('refuses while a commit is pending, since settling it would write', async () => {
    const s = setup();
    const ch = s.store.channel('Test')!;
    s.store.beginCommit({ channelId: ch.id, fromEdge: ch.edge, toEdge: ch.edge + DAY, state: emptyPlanState(5), items: 1, totalMs: DAY, slots: [], at: 1 });
    await expect(topUp(s.deps, 'Test', { dryRun: true })).rejects.toThrow(/pending/);
    expect(s.store.pendingCommit(ch.id)).toBeDefined();
  });
});

describe('a missed week', () => {
  it('lists the ordered pools that have a place', async () => {
    const s = setup();
    const { resolveSchedule, parseScheduleFile } = await import('@daytuner/schedule');
    const { schedule } = await resolveSchedule(parseScheduleFile(YAML), s.deps.client);
    const seq = listSequences(schedule);
    expect(seq).toHaveLength(1);
    expect(seq[0]).toMatchObject({ key: 'seq:a', pool: 'sitcoms', length: 400 });
    expect(seq[0]!.slots).toHaveLength(7);
  });

  it('rewinds so the next appended run repeats the episode, then carries on', async () => {
    const s = setup();
    await topUp(s.deps, 'Test');
    const ch = s.store.channel('Test')!;
    const pos = ch.state.sequences['seq:a']!;
    expect(pos.position).toBeGreaterThan(20);

    const r = await adjustCursor(s.deps, 'Test', 'seq:a', { kind: 'rewind', by: 2 });
    expect(r.after.position).toBe(pos.position - 2);
    expect(s.store.adjustments(ch.id)[0]).toMatchObject({ kind: 'rewind', amount: 2, positionBefore: pos.position, positionAfter: pos.position - 2 });
    expect(s.store.channel('Test')!.edge).toBe(ch.edge); // the committed lineup is untouched

    s.clock.t += DAY;
    await topUp(s.deps, 'Test');
    const eps = s.store.commits(ch.id)[0]!.slots.flatMap((x) => x.programs).filter((p) => p.startsWith('ep')).map((p) => Number(p.slice(2)));
    expect(eps[0]).toBe(pos.position - 2 + 1); // positions count from 0, ids from 1: the repeated episode comes first
    expect(eps[2]).toBe(pos.position + 1); // and the show is back where it was two episodes later
  });

  it('refuses an unknown sequence and an unknown channel', async () => {
    const s = setup();
    await expect(adjustCursor(s.deps, 'Test', 'seq:nope', { kind: 'rewind', by: 1 })).rejects.toThrow(/known: seq:a/);
    await expect(adjustCursor(s.deps, 'Nope', 'seq:a', { kind: 'rewind', by: 1 })).rejects.toThrow(/no channel/);
  });
});

describe('a verified append that does not match', () => {
  it('leaves the commit pending with a note, and resync reports it and marks the state stale', async () => {
    const s = setup();
    s.fake.corruptNextAppend = true;
    await expect(topUp(s.deps, 'Test')).rejects.toThrow(/stored something different/);
    const ch = s.store.channel('Test')!;
    const pending = s.store.pendingCommit(ch.id)!;
    expect(pending.note).toMatch(/^verification failed/);
    const r = await resync(s.deps, 'Test', { dryRun: true });
    expect(r.found.join('\n')).toMatch(/has a note: verification failed/);
    expect(r.actions[0]).toMatch(/what it holds differs from the plan/);
    expect(r.stateMayBeStale).toBe(true);
    await resync(s.deps, 'Test');
    expect(s.store.pendingCommit(ch.id)).toBeUndefined();
    expect((await topUp(s.deps, 'Test')).action).toBe('none');
  });
});

describe('adopting the places of shows from an existing lineup', () => {
  const withHistory = (s: ReturnType<typeof setup>) => {
    const piece = 22 * MIN + 1000;
    const flex = s.fake.lineup[0]!['duration'] as number;
    s.fake.lineup = [
      { type: 'flex', duration: flex - 3 * piece },
      { type: 'content', id: 'ep3', startOffsetMs: 0, duration: piece },
      { type: 'content', id: 'mov1', startOffsetMs: 0, duration: 0 },
      { type: 'content', id: 'ep5', startOffsetMs: 0, duration: piece },
      { type: 'content', id: 'ep5', startOffsetMs: 0, duration: piece },
    ];
  };

  it('shows the place found, and applies it only when asked', async () => {
    const s = setup();
    withHistory(s);
    const dry = await adoptHistory(s.deps, 'Test', { dryRun: true });
    const a = dry.found.find((f) => f.key === 'seq:a')!;
    expect(a.lastProgramId).toBe('ep5');
    expect(a.place).toEqual({ position: 5, history: 2 });
    expect(s.store.channel('Test')!.state.sequences['seq:a']).toBeUndefined();
    await adoptHistory(s.deps, 'Test');
    expect(s.store.channel('Test')!.state.sequences['seq:a']).toEqual({ position: 5, history: 2 });
  });

  it('leaves a show that is not in the lineup at episode 1', async () => {
    const s = setup();
    const r = await adoptHistory(s.deps, 'Test');
    expect(r.found.every((f) => f.lastProgramId === undefined)).toBe(true);
    expect(s.store.channel('Test')!.state.sequences['seq:a']).toBeUndefined();
  });

  it('wraps to the first episode after the last one', async () => {
    const s = setup();
    s.fake.lineup = [...s.fake.lineup, { type: 'content', id: 'ep400', startOffsetMs: 0, duration: 0 }];
    const r = await adoptHistory(s.deps, 'Test', { dryRun: true });
    expect(r.found.find((f) => f.key === 'seq:a')!.place.position).toBe(0);
  });

  it('refuses once DayTuner has written to the channel', async () => {
    const s = setup();
    await topUp(s.deps, 'Test');
    await expect(adoptHistory(s.deps, 'Test')).rejects.toThrow(/already written/);
  });
});

describe('staging a range', () => {
  const at = (days: number, hours = 0) => NOW0 + days * DAY + hours * 3_600_000;

  it('plans from the committed edge but stores only the kept part, and leaves the state alone', async () => {
    const s = setup(); // the lineup ends 3 days after NOW0
    const stateBefore = JSON.stringify(s.store.channel('Test')!.state);
    const r = await stageGenerate(s.deps, 'Test', { to: at(8), keepFrom: at(6), keepTo: at(7) });
    expect(r.planned).toBeGreaterThan(r.kept.length);
    expect(r.kept.length).toBeGreaterThan(0);
    const staged = s.store.stagedSlots(s.store.channel('Test')!.id);
    expect(staged.map((x) => x.start)).toEqual(r.kept.map((x) => x.start));
    expect(staged.every((x) => x.start >= at(6) && x.start < at(7))).toBe(true);
    expect(JSON.stringify(s.store.channel('Test')!.state)).toBe(stateBefore);
    expect(s.fake.requests.some((q) => q.startsWith('POST') && q.includes('/programming'))).toBe(false);
    expect(r.titles[staged[0]!.planned.programs[0]!]).toBeTruthy();
  });

  it('keeps the whole range by default, and replaces a range staged earlier', async () => {
    const s = setup();
    await stageGenerate(s.deps, 'Test', { to: at(5) });
    const first = s.store.stagedSlots(s.store.channel('Test')!.id);
    expect(first[0]!.start).toBeGreaterThanOrEqual(at(3));
    await stageGenerate(s.deps, 'Test', { to: at(5) });
    expect(s.store.stagedSlots(s.store.channel('Test')!.id)).toHaveLength(first.length);
  });

  it('is deterministic: staging the same range twice gives the same slots', async () => {
    const s = setup();
    await stageGenerate(s.deps, 'Test', { to: at(6) });
    const a = JSON.stringify(s.store.stagedSlots(s.store.channel('Test')!.id).map((x) => x.planned));
    await stageGenerate(s.deps, 'Test', { to: at(6) });
    expect(JSON.stringify(s.store.stagedSlots(s.store.channel('Test')!.id).map((x) => x.planned))).toBe(a);
  });

  it('rejects a range that ends before the lineup does, or a kept part outside it', async () => {
    const s = setup();
    await expect(stageGenerate(s.deps, 'Test', { to: at(1) })).rejects.toThrow(/not after the end/);
    await expect(stageGenerate(s.deps, 'Test', { to: at(8), keepFrom: at(2), keepTo: at(5) })).rejects.toThrow(/must lie inside/);
    await expect(stageGenerate(s.deps, 'Test', { to: at(8), keepFrom: at(6), keepTo: at(9) })).rejects.toThrow(/must lie inside/);
  });

  it('does not change what the worker commits', async () => {
    const a = setup();
    const b = setup();
    await stageGenerate(b.deps, 'Test', { to: NOW0 + 9 * DAY });
    const ra = await topUp(a.deps, 'Test');
    const rb = await topUp(b.deps, 'Test');
    expect(rb.items).toBe(ra.items);
    expect(b.fake.lineup).toEqual(a.fake.lineup);
  });
});

describe('locked staged slots', () => {
  it('are committed exactly as staged, and are no longer staged afterwards', async () => {
    const s = setup();
    const id = s.store.channel('Test')!.id;
    const edge = s.store.channel('Test')!.edge;
    // Stage a few days just after the lineup, with a different seed than the worker will plan with.
    const staged = await stageGenerate(s.deps, 'Test', { to: edge + 3 * DAY });
    const lockedSlot = staged.kept[1]!;
    s.store.setLocked('Test', lockedSlot.start, true);
    const r = await topUp(s.deps, 'Test');
    expect(r.action).toBe('appended');
    expect(r.conflicts).toEqual([]);
    expect(r.planned!.find((x) => x.start === lockedSlot.start)).toEqual(lockedSlot);
    expect(s.store.stagedSlots(id).every((x) => x.start >= s.store.channel('Test')!.edge)).toBe(true);
    expect(s.store.stagedSlots(id).find((x) => x.start === lockedSlot.start)).toBeUndefined();
    // What reached Tunarr holds the locked slot's content, in order.
    const contentIds = s.fake.lineup.filter((i) => i['type'] === 'content').map((i) => i['id']);
    for (const p of lockedSlot.programs) expect(contentIds).toContain(p);
  });

  it('is planned again and noted in the commit log when it no longer fits', async () => {
    const s = setup();
    const edge = s.store.channel('Test')!.edge;
    const staged = await stageGenerate(s.deps, 'Test', { to: edge + 2 * DAY });
    const slot = staged.kept.find((k) => k.programs.length > 0)!;
    s.store.setLocked('Test', slot.start, true);
    // A program of the locked slot changes length in the library.
    const id = slot.programs[0]!;
    const movie = s.fake.data.movies.find((m) => m.id === id);
    const ep = s.fake.data.shows[0]!.episodes.find((e) => e.id === id);
    (movie ?? ep)!.duration += 1000;
    const r = await topUp(s.deps, 'Test');
    expect(r.action).toBe('appended');
    expect(r.conflicts).toHaveLength(1);
    expect(r.conflicts[0]).toMatchObject({ reason: 'duration-changed', start: slot.start });
    const ch = s.store.channel('Test')!;
    const commit = s.store.commits(ch.id)[0]!;
    expect(commit.status).toBe('done');
    expect(commit.note).toMatch(/locked slots that could not be kept/);
  });
});

describe('pins on staged slots', () => {
  it('are kept when the slot is committed, and a program outside every pool is added to the library', async () => {
    const s = setup();
    const id = s.store.channel('Test')!.id;
    const edge = s.store.channel('Test')!.edge;
    const staged = await stageGenerate(s.deps, 'Test', { to: edge + 3 * DAY });
    const movieSlot = staged.kept.filter((k) => k.pool === 'movies')[1]!; // the first one may be only part of a slot
    // A movie no pool uses: too long for the pool's filter, but short enough for the slot.
    s.fake.data.movies.push({ id: 'special', title: 'Special', duration: 100 * MIN, genres: ['Drama'] });
    s.store.setPin('Test', movieSlot.start, 1, { id: 'special', title: 'Special', duration: 100 * MIN });
    const again = await stageGenerate(s.deps, 'Test', { to: movieSlot.start + 1, keepFrom: movieSlot.start, keepTo: movieSlot.start + 1 });
    expect(again.kept[0]!.programs[0]).toBe('special');
    expect(again.kept[0]!.blocks[0]!.pinned).toBe(true);
    expect(s.store.stagedSlots(id, movieSlot.start, movieSlot.start + 1)[0]!.planned.programs[0]).toBe('special');
    const r = await topUp(s.deps, 'Test');
    expect(r.action).toBe('appended');
    expect(r.planned!.find((x) => x.start === movieSlot.start)!.programs[0]).toBe('special');
    expect(s.fake.lineup.some((i) => i['type'] === 'content' && i['id'] === 'special')).toBe(true);
  });
});

describe('checking staged slots before a commit', () => {
  it('reports lock conflicts and pin problems without writing anything', async () => {
    const s = setup();
    const edge = s.store.channel('Test')!.edge;
    const staged = await stageGenerate(s.deps, 'Test', { to: edge + 3 * DAY });
    expect(await stageCheck(s.deps, 'Test')).toMatchObject({ conflicts: [], pinProblems: [] });

    const movies = staged.kept.filter((k) => k.pool === 'movies');
    s.store.setLocked('Test', movies[1]!.start, true);
    s.fake.data.movies.push({ id: 'epic', title: 'Epic', duration: 13 * 3_600_000, genres: ['Drama'] });
    s.store.setPin('Test', movies[2]!.start, 1, { id: 'epic', title: 'Epic', duration: 13 * 3_600_000 });
    for (const m of s.fake.data.movies) if (m.id !== 'epic') m.duration += 1000;

    const before = JSON.stringify([s.store.channel('Test'), s.store.stagedSlots(s.store.channel('Test')!.id)]);
    const check = await stageCheck(s.deps, 'Test');
    expect(check.conflicts.map((c) => [c.start, c.reason])).toEqual([[movies[1]!.start, 'duration-changed']]);
    expect(check.pinProblems.map((w) => w.code)).toEqual(['pin-does-not-fit']);
    expect(JSON.stringify([s.store.channel('Test'), s.store.stagedSlots(s.store.channel('Test')!.id)])).toBe(before);
  });

  it('has nothing to report when nothing is staged', async () => {
    expect(await stageCheck(setup().deps, 'Test')).toEqual({ conflicts: [], pinProblems: [], titles: {} });
  });
});

describe('reshaping staged slots', () => {
  async function staged() {
    const s = setup();
    const id = s.store.channel('Test')!.id;
    const edge = s.store.channel('Test')!.edge;
    await stageGenerate(s.deps, 'Test', { to: edge + 4 * DAY });
    const rows = () => s.store.stagedSlots(id);
    // Whole slots only: the first one may be partial.
    const full = rows().filter((r) => r.start > edge + 30 * MIN);
    return { ...s, id, rows, full };
  }
  const contiguous = (rows: { start: number; end: number }[]) => rows.every((r, i) => i === 0 || r.start === rows[i - 1]!.end);

  it('delete: the slot before grows to take its time, and nothing is left empty', async () => {
    const s = await staged();
    const [a, b, c] = [s.full[0]!, s.full[1]!, s.full[2]!];
    expect(a.end).toBe(b.start);
    await stageEdit(s.deps, 'Test', { kind: 'delete', start: b.start });
    const rows = s.rows();
    expect(rows.find((r) => r.start === b.start)).toBeUndefined();
    expect(rows.find((r) => r.start === a.start)).toMatchObject({ end: b.end, edited: true });
    expect(rows.find((r) => r.start === c.start)).toBeDefined();
    expect(contiguous(rows)).toBe(true);
    for (const r of rows) expect(r.planned.items.reduce((x, i) => x + i.duration, 0)).toBe(r.end - r.start);
  });

  it('resize: extending covers or cuts the slots after it', async () => {
    const s = await staged();
    const [a, b, c] = [s.full[0]!, s.full[1]!, s.full[2]!];
    const newEnd = b.start + Math.floor((b.end - b.start) / 2 / (15 * MIN)) * 15 * MIN; // inside the next slot
    await stageEdit(s.deps, 'Test', { kind: 'resize', start: a.start, end: newEnd });
    const rows = s.rows();
    expect(rows.find((r) => r.start === a.start)).toMatchObject({ end: newEnd });
    expect(rows.find((r) => r.start === b.start)).toBeUndefined();
    expect(rows.find((r) => r.start === newEnd)).toMatchObject({ end: b.end, edited: true });
    expect(rows.find((r) => r.start === c.start)).toBeDefined();
    expect(contiguous(rows)).toBe(true);
    // Covering the next slot completely removes it.
    await stageEdit(s.deps, 'Test', { kind: 'resize', start: a.start, end: c.start });
    expect(s.rows().find((r) => r.start === newEnd)).toBeUndefined();
    expect(contiguous(s.rows())).toBe(true);
  });

  it('resize: shortening hands the time to the slot after it', async () => {
    const s = await staged();
    const [a, b] = [s.full[0]!, s.full[1]!];
    const newEnd = a.start + 2 * 60 * MIN;
    expect(newEnd).toBeLessThan(a.end);
    await stageEdit(s.deps, 'Test', { kind: 'resize', start: a.start, end: newEnd });
    const rows = s.rows();
    expect(rows.find((r) => r.start === a.start)).toMatchObject({ end: newEnd });
    expect(rows.find((r) => r.start === newEnd)).toMatchObject({ end: b.end, slotId: b.slotId });
    expect(rows.find((r) => r.start === b.start)).toBeUndefined();
    expect(contiguous(rows)).toBe(true);
  });

  it('add: a slot with its pin splits the slot it sits in, and the rest carries on', async () => {
    const s = await staged();
    const big = s.full.find((r) => r.end - r.start >= 6 * 60 * MIN)!;
    const start = big.start + 60 * MIN;
    const end = start + 60 * MIN;
    const pin = { id: 'ep9', title: 'Show A "Ep 9"', duration: 22 * MIN + 1000 };
    const r = await stageEdit(s.deps, 'Test', { kind: 'add', start, end, pin });
    expect(r.kept.find((k) => k.start === start)!.programs).toEqual(['ep9']);
    const rows = s.rows();
    expect(rows.find((x) => x.start === big.start)).toMatchObject({ end: start });
    expect(rows.find((x) => x.start === start)).toMatchObject({ end, slotId: `added@${start}`, pool: null, pins: { 1: pin } });
    expect(rows.find((x) => x.start === end)).toMatchObject({ end: big.end, slotId: big.slotId });
    expect(contiguous(rows)).toBe(true);
    for (const x of rows) expect(x.planned.items.reduce((a, i) => a + i.duration, 0)).toBe(x.end - x.start);
  });

  it('a shaped day survives planning again and is what the worker commits', async () => {
    const s = await staged();
    const big = s.full.find((r) => r.end - r.start >= 6 * 60 * MIN)!;
    const start = big.start + 60 * MIN;
    await stageEdit(s.deps, 'Test', { kind: 'add', start, end: start + 60 * MIN, pin: { id: 'ep9', title: 'x', duration: 22 * MIN + 1000 } });
    const before = JSON.stringify(s.rows().map((r) => [r.start, r.end, r.slotId, r.planned.programs]));
    await stageGenerate(s.deps, 'Test', { to: s.store.channel('Test')!.edge + 4 * DAY });
    expect(JSON.stringify(s.rows().map((r) => [r.start, r.end, r.slotId, r.planned.programs]))).toBe(before);
    const r = await topUp(s.deps, 'Test');
    expect(r.planned!.find((p) => p.start === start)!.programs).toEqual(['ep9']);
  });

  it('refuses what it cannot do, and changes nothing', async () => {
    const s = await staged();
    const [a, b] = [s.full[0]!, s.full[1]!];
    const before = JSON.stringify(s.rows());
    await expect(stageEdit(s.deps, 'Test', { kind: 'delete', start: a.start + 15 * MIN })).rejects.toThrow(/no slot is staged/);
    await expect(stageEdit(s.deps, 'Test', { kind: 'resize', start: a.start, end: a.start + 7 * MIN })).rejects.toThrow(/grid/);
    await expect(stageEdit(s.deps, 'Test', { kind: 'resize', start: a.start, end: a.start })).rejects.toThrow(/after the slot starts/);
    await expect(stageEdit(s.deps, 'Test', { kind: 'add', start: a.start, end: a.start, pin: { id: 'ep9', title: 'x', duration: 1000 } })).rejects.toThrow(/after the start/);
    s.store.setLocked('Test', b.start, true);
    await expect(stageEdit(s.deps, 'Test', { kind: 'delete', start: b.start })).rejects.toThrow(/locked/);
    await expect(stageEdit(s.deps, 'Test', { kind: 'resize', start: a.start, end: b.end + 15 * MIN })).rejects.toThrow(/locked/);
    s.store.setLocked('Test', b.start, false);
    expect(JSON.stringify(s.rows())).toBe(before);
  });
});

describe('the preview diff', () => {
  async function staged() {
    const s = setup();
    const edge = s.store.channel('Test')!.edge;
    await stageGenerate(s.deps, 'Test', { to: edge + 4 * DAY });
    const id = s.store.channel('Test')!.id;
    return { ...s, id, full: s.store.stagedSlots(id).filter((r) => r.start > edge + 30 * MIN) };
  }

  it('an edit reports the slots it changed, with before and after', async () => {
    const s = await staged();
    const [a, b] = [s.full[0]!, s.full[1]!];
    const r = await stageEdit(s.deps, 'Test', { kind: 'delete', start: b.start });
    const grew = r.changes.find((c) => c.start === a.start)!;
    expect(grew).toMatchObject({ kind: 'changed', endBefore: a.end, end: b.end });
    expect(r.changes.find((c) => c.start === b.start)).toMatchObject({ kind: 'removed' });
    expect(r.changes.every((c) => c.start >= a.start)).toBe(true);
  });

  it('generating the same range again changes nothing', async () => {
    const s = await staged();
    const r = await stageGenerate(s.deps, 'Test', { to: s.store.channel('Test')!.edge + 4 * DAY });
    expect(r.changes).toEqual([]);
  });

  it('a pin shows up as a change to its slot, and the slots after it', async () => {
    const s = await staged();
    const slot = s.full.find((x) => x.pool === 'sitcoms')!;
    s.store.setPin('Test', slot.start, 2, { id: 'ep200', title: 'Pinned', duration: 22 * MIN + 1000 });
    const r = await stageRefresh(s.deps, 'Test', slot.start);
    expect(r.changes.find((c) => c.start === slot.start)).toMatchObject({ kind: 'changed' });
    expect(r.changes.find((c) => c.start === slot.start)!.after).toContain('ep200');
  });

  it('stage diff compares what was shaped with planning the schedule fresh', async () => {
    const s = await staged();
    expect((await stageDiff(s.deps, 'Test')).changes).toEqual([]);
    const big = s.full.find((r) => r.end - r.start >= 6 * 60 * MIN)!;
    await stageEdit(s.deps, 'Test', { kind: 'add', start: big.start + 60 * MIN, end: big.start + 120 * MIN, pin: { id: 'ep9', title: 'x', duration: 22 * MIN + 1000 } });
    const d = await stageDiff(s.deps, 'Test');
    expect(d.changes.some((c) => c.kind === 'new' && c.slotId.startsWith('added@'))).toBe(true);
    expect(await stageDiff(setup().deps, 'Test')).toMatchObject({ changes: [], staged: 0 });
  });

  it('a new schedule is dry-run against the staged slots, and writes nothing', async () => {
    const s = await staged();
    const movie = s.full.find((r) => r.pool === 'movies')!;
    s.store.setLocked('Test', movie.start, true);
    const before = JSON.stringify([s.store.channel('Test'), s.store.stagedSlots(s.id)]);
    expect((await revisionImpact(s.deps, 'Test', YAML)).conflicts).toEqual([]);
    const moved = YAML.replaceAll('at: "20:00"', 'at: "21:00"');
    const impact = await revisionImpact(s.deps, 'Test', moved);
    expect(impact.conflicts.map((c) => [c.start, c.reason])).toEqual([[movie.start, 'window-changed']]);
    expect(impact.changes.length).toBeGreaterThan(0);
    expect(JSON.stringify([s.store.channel('Test'), s.store.stagedSlots(s.id)])).toBe(before);
  });
});

describe('the chapter cache', () => {
  const asked = (s: ReturnType<typeof setup>) => s.fake.requests.filter((q) => q.includes('/stream_details')).length;

  it('reads chapters once, and later plans take them from the store', async () => {
    const s = setup();
    s.fake.data.movies[0]!.chapters = [{ start: 0, end: 30 * MIN }, { start: 30 * MIN, end: 85 * MIN }];
    await topUp(s.deps, 'Test', { dryRun: true });
    const first = asked(s);
    expect(first).toBeGreaterThan(0);
    await topUp(s.deps, 'Test', { dryRun: true });
    await stageGenerate(s.deps, 'Test', { to: s.store.channel('Test')!.edge + 2 * DAY });
    expect(asked(s)).toBe(first);
  });

  it('reads again when a program changed length, or the entry is older than its lifetime', async () => {
    const s = setup();
    await topUp(s.deps, 'Test', { dryRun: true });
    const first = asked(s);
    s.fake.data.movies[0]!.duration += 1000;
    await topUp(s.deps, 'Test', { dryRun: true });
    expect(asked(s)).toBe(first + 1);
    const second = asked(s);
    s.clock.t += CHAPTER_CACHE_LIFETIME_MS + 1;
    await stageGenerate(s.deps, 'Test', { to: s.store.channel('Test')!.edge + 2 * DAY });
    expect(asked(s)).toBeGreaterThan(second);
  });
});

describe('resync', () => {
  it('adopts Tunarr\'s end after a change made outside DayTuner, so the worker can carry on', async () => {
    const s = setup();
    s.fake.appendExternally([{ type: 'flex', duration: 5 * MIN }]);
    await expect(topUp(s.deps, 'Test')).rejects.toBeInstanceOf(ConsistencyError);

    const dry = await resync(s.deps, 'Test', { dryRun: true });
    expect(dry.stateMayBeStale).toBe(true);
    expect(dry.actions[0]).toMatch(/record .* as the end/);
    await expect(topUp(s.deps, 'Test')).rejects.toBeInstanceOf(ConsistencyError); // a dry run changed nothing

    await resync(s.deps, 'Test');
    expect((await topUp(s.deps, 'Test')).action).toBe('appended');
  });

  it('settles a pending commit that did reach Tunarr, without calling the state stale', async () => {
    const s = setup();
    s.fake.crashAfterNextAppend = true;
    await expect(topUp(s.deps, 'Test')).rejects.toThrow();
    // Put the pending commit back, as if the process had died before settling it.
    const ch = s.store.channel('Test')!;
    const done = s.store.commits(ch.id)[0]!;
    const fresh = Store.open(':memory:');
    fresh.addChannel({ name: 'Test', tunarrId: 'chan-1', floorMs: 7 * DAY, stepMs: DAY, schedule: YAML, state: emptyPlanState(5), edge: done.fromEdge });
    fresh.beginCommit({ channelId: fresh.channel('Test')!.id, fromEdge: done.fromEdge, toEdge: done.toEdge, state: done.state, items: done.items, totalMs: done.totalMs, slots: done.slots, at: 1 });
    const r = await resync({ ...s.deps, store: fresh }, 'Test');
    expect(r.actions[0]).toMatch(/complete commit/);
    expect(r.stateMayBeStale).toBe(false);
    expect(fresh.pendingCommit(fresh.channel('Test')!.id)).toBeUndefined();
  });

  it('has nothing to do when the store and Tunarr already agree', async () => {
    const r = await resync(setup().deps, 'Test');
    expect(r.actions).toEqual([]);
    expect(r.found[0]).toMatch(/nothing to adopt/);
  });
});


describe('resetting staged slots to the plan', () => {
  it('drops shape and pins in a range, plans again, and keeps locked slots', async () => {
    const s = setup();
    const edge = s.store.channel('Test')!.edge;
    await stageGenerate(s.deps, 'Test', { to: edge + 4 * DAY });
    const id = s.store.channel('Test')!.id;
    const plain = JSON.stringify(s.store.stagedSlots(id).map((r) => [r.start, r.end, r.slotId, r.planned.programs]));
    const full = s.store.stagedSlots(id).filter((r) => r.start > edge + 30 * MIN);
    const big = full.find((r) => r.end - r.start >= 6 * 60 * MIN)!;
    await stageEdit(s.deps, 'Test', { kind: 'add', start: big.start + 60 * MIN, end: big.start + 120 * MIN, pin: { id: 'ep9', title: 'x', duration: 22 * MIN + 1000 } });
    expect(s.store.stagedSlots(id).some((r) => r.edited)).toBe(true);

    const r = await stageReset(s.deps, 'Test', { from: big.start, to: big.end });
    expect(s.store.stagedSlots(id).some((x) => x.edited || Object.keys(x.pins).length > 0)).toBe(false);
    expect(JSON.stringify(s.store.stagedSlots(id).map((x) => [x.start, x.end, x.slotId, x.planned.programs]))).toBe(plain);
    expect(r.changes.some((c) => c.kind === 'removed' && c.slotId.startsWith('added@'))).toBe(true);

    // A locked slot in the range stays as it is.
    const other = s.store.stagedSlots(id).find((x) => x.pool === 'movies' && x.start > edge + 30 * MIN)!;
    s.store.setLocked('Test', other.start, true);
    await stageReset(s.deps, 'Test', { from: other.start, to: other.end });
    expect(s.store.stagedSlots(id).find((x) => x.start === other.start)).toMatchObject({ locked: true });
    await expect(stageReset(s.deps, 'Test', { from: 10, to: 5 })).rejects.toThrow(/after its start/);
  });
});


describe('metrics kept for each commit', () => {
  it('stores the metrics and the alert count of what a commit wrote', async () => {
    const s = setup();
    await topUp(s.deps, 'Test');
    const id = s.store.channel('Test')!.id;
    const [point] = s.store.commitMetrics(id);
    expect(point).toMatchObject({ alerts: expect.any(Number), warnings: expect.any(Number) });
    expect(point!.metrics.slots).toBeGreaterThan(0);
    expect(point!.metrics.gridAccuracy.share).toBeGreaterThan(0.99);
  });
});

describe('health', () => {
  it('is ok with a committed lineup and metrics inside the targets, and says what is wrong otherwise', async () => {
    const s = setup(9 * DAY);
    await topUp(s.deps, 'Test').catch(() => undefined); // already far enough ahead: nothing to commit
    const ch = () => s.store.channel('Test')!;
    const fine = evaluateHealth({ channel: ch(), last: undefined, lastRun: undefined, clock: s.clock });
    expect(fine.status).toBe('ok');
    expect(fine.checks.map((c) => c.name)).toEqual(['Committed ahead']);

    const short = setup(2 * DAY);
    expect(evaluateHealth({ channel: short.store.channel('Test')!, last: undefined, lastRun: undefined, clock: short.clock })).toMatchObject({ status: 'needs-attention' });

    await topUp(short.deps, 'Test');
    const id = short.store.channel('Test')!.id;
    const last = short.store.commitMetrics(id)[0]!;
    const run = { id: 1, channelId: id, at: 1, outcome: 'refused' as const, message: 'the lineup ran out' };
    const h = evaluateHealth({ channel: short.store.channel('Test')!, last, lastRun: run, clock: short.clock });
    expect(h.headline.adLoad).toBeGreaterThan(0);
    expect(h.checks.find((c) => c.name === 'Last run')).toMatchObject({ ok: false, detail: expect.stringContaining('the lineup ran out') });
    expect(h.status).toBe('needs-attention');
    // Tighten a target until it trips.
    short.store.setTargets('Test', { deadAirMaxShare: 0 });
    const tight = evaluateHealth({ channel: short.store.channel('Test')!, last, lastRun: undefined, clock: short.clock });
    expect(tight.checks.find((c) => c.name === 'Dead air')!.ok).toBe(last.metrics.deadAirShare === 0);
  });
});

describe('the daily run', () => {
  it('is due once its time has passed in the schedule\'s own zone, and not again until the next day', () => {
    const zone = 'America/Toronto';
    const at3 = 3 * 60;
    const noon = Date.UTC(2026, 10, 6, 17, 0); // 12:00 in Toronto (UTC-5)
    const instant = scheduledInstant(zone, at3, noon);
    expect(instant).toBe(Date.UTC(2026, 10, 6, 8, 0)); // 03:00 Toronto today
    const earlier = Date.UTC(2026, 10, 6, 6, 0); // 01:00 Toronto: today's run has not come yet
    expect(scheduledInstant(zone, at3, earlier)).toBe(Date.UTC(2026, 10, 5, 8, 0)); // yesterday's
    const s = setup();
    const ch = s.store.channel('Test')!;
    expect(isDue({ ...ch, runAtMinutes: at3 }, undefined, noon)).toBe(true);
    expect(isDue({ ...ch, runAtMinutes: at3 }, instant + 1, noon)).toBe(false);
    expect(isDue({ ...ch, runAtMinutes: at3 }, instant + 1, noon + DAY)).toBe(true);
  });

  it('copes with the daylight-saving change (03:00 on the spring day is after the gap)', () => {
    const zone = 'America/Toronto';
    const spring = Date.UTC(2026, 2, 8, 16, 0); // 8 March 2026, 12:00 EDT
    expect(scheduledInstant(zone, 2 * 60 + 30, spring)).toBe(Date.UTC(2026, 2, 8, 7, 30)); // 02:30 does not exist: it is 03:30 EDT
  });

  it('records how a run ended: appended, nothing to do, refused', async () => {
    const s = setup(2 * DAY);
    const id = s.store.channel('Test')!.id;
    await runAndRecord(s.deps, 'Test');
    expect(s.store.lastRuns(id, 1)[0]).toMatchObject({ outcome: 'appended', at: NOW0 });
    await runAndRecord(s.deps, 'Test');
    expect(s.store.lastRuns(id, 1)[0]).toMatchObject({ outcome: 'nothing-to-do' });
    s.fake.appendExternally([{ type: 'flex', duration: 5 * MIN }]);
    await expect(runAndRecord(s.deps, 'Test')).rejects.toThrow();
    expect(s.store.lastRuns(id, 1)[0]).toMatchObject({ outcome: 'refused' });
  });
});
