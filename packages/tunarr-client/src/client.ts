// A small typed client for the parts of Tunarr's API this project uses.
// Endpoints and caveats: docs/tunarr-api.md. Only reads here; writes are in lineup.ts.
// Tunarr reports durations as fractions of a millisecond. Everything leaves this file as whole
// milliseconds (rounded once, here), because the engine and the lineup only use whole milliseconds.

export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

const CHAPTER_TYPES = ['chapter', 'intro', 'outro', 'break', 'recap'] as const;

/** A chapter marker, in whole milliseconds from the start of the program. */
export interface ChapterInfo {
  start: number;
  end: number;
  type: (typeof CHAPTER_TYPES)[number];
}

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
  /** The length as Tunarr reports it, with its fraction: Tunarr plays and counts the clip at this length. */
  exact?: number;
}

export interface FillerListInfo {
  id: string;
  name: string;
  count: number;
}

/** A video of a local media source (music videos, concerts, ads): Tunarr's `other_video`. */
export interface VideoInfo {
  id: string;
  /** The file name without its extension, as Tunarr titles a local file. */
  title: string;
  duration: number;
  exact?: number;
  /** The full path in the pod, such as `/musicvideos/Gorillaz - Feel Good Inc.mp4`. */
  path: string;
  /** Tunarr's own tags: the folder of a local file. */
  tags: string[];
}

export interface MovieInfo {
  id: string;
  title: string;
  duration: number;
  /** The length with its fraction, as Tunarr reports it. */
  exact?: number;
  genres: string[];
  year: number | null;
  rating: string | null;
  studios: string[];
  tags: string[];
  actors: string[];
  directors: string[];
}

export interface ShowInfo {
  id: string;
  title: string;
  year: number | null;
  rating: string | null;
  studios: string[];
  tags: string[];
  actors: string[];
}

/** What a rule asks the index for: ids of movies or shows with a genre on the show, or an audio or subtitle language. */
export type IdsField = 'genre' | 'audio' | 'subtitles';

export interface EpisodeInfo {
  id: string;
  title: string;
  duration: number;
  /** The length with its fraction, as Tunarr reports it. */
  exact?: number;
  season: number;
  episode: number;
  /** When it first aired (ms), when known. */
  aired?: number;
}

type Json = Record<string, unknown>;

/** How many pages of one search are asked for at once. */
const SEARCH_PARALLEL = 4;
/** Tunarr's index returns at most this many values of a facet; a facet with that many may have been cut short. */
const FACET_LIMIT = 100;

