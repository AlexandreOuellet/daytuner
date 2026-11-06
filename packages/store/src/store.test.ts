import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    store.setSchedule('funny', 'channel: funny\ngrid: 15m\n');
    store.setState('funny', state(9, 3));
    expect(store.channel('funny')!.schedule).toContain('grid');
    expect(store.channel('funny')!.state).toEqual(state(9, 3));
    expect(() => store.setSchedule('ghost', 'x')).toThrow(/no channel/);
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
