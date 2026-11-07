import { describe, expect, it } from 'vitest';
import { TunarrClient, TunarrError, type FetchLike } from './client.js';

/** A fake Tunarr: routes by method and path, and records what was asked. */
function fake(routes: Record<string, unknown | ((body: unknown) => unknown)>): { fetch: FetchLike; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const path = url.replace('http://tunarr.test', '');
    const key = `${init?.method ?? 'GET'} ${path}`;
    calls.push(key);
    if (!(key in routes)) return { ok: false, status: 404, text: async () => 'not found' };
    const r = routes[key];
    const value = typeof r === 'function' ? r(init?.body ? JSON.parse(init.body) : undefined) : r;
    return { ok: true, status: 200, text: async () => JSON.stringify(value) };
  };
  return { fetch: fetchImpl, calls };
}

const client = (routes: Record<string, unknown>) => {
  const f = fake(routes);
  return { c: new TunarrClient('http://tunarr.test/', f.fetch), calls: f.calls };
};

describe('reading', () => {
  it('lists channels and rounds the duration to whole milliseconds', async () => {
    const { c } = client({
      'GET /api/channels': [{ id: 'a', number: 4, name: 'The Funny Bone', duration: 34118359878.753353, startTime: 1793725620000 }],
    });
    expect(await c.channels()).toEqual([{ id: 'a', number: 4, name: 'The Funny Bone', duration: 34118359879, startTime: 1793725620000 }]);
  });

  it('reads the clips of a filler list with whole-millisecond durations', async () => {
    const { c } = client({
      'GET /api/filler-lists': [{ id: 'f1', name: 'Old Ads', contentCount: 2 }],
      'GET /api/filler-lists/f1/programs': [
        { type: 'content', id: 'c1', duration: 30116.281, program: { title: 'Ad one' } },
        { type: 'content', id: 'c2', duration: 135732.245 },
      ],
    });
    expect(await c.fillerLists()).toEqual([{ id: 'f1', name: 'Old Ads', count: 2 }]);
    expect(await c.fillerListClips('f1')).toEqual([
      { id: 'c1', title: 'Ad one', duration: 30116 },
      { id: 'c2', title: '', duration: 135732 },
    ]);
  });

  it('pages through the movies from page 0 and reads genres and length', async () => {
    const page = (n: number) => ({
      results: [{ uuid: `m${n}`, title: `Movie ${n}`, duration: 5_400_000.4, genres: [{ name: 'Comedy' }], year: 1990 + n }],
      page: n,
      totalPages: 2,
      totalHits: 2,
    });
    const seen: number[] = [];
    const f: FetchLike = async (_url, init) => {
      const body = JSON.parse(init?.body ?? '{}') as { page: number };
      seen.push(body.page);
      return { ok: true, status: 200, text: async () => JSON.stringify(page(body.page)) };
    };
    const movies = await new TunarrClient('http://tunarr.test', f).movies();
    expect(seen).toEqual([0, 1]);
    expect(movies.map((m) => m.id)).toEqual(['m0', 'm1']);
    expect(movies[0]).toEqual({ id: 'm0', title: 'Movie 0', duration: 5_400_000, genres: ['Comedy'], year: 1990 });
  });

  it('fails loudly when a search returns fewer results than Tunarr reports', async () => {
    const f: FetchLike = async () => ({
      ok: true, status: 200, text: async () => JSON.stringify({ results: [], page: 0, totalPages: 1, totalHits: 175 }),
    });
    await expect(new TunarrClient('http://tunarr.test', f).shows()).rejects.toThrow(/returned 0 results but Tunarr reports 175/);
  });

  it('orders episodes by season then episode, whatever order Tunarr sends', async () => {
    const ep = (id: string, season: number, episode: number) => ({
      id, duration: 1_500_000.2, program: { type: 'episode', title: id, season: { index: season }, episodeNumber: episode },
    });
    const { c } = client({
      'GET /api/programs/s1/descendants': [ep('s2e1', 2, 1), ep('s1e2', 1, 2), ep('s1e1', 1, 1), { id: 'x', duration: 1, program: { type: 'season' } }],
    });
    expect((await c.episodes('s1')).map((e) => e.id)).toEqual(['s1e1', 's1e2', 's2e1']);
  });
});

describe('errors', () => {
  it('turns an HTTP error into a TunarrError that says what failed', async () => {
    const { c } = client({});
    await expect(c.channels()).rejects.toBeInstanceOf(TunarrError);
    await expect(c.channels()).rejects.toThrow(/404/);
  });

  it('rejects an answer of the wrong shape', async () => {
    const { c } = client({ 'GET /api/channels': [{ id: 'a' }] });
    await expect(c.channels()).rejects.toThrow(TypeError);
  });
});

describe('chapters', () => {
  const details = (chapters: unknown) => ({ details: { streamDetails: { chapters } } });
  it('reads markers in whole milliseconds, sorted, with unknown types as plain chapters', async () => {
    const { fetch } = fake({
      'GET /api/programs/p1/stream_details': details([
        { startTime: 600000.4, endTime: 900000, chapterType: 'break' },
        { startTime: 0, endTime: 600000.4, chapterType: 'mystery' },
      ]),
    });
    const c = await new TunarrClient('http://tunarr.test', fetch).chapters('p1');
    expect(c).toEqual([
      { start: 0, end: 600000, type: 'chapter' },
      { start: 600000, end: 900000, type: 'break' },
    ]);
  });
  it('gives an empty list when the program has none', async () => {
    const { fetch } = fake({ 'GET /api/programs/p2/stream_details': details([]) });
    expect(await new TunarrClient('http://tunarr.test', fetch).chapters('p2')).toEqual([]);
  });
});
