// Resolves a parsed channel file against a library: shows and movies become program ids, filler
// list names become clip lists. The result is exactly what the engine's plan() takes.
// The source is anything shaped like the Tunarr client, so tests can use a fake one.

import { FILL_LINK, gapsOf } from './weekplan.js';
import type { AdPosition, Chapter, Library, Pool, Schedule, SlotDef } from '@daytuner/engine';
import { DAY_NAMES, tagIndexOf, type PoolDef, type ScheduleFile } from './file.js';
import { hasAnyTag, type TagIndex } from './tags.js';
import { matchesFilter } from './units.js';
import { indexLookup, RuleError, selectMovies, selectShows, type RuleMovie, type RuleShow, type RuleSource } from './rules.js';

export interface LibrarySource extends RuleSource {
  movies(): Promise<RuleMovie[]>;
  shows(): Promise<RuleShow[]>;
  episodes(showId: string): Promise<{ id: string; title: string; duration: number; exact?: number; season: number; episode: number; aired?: number }[]>;
  fillerLists(): Promise<{ id: string; name: string }[]>;
  fillerListClips(listId: string): Promise<{ id: string; duration: number; exact?: number; title?: string }[]>;
  /** The videos of local media sources (music videos, concerts). Optional: without it a `videos` pool cannot be resolved. */
  otherVideos?(): Promise<{ id: string; title: string; duration: number; exact?: number; path: string; tags?: string[] }[]>;
  /** Chapter markers of one program. Optional: a source without it plans with the every-N-minutes offers. */
  chapters?(programId: string, duration: number): Promise<{ start: number; end: number; type: Chapter['type'] }[]>;
}

/** How many chapter requests run at once. Each takes about 0.4 s in Tunarr. */
const CHAPTER_CONCURRENCY = 8;

const emptyTags: TagIndex = { tagsOf: () => [], all: new Set() };

export interface Resolved {
  schedule: Schedule;
  library: Library;
  /** Tunarr's id for each clip list the schedule uses, for writing lineup items. */
  fillerListIds: Record<string, string>;
  /** A readable name for every program the schedule can use, to show people instead of ids. */
  titles: Record<string, string>;
  /** Things worth telling the owner that do not stop the plan, such as a label that no longer matches. */
  notes: string[];
}

export class ResolveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResolveError';
  }
}

/** Titles match ignoring case, spacing, and the difference between straight and curly quotes. */
const normalize = (s: string): string =>
  s.replace(/[\u2018\u2019\u02bc]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/\s+/g, ' ').trim().toLowerCase();
export const same = (a: string, b: string): boolean => normalize(a) === normalize(b);

/** One episode of each show in turn; a show that runs out drops out. */
export function takeTurns<T>(lists: readonly (readonly T[])[]): T[] {
  const out: T[] = [];
  const longest = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < longest; i++) for (const l of lists) if (i < l.length) out.push(l[i]!);
  return out;
}

export interface ResolvedPool {
  ids: string[];
  /** The shows of a pool of shows, in turn order, with how many episodes each gives. */
  members?: { id: string; title: string; episodes: number }[];
  order: Pool['order'];
  programs: Record<string, { duration: number }>;
  titles: Record<string, string>;
}

/**
 * Turns a pool definition (shows, or a movie filter) into the programs it holds, with their lengths and readable names.
 * One resolver keeps the show and movie lists it reads, so resolving several pools reads each list once.
 */
/** How many shows' episode lists are read at once. */
const EPISODE_READS = 6;

type Episode = Awaited<ReturnType<LibrarySource['episodes']>>[number];

