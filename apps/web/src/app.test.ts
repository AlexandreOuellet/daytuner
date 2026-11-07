import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
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
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    store = Store.open(':memory:');
    store.addChannel({
      name: 'funny', tunarrId: 'tun-1', floorMs: 7 * DAY, stepMs: DAY, schedule: EXAMPLE, state: emptyPlanState(1), edge: NOW + 8 * DAY, at: 5,
    });
    app = createApp({ store, clock: { now: () => NOW }, client: new TunarrClient('http://tunarr.test', () => { throw new Error('no Tunarr in this test'); }) });
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

  it('gives a card per channel with its health, and the metrics of each commit', async () => {
    const ch = store.channel('funny')!;
    const metrics = { slots: 3, adLoadRatio: { count: 3, median: 0.3, p90: 0.4, p99: 0.4, max: 0.4 }, deadAirShare: 0.001, endOfSlotMinutes: { count: 3, median: 5, p90: 9, p99: 9, max: 9 }, repeatedProgramAirings: 0 };
    const c = store.beginCommit({ channelId: ch.id, fromEdge: ch.edge, toEdge: ch.edge + 1000, state: emptyPlanState(1), items: 1, totalMs: 1000, slots: [], at: 1 });
    store.completeCommit(c.id, ch.edge + 1000, 2, { metrics: metrics as never, alerts: 0, warnings: 1 });
    const cards = (await get('/api/dashboard')).body;
    expect(cards[0]).toMatchObject({ name: 'funny', health: { status: 'ok', headline: { adLoad: 0.3, deadAirShare: 0.001 } } });
    expect(cards[0].health.checks.map((x: any) => x.name)).toContain('Dead air');
    expect((await get('/api/channels/funny/metrics')).body.map((p: any) => [p.commitId, p.alerts, p.warnings])).toEqual([[c.id, 0, 1]]);
    store.setTargets('funny', { deadAirMaxShare: 0.0001 });
    expect((await get('/api/channels/funny/health')).body).toMatchObject({ status: 'needs-attention' });
    expect((await get('/api/channels/funny/health')).body.checks.find((x: any) => x.name === 'Dead air')).toMatchObject({ ok: false });
  });

  it('shows and changes targets and settings, and lists the runs', async () => {
    const post = async (path: string, body: unknown) => {
      const r = await app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return { status: r.status, body: await r.json() as any };
    };
    expect((await get('/api/channels/funny/targets')).body).toMatchObject({ deadAirMaxShare: 0.005, adLoadRange: null });
    expect((await post('/api/channels/funny/targets', { endOfSlotP90MaxMinutes: 20 })).body).toMatchObject({ endOfSlotP90MaxMinutes: 20, deadAirMaxShare: 0.005 });
    expect((await post('/api/channels/funny/targets', { deadAirMaxShare: -1 })).status).toBe(400);
    const set = await post('/api/channels/funny/settings', { runAt: '04:30', floorMs: 5 * DAY });
    expect(set.body).toMatchObject({ runAtMinutes: 270, floorMs: 5 * DAY });
    expect((await post('/api/channels/funny/settings', { runAt: 'noon' })).status).toBe(400);
    expect((await post('/api/channels/funny/settings', { runAt: '25:00' })).status).toBe(400);
    store.recordRun('funny', 5, 'appended', 'appended 9 slots');
    expect((await get('/api/channels/funny/runs')).body[0]).toMatchObject({ outcome: 'appended', message: 'appended 9 slots' });
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

describe('serving the pages', () => {
  it('serves files from the built folder, index.html for other paths, and keeps /api for the API', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'daytuner-ui-'));
    try {
      mkdirSync(join(dir, 'assets'));
      writeFileSync(join(dir, 'index.html'), '<title>DayTuner</title>');
      writeFileSync(join(dir, 'assets', 'app.js'), 'console.log(1)');
      writeFileSync(join(dirname(dir), 'secret.txt'), 'nope');
      const store = Store.open(':memory:');
      const app = createApp({ store, clock: { now: () => NOW }, client: new TunarrClient('http://tunarr.test', () => { throw new Error('none'); }), uiDir: dir });
      const index = await app.request('/');
      expect(index.status).toBe(200);
      expect(index.headers.get('content-type')).toContain('text/html');
      expect(await index.text()).toContain('DayTuner');
      const js = await app.request('/assets/app.js');
      expect(js.headers.get('content-type')).toContain('javascript');
      expect(js.headers.get('cache-control')).toContain('immutable');
      expect(await (await app.request('/channel/anything')).text()).toContain('DayTuner'); // the app routes itself
      expect((await app.request('/api/nothing')).status).toBe(404);
      expect((await app.request('/api/health')).status).toBe(200);
      const escape = await app.request('/..%2Fsecret.txt');
      expect(await escape.text()).not.toContain('nope'); // cannot read outside the folder
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(join(dirname(dir), 'secret.txt'), { force: true });
    }
  });
});
