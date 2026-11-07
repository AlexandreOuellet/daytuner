import { beforeEach, describe, expect, it } from 'vitest';
import { Store } from '@daytuner/store';
import { FakeTunarr, TunarrClient } from '@daytuner/tunarr-client';
import { createApp } from './app.js';
import { Jobs } from './jobs.js';

const DAY = 86_400_000;
const MIN = 60_000;
const NOW = Date.UTC(2026, 10, 6, 12, 0, 0);

const YAML = `
channel: Test
timezone: America/Toronto
grid: 15m
ads:
  step: 15s
  ratio: { min: 15%, max: 60% }
  mid:  { list: Ads, every: 8m, length: 2m-3m, tailBuffer: 1m }
  post: { list: Ads, length: 0-5m }
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

type Res = { status: number; body: any };

function build(writes = false) {
  const startTime = NOW - 10 * DAY;
  const fake = new FakeTunarr({
    shows: [{ id: 'show-a', title: 'Show A', episodes: Array.from({ length: 300 }, (_, i) => ({ id: `ep${i + 1}`, title: `Ep ${i + 1}`, duration: 22 * MIN + 1000, season: 1 + Math.floor(i / 20), episode: (i % 20) + 1 })) }],
    movies: Array.from({ length: 12 }, (_, i) => ({ id: `mov${i}`, title: `Movie ${i}`, duration: (85 + i * 2) * MIN, genres: ['Comedy'] })),
    fillerLists: [
      { id: 'fl-ads', name: 'Ads', clips: Array.from({ length: 40 }, (_, i) => ({ id: `ad${i}`, duration: 15_000 + (i % 7) * 1000 + i * 13 })) },
      { id: 'fl-fill', name: 'Fillers', clips: Array.from({ length: 10 }, (_, i) => ({ id: `fl${i}`, duration: 180_000 + i * 1000 })) },
    ],
    channel: { id: 'chan-1', number: 1, name: 'Test', startTime },
    lineup: [{ type: 'flex', duration: NOW + 3 * DAY - startTime }],
  });
  const store = Store.open(':memory:');
  const clock = { now: () => NOW };
  const jobs = new Jobs(clock);
  const app = createApp({
    store, clock, jobs, client: new TunarrClient('http://tunarr.test', fake.fetch),
    ...(writes ? { writeClient: new TunarrClient('http://tunarr.test', fake.fetch, true) } : {}),
  });
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const r = await app.request(path, { method, ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    return { status: r.status, body: await r.json() };
  };
  const post = (path: string, body?: unknown) => call('POST', path, body ?? {});
  /** Posts a job-starting call and waits for the job to finish. */
  const job = async (path: string, body?: unknown) => {
    const r = await post(path, body);
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    return (await jobs.settled(r.body.job.id))!;
  };
  return { fake, store, jobs, app, call, post, job, get: (p: string) => call('GET', p) };
}

describe('actions', () => {
  let t: ReturnType<typeof build>;
  beforeEach(async () => {
    t = build();
    const j = await t.job('/api/channels', { yaml: YAML });
    expect(j).toMatchObject({ state: 'done' });
  });

  it('adds a channel from a channel file, reporting where each show stands', async () => {
    expect(t.store.channel('Test')).toMatchObject({ tunarrId: 'chan-1', revision: 1 });
    const again = await t.job('/api/channels', { yaml: YAML });
    expect(again.state).toBe('failed');
    expect(again.message).toMatch(/already exists/);
    expect((await t.post('/api/channels', { yaml: 'nonsense: true' })).status).toBe(400);
    expect((await t.post('/api/channels', {})).status).toBe(400);
  });

  it('stages a range, locks and pins and reshapes it, and reports what changed', async () => {
    const edge = t.store.channel('Test')!.edge;
    const day = (n: number) => edge + n * DAY;
    const gen = await t.job('/api/channels/Test/stage/generate', { to: day(4) });
    expect(gen).toMatchObject({ state: 'done', result: { staged: expect.any(Number) } });
    const staged = (await t.get('/api/channels/Test/staged')).body;
    expect(staged.length).toBeGreaterThan(4);
    const full = staged.filter((s: any) => s.start > edge + 30 * MIN);
    const movie = full.find((s: any) => s.pool === 'movies');

    expect((await t.post('/api/channels/Test/stage/lock', { start: movie.start, locked: true })).body).toEqual({ ok: true });
    expect((await t.get('/api/channels/Test/staged')).body.find((s: any) => s.start === movie.start).locked).toBe(true);
    expect((await t.post('/api/channels/Test/stage/lock', { start: 12345, locked: true })).status).toBe(400);
    await t.post('/api/channels/Test/stage/lock', { start: movie.start, locked: false });

    const pin = await t.job('/api/channels/Test/stage/pin', { start: movie.start, block: 1, program: 'movie:Movie 3' });
    expect(pin).toMatchObject({ state: 'done' });
    expect((await t.get('/api/channels/Test/staged')).body.find((s: any) => s.start === movie.start).pins['1'].title).toBe('Movie 3');
    expect((await t.post('/api/channels/Test/stage/pin', { start: movie.start, block: 0, program: 'movie:Movie 3' })).status).toBe(400);
    expect((await t.job('/api/channels/Test/stage/pin', { start: movie.start, block: 1, program: 'movie:Nope' })).state).toBe('failed');
    expect((await t.job('/api/channels/Test/stage/unpin', { start: movie.start, block: 1 })).state).toBe('done');

    const big = full.find((s: any) => s.end - s.start >= 6 * 60 * MIN);
    const add = await t.job('/api/channels/Test/stage/edit', { kind: 'add', start: big.start + 60 * MIN, end: big.start + 120 * MIN, program: 'episode:Show A/Ep 9' });
    expect(add.state, add.message).toBe('done');
    expect((add.result as any).changes.some((c: any) => c.kind === 'new')).toBe(true);
    expect((await t.get('/api/channels/Test/staged')).body.some((s: any) => s.edited)).toBe(true);
    expect((await t.post('/api/channels/Test/stage/edit', { kind: 'explode', start: 1 })).status).toBe(400);

    expect(((await t.job('/api/channels/Test/stage/diff')).result as any).changes.length).toBeGreaterThan(0);
    expect(((await t.job('/api/channels/Test/stage/check')).result as any).conflicts).toEqual([]);

    const reset = await t.job('/api/channels/Test/stage/reset', { from: big.start, to: big.end });
    expect(reset.state, reset.message).toBe('done');
    expect((await t.get('/api/channels/Test/staged')).body.some((s: any) => s.edited)).toBe(false);
    expect((await t.post('/api/channels/Test/stage/clear')).body.cleared).toBeGreaterThan(0);
    expect((await t.get('/api/channels/Test/staged')).body).toEqual([]);
  });

  it('takes local dates as well as epoch milliseconds, and rejects nonsense', async () => {
    const r = await t.job('/api/channels/Test/stage/generate', { to: '2026-11-12', keepFrom: '2026-11-11', keepTo: '2026-11-12' });
    expect(r.state, r.message).toBe('done');
    expect((await t.post('/api/channels/Test/stage/generate', { to: 'soon' })).status).toBe(400);
    expect((await t.post('/api/channels/Test/stage/generate', {})).status).toBe(400);
  });

  it('answers 409 with the running job while a channel is busy, and 404 for an unknown channel', async () => {
    let release!: () => void;
    t.jobs.start('Test', 'plan', () => new Promise<void>((r) => { release = r; }));
    const busy = await t.post('/api/channels/Test/stage/generate', { to: NOW + 9 * DAY });
    expect(busy.status).toBe(409);
    expect(busy.body.job.kind).toBe('plan');
    release();
    expect((await t.post('/api/channels/ghost/stage/generate', { to: 1 })).status).toBe(404);
  });

  it('checks a new schedule against locked slots and saves it only when it fits, or when forced', async () => {
    const edge = t.store.channel('Test')!.edge;
    await t.job('/api/channels/Test/stage/generate', { to: edge + 4 * DAY });
    const movie = (await t.get('/api/channels/Test/staged')).body.find((s: any) => s.pool === 'movies' && s.start > edge + 30 * MIN);
    await t.post('/api/channels/Test/stage/lock', { start: movie.start, locked: true });
    const moved = YAML.replaceAll('at: "20:00"', 'at: "21:00"');

    const check = await t.job('/api/channels/Test/schedule/check', { yaml: moved });
    expect((check.result as any).conflicts.map((c: any) => c.reason)).toEqual(['window-changed']);
    expect(t.store.channel('Test')!.revision).toBe(1);

    const refused = await t.job('/api/channels/Test/schedule', { yaml: moved });
    expect(refused.result).toMatchObject({ saved: false, revision: 1 });
    const forced = await t.job('/api/channels/Test/schedule', { yaml: moved, force: true });
    expect(forced.result).toMatchObject({ saved: true, revision: 2 });
    expect((await t.get('/api/channels/Test/revisions')).body).toHaveLength(2);
    expect((await t.post('/api/channels/Test/schedule/rollback', { revision: 1 })).body).toEqual({ revision: 1 });
    expect(t.store.channel('Test')!.revision).toBe(1);
    expect((await t.post('/api/channels/Test/schedule/rollback', { revision: 9 })).status).toBe(400);
    expect((await t.post('/api/channels/Test/schedule', { yaml: 'nonsense: true' })).status).toBe(400);
    const same = await t.job('/api/channels/Test/schedule', { yaml: YAML });
    expect(same.result).toMatchObject({ saved: true, revision: 1 });
  });

  it('lists the shows\' places and adjusts one', async () => {
    const list = (await t.get('/api/channels/Test/cursors')).body;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ key: 'seq:a', pool: 'sitcoms', position: 0, next: { programId: 'ep1' }, perWeek: 7 });
    expect(list[0].slotInfo[0]).toEqual({ id: expect.stringMatching(/^\d@/), mode: 'continue' });
    const edge = t.store.channel('Test')!.edge;
    await t.job('/api/channels/Test/stage/generate', { to: edge + 3 * DAY });
    const set = await t.job('/api/channels/Test/cursors/adjust', { key: 'seq:a', kind: 'set', amount: 10 });
    expect(set.state, set.message).toBe('done');
    expect(set.result).toMatchObject({ before: { position: 0 }, after: { position: 10 } });
    expect((await t.get('/api/channels/Test/cursors')).body[0].position).toBe(10);
    const pv = await t.job('/api/channels/Test/cursors/preview', { key: 'seq:a', kind: 'rewind', amount: 5 });
    expect(pv.state, pv.message).toBe('done');
    expect(pv.result).toMatchObject({ key: 'seq:a', before: { position: 10 }, after: { position: 5 } });
    expect((await t.get('/api/channels/Test/cursors')).body[0].position).toBe(10); // a preview changes nothing
    expect((await t.post('/api/channels/Test/cursors/preview', { key: 'seq:a', kind: 'spin', amount: 1 })).status).toBe(400);
    expect((await t.job('/api/channels/Test/cursors/adjust', { key: 'seq:nope', kind: 'rewind', amount: 1 })).state).toBe('failed');
    expect((await t.post('/api/channels/Test/cursors/adjust', { key: 'seq:a', kind: 'spin', amount: 1 })).status).toBe(400);
  });

  it('gives the ad settings with the filler lists, samples a change without saving, and saves it as a revision', async () => {
    const ads = (await t.get('/api/channels/Test/ads')).body;
    expect(ads.revision).toBe(1);
    expect(ads.settings).toMatchObject({ step: 15_000, ratio: { min: 0.15, max: 0.6 }, interstitial: 'Fillers' });
    expect(ads.lists.map((l: any) => [l.name, l.count])).toEqual([['Ads', 40], ['Fillers', 10]]);

    const settings = { ...ads.settings, ratio: { min: 0.2, max: 0.5 }, bumpers: { pre: 'Fillers' } };
    const sample = await t.job('/api/channels/Test/ads/sample', { settings });
    expect(sample.state, sample.message).toBe('done');
    const samples = (sample.result as any).samples;
    expect(samples.map((x: any) => x.kind)).toEqual(['episode', 'movie']);
    expect(samples[0].segments.some((g: any) => g.type === 'bumper' && g.position === 'pre')).toBe(true);
    expect(t.store.channel('Test')!.revision).toBe(1); // a sample saves nothing

    const saved = await t.job('/api/channels/Test/ads', { settings });
    expect(saved.result).toMatchObject({ saved: true, revision: 2 });
    expect((await t.get('/api/channels/Test/ads')).body.settings).toMatchObject({ ratio: { min: 0.2, max: 0.5 }, bumpers: { pre: 'Fillers' } });
    const unchanged = await t.job('/api/channels/Test/ads', { settings: (await t.get('/api/channels/Test/ads')).body.settings });
    expect(unchanged.result).toMatchObject({ saved: true, revision: 2 }); // nothing changed: no new revision

    expect((await t.post('/api/channels/Test/ads', { settings: { nonsense: true } })).status).toBe(400);
    expect((await t.post('/api/channels/Test/ads/sample', {})).status).toBe(400);
    expect((await t.post('/api/channels/Test/ads', { settings: { ...settings, positions: { head: { min: 0, max: 60000 } } } })).status).toBe(400); // ads without a list
    expect((await t.job('/api/channels/Test/ads', { settings: { ...settings, interstitial: 'Missing list' } })).state).toBe('failed');
  });

  it('gives the week and pools as data, saves a changed week, and checks it against locked slots first', async () => {
    const got = (await t.get('/api/channels/Test/schedule/model')).body;
    expect(got.revision).toBe(1);
    expect(got.model.week).toHaveLength(14);
    expect(got.model.pools['sitcoms']).toMatchObject({ shows: [{ show: 'Show A' }] });

    const edge = t.store.channel('Test')!.edge;
    await t.job('/api/channels/Test/stage/generate', { to: edge + 4 * DAY });
    const movie = (await t.get('/api/channels/Test/staged')).body.find((s: any) => s.pool === 'movies' && s.start > edge + 30 * MIN);
    await t.post('/api/channels/Test/stage/lock', { start: movie.start, locked: true });
    const week = got.model.week.map((s: any) => (s.pool === 'movies' ? { ...s, at: s.at + 3_600_000 } : s));

    const check = await t.job('/api/channels/Test/schedule/model', { week, pools: got.model.pools, check: true });
    expect((check.result as any).impact.conflicts.length).toBe(1);
    expect(t.store.channel('Test')!.revision).toBe(1);
    const refused = await t.job('/api/channels/Test/schedule/model', { week, pools: got.model.pools });
    expect(refused.result).toMatchObject({ saved: false });
    const saved = await t.job('/api/channels/Test/schedule/model', { week, pools: got.model.pools, force: true });
    expect(saved.result).toMatchObject({ saved: true, revision: 2 });
    expect((await t.get('/api/channels/Test/schedule/model')).body.model.week.find((s: any) => s.pool === 'movies').at).toBe(21 * 3_600_000);

    expect((await t.post('/api/channels/Test/schedule/model', { week: [], pools: got.model.pools })).status).toBe(400);
    expect((await t.post('/api/channels/Test/schedule/model', { week: [{ day: 1, at: 61_000, pool: 'movies' }], pools: got.model.pools })).status).toBe(400);
    expect((await t.post('/api/channels/Test/schedule/model', {})).status).toBe(400);
  });

  it('places special days on the calendar with their state, saves them, and finds programs to play', async () => {
    const saved = (await t.get('/api/channels/Test/schedule/model')).body.model;
    expect(saved.exceptions).toEqual([]);
    const exceptions = [
      { on: { month: 11, day: 9 }, at: 20 * 3_600_000, play: { movie: 'Movie 3', id: 'mov3' } },      // a Monday 20:00 slot, after the end of the committed lineup
      { on: { month: 11, day: 13 }, at: 20 * 3_600_000, play: { show: 'Show A', id: 'show-a', title: 'Ep 4' } },
    ];
    const occ = (await t.post('/api/channels/Test/special-days', { exceptions })).body;
    expect(occ.map((o: any) => [o.index, o.date, o.state, o.matchesSlot])).toEqual([[0, '2026-11-09', 'rule', true], [1, '2026-11-13', 'rule', true], [0, '2027-11-09', 'rule', true], [1, '2027-11-13', 'rule', true]]);
    expect((await t.post('/api/channels/Test/special-days', {})).body).toEqual([]); // the saved file has none
    const edge = t.store.channel('Test')!.edge;
    await t.job('/api/channels/Test/stage/generate', { to: edge + 6 * DAY });
    const staged = (await t.post('/api/channels/Test/special-days', { exceptions })).body;
    expect(staged.find((o: any) => o.date === '2026-11-13').state).toBe('staged'); // its slot is staged
    expect(staged.find((o: any) => o.date === '2027-11-13').state).toBe('rule');

    const rejected = await t.post('/api/channels/Test/schedule/model', { week: saved.week, pools: saved.pools, exceptions: [{ on: { month: 2, day: 30 }, at: 0, play: { movie: 'x' } }] });
    expect(rejected.status).toBe(400);
    const done = await t.job('/api/channels/Test/schedule/model', { week: saved.week, pools: saved.pools, exceptions });
    expect(done.result).toMatchObject({ saved: true, revision: 2 });
    expect((await t.get('/api/channels/Test/schedule/model')).body.model.exceptions).toHaveLength(2);
    expect((await t.post('/api/channels/Test/special-days', {})).body).toHaveLength(4);

    expect((await t.get('/api/library/movies?q=movie 1')).body.map((m: any) => m.title)).toEqual(['Movie 1', 'Movie 10', 'Movie 11']);
    expect((await t.get('/api/library/movies?q=m')).body).toEqual([]); // too short to search
    const eps = (await t.get('/api/library/shows/show-a/episodes')).body;
    expect(eps[0]).toMatchObject({ id: 'ep1', title: 'Ep 1', season: 1, episode: 1 });
  });

  it('reads what unsaved pools hold, and lists the shows and genres of the library', async () => {
    const r = await t.job('/api/channels/Test/pools/stats', { pools: { mine: { shows: [{ show: 'Show A' }] }, odd: { movies: { genre: 'Comedy', duration: { op: '<=', ms: 90 * MIN } } } } });
    expect(r.state, r.message).toBe('done');
    const stats = r.result as any;
    expect(stats.mine.count).toBe(300);
    expect(stats.odd.durations.every((x: number) => x <= 90 * MIN)).toBe(true);
    expect((await t.post('/api/channels/Test/pools/stats', {})).status).toBe(400);
    const lib = (await t.get('/api/library')).body;
    expect(lib).toEqual({ shows: [{ id: 'show-a', title: 'Show A' }], genres: ['Comedy'] });
  });

  it('plans with a dry run, and will not write unless the server was started with writing on', async () => {
    const dry = await t.job('/api/channels/Test/run');
    expect(dry).toMatchObject({ state: 'done', result: { action: 'would-append' } });
    const before = t.fake.lineup.length;
    const refused = await t.post('/api/channels/Test/run', { dryRun: false });
    expect(refused.status).toBe(403);
    expect(refused.body.error).toMatch(/switched off/);
    expect(t.fake.lineup).toHaveLength(before);
    expect((await t.get('/api/health')).body.writes).toBe(false);
  });

  it('commits when writing is on, and says so in the health check', async () => {
    const w = build(true);
    await w.job('/api/channels', { yaml: YAML });
    expect((await w.get('/api/health')).body.writes).toBe(true);
    const before = w.fake.lineup.length;
    const done = await w.job('/api/channels/Test/run', { dryRun: false });
    expect(done).toMatchObject({ state: 'done', result: { action: 'appended' } });
    expect(w.fake.lineup.length).toBeGreaterThan(before);
    expect(((await w.get('/api/channels/Test/commits')).body)[0]).toMatchObject({ status: 'done' });
  });

  it('resyncs, adopts history, and exports the schedule with ids', async () => {
    t.fake.appendExternally([{ type: 'flex', duration: 5 * MIN }]);
    const edgeBefore = t.store.channel('Test')!.edge;
    const dry = (await t.post('/api/channels/Test/resync')).body;
    expect(dry.actions[0]).toMatch(/record .* as the end/);
    expect(t.store.channel('Test')!.edge).toBe(edgeBefore); // a dry run changes nothing
    await t.post('/api/channels/Test/resync', { apply: true });
    const adopt = await t.job('/api/channels/Test/adopt-history');
    expect(adopt.state).toBe('done');
    expect((adopt.result as any).applied).toBe(false);
    const exp = (await t.get('/api/channels/Test/export')).body;
    expect(exp.yaml).toContain('id: show-a');
  });
});