/** The episodes a pool plays: the seasons asked for, without specials when told, no shorter or longer than asked, in the order asked. */
function applyEpisodeRules(eps: Episode[], rules: PoolDef['episodes']): Episode[] {
  if (!rules) return eps;
  let out = eps.filter((e) =>
    (rules.seasons === undefined || (e.season >= rules.seasons.from && e.season <= rules.seasons.to))
    && (rules.specials !== 'skip' || e.season !== 0)
    && (rules.duration === undefined || matchesFilter(e.duration, rules.duration)));
  if (rules.order === 'airdate') {
    out = [...out].sort((a, b) => (a.aired ?? Infinity) - (b.aired ?? Infinity) || a.season - b.season || a.episode - b.episode);
  }
  return out;
}

export function makeLibraryReader(source: Pick<LibrarySource, 'movies' | 'shows' | 'episodes' | 'idsWhere'> & Partial<Pick<LibrarySource, 'otherVideos'>>, notes: string[] = [], tags: TagIndex = emptyTags): {
  pool: (def: PoolDef) => Promise<ResolvedPool>;
  episodesOfShow: (title: string, id?: string) => ReturnType<LibrarySource['episodes']>;
  movies: () => ReturnType<LibrarySource['movies']>;
} {
  let showList: Awaited<ReturnType<LibrarySource['shows']>> | undefined;
  let movieList: Awaited<ReturnType<LibrarySource['movies']>> | undefined;
  let videoList: Awaited<ReturnType<NonNullable<LibrarySource['otherVideos']>>> | undefined;
  const resolveShow = async (title: string, id?: string): Promise<RuleShow> => {
    showList ??= await source.shows();
    if (id !== undefined) {
      const found = showList.find((s) => s.id === id);
      if (!found) throw new ResolveError(`there is no show with id "${id}" (labelled "${title}")`);
      if (!same(found.title, title)) notes.push(`the show with id "${id}" is now titled "${found.title}", the file labels it "${title}"`);
      return found;
    }
    const matches = showList.filter((s) => same(s.title, title));
    if (matches.length === 0) throw new ResolveError(`there is no show named "${title}"`);
    if (matches.length > 1) {
      throw new ResolveError(`there is more than one show named "${title}"; add an id: ${matches.map((m) => m.id).join(', ')}`);
    }
    return matches[0]!;
  };
  const episodesOfShow = async (title: string, id?: string) => source.episodes((await resolveShow(title, id)).id);
  const movies = async () => (movieList ??= await source.movies());
  const look = indexLookup(source);
  const showsList = async () => (showList ??= await source.shows());
  const pool = async (def: PoolDef): Promise<ResolvedPool> => {
    const programs: ResolvedPool['programs'] = {};
    const titles: ResolvedPool['titles'] = {};
    let ids: string[];
    let order: Pool['order'];
    let members: ResolvedPool['members'];
    try {
      if (def.shows) {
        // Shows named by hand come first and win over a rule that finds the same show; each show appears once.
        const all = await showsList();
        const entries: { id: string; title: string; named: boolean; entry: number }[] = [];
        const named = new Set<string>();
        const foundNamed = new Map<number, RuleShow>();
        for (const [i, ref] of def.shows.entries()) {
          if (typeof ref !== 'string' && 'match' in ref) continue;
          const { title, id } = typeof ref === 'string' ? { title: ref, id: undefined } : { title: ref.show, id: ref.id };
          const found = await resolveShow(title, id);
          foundNamed.set(i, found);
          named.add(found.id);
        }
        let n = 0;
        for (const [i, ref] of def.shows.entries()) {
          if (typeof ref === 'string' || !('match' in ref)) {
            const title = typeof ref === 'string' ? ref : ref.show;
            const found = foundNamed.get(i)!;
            if (!entries.some((e) => e.id === found.id)) entries.push({ id: found.id, title, named: true, entry: n });
          } else {
            const hit = await selectShows(all, ref.match, ref.except ?? [], source, look);
            for (const sh of hit.sort((x, y) => x.title.localeCompare(y.title))) {
              if (!named.has(sh.id) && !entries.some((e) => e.id === sh.id)) entries.push({ id: sh.id, title: sh.title, named: false, entry: n });
            }
          }
          n++;
        }
        const perShow: string[][] = [];
        members = [];
        // The episodes of the shows are read a few at a time.
        const read: Episode[][] = new Array(entries.length);
        let next = 0;
        await Promise.all(Array.from({ length: Math.min(EPISODE_READS, entries.length) }, async () => {
          while (next < entries.length) { const i = next++; read[i] = await source.episodes(entries[i]!.id); }
        }));
        for (const [i, sh] of entries.entries()) {
          const eps = applyEpisodeRules(read[i]!, def.episodes);
          for (const e of eps) {
            programs[e.id] = { duration: e.duration, ...(e.exact !== undefined ? { exact: e.exact } : {}) };
            titles[e.id] = `${sh.title} S${e.season}E${e.episode} "${e.title}"`;
          }
          if (eps.length === 0) continue;
          perShow.push(eps.map((e) => e.id));
          members.push({ id: sh.id, title: sh.title, episodes: eps.length });
        }
        ids = takeTurns(perShow);
        order = def.order === 'shuffle' ? 'shuffled' : 'ordered';
      } else if (def.videos) {
        if (!source.otherVideos) throw new ResolveError('this library source cannot read local videos, so a videos pool cannot be resolved');
        videoList ??= await source.otherVideos();
        const v = def.videos;
        const prefix = v.path.endsWith('/') ? v.path : `${v.path}/`;
        const chosen = videoList
          .filter((x) => x.path.startsWith(prefix))
          .filter((x) => v.title === undefined || v.title.some((t) => normalize(x.title).includes(normalize(t))))
          .filter((x) => v.duration === undefined || matchesFilter(x.duration, v.duration))
          .filter((x) => v.tag === undefined || hasAnyTag(tags.tagsOf(x.title), v.tag))
          .sort((a, b) => a.path.localeCompare(b.path));
        for (const x of chosen) {
          programs[x.id] = { duration: x.duration, ...(x.exact !== undefined ? { exact: x.exact } : {}) };
          titles[x.id] = x.title;
        }
        ids = chosen.map((x) => x.id);
        order = def.order === 'sequential' ? 'ordered' : 'shuffled';
      } else {
        const chosen = await selectMovies(await movies(), def.movies!, source, look);
        for (const x of chosen) {
          programs[x.id] = { duration: x.duration, ...(x.exact !== undefined ? { exact: x.exact } : {}) };
          titles[x.id] = x.title;
        }
        ids = chosen.map((x) => x.id);
        order = def.order === 'sequential' ? 'ordered' : 'shuffled';
      }
    } catch (e) {
      if (e instanceof RuleError) throw new ResolveError(e.message);
      throw e;
    }
    return { ids, order, programs, titles, ...(members ? { members } : {}) };
  };
  return { pool, episodesOfShow, movies };
}

