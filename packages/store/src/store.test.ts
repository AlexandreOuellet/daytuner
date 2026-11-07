import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PlanState } from '@daytuner/engine';
import { Store, StoreError, type NewChannel } from './store.js';

const state = (rng: number, position = 0): PlanState => ({ rng, sequences: { 'seq:office': { position, history: position } }, bags: { 'clips:Ads': { remaining: ['a', 'b'] } } });
const channel = (over: Partial<NewChannel> = {}): NewChannel => ({
  name: 'funny', tunarrId: 'tun-1', floorMs: 7 * 86_400_000, stepMs: 86_400_000, schedule: 'channel: funny\n', state: state(1), edge: 1_793_948_880_000.478, ...over,
});
const commit = (channelId: number, over: Record<string, unknown> = {}) => ({
  channelId, fromEdge: 1000, toEdge: 5000, state: state(2, 4), items: 12, totalMs: 4000,
  slots: [{ slotId: '1@72000000', start: 1000, end: 5000, programs: ['p1'] }], at: 111, ...over,
});

describe('channels', () => {
  let store: Store;
  beforeEach(() => { store = Store.open(':memory:'); });
  afterEach(() => store.close());

  it('stores a channel with its state and an exact fractional edge', () => {
    const c = store.addChannel(channel());
    expect(c).toMatchObject({ name: 'funny', tunarrId: 'tun-1', edge: 1_793_948_880_000.478 });
    expect(c.state).toEqual(state(1));
    expect(store.channel('funny')).toEqual(c);
    expect(store.channels().map((x) => x.name)).toEqual(['funny']);
  });

  it('refuses a second channel with the same name, and bad settings', () => {
    store.addChannel(channel());
    expect(() => store.addChannel(channel())).toThrow(/already exists/);
    expect(() => store.addChannel(channel({ name: 'x', floorMs: 0 }))).toThrow(StoreError);
  });

  it('replaces the schedule and the state by hand', () => {
    store.addChannel(channel());
    store.setSchedule('funny', 'channel: funny\ngrid: 15m\n', 5);
    store.setState('funny', state(9, 3));
    expect(store.channel('funny')!.schedule).toContain('grid');
    expect(store.channel('funny')!.state).toEqual(state(9, 3));
    expect(() => store.setSchedule('ghost', 'x', 1)).toThrow(/no channel/);
  });
});

describe('commits', () => {
  let store: Store;
  let id: number;
  beforeEach(() => { store = Store.open(':memory:'); id = store.addChannel(channel()).id; });
  afterEach(() => store.close());

  it('keeps the channel unchanged while a commit is pending', () => {
    const c = store.beginCommit(commit(id));
    expect(c.status).toBe('pending');
    expect(store.pendingCommit(id)?.id).toBe(c.id);
    expect(store.channel('funny')!.state).toEqual(state(1));
    expect(store.channel('funny')!.edge).toBe(1_793_948_880_000.478);
  });

  it('moves the state and the edge together when a commit is completed', () => {
    const c = store.beginCommit(commit(id));
    store.completeCommit(c.id, 5000.25, 222);
    const ch = store.channel('funny')!;
    expect(ch.state).toEqual(state(2, 4));
    expect(ch.edge).toBe(5000.25);
    expect(store.pendingCommit(id)).toBeUndefined();
    expect(store.commits(id)[0]).toMatchObject({ status: 'done', finishedAt: 222, items: 12, totalMs: 4000 });
  });

  it('leaves the channel as it was when a commit is abandoned', () => {
    const c = store.beginCommit(commit(id));
    store.abandonCommit(c.id, 333);
    expect(store.channel('funny')!.state).toEqual(state(1));
    expect(store.commits(id)[0]).toMatchObject({ status: 'abandoned' });
    expect(store.pendingCommit(id)).toBeUndefined();
  });

  it('allows only one pending commit per channel', () => {
    store.beginCommit(commit(id));
    expect(() => store.beginCommit(commit(id))).toThrow(/pending commit/);
  });

  it('refuses to finish a commit twice or one that is not pending', () => {
    const c = store.beginCommit(commit(id));
    store.completeCommit(c.id, 5000, 1);
    expect(() => store.completeCommit(c.id, 5000, 2)).toThrow(/not pending/);
    expect(() => store.abandonCommit(c.id, 3)).toThrow(/not pending/);
    expect(() => store.completeCommit(999, 1, 1)).toThrow(/no commit/);
  });

  it('lists the log newest first, with the slots recorded', () => {
    const a = store.beginCommit(commit(id));
    store.completeCommit(a.id, 5000, 1);
    const b = store.beginCommit(commit(id, { fromEdge: 5000, toEdge: 9000 }));
    store.completeCommit(b.id, 9000, 2);
    const log = store.commits(id);
    expect(log.map((c) => c.toEdge)).toEqual([9000, 5000]);
    expect(log[0]!.slots[0]).toEqual({ slotId: '1@72000000', start: 1000, end: 5000, programs: ['p1'] });
  });
});

