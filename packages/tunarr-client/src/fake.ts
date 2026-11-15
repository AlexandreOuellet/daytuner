// An in-memory stand-in for Tunarr, for tests: just enough of the API this project uses. It enforces
// the rules that matter: appends only, durations whole, and pages counted from 0.

import type { FetchLike } from './client.js';

export interface FakeData {
  shows: { id: string; title: string; episodes: { id: string; title: string; duration: number; season: number; episode: number; chapters?: { start: number; end: number; type?: string }[] }[] }[];
  movies: { id: string; title: string; duration: number; genres: string[]; chapters?: { start: number; end: number; type?: string }[] }[];
  fillerLists: { id: string; name: string; clips: { id: string; duration: number }[] }[];
  channel: { id: string; number: number; name: string; startTime: number };
  /** Items already in the lineup (for a channel with a history). */
  lineup?: Record<string, unknown>[];
}

export class FakeTunarr {
  lineup: Record<string, unknown>[];
  requests: string[] = [];
  /** The next append is stored, but the call then fails (as if the connection dropped). */
  crashAfterNextAppend = false;
  /** The next append is not stored and the call fails. */
  dropNextAppend = false;
  /** The next append is stored with its first two items' durations swapped: same total, different content. */
  corruptNextAppend = false;
  /** The channel start time reported, changeable to simulate a change made in Tunarr itself. */
  constructor(readonly data: FakeData) {
    this.lineup = [...(data.lineup ?? [])];
  }

  get duration(): number {
    return this.lineup.reduce((a: number, i) => a + Number(i['duration']), 0);
  }

  /** Something outside DayTuner adds to the lineup (for example a save from Tunarr's own interface). */
  appendExternally(items: Record<string, unknown>[]): void {
    this.lineup.push(...items);
  }

  /** Channels created through POST /api/channels, as sent. */
  readonly created: Record<string, unknown>[] = [];
  private readonly createdLineups = new Map<string, Record<string, unknown>[]>();
  /** The lineup of the first channel that was created through the fake. */
  get createdLineup(): Record<string, unknown>[] {
    return this.createdLineups.get(String(this.created[0]?.['id'])) ?? [];
  }

  readonly fetch: FetchLike = async (url, init) => {
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    const method = init?.method ?? 'GET';
    this.requests.push(`${method} ${path}`);
    const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    const json = (v: unknown, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(v) });
    const d = this.data;
    const ch = d.channel;

