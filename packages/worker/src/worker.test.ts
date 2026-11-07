import { beforeEach, describe, expect, it } from 'vitest';
import { emptyPlanState } from '@daytuner/engine';
import { Store } from '@daytuner/store';
import { FakeTunarr, TunarrClient } from '@daytuner/tunarr-client';
import { adjustCursor, adoptHistory, ConsistencyError, listSequences, resync, topUp, type WorkerDeps } from './worker.js';

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

