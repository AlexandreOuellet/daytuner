import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { emptyPlanState, type PlannedSlot } from '@daytuner/engine';
import { Store } from '@daytuner/store';
import { TunarrClient } from '@daytuner/tunarr-client';
import { createApp } from './app.js';

const EXAMPLE = readFileSync(new URL('../../../schedules/example.yaml', import.meta.url), 'utf8');
const NOW = Date.UTC(2026, 10, 7, 12);
const DAY = 86_400_000;

const slot = (start: number, end: number): PlannedSlot => ({
  slotId: '1@72000000', start, end, pool: 'movies', programs: ['m1'], blocks: [{ programId: 'm1', start, end }], exception: false,
  items: [{ kind: 'content', programId: 'm1', startOffset: 0, duration: end - start }],
});

describe('the API', () => {
  let store: Store;
  let get: (path: string) => Promise<{ status: number; body: any }>;

  beforeEach(() => {
    store = Store.open(':memory:');
    store.addChannel({
      name: 'funny', tunarrId: 'tun-1', floorMs: 7 * DAY, stepMs: DAY, schedule: EXAMPLE, state: emptyPlanState(1), edge: NOW + 8 * DAY, at: 5,
    });
    const app = createApp({ store, clock: { now: () => NOW }, client: new TunarrClient('http://tunarr.test', () => { throw new Error('no Tunarr in this test'); }) });
    get = async (path) => {
      const r = await app.request(path);
      return { status: r.status, body: await r.json() };
    };
  });

  it('says it is healthy, its version, and that it cannot write', async () => {
    expect(await get('/api/health')).toMatchObject({ status: 200, body: { ok: true, writes: false } });
  });

  it('lists channels with how far ahead they are and whether anything is pending or staged', async () => {
    const { body } = await get('/api/channels');
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ name: 'funny', tunarrId: 'tun-1', timezone: 'America/Toronto', revision: 1, aheadMs: 8 * DAY, pendingCommit: false, staged: 0 });
    const ch = store.channel('funny')!;
    store.beginCommit({ channelId: ch.id, fromEdge: ch.edge, toEdge: ch.edge + 1000, state: emptyPlanState(1), items: 1, totalMs: 1000, slots: [], at: 1 });
    expect((await get('/api/channels')).body[0].pendingCommit).toBe(true);
  });

  it('gives one channel with its latest commits (without the state blobs)', async () => {
    const ch = store.channel('funny')!;
    const c = store.beginCommit({ channelId: ch.id, fromEdge: ch.edge, toEdge: ch.edge + 1000, state: emptyPlanState(1), items: 1, totalMs: 1000, slots: [], at: 1 });
    store.completeCommit(c.id, ch.edge + 1000, 2);
    const { status, body } = await get('/api/channels/funny');
    expect(status).toBe(200);
    expect(body.commits).toHaveLength(1);
    expect(body.commits[0]).toMatchObject({ status: 'done', items: 1 });
    expect(body.commits[0].state).toBeUndefined();
  });

  it('answers 404 with a message for an unknown channel, revision or job', async () => {
    expect(await get('/api/channels/ghost')).toMatchObject({ status: 404, body: { error: 'no channel named "ghost"' } });
    expect((await get('/api/channels/funny/revisions/9')).status).toBe(404);
    expect((await get('/api/jobs/job-1')).status).toBe(404);
    expect((await get('/api/nothing')).status).toBe(404);
  });

  it('serves the schedule, its revisions and the diff between them', async () => {
    store.setSchedule('funny', EXAMPLE.replace('min: 15%', 'min: 20%'), 50);
    expect((await get('/api/channels/funny/schedule')).body).toMatchObject({ revision: 2 });
    const revs = (await get('/api/channels/funny/revisions')).body;
    expect(revs.map((r: any) => [r.number, r.current])).toEqual([[1, false], [2, true]]);
    expect((await get('/api/channels/funny/revisions/1')).body.yaml).toBe(EXAMPLE);
    const diff = (await get('/api/channels/funny/diff')).body;
    expect(diff).toMatchObject({ from: 1, to: 2 });
    expect(diff.lines.filter((l: any) => l.kind !== 'same').map((l: any) => [l.kind, l.text.includes('min: ')])).toEqual([['removed', true], ['added', true]]);
    expect((await get('/api/channels/funny/diff?from=7&to=2')).status).toBe(404);
    expect((await get('/api/channels/funny/diff?from=x')).status).toBe(400);
  });

  it('lists staged slots in a range, with items only when asked', async () => {
    const edge = NOW + 8 * DAY;
    store.replaceStaged('funny', edge, edge + 5 * DAY, [slot(edge + DAY, edge + DAY + 3600_000), slot(edge + 2 * DAY, edge + 2 * DAY + 3600_000)], 7);
    store.setLocked('funny', edge + DAY, true);
    store.setPin('funny', edge + 2 * DAY, 1, { id: 'p9', title: 'Special', duration: 1000 });
    const all = (await get('/api/channels/funny/staged')).body;
    expect(all.map((s: any) => [s.locked, Object.keys(s.pins).length, s.programs, s.items])).toEqual([[true, 0, ['m1'], undefined], [false, 1, ['m1'], undefined]]);
    expect((await get(`/api/channels/funny/staged?from=${edge + 2 * DAY}`)).body).toHaveLength(1);
    expect((await get('/api/channels/funny/staged?items=1')).body[0].items).toHaveLength(1);
  });

  it('lists commits, newest first', async () => {
    const ch = store.channel('funny')!;
    for (let i = 0; i < 2; i++) {
      const c = store.beginCommit({ channelId: ch.id, fromEdge: ch.edge + i * 1000, toEdge: ch.edge + (i + 1) * 1000, state: emptyPlanState(1), items: i + 1, totalMs: 1000, slots: [], at: i });
      store.completeCommit(c.id, ch.edge + (i + 1) * 1000, i);
    }
    expect((await get('/api/channels/funny/commits')).body.map((c: any) => c.items)).toEqual([2, 1]);
  });
});