export async function resolveSchedule(file: ScheduleFile, source: LibrarySource): Promise<Resolved> {
  const programs: Library['programs'] = {};
  const titles: Record<string, string> = {};
  const notes: string[] = [];

  const tags = tagIndexOf(file);

  // Clip lists.
  const listNames = new Set<string>();
  for (const p of [file.ads.head, file.ads.pre, file.ads.post, file.ads.tail, file.ads.mid]) if (p?.list) listNames.add(p.list);
  for (const b of Object.values(file.bumpers)) if (b) listNames.add(b.list);
  if (file.interstitial) listNames.add(file.interstitial.list);
  const available = await source.fillerLists();
  const fillerListIds: Record<string, string> = {};
  const clips: Library['clips'] = {};
  for (const name of listNames) {
    const found = available.find((l) => same(l.name, name));
    if (!found) {
      throw new ResolveError(`there is no filler list named "${name}" (available: ${available.map((l) => l.name).join(', ') || 'none'})`);
    }
    fillerListIds[name] = found.id;
    clips[name] = (await source.fillerListClips(found.id)).map((c) => {
      const t = c.title ? tags.tagsOf(c.title) : [];
      return { id: c.id, duration: c.duration, ...(c.exact !== undefined ? { exact: c.exact } : {}), ...(t.length > 0 ? { tags: t } : {}) };
    });
  }

  // Pools.
  const reader = makeLibraryReader(source, notes, tags);
  const resolvePool = reader.pool;
  const episodesOfShow = reader.episodesOfShow;
  const pools: Record<string, Pool> = {};
  for (const [name, def] of Object.entries(file.pools)) {
    const r = await resolvePool(def);
    Object.assign(programs, r.programs);
    Object.assign(titles, r.titles);
    const { ids, order } = r;
    if (ids.length === 0) throw new ResolveError(`pool "${name}" matches nothing in the library`);
    pools[name] = { order, programs: ids };
  }

  // Exceptions: each plays one chosen program.
  const exceptions: Schedule['exceptions'][number][] = [];
  for (const e of file.exceptions) {
    let programId: string;
    if ('show' in e.play) {
      const eps = await episodesOfShow(e.play.show, e.play.id);
      const ep = eps.find((x) => same(x.title, (e.play as { title: string }).title));
      if (!ep) throw new ResolveError(`"${e.play.show}" has no episode titled "${e.play.title}"`);
      programs[ep.id] = { duration: ep.duration, ...(ep.exact !== undefined ? { exact: ep.exact } : {}) };
      titles[ep.id] = `${e.play.show} "${ep.title}"`;
      programId = ep.id;
    } else {
      const movieList = await reader.movies();
      const title = e.play.movie;
      const mv = e.play.id !== undefined ? movieList.find((x) => x.id === e.play.id) : movieList.find((x) => same(x.title, title));
      if (!mv) throw new ResolveError(e.play.id !== undefined ? `there is no movie with id "${e.play.id}" (labelled "${title}")` : `there is no movie titled "${title}"`);
      if (e.play.id !== undefined && !same(mv.title, title)) notes.push(`the movie with id "${e.play.id}" is now titled "${mv.title}", the file labels it "${title}"`);
      programs[mv.id] = { duration: mv.duration, ...(mv.exact !== undefined ? { exact: mv.exact } : {}) };
      titles[mv.id] = mv.title;
      programId = mv.id;
    }
    if (typeof e.counts === 'string' && !(e.counts in pools)) throw new ResolveError(`exception counts against an unknown pool "${e.counts}"`);
    exceptions.push({ on: e.on, at: e.at, programId, ...(e.counts !== undefined ? { counts: e.counts } : {}) });
  }

  // Chapters, for the programs a mid break could split. Without mid breaks nothing needs them.
  if (file.ads.mid && source.chapters) {
    const ids = Object.keys(programs);
    let next = 0;
    let failed = 0;
    const worker = async (): Promise<void> => {
      while (next < ids.length) {
        const id = ids[next++]!;
        try {
          const chapters = await source.chapters!(id, programs[id]!.duration);
          if (chapters.length > 0) programs[id] = { ...programs[id]!, chapters };
        } catch {
          failed++;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CHAPTER_CONCURRENCY, ids.length) }, worker));
    if (failed > 0) notes.push(`chapters could not be read for ${failed} of ${ids.length} programs; they use the every-N-minutes offers`);
  }

  // The week.
  const week: SlotDef[] = [];
  DAY_NAMES.forEach((dayName, day) => {
    for (const s of file.week[dayName] ?? []) {
      week.push({
        day,
        at: s.at,
        pool: s.pool,
        ...(s.link ? { link: { name: s.link, mode: s.linkMode ?? 'continue' } } : {}),
        ...(s.run ? { run: true as const } : {}),
        ...(s.tags ? { tags: s.tags } : {}),
      });
    }
  });
  // Time no slot covers is played from the fill pool: one more start-only slot per gap, all sharing one place in it.
  const spans = DAY_NAMES.flatMap((dayName, day) => (file.week[dayName] ?? []).map((s) => ({ day, at: s.at, ...(s.length !== undefined ? { length: s.length } : {}) })));
  for (const g of gapsOf(spans)) {
    week.push({ day: g.day, at: g.at, pool: file.fill!, link: { name: FILL_LINK, mode: 'continue' } });
  }

  const position = (p: { list?: string | undefined; length: { min: number; max: number } } | undefined): AdPosition | undefined =>
    p && p.list && p.length.max > 0 ? { list: p.list, range: p.length } : undefined;
  const a = file.ads;
  const head = position(a.head);
  const pre = position(a.pre);
  const post = position(a.post);
  const tail = position(a.tail);
  const schedule: Schedule = {
    grid: file.grid,
    zone: file.timezone,
    ads: {
      step: a.step,
      ratio: a.ratio,
      ...(head ? { head } : {}),
      ...(pre ? { pre } : {}),
      ...(post ? { post } : {}),
      ...(tail ? { tail } : {}),
      ...(a.mid
        ? {
            mid: {
              list: a.mid.list,
              range: a.mid.length,
              offers: { every: a.mid.every, tailBuffer: a.mid.tailBuffer, ...(a.mid.chapterTypes ? { chapterTypes: a.mid.chapterTypes } : {}) },
              ...(a.mid.minGap ? { minGap: a.mid.minGap } : {}),
            },
          }
        : {}),
    },
    bumpers: file.bumpers,
    ...(file.interstitial
      ? {
          interstitial: {
            list: file.interstitial.list,
            ...(file.interstitial.length ? { length: file.interstitial.length } : {}),
            ...(file.interstitial.cooldown !== undefined ? { cooldown: file.interstitial.cooldown } : {}),
            ...(file.interstitial.cut !== undefined ? { cut: file.interstitial.cut } : {}),
          },
        }
      : {}),
    pools,
    week,
    exceptions,
  };
  return { schedule, library: { programs, clips }, fillerListIds, titles, notes };
}

