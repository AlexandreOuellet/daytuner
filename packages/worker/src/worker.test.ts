import { beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyPlanState, type Schedule } from '@daytuner/engine';
import { Store } from '@daytuner/store';
import { FakeTunarr, TunarrClient } from '@daytuner/tunarr-client';
import { CHAPTER_CACHE_LIFETIME_MS } from './chapters.js';
import { evaluateHealth } from './health.js';
import { adSamples } from './adsample.js';
import { poolStats } from './poolstats.js';
import { adSettingsOf, parseScheduleFile } from '@daytuner/schedule';
import { isDue, runAndRecord, scheduledInstant } from './scheduler.js';
import { blocksFromLineup, calendarPlan, earlierEpisode, runsOf, stageRerun } from './calendar.js';
import { cursorPreview, stageReset, adjustCursor, adoptHistory, revisionImpact, stageCheck, stageDiff, stageEdit, stageGenerate, stageRefresh, ConsistencyError, listSequences, resync, topUp, createChannel, addChannel, newChannelFile, layoutProblems, poolChanges, gridsFor, gridFitsZone, originOf, type WorkerDeps } from './worker.js';

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
    expect(Math.abs(s.store.channel('Test')!.edge - tun)).toBeLessThan(1);
    expect(s.store.commits(s.store.channel('Test')!.id)[0]).toMatchObject({ status: 'done', items: r.items });
  });

  it('stores the lineup where the plan says, on the grid, even when the lineup it continues ends off the grid', async () => {
    // The old lineup ends 7 minutes and 13 seconds after a grid line, as an adopted lineup may.
    const odd = setup(3 * DAY + 7 * MIN + 13_000);
    const grid = 15 * MIN;
    const items0 = odd.fake.lineup.length;
    const edgeBefore = odd.fake.data.channel.startTime + odd.fake.duration;
    const r = await topUp(odd.deps, 'Test');
    expect(r.action).toBe('appended');
    const stored = odd.fake.lineup.slice(items0);
    // A flex pad takes the lineup to the next grid line, and the plan starts there.
    expect(stored[0]).toMatchObject({ type: 'flex' });
    const first = r.planned![0]!;
    expect(first.start % grid).toBe(0);
    expect(Math.abs(first.start - edgeBefore - Number(stored[0]!['duration']))).toBeLessThanOrEqual(1);
    // Every item is where the plan put it: the stored lineup, laid end to end from the channel's start time, reaches each slot
    // and each block boundary at exactly the planned millisecond.
    let at = edgeBefore;
    let i = 0;
    const clock = (n: number): void => { for (let k = 0; k < n; k++) at += Number(odd.fake.real(stored[i++]!)['duration']); };
    clock(1); // the pad
    for (const slot of r.planned!) {
      // never before the line (a guide that cuts off the seconds would show :29:59), and not accumulating over the days planned
      expect(at - slot.start).toBeGreaterThanOrEqual(-1e-6);
      expect(at - slot.start).toBeLessThan(3);
      clock(slot.items.length);
      expect(Math.abs(at - slot.end)).toBeLessThan(1);
      expect(slot.start % grid).toBe(0);
      expect(slot.end % grid).toBe(0);
      slot.blocks.forEach((b, j) => {
        if (j > 0) expect(b.start % grid).toBe(0);
        if (j < slot.blocks.length - 1) expect(b.end % grid).toBe(0);
      });
    }
    expect(i).toBe(stored.length);
    expect(Math.abs(odd.fake.data.channel.startTime + odd.fake.duration - r.planned![r.planned!.length - 1]!.end)).toBeLessThan(1);
    expect(layoutProblems(r.planned!, first.start, grid)).toEqual([]);
  });

  it('says what is wrong with a plan that is not on the grid, before writing anything', () => {
    const slot = (start: number, end: number, extra: object = {}) => ({ slotId: 's', start, end, pool: 'p', programs: [], exception: false, blocks: [], items: [{ kind: 'flex', duration: end - start }], ...extra }) as never;
    const g = 15 * MIN;
    expect(layoutProblems([slot(0, g), slot(g, 3 * g)], 0, g)).toEqual([]);
    expect(layoutProblems([slot(1000, g)], 0, g).join()).toMatch(/not where the lineup is aligned to/);
    expect(layoutProblems([slot(0, g), slot(g + 1, 2 * g)], 0, g).join()).toMatch(/does not start where the slot before it ends/);
    expect(layoutProblems([slot(0, g + 5_000)], 0, g).join()).toMatch(/not on the 15-minute grid/);
    expect(layoutProblems([slot(0, g, { items: [{ kind: 'flex', duration: g - 1 }] })], 0, g).join()).toMatch(/its items last/);
    expect(layoutProblems([slot(0, 2 * g, { blocks: [{ programId: 'a', start: 0, end: g + 3000 }, { programId: 'b', start: g + 3000, end: 2 * g }] })], 0, g).join()).toMatch(/block 1 ends at .*off the grid/);
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

  it('carries on when the end has only drifted a little from the grid line it was written to, and says so', async () => {
    const s = setup();
    const edge = s.store.channel('Test')!.edge;
    const next = Math.ceil(edge / (15 * MIN)) * (15 * MIN);
    // The store thinks the lineup ends 139 ms after Tunarr's end (which is the grid line, less 139 ms in Tunarr's record).
    s.store.setEdge('Test', next);
    s.fake.appendExternally([{ type: 'flex', duration: next - 139 - edge }]);
    const r = await topUp(s.deps, 'Test');
    expect(r.action).toBe('appended');
    expect(r.warnings.some((w) => w.code === 'edge-drift' && /139 ms before/.test(w.message))).toBe(true);
    expect(s.store.commits(s.store.channel('Test')!.id)[0]!.slots[0]!.start).toBe(next);
  });

  it('carries on when the end has drifted a little past the grid line it was written to, at the cost of a grid step of flex, and says so as a warning', async () => {
    // Tunarr reads a clip back with its real length, which can be a fraction over what was written as well as under it.
    const s = setup();
    const edge = s.store.channel('Test')!.edge;
    const line = Math.ceil((edge + 1) / (15 * MIN)) * (15 * MIN);
    s.store.setEdge('Test', line);
    s.fake.appendExternally([{ type: 'flex', duration: line + 139 - edge }]); // 139 ms after the line
    const r = await topUp(s.deps, 'Test');
    expect(r.action).toBe('appended');
    const w = r.warnings.find((x) => x.code === 'edge-drift')!;
    expect(w.severity).toBe('warning');
    expect(w.message).toMatch(/139 ms after/);
    expect(w.message).toMatch(/15 minutes/); // what it costs: the next slot waits for the next grid line
    expect(s.store.commits(s.store.channel('Test')!.id)[0]!.slots[0]!.start).toBe(line + 15 * MIN);
  });

  it('still refuses a drift that is a second or more, in either direction', async () => {
    const t = setup();
    const e2 = t.store.channel('Test')!.edge;
    const n2 = Math.ceil((e2 + 1) / (15 * MIN)) * (15 * MIN);
    t.store.setEdge('Test', n2);
    t.fake.appendExternally([{ type: 'flex', duration: n2 - 1500 - e2 }]);
    await expect(topUp(t.deps, 'Test')).rejects.toThrow(/outside DayTuner/);
    const u = setup();
    const e3 = u.store.channel('Test')!.edge;
    const n3 = Math.ceil((e3 + 1) / (15 * MIN)) * (15 * MIN);
    u.store.setEdge('Test', n3);
    u.fake.appendExternally([{ type: 'flex', duration: n3 + 1500 - e3 }]); // a second and a half past the line
    await expect(topUp(u.deps, 'Test')).rejects.toThrow(/outside DayTuner/);
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
    expect(Math.abs(ch.edge - (s.fake.data.channel.startTime + s.fake.duration))).toBeLessThan(1);
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
    expect(s.store.channel('Test')!.state.sequences['seq:a']).toEqual({ position: 5, history: 2, last: 'ep5' });
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

describe('staging ahead never leaves a gap in the lineup', () => {
  it('commits only what is due, continuing from the end of the lineup, and picks a staged slot up when its time comes', async () => {
    const s = setup();
    const id = s.store.channel('Test')!.id;
    const grid = 15 * MIN;
    const edge0 = s.store.channel('Test')!.edge;
    // Stage one slot far ahead, with days between that are not staged, and give it a pin and a lock.
    const far = edge0 + 20 * DAY;
    const staged = await stageGenerate(s.deps, 'Test', { to: far + DAY, keepFrom: far, keepTo: far + DAY });
    const slot = staged.kept.find((k) => k.pool === 'movies' && k.start >= far + MIN)!;
    // A film no pool plays, so it can only reach the lineup through the pin.
    s.fake.data.movies.push({ id: 'special', title: 'Pinned far ahead', duration: 100 * MIN, genres: ['Drama'] });
    s.store.setPin('Test', slot.start, 1, { id: 'special', title: 'Pinned far ahead', duration: 100 * MIN });
    await stageRefresh(s.deps, 'Test', slot.start); // the pin takes effect, then the lock keeps the slot as it is
    s.store.setLocked('Test', slot.start, true);
    expect(s.store.stagedSlots(id).every((r) => r.start >= far)).toBe(true);

    const stored = (): Record<string, unknown>[] => s.fake.lineup;
    const position = (index: number): number => { let at = s.fake.data.channel.startTime; for (let i = 0; i < index; i++) at += Number(stored()[i]!['duration']); return at; };
    let reached = false;
    for (let day = 0; day < 40 && !reached; day++) {
      const before = s.fake.lineup.length;
      const edgeBefore = s.fake.data.channel.startTime + s.fake.duration;
      const r = await topUp(s.deps, 'Test');
      if (r.action !== 'appended') { s.clock.t += DAY; continue; }
      // What was added starts exactly where the lineup ended (a pad only to reach the grid), and touches: no gap, ever.
      const first = r.planned![0]!;
      expect(first.start - edgeBefore).toBeGreaterThanOrEqual(-3);
      expect(first.start - edgeBefore).toBeLessThan(grid);
      expect(r.planned!.every((x, i, all) => i === 0 || all[i - 1]!.end === x.start)).toBe(true);
      expect(layoutProblems(r.planned!, first.start, grid)).toEqual([]);
      expect(Math.abs(s.fake.data.channel.startTime + s.fake.duration - r.planned![r.planned!.length - 1]!.end)).toBeLessThan(3);
      // The far slot is not in the lineup until a commit reaches it, and then it is exactly at its time, pinned.
      const planned = r.planned!.find((x) => x.start === slot.start);
      const inLineup = stored().slice(before).some((i) => i['id'] === 'special');
      if (planned) {
        reached = true;
        expect(inLineup).toBe(true);
        const index = stored().findIndex((i, n) => n >= before && i['id'] === 'special');
        expect(position(index - slot.items.findIndex((x) => x.kind === 'content')) - slot.start).toBeLessThanOrEqual(0); // the slot's first item is at or before it
        expect(r.planned!.find((x) => x.start === slot.start)!.start % grid).toBe(0);
      } else {
        expect(inLineup).toBe(false);
        expect(s.store.stagedSlots(id).some((r2) => r2.start === slot.start)).toBe(true); // still waiting
      }
      s.clock.t += DAY;
    }
    expect(reached).toBe(true);
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

  it('the calendar tells staged slots from planned ones, and marks what was done by hand', async () => {
    const s = await staged();
    const edge = s.store.channel('Test')!.edge;
    const range = { from: edge, to: edge + 8 * DAY };
    const plain = await calendarPlan(s.deps, 'Test', range);
    const stagedStarts = new Set(s.store.stagedSlots(s.id).filter((r) => r.start < edge + 8 * DAY).map((r) => r.start));
    expect(plain.slots.filter((x) => x.source === 'staged').map((x) => x.slot.start).sort((a, b) => a - b)).toEqual([...stagedStarts].sort((a, b) => a - b));
    expect(plain.slots.some((x) => x.source === 'planned')).toBe(true);
    // Staged but untouched: stored, and exactly the plan.
    expect(plain.slots.filter((x) => x.source === 'staged').every((x) => x.hand.length === 0 && !x.differs && x.plan.length === 0)).toBe(true);
    // Never planned past eight weeks.
    expect((await calendarPlan(s.deps, 'Test', { from: edge, to: edge + 100 * DAY })).to).toBe(edge + 56 * DAY);

    const slot = s.full.find((x) => x.pool === 'sitcoms')!;
    s.store.setPin('Test', slot.start, 2, { id: 'ep200', title: 'Pinned', duration: 22 * MIN + 1000 });
    await stageRefresh(s.deps, 'Test', slot.start);
    s.store.setLocked('Test', slot.start, true);
    const hand = (await calendarPlan(s.deps, 'Test', range)).slots.find((x) => x.slot.start === slot.start)!;
    expect(hand).toMatchObject({ source: 'staged', differs: true });
    expect(hand.hand).toEqual(expect.arrayContaining(['1 pin', 'locked']));
    expect(hand.plan.length).toBeGreaterThan(0);
    expect(hand.totals.programMs).toBeGreaterThan(0);
  });

  it('a rerun plays the earlier episode in a block and uses up no new episode, so the show does not skip one', async () => {
    const s = await staged();
    const edge = s.store.channel('Test')!.edge;
    const range = { from: edge, to: edge + 8 * DAY };
    const before = await calendarPlan(s.deps, 'Test', range);
    const sit = before.slots.filter((x) => x.source === 'staged' && x.slot.pool === 'sitcoms' && x.slot.blocks.length >= 2);
    const slot = sit[0]!, later = sit[1]!;
    const id = slot.slot.blocks[1]!.programId;
    expect(before.rerunnable).toContain(id);
    const nextBefore = Number(later.slot.blocks[0]!.programId.slice(2));

    await stageRerun(s.deps, 'Test', { start: slot.slot.start, block: 2, pool: 'sitcoms', programId: id });
    const after = await calendarPlan(s.deps, 'Test', range);
    const now = after.slots.find((x) => x.slot.start === slot.slot.start)!;
    expect(now.slot.blocks[1]).toMatchObject({ pinned: true, programId: slot.slot.blocks[0]!.programId });
    expect(now.hand).toContain('1 pin');
    // The next new episode comes one earlier than before: the rerun took none.
    expect(Number(after.slots.find((x) => x.slot.start === later.slot.start)!.slot.blocks[0]!.programId.slice(2))).toBe(nextBefore - 1);

    await expect(stageRerun(s.deps, 'Test', { start: slot.slot.start, block: 1, pool: 'movies', programId: 'mov1' })).rejects.toThrow(/in order/);
    await expect(stageRerun(s.deps, 'Test', { start: slot.slot.start, block: 1, pool: 'sitcoms', programId: 'ep1' })).rejects.toThrow(/first episode/);
  });

  it('a rerun is refused when the page names a program the block does not play (the page is out of date), pinning nothing', async () => {
    const s = await staged();
    const edge = s.store.channel('Test')!.edge;
    const view = await calendarPlan(s.deps, 'Test', { from: edge, to: edge + 8 * DAY });
    const sit = view.slots.filter((x) => x.source === 'staged' && x.slot.pool === 'sitcoms' && x.slot.blocks.length >= 2);
    const slot = sit[0]!;
    const other = sit[1]!.slot.blocks[0]!.programId; // a later episode: block 2 of this slot does not play it
    await expect(stageRerun(s.deps, 'Test', { start: slot.slot.start, block: 2, pool: 'sitcoms', programId: other })).rejects.toThrow(/plays something else now/);
    const after = await calendarPlan(s.deps, 'Test', { from: edge, to: edge + 8 * DAY });
    expect(after.slots.find((x) => x.slot.start === slot.slot.start)!.slot.blocks.some((b) => b.pinned)).toBe(false);
  });

  it('a block rerun is offered only in a pool of one show: with turns between shows it would upset them', () => {
    const titles = { a1: 'TNG S1E1 "x"', b1: 'Lower Decks S1E1 "y"', a2: 'TNG S1E2 "x"', b2: 'Lower Decks S1E2 "y"', a3: 'TNG S1E3 "x"' };
    const mixed = { order: 'ordered' as const, programs: ['a1', 'b1', 'a2', 'b2', 'a3'] };
    expect(earlierEpisode(mixed, 'b2', titles)).toBeUndefined();
    expect(earlierEpisode(mixed, 'a3', titles)).toBeUndefined();
    const one = { order: 'ordered' as const, programs: ['a1', 'a2', 'a3'] };
    expect(earlierEpisode(one, 'a3', titles)).toBe('a2');
    expect(earlierEpisode(one, 'a1', titles)).toBeUndefined(); // the first
    expect(earlierEpisode({ order: 'shuffled', programs: ['a1', 'a2'] }, 'a2', titles)).toBeUndefined();
  });

  it('the calendar reads the library once, however many weeks are asked for, and again when the schedule changes', async () => {
    const s = await staged();
    // Its own schedule text, so nothing an earlier test read is reused.
    s.store.setSchedule('Test', s.store.channel('Test')!.schedule + '\n# calendar cache test\n', Date.now());
    const edge = s.store.channel('Test')!.edge;
    const shows = vi.spyOn(s.deps.client, 'shows');
    const week = (n: number) => ({ from: edge + n * 7 * DAY, to: edge + (n + 1) * 7 * DAY });
    // Made together (as the page does when scrolled) and then one after another.
    const [a, b] = await Promise.all([calendarPlan(s.deps, 'Test', week(0)), calendarPlan(s.deps, 'Test', week(1))]);
    const again = await calendarPlan(s.deps, 'Test', week(0));
    await calendarPlan(s.deps, 'Test', week(2));
    expect(shows.mock.calls.length).toBe(1);
    expect(again.slots.map((x) => [x.slot.start, x.source, x.slot.programs])).toEqual(a.slots.map((x) => [x.slot.start, x.source, x.slot.programs]));
    expect(b.slots.length).toBeGreaterThan(0);
    // A saved schedule is a different key: read again.
    const ch = s.store.channel('Test')!;
    s.store.setSchedule('Test', ch.schedule + '\n# changed\n', Date.now());
    await calendarPlan(s.deps, 'Test', week(0));
    expect(shows.mock.calls.length).toBe(2);
  });

  it('the committed lineup is cut into blocks, each with its own breaks', () => {
    const f = (id: string, type: string, duration: number) => ({ type: 'filler', id, fillerListId: id.startsWith('b') ? 'L-bump' : 'L-ads', fillerType: type, duration });
    const c = (id: string, offset: number, duration: number) => ({ type: 'content', id, startOffsetMs: offset, duration });
    const lineup = [
      f('b1', 'head', 20_000), f('a1', 'head', 60_000), c('m1', 0, 600_000), f('a2', 'mid', 30_000), c('m1', 600_000, 600_000), f('a3', 'post', 30_000),
      f('a4', 'pre', 10_000), c('m2', 0, 900_000), { type: 'flex', duration: 5_000 },
    ];
    const start = 1_000_000;
    const roleOf = (id: string, type: string) => (type === 'fallback' ? 'interstitial' as const : id === 'L-bump' ? 'bumper' as const : 'ad' as const);
    const all = blocksFromLineup(lineup, start, { from: 0, to: Number.MAX_SAFE_INTEGER }, roleOf, (id) => id);
    expect(all.map((b) => [b.programs, b.start, b.end])).toEqual([[['m1'], start, start + 1_340_000], [['m2'], start + 1_340_000, start + 1_340_000 + 10_000 + 900_000 + 5_000]]);
    expect(all[0]!.items.map((i) => i.kind === 'filler' ? `${i.position}:${i.role}` : i.kind)).toEqual(['head:bumper', 'head:ad', 'content', 'mid:ad', 'content', 'post:ad']);
    expect(all[0]!.totals).toMatchObject({ programMs: 1_200_000, adMs: 120_000, bumperMs: 20_000 });
    expect(all[1]!.items[0]).toMatchObject({ kind: 'filler', position: 'pre' }); // the pre break belongs to the program after it
    expect(all[1]!.totals.deadAirMs).toBe(5_000);
    // Neighbouring blocks of one pool are one run, like a slot.
    const runs = runsOf(all, new Map([['m1', 'sitcoms'], ['m2', 'sitcoms']]));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ pool: 'sitcoms', start, programs: ['m1', 'm2'] });
    expect(runs[0]!.blocks.map((b) => b.programId)).toEqual(['m1', 'm2']);
    expect(runs[0]!.totals.programMs).toBe(2_100_000);
    expect(runsOf(all, new Map([['m1', 'sitcoms']])).map((r) => r.pool)).toEqual(['sitcoms', null]);
    // Only blocks that overlap the range.
    expect(blocksFromLineup(lineup, start, { from: start + 1_400_000, to: start + 1_500_000 }, roleOf, (id) => id).map((b) => b.programs)).toEqual([['m2']]);
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


describe('previewing a cursor adjustment', () => {
  const edgeOf = (s: ReturnType<typeof setup>) => s.store.channel('Test')!.edge;

  it('shows the next airings of the show with the episode each plays now and after, and changes nothing', async () => {
    const s = setup();
    s.store.setState('Test', { ...s.store.channel('Test')!.state, sequences: { 'seq:a': { position: 10, history: 10 } } });
    const p = await cursorPreview(s.deps, 'Test', 'seq:a', { kind: 'rewind', by: 2 });
    expect(p).toMatchObject({ key: 'seq:a', before: { position: 10 }, after: { position: 8, history: 8 }, committedUntil: edgeOf(s) });
    expect(p.airings.length).toBeGreaterThan(0);
    const first = p.airings[0]!;
    expect(first.kind).toBe('continue');
    expect(first.before[0]).toBe('ep11');
    expect(first.after[0]).toBe('ep9');
    expect(p.next).toEqual({ before: 'ep11', after: 'ep9' });
    expect(first.staged).toBe(false);
    expect(p.titles['ep9']).toBe('Show A S1E9 "Ep 9"');
    expect(s.store.channel('Test')!.state.sequences['seq:a']).toEqual({ position: 10, history: 10 }); // the preview moved nothing
  });

  it('marks staged and locked airings, and a locked slot keeps its episodes', async () => {
    const s = setup();
    await stageGenerate(s.deps, 'Test', { to: edgeOf(s) + 4 * DAY });
    const id = s.store.channel('Test')!.id;
    const sit = s.store.stagedSlots(id).filter((r) => r.pool === 'sitcoms' && r.start > edgeOf(s) + 30 * MIN);
    s.store.setLocked('Test', sit[0]!.start, true);
    const p = await cursorPreview(s.deps, 'Test', 'seq:a', { kind: 'set', index: 100 }, { count: 4 });
    const lockedAiring = p.airings.find((a) => a.start === sit[0]!.start)!;
    expect(lockedAiring).toMatchObject({ staged: true, locked: true });
    expect(lockedAiring.after).toEqual(lockedAiring.before);
    const next = p.airings.find((a) => a.start === sit[1]!.start)!;
    expect(next).toMatchObject({ staged: true, locked: false });
    expect(next.after[0]).not.toBe(next.before[0]);
  });

  it('rejects an unknown sequence', async () => {
    await expect(cursorPreview(setup().deps, 'Test', 'seq:nope', { kind: 'rewind', by: 1 })).rejects.toThrow(/known: seq:a/);
  });
});


describe('a sample of ad settings', () => {
  const settingsOf = (s: ReturnType<typeof setup>) => adSettingsOf(parseScheduleFile(s.store.channel('Test')!.schedule));

  it('plans a real episode and a real movie with the settings, without saving anything', async () => {
    const s = setup();
    const before = JSON.stringify([s.store.channel('Test'), s.store.stagedSlots(s.store.channel('Test')!.id)]);
    const samples = await adSamples(s.deps, 'Test', settingsOf(s));
    expect(samples.map((x) => x.kind)).toEqual(['episode', 'movie']);
    for (const x of samples) {
      expect(x.segments.reduce((a, g) => a + g.ms, 0)).toBe(x.windowMs);
      expect(x.segments.filter((g) => g.type === 'content').reduce((a, g) => a + g.ms, 0)).toBe(x.programMs);
      expect(x.adMs).toBeGreaterThan(0);
      expect(x.adShare).toBeCloseTo(x.adMs / x.programMs, 6);
      expect(x.midBreaks).toBeGreaterThan(0);
    }
    expect(samples[0]!.title).toMatch(/Show A S1E1/);
    expect(JSON.stringify([s.store.channel('Test'), s.store.stagedSlots(s.store.channel('Test')!.id)])).toBe(before);
  });

  it('shows what a different setting does: no mid breaks means none, and a bumper appears where it is asked', async () => {
    const s = setup();
    const base = settingsOf(s);
    const noMid = await adSamples(s.deps, 'Test', { ...base, mid: undefined } as typeof base);
    expect(noMid[0]!.midBreaks).toBe(0);
    const withBumper = await adSamples(s.deps, 'Test', { ...base, bumpers: { pre: 'Fillers' } });
    expect(withBumper[0]!.segments.some((g) => g.type === 'bumper' && g.position === 'pre' && g.list === 'Fillers')).toBe(true);
    await expect(adSamples(s.deps, 'Test', { ...base, interstitial: 'No such list' })).rejects.toThrow(/no filler list named/);
  });
});


describe('what a pool holds', () => {
  it('counts the programs and lists their lengths, for pools that are not saved yet, and says what is wrong with one that cannot be read', async () => {
    const s = setup();
    const stats = await poolStats(s.deps.client, {
      sitcoms: { shows: [{ show: 'Show A' }] },
      comedies: { movies: { genre: 'Comedy', duration: { op: '<=', ms: 95 * MIN } } },
      ghost: { shows: [{ show: 'Nope' }] },
      none: { movies: { genre: 'Western' } },
    });
    expect(stats['sitcoms']!.count).toBe(400);
    expect(stats['sitcoms']!.durations[0]).toBe(22 * MIN + 1000);
    expect(stats['comedies']!.durations.every((d) => d <= 95 * MIN)).toBe(true);
    expect(stats['comedies']!.durations).toEqual([...stats['comedies']!.durations].sort((a, b) => a - b));
    expect(stats['ghost']).toMatchObject({ count: 0, error: expect.stringContaining('no show named "Nope"') });
    expect(stats['none']).toMatchObject({ count: 0, durations: [] });
  });
});


describe('pool changes', () => {
  const schedule = { pools: { movies: { order: 'shuffled', programs: ['a', 'b', 'c', 'd'] }, shows: { order: 'ordered', programs: ['x'] } } } as unknown as Schedule;
  const titles = { a: 'A', b: 'B', c: 'C', d: 'D', x: 'X' };
  it('says nothing the first time, and when nothing changed', () => {
    expect(poolChanges(undefined, schedule, titles, 0)).toEqual([]);
    expect(poolChanges({ movies: ['a', 'b', 'c', 'd'], shows: ['x'] }, schedule, titles, 0)).toEqual([]);
  });
  it('names what joined and what left, and warns when a pool more than doubles', () => {
    const w = poolChanges({ movies: ['a', 'b', 'z'], shows: ['x'] }, schedule, titles, 5);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ code: 'pool-changed', severity: 'info', slotId: 'movies', at: 5 });
    expect(w[0]!.message).toContain('2 joined (C; D)');
    expect(w[0]!.message).toContain('1 left (z)');
    expect(poolChanges({ movies: ['a'], shows: ['x'] }, schedule, titles, 0)[0]).toMatchObject({ severity: 'warning' });
  });
});

describe('creating a channel', () => {
  const opts = { name: 'Late Night', number: 9, hidden: true, timezone: 'America/Toronto', adList: 'Ads', fillerList: 'Fillers', floorMs: 7 * DAY, stepMs: DAY, seed: 1 };

  it('writes the channel file with an empty week, and the lists named', () => {
    const f = parseScheduleFile(newChannelFile(opts));
    expect(f).toMatchObject({ channel: 'Late Night', timezone: 'America/Toronto', grid: 15 * MIN, interstitial: { list: 'Fillers' }, week: {} });
    expect(f.ads.mid?.list).toBe('Ads');
    expect(Object.keys(f.pools)).toEqual([]);
    expect(parseScheduleFile(newChannelFile({ name: 'Plain "quoted"', timezone: 'UTC' })).channel).toBe('Plain "quoted"');
  });

  it('takes the grid chosen, and refuses one that is not offered', async () => {
    expect(parseScheduleFile(newChannelFile({ ...opts, gridMinutes: 30 })).grid).toBe(30 * MIN);
    expect(() => newChannelFile({ ...opts, gridMinutes: 7 })).toThrow(/grid must be one of/);
    const s = setup();
    s.clock.t = NOW0 + 7 * MIN;
    await createChannel(s.deps, { ...opts, gridMinutes: 30 });
    expect(s.fake.created[0]!['startTime']).toBe(Math.floor(s.clock.t / (30 * MIN)) * 30 * MIN);
    expect(parseScheduleFile(s.store.channel('Late Night')!.schedule).grid).toBe(30 * MIN);
  });

  it('creates a hidden channel in Tunarr starting now on the grid, and adds it to the store', async () => {
    const s = setup();
    s.clock.t = NOW0 + 7 * MIN;
    const r = await createChannel(s.deps, opts);
    const made = s.fake.created[0]!;
    expect(made).toMatchObject({ name: 'Late Night', number: 9, stealth: true, duration: 0, transcodeConfigId: 'tc-default' });
    expect(made['startTime']).toBe(Math.floor(s.clock.t / (15 * MIN)) * 15 * MIN);
    expect(r).toMatchObject({ name: 'Late Night', edge: made['startTime'] });
    expect(s.store.channel('Late Night')).toMatchObject({ tunarrId: made['id'] });
  });

  it('refuses a number or name in use, an empty name, and a list Tunarr does not have, creating nothing', async () => {
    const s = setup();
    await expect(createChannel(s.deps, { ...opts, number: 1 })).rejects.toThrow(/choose another number/);
    await expect(createChannel(s.deps, { ...opts, name: 'test' })).rejects.toThrow(/choose another name/);
    await expect(createChannel(s.deps, { ...opts, name: '  ' })).rejects.toThrow(/give the channel a name/);
    await expect(createChannel(s.deps, { ...opts, adList: 'No such list' })).rejects.toThrow(/No such list/);
    expect(s.fake.created).toEqual([]);
  });

  it('takes over a channel an earlier try left in Tunarr (it failed after the create), instead of refusing the retry or making a second', async () => {
    const s = setup();
    const lineup = vi.spyOn(s.deps.client, 'lineup').mockRejectedValueOnce(new Error('Tunarr dropped the connection'));
    await expect(createChannel(s.deps, opts)).rejects.toThrow(/dropped the connection/);
    expect(s.fake.created).toHaveLength(1); // made in Tunarr
    expect(s.store.channel('Late Night')).toBeUndefined(); // but not taken over
    lineup.mockRestore();
    const r = await createChannel(s.deps, opts); // the same form sent again
    expect(s.fake.created).toHaveLength(1); // no second channel
    expect(r.name).toBe('Late Night');
    expect(s.store.channel('Late Night')).toMatchObject({ tunarrId: s.fake.created[0]!['id'] });
    // but a channel of that number and name that DayTuner already manages is still refused
    await expect(createChannel(s.deps, opts)).rejects.toThrow(/already manages/);
  });

  it('does not take over a channel that has a lineup, or one that only shares the number', async () => {
    const s = setup();
    s.fake.created.push({ id: 'used', number: 9, name: 'Late Night', startTime: NOW0 - DAY });
    s.fake.createdLineups.set('used', [{ type: 'flex', duration: 3600_000 }]);
    await expect(createChannel(s.deps, opts)).rejects.toThrow(/Tunarr already has a channel 9/);
    const t = setup();
    t.fake.created.push({ id: 'other', number: 9, name: 'Something Else', startTime: NOW0 - DAY, duration: 0 });
    await expect(createChannel(t.deps, opts)).rejects.toThrow(/choose another/);
  });

  it('refuses to manage one Tunarr channel under two names', async () => {
    const s = setup();
    await createChannel(s.deps, opts);
    const file = newChannelFile({ ...opts, name: 'Second Name' });
    await expect(addChannel(s.deps, { yaml: file, tunarrChannel: String(s.fake.created[0]!['id']), floorMs: 7 * DAY, stepMs: DAY, seed: 1 })).rejects.toThrow(/already managed here as "Late Night"/);
    expect(s.store.channel('Second Name')).toBeUndefined();
  });

  it('plans nothing for a channel with no slots, and writes nothing', async () => {
    const s = setup();
    await createChannel(s.deps, opts);
    const r = await topUp(s.deps, 'Late Night');
    expect(r.action).toBe('none');
    expect(s.fake.requests.filter((x) => x.includes('programming') && x.startsWith('POST'))).toEqual([]);
  });

  it('first plan of a channel that has sat empty for days: a flex bridges to the grid line before now, and nothing is planned in the past', async () => {
    const s = setup();
    await createChannel(s.deps, opts);
    const startTime = s.fake.created[0]!['startTime'] as number;
    s.clock.t = startTime + 3 * DAY + 7 * MIN; // nobody designed a schedule for three days
    expect((await topUp(s.deps, 'Late Night')).action).toBe('none'); // still no slots: nothing written, nothing refused
    s.store.setSchedule('Late Night', YAML.replace(/^channel: .*$/m, 'channel: Late Night'), s.clock.t);
    const r = await topUp(s.deps, 'Late Night');
    expect(r.action).toBe('appended');
    const nowLine = Math.floor(s.clock.t / (15 * MIN)) * 15 * MIN;
    expect(r.planned![0]!.start).toBe(nowLine);
    expect(s.fake.createdLineup[0]).toMatchObject({ type: 'flex', duration: nowLine - startTime });
    expect(s.store.channel('Late Night')!.edge).toBeGreaterThan(s.clock.t + 7 * DAY);
  });

  it('everything that plans ahead starts where the next run will, for a channel that sat empty (not at its old start time)', async () => {
    const s = setup();
    await createChannel(s.deps, opts);
    const startTime = s.fake.created[0]!['startTime'] as number;
    s.clock.t = startTime + 3 * DAY + 7 * MIN;
    s.store.setSchedule('Late Night', YAML.replace(/^channel: .*$/m, 'channel: Late Night'), s.clock.t);
    const nowLine = Math.floor(s.clock.t / (15 * MIN)) * 15 * MIN;
    const cal = await calendarPlan(s.deps, 'Late Night', { from: nowLine, to: nowLine + 2 * DAY });
    expect(cal.committedUntil).toBe(nowLine); // not three days earlier, where the channel was created
    expect(cal.slots[0]!.slot.start).toBeGreaterThanOrEqual(nowLine);
    const staged = await stageGenerate(s.deps, 'Late Night', { to: nowLine + DAY });
    expect(staged.planned).toBeGreaterThan(0);
    expect(Math.min(...s.store.stagedSlots(s.store.channel('Late Night')!.id).map((r) => r.start))).toBeGreaterThanOrEqual(nowLine);
    // and the run then writes what the calendar showed
    const r = await topUp(s.deps, 'Late Night');
    expect(r.planned![0]!.start).toBe(cal.slots[0]!.slot.start);
  });
});

describe('the grid and the time zone', () => {
  const NOW = Date.UTC(2026, 10, 20, 12);
  it('lets a grid through only when it divides the zone offset from UTC, in winter and in summer', () => {
    expect(gridsFor('America/Toronto', NOW)).toEqual([5, 10, 15, 20, 30, 60]);
    expect(gridsFor('UTC', NOW)).toEqual([5, 10, 15, 20, 30, 60]);
    expect(gridsFor('Asia/Kolkata', NOW)).toEqual([5, 10, 15, 30]); // +5:30
    expect(gridsFor('America/St_Johns', NOW)).toEqual([5, 10, 15, 30]); // -3:30 and -2:30
    expect(gridFitsZone('Asia/Kathmandu', 30 * MIN, NOW)).toBe(false); // +5:45
    expect(gridFitsZone('Asia/Kathmandu', 15 * MIN, NOW)).toBe(true);
  });
  it('refuses to create a channel on a grid its zone cannot lie on, and says which grids would do', async () => {
    const s = setup();
    const o = { name: 'Delhi', number: 12, hidden: true, timezone: 'Asia/Kolkata', gridMinutes: 60, floorMs: 7 * DAY, stepMs: DAY, seed: 1 };
    await expect(createChannel(s.deps, o)).rejects.toThrow(/does not fit the time zone Asia\/Kolkata.*5, 10, 15, 30/);
    expect(s.fake.created).toEqual([]);
    await createChannel(s.deps, { ...o, gridMinutes: 30 });
    expect(s.fake.created).toHaveLength(1);
  });
  it('refuses a run for a channel file whose grid its zone cannot lie on, with the reason, before writing anything', async () => {
    const s = setup();
    s.store.setSchedule('Test', YAML.replace(/^timezone: .*$/m, 'timezone: Asia/Kolkata').replace(/^grid: .*$/m, 'grid: 60m'), s.clock.t);
    await expect(topUp(s.deps, 'Test')).rejects.toThrow(/60-minute grid does not fit the time zone Asia\/Kolkata/);
    expect(s.fake.requests.filter((x) => x.includes('programming') && x.startsWith('POST'))).toEqual([]);
  });
  it('starts an empty channel at the grid line before now, and a written one at the line after its end', () => {
    const grid = 15 * MIN;
    expect(originOf(1000, true, grid, 10 * DAY + 7 * MIN)).toEqual({ from: 10 * DAY, flex: 10 * DAY - 1000 });
    expect(originOf(1000, false, grid, 10 * DAY + 7 * MIN)).toEqual({ from: grid, flex: grid - 1000 });
    expect(originOf(10 * DAY + 3 * MIN, true, grid, 10 * DAY + 7 * MIN)).toEqual({ from: 10 * DAY + grid, flex: grid - 3 * MIN });
  });
});

describe('checking and saving a schedule', () => {
  it('reads the library once for a check and the save of the same text that follows it (the page does both)', async () => {
    const s = setup();
    const yaml = `${YAML}\n# edit ${Math.random()}\n`; // a text no earlier test has resolved
    const count = () => s.fake.requests.length;
    const a0 = count();
    await revisionImpact(s.deps, 'Test', yaml); // the check
    const first = count() - a0;
    expect(first).toBeGreaterThan(0);
    const b0 = count();
    await revisionImpact(s.deps, 'Test', yaml); // what the save runs
    expect(count() - b0).toBe(0);
    s.clock.t += 31 * MIN; // after half an hour the library is read again
    const c0 = count();
    await revisionImpact(s.deps, 'Test', yaml);
    expect(count() - c0).toBeGreaterThan(0);
  });
});

describe('the calendar', () => {
  it('plans again when the library changes, not only when the schedule or the state does', async () => {
    const s = setup();
    const range = { from: NOW0, to: NOW0 + 10 * DAY };
    await calendarPlan(s.deps, 'Test', range); // warms the plan
    for (let i = 0; i < 4; i++) s.fake.data.movies.push({ id: `mov-new${i}`, title: `New ${i}`, duration: (70 + i) * MIN, genres: ['Comedy'] });
    s.clock.t += 31 * MIN; // the library is read again after half an hour
    const after = await calendarPlan(s.deps, 'Test', range);
    const dry = await topUp(s.deps, 'Test', { dryRun: true }); // always plans fresh
    const pick = (slots: { slot?: { pool: string; programs: string[] }; pool?: string; programs?: string[] }[]) =>
      slots.map((x) => x.slot ?? (x as { pool: string; programs: string[] })).filter((x) => x.pool === 'movies').slice(0, 4).map((x) => x.programs);
    expect(pick(after.slots)).toEqual(pick(dry.planned!));
  });
});
