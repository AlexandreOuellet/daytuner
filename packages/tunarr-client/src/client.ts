// A small typed client for the parts of Tunarr's API this project uses.
// Endpoints and caveats: docs/tunarr-api.md. Only reads here; writes are in lineup.ts.
// Tunarr reports durations as fractions of a millisecond. Everything leaves this file as whole
// milliseconds (rounded once, here), because the engine and the lineup only use whole milliseconds.

export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

export class TunarrError extends Error {
  constructor(readonly status: number, readonly url: string, body: string) {
    super(`Tunarr answered ${status} for ${url}: ${body.slice(0, 300)}`);
    this.name = 'TunarrError';
  }
}

export interface ChannelInfo {
  id: string;
  number: number;
  name: string;
  /** Total lineup length in whole milliseconds. */
  duration: number;
  startTime: number;
}

export interface ClipInfo {
  id: string;
  title: string;
  /** Whole milliseconds. */
  duration: number;
}

export interface FillerListInfo {
  id: string;
  name: string;
  count: number;
}

export interface MovieInfo {
  id: string;
  title: string;
  duration: number;
  genres: string[];
  year: number | null;
}

export interface ShowInfo {
  id: string;
  title: string;
}

export interface EpisodeInfo {
  id: string;
  title: string;
  duration: number;
  season: number;
  episode: number;
}

type Json = Record<string, unknown>;

const rec = (v: unknown, what: string): Json => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new TypeError(`expected an object for ${what}`);
  return v as Json;
};
const arr = (v: unknown, what: string): unknown[] => {
  if (!Array.isArray(v)) throw new TypeError(`expected a list for ${what}`);
  return v;
};
const str = (v: unknown, what: string): string => {
  if (typeof v !== 'string') throw new TypeError(`expected a string for ${what}`);
  return v;
};
const num = (v: unknown, what: string): number => {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new TypeError(`expected a number for ${what}`);
  return v;
};

