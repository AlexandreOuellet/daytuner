// Pool rules: which movies and shows a rule describes. DayTuner evaluates these itself on every plan; the library only supplies
// each item's metadata, and the ids that match a field it keeps in an index and does not return (a show's genres, the audio and
// subtitle languages). See docs/pool-rules.md.

import type { MovieRule, ShowRule, YearSpan } from './file.js';
import { languageVariants } from './languages.js';
import { matchesFilter } from './units.js';

export interface RuleMovie {
  id: string;
  title: string;
  duration: number;
  genres: string[];
  year?: number | null;
  rating?: string | null;
  studios?: string[];
  tags?: string[];
  actors?: string[];
  directors?: string[];
}

export interface RuleShow {
  id: string;
  title: string;
  year?: number | null;
  rating?: string | null;
  studios?: string[];
  tags?: string[];
  actors?: string[];
}

export type IndexField = 'genre' | 'audio' | 'subtitles';

export interface RuleSource {
  /** Ids of the movies, or the shows, that the library's index says match. Without it a rule on these fields cannot be used. */
  idsWhere?(kind: 'movie' | 'show', field: IndexField, values: readonly string[]): Promise<Set<string>>;
}

export class RuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuleError';
  }
}

const norm = (s: string): string =>
  s.replace(/[‘’ʼ]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim().toLowerCase();
const anyEqual = (wanted: readonly string[], have: readonly string[] | string | null | undefined): boolean => {
  const mine = (Array.isArray(have) ? have : have == null ? [] : [have]).map(norm);
  return wanted.some((w) => mine.includes(norm(w)));
};
const inYears = (span: YearSpan, year: number | null | undefined): boolean => year != null && year >= span.from && year <= span.to;

/** Looks up and remembers the index answers of one resolve, so a rule used twice asks once. */
export function indexLookup(source: RuleSource): (kind: 'movie' | 'show', field: IndexField, values: readonly string[]) => Promise<Set<string>> {
  const seen = new Map<string, Promise<Set<string>>>();
  return (kind, field, values) => {
    if (!source.idsWhere) throw new RuleError(`a rule on ${field === 'genre' ? 'the genre of a show' : field === 'audio' ? 'the audio language' : 'the subtitle language'} needs a library that can look it up, and this one cannot`);
    const key = `${kind}:${field}:${[...values].sort().join(',')}`;
    let hit = seen.get(key);
    if (!hit) seen.set(key, (hit = source.idsWhere(kind, field, values)));
    return hit;
  };
}

type Lookup = ReturnType<typeof indexLookup>;
type Common = ShowRule | MovieRule;

/** The ids a rule's index conditions allow, as one set per condition. */
async function remoteSets(rule: Common, kind: 'movie' | 'show', look: Lookup, genreInIndex: boolean): Promise<Set<string>[]> {
  const sets: Set<string>[] = [];
  if (rule.genre && genreInIndex) sets.push(await look(kind, 'genre', rule.genre));
  if (rule.audio) sets.push(await look(kind, 'audio', [...new Set(rule.audio.flatMap(languageVariants))]));
  if (rule.subtitles) sets.push(await look(kind, 'subtitles', [...new Set(rule.subtitles.flatMap(languageVariants))]));
  return sets;
}

function movieLocal(r: MovieRule, m: RuleMovie): boolean {
  return (r.genre === undefined || anyEqual(r.genre, m.genres))
    && (r.title === undefined || r.title.some((t) => norm(m.title).includes(norm(t))))
    && (r.year === undefined || inYears(r.year, m.year))
    && (r.rating === undefined || anyEqual(r.rating, m.rating))
    && (r.studio === undefined || anyEqual(r.studio, m.studios))
    && (r.tag === undefined || anyEqual(r.tag, m.tags))
    && (r.actor === undefined || anyEqual(r.actor, m.actors))
    && (r.director === undefined || anyEqual(r.director, m.directors))
    && (r.duration === undefined || matchesFilter(m.duration, r.duration));
}

function showLocal(r: ShowRule, s: RuleShow): boolean {
  return (r.title === undefined || r.title.some((t) => norm(s.title).includes(norm(t))))
    && (r.year === undefined || inYears(r.year, s.year))
    && (r.rating === undefined || anyEqual(r.rating, s.rating))
    && (r.studio === undefined || anyEqual(r.studio, s.studios))
    && (r.tag === undefined || anyEqual(r.tag, s.tags))
    && (r.actor === undefined || anyEqual(r.actor, s.actors));
}

/** The movies that meet the conditions beside `match` and any one of the `match` rules (all of them when there are none), minus `except`. */
export async function selectMovies(
  movies: readonly RuleMovie[],
  def: { match?: MovieRule[]; except?: MovieRule[] } & MovieRule,
  source: RuleSource,
  look: Lookup = indexLookup(source),
): Promise<RuleMovie[]> {
  const { match, except, ...beside } = def;
  const holds = async (rule: MovieRule): Promise<(m: RuleMovie) => boolean> => {
    const sets = await remoteSets(rule, 'movie', look, false);
    return (m) => movieLocal(rule, m) && sets.every((s) => s.has(m.id));
  };
  const base = await holds(beside);
  const anyOf = match ? await Promise.all(match.map(holds)) : undefined;
  const not = await Promise.all((except ?? []).map(holds));
  return movies.filter((m) => base(m) && (anyOf === undefined || anyOf.some((f) => f(m))) && !not.some((f) => f(m)));
}

/** The shows that meet any of the rules, minus those an `except` entry names or describes. */
export async function selectShows(
  shows: readonly RuleShow[],
  rules: readonly ShowRule[],
  except: readonly (ShowRule | { show: string; id?: string })[],
  source: RuleSource,
  look: Lookup = indexLookup(source),
): Promise<RuleShow[]> {
  const holds = async (rule: ShowRule): Promise<(s: RuleShow) => boolean> => {
    const sets = await remoteSets(rule, 'show', look, true);
    return (s) => showLocal(rule, s) && sets.every((x) => x.has(s.id));
  };
  const any = await Promise.all(rules.map(holds));
  const named: ((s: RuleShow) => boolean)[] = [];
  for (const e of except) {
    if ('show' in e) named.push((s) => (e.id !== undefined ? s.id === e.id : norm(s.title) === norm(e.show)));
    else named.push(await holds(e));
  }
  return shows.filter((s) => any.some((f) => f(s)) && !named.some((f) => f(s)));
}