describe('a file on disk', () => {
  it('keeps everything after closing and reopening', () => {
    const dir = mkdtempSync(join(tmpdir(), 'daytuner-store-'));
    try {
      const path = join(dir, 'daytuner.db');
      const first = Store.open(path);
      const ch = first.addChannel(channel());
      const c = first.beginCommit(commit(ch.id));
      first.close();

      const second = Store.open(path);
      expect(second.channel('funny')!.edge).toBe(1_793_948_880_000.478);
      expect(second.pendingCommit(ch.id)?.id).toBe(c.id); // a crash between begin and complete is visible
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('setEdge', () => {
  it('moves only the edge', () => {
    const store = Store.open(':memory:');
    store.addChannel(channel());
    store.setEdge('funny', 42.5);
    expect(store.channel('funny')!.edge).toBe(42.5);
    expect(store.channel('funny')!.state).toEqual(state(1));
    expect(() => store.setEdge('ghost', 1)).toThrow(/no channel/);
    store.close();
  });
});

describe('cursor adjustments', () => {
  it('changes one sequence and logs it, and is refused while a commit is pending', () => {
    const store = Store.open(':memory:');
    const ch = store.addChannel(channel({ state: state(1, 6) }));
    store.applyAdjustment('funny', { at: 5, sequenceKey: 'seq:office', kind: 'rewind', amount: 2, positionBefore: 6, next: { position: 4, history: 4 } });
    expect(store.channel('funny')!.state.sequences['seq:office']).toEqual({ position: 4, history: 4 });
    expect(store.channel('funny')!.state.bags).toEqual(state(1).bags); // nothing else moved
    expect(store.adjustments(ch.id)[0]).toMatchObject({ kind: 'rewind', amount: 2, positionBefore: 6, positionAfter: 4 });

    store.beginCommit(commit(ch.id));
    expect(() => store.applyAdjustment('funny', { at: 6, sequenceKey: 'seq:office', kind: 'set', amount: 0, positionBefore: 4, next: { position: 0, history: 0 } })).toThrow(/pending commit/);
    expect(store.channel('funny')!.state.sequences['seq:office']).toEqual({ position: 4, history: 4 });
    expect(() => store.applyAdjustment('ghost', { at: 1, sequenceKey: 'x', kind: 'set', amount: 0, positionBefore: 0, next: { position: 0, history: 0 } })).toThrow(/no channel/);
    store.close();
  });
});

describe('commit notes', () => {
  const state: PlanState = { rng: 1, sequences: {}, bags: {} } as unknown as PlanState;

  it('keeps a note on a commit', () => {
    const s = Store.open(':memory:');
    const ch = s.addChannel({ name: 'A', tunarrId: 't', floorMs: 1, stepMs: 1, schedule: '', state, edge: 0 });
    const c = s.beginCommit({ channelId: ch.id, fromEdge: 0, toEdge: 10, state, items: 1, totalMs: 10, slots: [], at: 1 });
    expect(c.note).toBeNull();
    s.noteCommit(c.id, 'why');
    expect(s.pendingCommit(ch.id)!.note).toBe('why');
    expect(() => s.noteCommit(999, 'x')).toThrow(/no commit/);
  });

  it('upgrades a database made before commits had notes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'daytuner-'));
    try {
      const path = join(dir, 'old.db');
      const old = new DatabaseSync(path);
      old.exec(`create table commits (id integer primary key autoincrement, channel_id integer not null, status text not null,
        from_edge real not null, to_edge real not null, state text not null, items integer not null, total_ms integer not null,
        slots text not null, started_at integer not null, finished_at integer);`);
      old.close();
      const s = Store.open(path);
      s.close();
      const check = new DatabaseSync(path);
      expect((check.prepare('pragma table_info(commits)').all() as { name: string }[]).some((c) => c.name === 'note')).toBe(true);
      check.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('schedule revisions', () => {
  let store: Store;
  beforeEach(() => { store = Store.open(':memory:'); });
  afterEach(() => store.close());

  it('starts at revision 1 and numbers each save', () => {
    const c = store.addChannel(channel({ at: 10 }));
    expect(c.revision).toBe(1);
    expect(store.setSchedule('funny', 'v2\n', 20)).toBe(2);
    expect(store.setSchedule('funny', 'v3\n', 30)).toBe(3);
    expect(store.channel('funny')).toMatchObject({ revision: 3, schedule: 'v3\n' });
    expect(store.revisions(c.id).map((r) => [r.number, r.savedAt, r.yaml])).toEqual([
      [1, 10, 'channel: funny\n'], [2, 20, 'v2\n'], [3, 30, 'v3\n'],
    ]);
  });

  it('does not make a revision when the text is unchanged', () => {
    const c = store.addChannel(channel());
    expect(store.setSchedule('funny', 'channel: funny\n', 5)).toBe(1);
    expect(store.revisions(c.id)).toHaveLength(1);
  });

  it('goes back to an earlier revision, keeps the history, and numbers the next save after the last', () => {
    const c = store.addChannel(channel());
    store.setSchedule('funny', 'v2\n', 2);
    store.setSchedule('funny', 'v3\n', 3);
    store.useRevision('funny', 1);
    expect(store.channel('funny')).toMatchObject({ revision: 1, schedule: 'channel: funny\n' });
    expect(store.revisions(c.id)).toHaveLength(3);
    expect(store.setSchedule('funny', 'v4\n', 4)).toBe(4);
    expect(() => store.useRevision('funny', 9)).toThrow(/no revision 9/);
    expect(() => store.useRevision('ghost', 1)).toThrow(/no channel/);
  });

  it('gives a database made before revisions its schedule as revision 1', () => {
    const dir = mkdtempSync(join(tmpdir(), 'daytuner-'));
    try {
      const path = join(dir, 'old.db');
      const old = new DatabaseSync(path);
      old.exec(`create table channels (id integer primary key autoincrement, name text not null unique, tunarr_id text not null,
        floor_ms integer not null, step_ms integer not null, schedule text not null, state text not null, edge real not null);`);
      old.prepare("insert into channels (name, tunarr_id, floor_ms, step_ms, schedule, state, edge) values ('old', 't', 1, 1, 'yaml\n', '{}', 0)").run();
      old.close();
      const s = Store.open(path);
      const c = s.channel('old')!;
      expect(c.revision).toBe(1);
      expect(s.revisions(c.id).map((r) => [r.number, r.yaml])).toEqual([[1, 'yaml\n']]);
      s.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('staged slots', () => {
  let store: Store;
  let id: number;
  beforeEach(() => {
    store = Store.open(':memory:');
    id = store.addChannel(channel({ edge: 1000 })).id;
  });
  afterEach(() => store.close());
  const slot = (start: number, end: number) => ({
    slotId: '1@72000000', start, end, pool: 'movies', programs: ['m1'], blocks: [], exception: false, items: [],
  });

  it('stores slots and returns them in order, inside a range', () => {
    store.replaceStaged('funny', 1000, 9000, [slot(5000, 6000), slot(2000, 3000)], 7);
    expect(store.stagedSlots(id).map((s) => [s.start, s.end, s.locked, s.pins])).toEqual([[2000, 3000, false, {}], [5000, 6000, false, {}]]);
    expect(store.stagedSlots(id, 4000, 9000)).toHaveLength(1);
    expect(store.stagedSlots(id)[0]!.planned.programs).toEqual(['m1']);
  });

  it('replaces what was staged in the range and leaves the rest', () => {
    store.replaceStaged('funny', 1000, 9000, [slot(2000, 3000), slot(5000, 6000)], 1);
    store.replaceStaged('funny', 4000, 9000, [slot(5000, 7000)], 2);
    expect(store.stagedSlots(id).map((s) => [s.start, s.end])).toEqual([[2000, 3000], [5000, 7000]]);
  });

  it('refuses a slot before the committed edge', () => {
    expect(() => store.replaceStaged('funny', 0, 9000, [slot(500, 900)], 1)).toThrow(/at or after the end/);
    expect(store.stagedSlots(id)).toHaveLength(0);
  });

  it('locks and unlocks a slot; replacing a range leaves a locked slot as it is', () => {
    store.replaceStaged('funny', 1000, 9000, [slot(2000, 3000), slot(5000, 6000)], 1);
    store.setLocked('funny', 2000, true);
    expect(store.stagedSlots(id).map((s) => s.locked)).toEqual([true, false]);
    store.replaceStaged('funny', 1000, 9000, [{ ...slot(2000, 3500), programs: ['changed'] }, slot(5000, 7000)], 2);
    const after = store.stagedSlots(id);
    expect(after.map((s) => [s.start, s.end, s.locked, s.planned.programs[0]])).toEqual([[2000, 3000, true, 'm1'], [5000, 7000, false, 'm1']]);
    store.setLocked('funny', 2000, false);
    store.replaceStaged('funny', 1000, 9000, [], 3);
    expect(store.stagedSlots(id)).toHaveLength(0);
    expect(() => store.setLocked('funny', 4242, true)).toThrow(/no slot is staged/);
  });

  it('keeps pins on a slot that is planned again, and refuses to pin a locked slot', () => {
    store.replaceStaged('funny', 1000, 9000, [slot(2000, 3000)], 1);
    store.setPin('funny', 2000, 2, { id: 'p9', title: 'Special', duration: 5000 });
    store.replaceStaged('funny', 1000, 9000, [{ ...slot(2000, 3000), programs: ['again'] }], 2);
    expect(store.stagedSlots(id)[0]).toMatchObject({ pins: { 2: { id: 'p9', title: 'Special', duration: 5000 } } });
    expect(store.stagedSlots(id)[0]!.planned.programs).toEqual(['again']);
    store.removePin('funny', 2000, 2);
    expect(store.stagedSlots(id)[0]!.pins).toEqual({});
    store.setLocked('funny', 2000, true);
    expect(() => store.setPin('funny', 2000, 1, { id: 'x', title: 'x', duration: 1 })).toThrow(/locked/);
    expect(() => store.setPin('funny', 4242, 1, { id: 'x', title: 'x', duration: 1 })).toThrow(/no slot is staged/);
  });

  it('restructures rows in one step, keeps the edited flag through planning again, and refuses one before the edge', () => {
    store.replaceStaged('funny', 1000, 9000, [slot(2000, 3000), slot(3000, 4000)], 1);
    const [a, b] = store.stagedSlots(id);
    store.restructure('funny', [3000], [{ ...a!, end: 4000, edited: true, planned: a!.planned }], 2);
    expect(store.stagedSlots(id).map((s) => [s.start, s.end, s.edited])).toEqual([[2000, 4000, true]]);
    store.replaceStaged('funny', 1000, 9000, [slot(2000, 4000)], 3);
    expect(store.stagedSlots(id)[0]!.edited).toBe(true);
    expect(() => store.restructure('funny', [], [{ ...b!, start: 500 }], 4)).toThrow(/at or after the end/);
    store.restructure('funny', [], [{ ...b!, start: 5000, end: 6000, slotId: 'added@5000', pool: null }], 5);
    expect(store.stagedSlots(id).find((s) => s.start === 5000)).toMatchObject({ slotId: 'added@5000', pool: null });
  });

  it('drops the staged slots a completed commit has put in Tunarr', () => {
    store.replaceStaged('funny', 1000, 9000, [slot(2000, 3000), slot(5000, 6000)], 1);
    const c = store.beginCommit({ channelId: id, fromEdge: 1000, toEdge: 4000, state: state(2), items: 1, totalMs: 3000, slots: [], at: 1 });
    store.completeCommit(c.id, 4000, 2);
    expect(store.stagedSlots(id).map((s) => s.start)).toEqual([5000]);
  });

  it('clears a range, or everything, and says how many', () => {
    store.replaceStaged('funny', 1000, 9000, [slot(2000, 3000), slot(5000, 6000)], 1);
    expect(store.clearStaged('funny', 4000, 9000)).toBe(1);
    expect(store.clearStaged('funny')).toBe(1);
    expect(() => store.clearStaged('ghost')).toThrow(/no channel/);
  });
});

describe('the chapter cache', () => {
  const ch = [{ start: 0, end: 1000, type: 'chapter' as const }];
  it('returns what was cached while the length is the same and the entry is fresh', () => {
    const s = Store.open(':memory:');
    s.cacheChapters('p1', 5000, ch, 100);
    expect(s.cachedChapters('p1', 5000, 0)).toEqual(ch);
    expect(s.cachedChapters('p1', 5001, 0)).toBeUndefined(); // the program changed length
    expect(s.cachedChapters('p1', 5000, 101)).toBeUndefined(); // too old
    expect(s.cachedChapters('p2', 5000, 0)).toBeUndefined();
  });
  it('remembers that a program has no chapters, replaces an entry, and can be cleared', () => {
    const s = Store.open(':memory:');
    s.cacheChapters('p1', 5000, [], 1);
    expect(s.cachedChapters('p1', 5000, 0)).toEqual([]);
    s.cacheChapters('p1', 5000, ch, 2);
    expect(s.cachedChapters('p1', 5000, 0)).toEqual(ch);
    expect(s.clearChapterCache()).toBe(1);
    expect(s.cachedChapters('p1', 5000, 0)).toBeUndefined();
  });
});