export class TunarrClient {
  /**
   * @param allowWrites Writing is off unless this is true, so reading code can never write by mistake.
   *   Only point a writing client at a test copy of Tunarr, never at the one people are watching.
   */
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: FetchLike = (url, init) => fetch(url, init),
    private readonly allowWrites = false,
  ) {}

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const url = this.baseUrl.replace(/\/$/, '') + path;
    const res = await this.fetchImpl(url, {
      method,
      ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    if (!res.ok) throw new TunarrError(res.status, url, text);
    return text === '' ? null : JSON.parse(text);
  }

  get(path: string): Promise<unknown> {
    return this.request('GET', path);
  }

  post(path: string, body: unknown): Promise<unknown> {
    return this.request('POST', path, body);
  }

  /**
   * Appends items to the end of a channel's lineup. It only ever appends: the lineup is never
   * replaced, and the channel's start time is never touched.
   */
  async appendLineup(channelId: string, lineup: readonly unknown[]): Promise<void> {
    if (!this.allowWrites) throw new Error('this client was not created with allowWrites, so it cannot write');
    if (lineup.length === 0) return;
    await this.post(`/api/channels/${channelId}/programming`, { type: 'manual', lineup, append: true });
  }

  async channels(): Promise<ChannelInfo[]> {
    return arr(await this.get('/api/channels'), 'channels').map((c) => channelOf(rec(c, 'channel')));
  }

  async channel(id: string): Promise<ChannelInfo> {
    return channelOf(rec(await this.get(`/api/channels/${id}`), 'channel'));
  }

  /** The stored lineup of a channel, as Tunarr sends it. */
  async lineup(channelId: string): Promise<Json[]> {
    const d = rec(await this.get(`/api/channels/${channelId}/programming`), 'programming');
    return arr(d['lineup'], 'lineup').map((i) => rec(i, 'lineup item'));
  }

  async fillerLists(): Promise<FillerListInfo[]> {
    return arr(await this.get('/api/filler-lists'), 'filler lists').map((f) => {
      const o = rec(f, 'filler list');
      return { id: str(o['id'], 'id'), name: str(o['name'], 'name'), count: typeof o['contentCount'] === 'number' ? o['contentCount'] : 0 };
    });
  }

  async fillerListClips(id: string): Promise<ClipInfo[]> {
    return arr(await this.get(`/api/filler-lists/${id}/programs`), 'clips').map((c) => {
      const o = rec(c, 'clip');
      const p = o['program'] === undefined ? {} : rec(o['program'], 'clip program');
      return {
        id: str(o['id'], 'clip id'),
        title: typeof p['title'] === 'string' ? p['title'] : '',
        duration: Math.round(num(o['duration'], 'clip duration')),
      };
    });
  }

  /**
   * Every result of a search. Tunarr counts pages from 0, and a search that drops results would be
   * silent, so the number collected is checked against the total the server reports.
   */
  private async search(filter: Json, pageSize = 200): Promise<Json[]> {
    const out: Json[] = [];
    let totalHits: number | undefined;
    for (let page = 0; ; page++) {
      const d = rec(
        await this.post('/api/programs/search', { query: { query: null, filter }, page, limit: pageSize }),
        'search',
      );
      out.push(...arr(d['results'], 'results').map((r) => rec(r, 'result')));
      totalHits = num(d['totalHits'], 'totalHits');
      if (page + 1 >= num(d['totalPages'], 'totalPages')) break;
    }
    if (out.length !== totalHits) {
      throw new Error(`the search returned ${out.length} results but Tunarr reports ${totalHits}`);
    }
    return out;
  }

  /** Every movie in the library. Filtering by genre and length is done by the caller. */
  async movies(): Promise<MovieInfo[]> {
    const results = await this.search({
      type: 'value',
      fieldSpec: { key: 'type', name: 'type', type: 'string', op: '=', value: ['movie'] },
    });
    return results.map((r) => ({
      id: str(r['uuid'], 'uuid'),
      title: str(r['title'], 'title'),
      duration: Math.round(num(r['duration'], 'movie duration')),
      genres: Array.isArray(r['genres']) ? r['genres'].map((g) => str(rec(g, 'genre')['name'], 'genre name')) : [],
      year: typeof r['year'] === 'number' ? r['year'] : null,
    }));
  }

  async shows(): Promise<ShowInfo[]> {
    const results = await this.search({
      type: 'value',
      fieldSpec: { key: 'type', name: 'type', type: 'string', op: '=', value: ['show'] },
    });
    return results.map((r) => ({ id: str(r['uuid'], 'uuid'), title: str(r['title'], 'title') }));
  }

  /** All the episodes of a show, in the order a viewer would watch them: by season, then episode. */
  async episodes(showId: string): Promise<EpisodeInfo[]> {
    const items = arr(await this.get(`/api/programs/${showId}/descendants`), 'episodes').map((i) => rec(i, 'episode'));
    const out: EpisodeInfo[] = [];
    for (const item of items) {
      const p = rec(item['program'], 'episode program');
      if (p['type'] !== 'episode') continue;
      const season = p['season'] === undefined || p['season'] === null ? undefined : rec(p['season'], 'season');
      out.push({
        id: str(item['id'], 'episode id'),
        title: str(p['title'], 'episode title'),
        duration: Math.round(num(item['duration'], 'episode duration')),
        season: season && typeof season['index'] === 'number' ? season['index'] : 0,
        episode: typeof p['episodeNumber'] === 'number' ? p['episodeNumber'] : 0,
      });
    }
    return out.sort((a, b) => a.season - b.season || a.episode - b.episode || a.title.localeCompare(b.title));
  }
}

function channelOf(o: Json): ChannelInfo {
  return {
    id: str(o['id'], 'channel id'),
    number: num(o['number'], 'channel number'),
    name: str(o['name'], 'channel name'),
    duration: Math.round(num(o['duration'], 'channel duration')),
    startTime: num(o['startTime'], 'channel start time'),
  };
}