/** The names in a list of {name} objects (genres, studios, actors), or none. */
const names = (v: unknown): string[] => (Array.isArray(v) ? v.flatMap((x) => (typeof x === 'object' && x !== null && typeof (x as Json)['name'] === 'string' ? [(x as Json)['name'] as string] : [])) : []);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

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

  /** The values of a field the index keeps as facets (it returns at most 100). Empty when this Tunarr has no such facet. */
  async facetValues(field: string): Promise<string[]> {
    try {
      const d = rec(await this.post(`/api/programs/facets/${field}`, {}), 'facet');
      return Object.keys(rec(d['facetValues'], 'facetValues'));
    } catch {
      return [];
    }
  }

  post(path: string, body: unknown): Promise<unknown> {
    return this.request('POST', path, body);
  }

  /** The id of Tunarr's default transcode configuration (a new channel needs one). */
  async defaultTranscodeConfigId(): Promise<string> {
    const all = arr(await this.get('/api/transcode_configs'), 'transcode configs').map((c) => rec(c, 'transcode config'));
    const pick = all.find((c) => c['isDefault'] === true) ?? all[0];
    if (!pick) throw new Error('Tunarr has no transcode configuration, so a channel cannot be created');
    return str(pick['id'], 'transcode config id');
  }

  /**
   * Creates an empty channel (no programs, duration 0) starting at `startTime`, which the caller puts on its grid. This is the one
   * thing besides appending that this client writes. The start time is set here and never changed afterwards.
   */
  async createChannel(o: { name: string; number: number; startTime: number; stealth: boolean }): Promise<ChannelInfo> {
    if (!this.allowWrites) throw new Error('this client was not created with allowWrites, so it cannot write');
    const channel = {
      id: globalThis.crypto.randomUUID(), name: o.name, number: o.number, startTime: o.startTime, duration: 0, stealth: o.stealth,
      groupTitle: 'tunarr', guideMinimumDuration: 30_000, disableFillerOverlay: false, subtitlesEnabled: false,
      icon: { path: '', width: 0, duration: 0, position: 'bottom-right', useDefaultIconFallback: true },
      offline: { picture: '', soundtrack: '', mode: 'pic' },
      streamMode: 'hls', transcodeConfigId: await this.defaultTranscodeConfigId(),
    };
    // Tunarr gives the channel an id of its own, whatever id is sent: read it from the answer.
    const made = rec(await this.post('/api/channels', { type: 'new', channel }), 'created channel');
    return this.channel(str(made['id'], 'created channel id'));
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
        exact: num(o['duration'], 'clip duration'),
      };
    });
  }

  /**
   * Every result of a search. Tunarr counts pages from 0, and a search that drops results would be
   * silent, so the number collected is checked against the total the server reports.
   */
  private async search(filter: Json, pageSize = 200): Promise<Json[]> {
    const fetchPage = async (page: number): Promise<{ results: Json[]; totalHits: number; totalPages: number }> => {
      const d = rec(await this.post('/api/programs/search', { query: { query: null, filter }, page, limit: pageSize }), 'search');
      return { results: arr(d['results'], 'results').map((r) => rec(r, 'result')), totalHits: num(d['totalHits'], 'totalHits'), totalPages: num(d['totalPages'], 'totalPages') };
    };
    const first = await fetchPage(0);
    const pages: Json[][] = [first.results];
    // The rest of the pages are asked for a few at a time: a large library is many pages, each slow on its own.
    const rest = Array.from({ length: Math.max(0, first.totalPages - 1) }, (_, i) => i + 1);
    for (let i = 0; i < rest.length; i += SEARCH_PARALLEL) {
      pages.push(...(await Promise.all(rest.slice(i, i + SEARCH_PARALLEL).map(async (p) => (await fetchPage(p)).results))));
    }
    const out = pages.flat();
    if (out.length !== first.totalHits) {
      throw new Error(`the search returned ${out.length} results but Tunarr reports ${first.totalHits}`);
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
      exact: num(r['duration'], 'movie duration'),
      genres: names(r['genres']),
      year: typeof r['year'] === 'number' ? r['year'] : null,
      rating: typeof r['rating'] === 'string' ? r['rating'] : null,
      studios: names(r['studios']),
      tags: strings(r['tags']),
      actors: names(r['actors']),
      directors: names(r['directors']),
    }));
  }

  /** Every video of every local media source. Pick the ones wanted by their path. */
  async otherVideos(): Promise<VideoInfo[]> {
    const results = await this.search({
      type: 'value',
      fieldSpec: { key: 'type', name: 'type', type: 'string', op: '=', value: ['other_video'] },
    }, 1000);
    return results.map((r) => ({
      id: str(r['uuid'], 'uuid'),
      title: str(r['title'], 'title'),
      duration: Math.round(num(r['duration'], 'video duration')),
      exact: num(r['duration'], 'video duration'),
      path: typeof r['externalId'] === 'string' ? r['externalId'] : '',
      tags: strings(r['tags']),
    }));
  }

  async shows(): Promise<ShowInfo[]> {
    const results = await this.search({
      type: 'value',
      fieldSpec: { key: 'type', name: 'type', type: 'string', op: '=', value: ['show'] },
    });
    return results.map((r) => ({
      id: str(r['uuid'], 'uuid'),
      title: str(r['title'], 'title'),
      year: typeof r['year'] === 'number' ? r['year'] : null,
      rating: typeof r['rating'] === 'string' ? r['rating'] : null,
      studios: names(r['studios']),
      tags: strings(r['tags']),
      actors: names(r['actors']),
    }));
  }

  /**
   * The ids of the movies, or of the shows (those with an episode that matches), for a field that the library keeps in its
   * search index and does not return in a result: the genres of a show, the audio languages, the subtitle languages.
   * Language values are three-letter codes ("fra").
   */
  async idsWhere(kind: 'movie' | 'show', field: IdsField, values: readonly string[]): Promise<Set<string>> {
    const key = { genre: kind === 'show' ? 'grandparent.genres' : 'genres.name', audio: 'audioLanguages', subtitles: 'subtitleLanguages' }[field];
    const type = kind === 'movie' ? 'movie' : 'episode';
    const filter = {
      type: 'op', op: 'and',
      children: [
        { type: 'value', fieldSpec: { key: 'type', name: 'type', type: 'string', op: '=', value: [type] } },
        { type: 'value', fieldSpec: { key, name: field, type: 'faceted_string', op: 'in', value: [...values] } },
      ],
    };
    if (kind === 'show') {
      const quick = await this.showIdsByFacet(filter);
      if (quick) return quick;
    }
    const out = new Set<string>();
    for (const r of await this.search(filter, 1000)) {
      const id = kind === 'movie' ? r['uuid'] : r['showId'];
      if (typeof id === 'string') out.add(id);
    }
    return out;
  }

  /**
   * The shows that have an episode matching the filter, from one facet call (the titles of the matching episodes' shows) instead
   * of paging through every matching episode. Undefined when that cannot be trusted: the facet is full (it may have been cut
   * short), or a title is not any show's title; the caller then pages through the episodes.
   */
  private async showIdsByFacet(filter: Json): Promise<Set<string> | undefined> {
    let titles: string[];
    try {
      const d = rec(await this.post('/api/programs/facets/grandparent.title', { filter }), 'facet');
      titles = Object.keys(rec(d['facetValues'], 'facetValues'));
    } catch {
      return undefined; // a Tunarr without this facet: page through the episodes instead
    }
    if (titles.length >= FACET_LIMIT) return undefined;
    const byTitle = new Map<string, string[]>();
    for (const s of await this.shows()) byTitle.set(s.title, [...(byTitle.get(s.title) ?? []), s.id]);
    const out = new Set<string>();
    for (const t of titles) {
      const ids = byTitle.get(t);
      if (!ids) return undefined;
      if (ids.length === 1) { out.add(ids[0]!); continue; }
      // Two shows share the title: ask which of them have a matching episode.
      const narrowed = { type: 'op', op: 'and', children: [filter, { type: 'value', fieldSpec: { key: 'grandparent.title', name: 'its show', type: 'faceted_string', op: '=', value: [t] } }] };
      for (const r of await this.search(narrowed, 1000)) if (typeof r['showId'] === 'string') out.add(r['showId']);
    }
    return out;
  }

  /** All the episodes of a show, in the order a viewer would watch them: by season, then episode. */
  /**
   * The chapter markers of one program, earliest first, or an empty list when it has none. Tunarr only
   * gives them in a program's stream details, one call per program (about 0.4 s each). A marker of a
   * type DayTuner does not know counts as a plain chapter.
   */
  async chapters(programId: string): Promise<ChapterInfo[]> {
    const d = rec(await this.get(`/api/programs/${programId}/stream_details`), 'stream details');
    const sd = rec(rec(d['details'], 'details')['streamDetails'], 'streamDetails');
    return arr(sd['chapters'] ?? [], 'chapters')
      .map((c) => {
        const o = rec(c, 'chapter');
        const type = CHAPTER_TYPES.find((t) => t === o['chapterType']) ?? 'chapter';
        return { start: Math.round(num(o['startTime'], 'chapter start')), end: Math.round(num(o['endTime'], 'chapter end')), type };
      })
      .sort((a, b) => a.start - b.start);
  }

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
        exact: num(item['duration'], 'episode duration'),
        season: season && typeof season['index'] === 'number' ? season['index'] : 0,
        episode: typeof p['episodeNumber'] === 'number' ? p['episodeNumber'] : 0,
        ...(typeof p['releaseDate'] === 'number' ? { aired: p['releaseDate'] } : {}),
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