    if (method === 'GET' && path === '/api/transcode_configs') return json([{ id: 'tc-default', name: 'Default', isDefault: true }]);
    if (method === 'POST' && path === '/api/channels') {
      const made = body?.['channel'] as Record<string, unknown> | undefined;
      if (!body || body['type'] !== 'new' || !made) return json({ error: 'the fake only creates channels with type "new"' }, 400);
      if (this.created.some((c) => c['number'] === made['number']) || made['number'] === ch.number) return json({ error: 'channel number in use' }, 400);
      const stored = { ...made, id: `created-${this.created.length + 1}` }; // as Tunarr does, ignore the id sent
      this.created.push(stored);
      this.createdLineups.set(String(stored.id), []);
      return json(stored);
    }
    const lengthOf = (id: unknown): number => (this.createdLineups.get(String(id)) ?? []).reduce((a, i) => a + Number(i['duration']), 0);
    const made = this.created.find((c) => path === `/api/channels/${String(c['id'])}`);
    if (method === 'GET' && made) return json({ ...made, duration: lengthOf(made['id']) });
    const madeLineup = this.created.find((c) => path === `/api/channels/${String(c['id'])}/programming`);
    if (madeLineup && method === 'GET') return json({ lineup: this.createdLineups.get(String(madeLineup['id'])) ?? [] });
    if (madeLineup && method === 'POST') {
      if (!body || body['type'] !== 'manual' || body['append'] !== true) return json({ error: 'only appending manual lineups is allowed in the fake' }, 400);
      this.createdLineups.get(String(madeLineup['id']))!.push(...(body['lineup'] as Record<string, unknown>[]));
      return json(null);
    }
    if (method === 'GET' && path === '/api/channels') return json([this.channelJson(), ...this.created.map((c) => ({ ...c, duration: lengthOf(c['id']) }))]);
    if (method === 'GET' && path === `/api/channels/${ch.id}`) return json(this.channelJson());
    if (method === 'GET' && path === `/api/channels/${ch.id}/programming`) return json({ lineup: this.lineup });
    if (method === 'POST' && path === `/api/channels/${ch.id}/programming`) {
      if (!body || body['type'] !== 'manual' || body['append'] !== true) return json({ error: 'only appending manual lineups is allowed in the fake' }, 400);
      const items = body['lineup'] as Record<string, unknown>[];
      for (const i of items) if (!Number.isInteger(i['duration'])) return json({ error: `duration ${String(i['duration'])} is not whole` }, 400);
      if (this.dropNextAppend) { this.dropNextAppend = false; return json({ error: 'connection dropped' }, 500); }
      if (this.corruptNextAppend && items.length >= 2) {
        this.corruptNextAppend = false;
        const [a, b, ...more] = items as [Record<string, unknown>, Record<string, unknown>, ...Record<string, unknown>[]];
        this.lineup.push({ ...a, duration: b['duration'] }, { ...b, duration: a['duration'] }, ...more);
      } else this.lineup.push(...items);
      if (this.crashAfterNextAppend) { this.crashAfterNextAppend = false; return json({ error: 'connection dropped after storing' }, 500); }
      return json(null);
    }
    if (method === 'GET' && path === '/api/filler-lists') return json(d.fillerLists.map((l) => ({ id: l.id, name: l.name, contentCount: l.clips.length })));
    const fl = /^\/api\/filler-lists\/([^/]+)\/programs$/.exec(path);
    if (method === 'GET' && fl) {
      const list = d.fillerLists.find((l) => l.id === fl[1]);
      return list ? json(list.clips.map((c) => ({ type: 'content', id: c.id, duration: c.duration + 0.25, program: { title: c.id } }))) : json({}, 404);
    }
    if (method === 'POST' && path === '/api/programs/search') {
      const q = body as { query: { filter: { fieldSpec: { value: string[] } } }; page: number; limit: number };
      const type = q.query.filter.fieldSpec.value[0];
      const all =
        type === 'movie'
          ? d.movies.map((m) => ({ uuid: m.id, type: 'movie', title: m.title, duration: m.duration + 0.4, genres: m.genres.map((name) => ({ name })) }))
          : d.shows.map((s) => ({ uuid: s.id, type: 'show', title: s.title }));
      const start = q.page * q.limit;
      return json({ results: all.slice(start, start + q.limit), page: q.page, totalPages: Math.max(1, Math.ceil(all.length / q.limit)), totalHits: all.length });
    }
    const sd = /^\/api\/programs\/([^/]+)\/stream_details$/.exec(path);
    if (method === 'GET' && sd) {
      const p = [...d.movies, ...d.shows.flatMap((x) => x.episodes)].find((x) => x.id === sd[1]);
      if (!p) return json({}, 404);
      const chapters = (p.chapters ?? []).map((c, index) => ({ index, startTime: c.start, endTime: c.end, title: `Chapter ${index + 1}`, chapterType: c.type ?? 'chapter' }));
      return json({ details: { streamDetails: { chapters, duration: 'PT1H', audioOnly: false }, streamSource: { type: 'http', path: 'x' } } });
    }
    const desc = /^\/api\/programs\/([^/]+)\/descendants$/.exec(path);
    if (method === 'GET' && desc) {
      const show = d.shows.find((s) => s.id === desc[1]);
      if (!show) return json({}, 404);
      return json([...show.episodes].reverse().map((e) => ({
        type: 'content', id: e.id, duration: e.duration + 0.3,
        program: { type: 'episode', title: e.title, season: { index: e.season }, episodeNumber: e.episode },
      })));
    }
    return json({ error: `the fake does not know ${method} ${path}` }, 404);
  };

  private channelJson(): Record<string, unknown> {
    const ch = this.data.channel;
    return { id: ch.id, number: ch.number, name: ch.name, startTime: ch.startTime, duration: this.duration };
  }
}