/**
 * Finds one program in the library from text: `movie:Title`, or `episode:Show/Episode title`. Matching ignores
 * case and quote style. More than one match, or none, is an error that says what was found.
 */
export async function findProgram(
  source: Pick<LibrarySource, 'movies' | 'shows' | 'episodes' | 'idsWhere'>,
  spec: string,
): Promise<{ id: string; title: string; duration: number }> {
  const movie = /^movie:(.+)$/s.exec(spec.trim());
  if (movie) {
    const title = movie[1]!.trim();
    const found = (await source.movies()).filter((m) => same(m.title, title));
    if (found.length === 0) throw new ResolveError(`there is no movie titled "${title}"`);
    if (found.length > 1) throw new ResolveError(`there is more than one movie titled "${title}" (${found.map((m) => m.id).join(', ')})`);
    return { id: found[0]!.id, title: found[0]!.title, duration: found[0]!.duration };
  }
  const ep = /^episode:(.+?)\/(.+)$/s.exec(spec.trim());
  if (ep) {
    const [show, title] = [ep[1]!.trim(), ep[2]!.trim()];
    const shows = (await source.shows()).filter((x) => same(x.title, show));
    if (shows.length === 0) throw new ResolveError(`there is no show named "${show}"`);
    if (shows.length > 1) throw new ResolveError(`there is more than one show named "${show}" (${shows.map((x) => x.id).join(', ')})`);
    const found = (await source.episodes(shows[0]!.id)).filter((e) => same(e.title, title));
    if (found.length === 0) throw new ResolveError(`"${show}" has no episode titled "${title}"`);
    if (found.length > 1) throw new ResolveError(`"${show}" has more than one episode titled "${title}"`);
    return { id: found[0]!.id, title: `${shows[0]!.title} "${found[0]!.title}"`, duration: found[0]!.duration };
  }
  throw new ResolveError(`"${spec}" is not a program: write movie:Title or episode:Show/Episode title`);
}
