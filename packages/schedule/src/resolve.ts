// Resolves a parsed channel file against a library: shows and movies become program ids, filler
// list names become clip lists. The result is exactly what the engine's plan() takes.
// The source is anything shaped like the Tunarr client, so tests can use a fake one.

import type { AdPosition, Library, Pool, Schedule, SlotDef } from '@daytuner/engine';
import { DAY_NAMES, type ScheduleFile } from './file.js';
import { matchesFilter } from './units.js';

export interface LibrarySource {
  movies(): Promise<{ id: string; title: string; duration: number; genres: string[] }[]>;
  shows(): Promise<{ id: string; title: string }[]>;
  episodes(showId: string): Promise<{ id: string; title: string; duration: number; season: number; episode: number }[]>;
  fillerLists(): Promise<{ id: string; name: string }[]>;
  fillerListClips(listId: string): Promise<{ id: string; duration: number }[]>;
}

export interface Resolved {
  schedule: Schedule;
  library: Library;
  /** Tunarr's id for each clip list the schedule uses, for writing lineup items. */
  fillerListIds: Record<string, string>;
  /** A readable name for every program the schedule can use, to show people instead of ids. */
  titles: Record<string, string>;
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

export async function resolveSchedule(file: ScheduleFile, source: LibrarySource): Promise<Resolved> {
  const programs: Library['programs'] = {};
  const titles: Record<string, string> = {};

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
    clips[name] = (await source.fillerListClips(found.id)).map((c) => ({ id: c.id, duration: c.duration }));
  }

  // Pools.
  let showList: Awaited<ReturnType<LibrarySource['shows']>> | undefined;
  let movieList: Awaited<ReturnType<LibrarySource['movies']>> | undefined;
  const episodesOfShow = async (title: string) => {
    showList ??= await source.shows();
    const matches = showList.filter((s) => same(s.title, title));
    if (matches.length === 0) throw new ResolveError(`there is no show named "${title}"`);
    if (matches.length > 1) throw new ResolveError(`there is more than one show named "${title}"`);
    return source.episodes(matches[0]!.id);
  };

  const pools: Record<string, Pool> = {};
  for (const [name, def] of Object.entries(file.pools)) {
    let ids: string[];
    let order: Pool['order'];
    if (def.shows) {
      const perShow: string[][] = [];
      for (const title of def.shows) {
        const eps = await episodesOfShow(title);
        for (const e of eps) {
          programs[e.id] = { duration: e.duration };
          titles[e.id] = `${title} S${e.season}E${e.episode} "${e.title}"`;
        }
        perShow.push(eps.map((e) => e.id));
      }
      ids = takeTurns(perShow);
      order = def.order === 'shuffle' ? 'shuffled' : 'ordered';
    } else {
      movieList ??= await source.movies();
      const m = def.movies!;
      const chosen = movieList.filter(
        (x) => (m.genre === undefined || x.genres.some((g) => same(g, m.genre!))) && (m.duration === undefined || matchesFilter(x.duration, m.duration)),
      );
      for (const x of chosen) {
        programs[x.id] = { duration: x.duration };
        titles[x.id] = x.title;
      }
      ids = chosen.map((x) => x.id);
      order = def.order === 'sequential' ? 'ordered' : 'shuffled';
    }
    if (ids.length === 0) throw new ResolveError(`pool "${name}" matches nothing in the library`);
    pools[name] = { order, programs: ids };
  }

  // Exceptions: each plays one chosen program.
  const exceptions: Schedule['exceptions'][number][] = [];
  for (const e of file.exceptions) {
    let programId: string;
    if ('show' in e.play) {
      const eps = await episodesOfShow(e.play.show);
      const ep = eps.find((x) => same(x.title, (e.play as { title: string }).title));
      if (!ep) throw new ResolveError(`"${e.play.show}" has no episode titled "${e.play.title}"`);
      programs[ep.id] = { duration: ep.duration };
      titles[ep.id] = `${e.play.show} "${ep.title}"`;
      programId = ep.id;
    } else {
      movieList ??= await source.movies();
      const title = e.play.movie;
      const mv = movieList.find((x) => same(x.title, title));
      if (!mv) throw new ResolveError(`there is no movie titled "${title}"`);
      programs[mv.id] = { duration: mv.duration };
      titles[mv.id] = mv.title;
      programId = mv.id;
    }
    if (typeof e.counts === 'string' && !(e.counts in pools)) throw new ResolveError(`exception counts against an unknown pool "${e.counts}"`);
    exceptions.push({ on: e.on, at: e.at, programId, ...(e.counts !== undefined ? { counts: e.counts } : {}) });
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
      });
    }
  });

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
    ...(file.interstitial ? { interstitial: file.interstitial } : {}),
    pools,
    week,
    exceptions,
  };
  return { schedule, library: { programs, clips }, fillerListIds, titles };
}
