import { describe, expect, it } from 'vitest';
import { parseScheduleFile } from './file.js';
import { makeLibraryReader, ResolveError, type LibrarySource } from './resolve.js';

const ep = (id: string, season: number, episode: number, minutes = 22, aired?: number) => ({ id, title: id, duration: minutes * 60_000, season, episode, ...(aired !== undefined ? { aired } : {}) });

const MOVIES = [
  { id: 'm1', title: 'Amélie', duration: 122 * 60_000, genres: ['Comedy', 'Romance'], year: 2001, rating: 'R', studios: ['Claudie Ossard'], tags: ['paris'], actors: ['Audrey Tautou'], directors: ['Jean-Pierre Jeunet'] },
  { id: 'm2', title: 'Airplane!', duration: 87 * 60_000, genres: ['Comedy'], year: 1980, rating: 'PG', studios: ['Paramount'], tags: ['spoof'], actors: ['Leslie Nielsen'], directors: ['Jim Abrahams'] },
  { id: 'm3', title: 'Das Boot', duration: 149 * 60_000, genres: ['War', 'Drama'], year: 1981, rating: 'R', studios: [], tags: [], actors: [], directors: [] },
  { id: 'm4', title: 'Parasite', duration: 132 * 60_000, genres: ['Thriller', 'Drama'], year: 2019, rating: 'R', studios: [], tags: [], actors: [], directors: [] },
  { id: 'm5', title: 'Ghost Dog', duration: 116 * 60_000, genres: ['Crime'], year: 1999, rating: 'R', studios: [], tags: [], actors: [], directors: [] },
];
const AUDIO: Record<string, string[]> = { fra: ['m1'], deu: ['m3'], kor: ['m4'], eng: ['m2', 'm5'] };
const SUBS: Record<string, string[]> = { fra: ['m3', 'm4', 'm5'], eng: ['m1', 'm3', 'm4'] };
const SHOWS = [
  { id: 's1', title: 'Columbo', year: 1971, rating: 'CA-PG', studios: [], tags: ['crime'], actors: ['Peter Falk'] },
  { id: 's2', title: 'The Office', year: 2005, rating: 'CA-PG', studios: [], tags: ['sitcom'], actors: [] },
  { id: 's3', title: 'Parks', year: 2009, rating: 'CA-PG', studios: [], tags: ['sitcom'], actors: [] },
  { id: 's4', title: 'Dark', year: 2017, rating: 'CA-18+', studios: [], tags: [], actors: [] },
];
const SHOW_GENRES: Record<string, string[]> = { Comedy: ['s2', 's3'], Crime: ['s1'], Drama: ['s4'] };
const EPS: Record<string, ReturnType<typeof ep>[]> = {
  s1: [ep('c1', 1, 1, 70), ep('c2', 1, 2, 70)],
  s2: [ep('o0', 0, 1, 10), ep('o1', 1, 1), ep('o2', 1, 2), ep('o3', 2, 1)],
  s3: [ep('p1', 1, 1, 21, 3000), ep('p2', 1, 2, 21, 1000)],
  s4: [ep('d1', 1, 1, 50)],
};
const asked: string[] = [];
const source = (): LibrarySource => ({
  movies: async () => MOVIES,
  shows: async () => SHOWS,
  episodes: async (id) => EPS[id] ?? [],
  fillerLists: async () => [],
  fillerListClips: async () => [],
  idsWhere: async (kind, field, values) => {
    asked.push(`${kind}:${field}:${values.join(',')}`);
    const table = field === 'audio' ? AUDIO : field === 'subtitles' ? SUBS : SHOW_GENRES;
    return new Set(values.flatMap((v) => table[v] ?? []));
  },
});

const pool = (yaml: string) => {
  const f = parseScheduleFile(`channel: T\ntimezone: America/Toronto\ngrid: 15m\nads: { step: 15s, ratio: { min: 15%, max: 60% } }\npools:\n  p:\n${yaml.split('\n').map((l) => `    ${l}`).join('\n')}\nweek:\n  sun: [ { at: "08:00", pool: p } ]\n`);
  return f.pools['p']!;
};
const resolve = async (yaml: string) => makeLibraryReader(source()).pool(pool(yaml));

describe('movie rules', () => {
  it('keeps the old genre and length filter working', async () => {
    expect((await resolve('movies: { genre: Comedy, duration: "<=117m" }')).ids).toEqual(['m2']);
  });
  it('matches French audio or French subtitles, independently, each movie once', async () => {
    expect((await resolve('movies:\n  match:\n    - { audio: fra }\n    - { subtitles: French }')).ids).toEqual(['m1', 'm3', 'm4', 'm5']);
    expect((await resolve('movies: { audio: fra }')).ids).toEqual(['m1']);
    expect((await resolve('movies: { subtitles: fra }')).ids).toEqual(['m3', 'm4', 'm5']);
  });
  it('requires everything inside one rule, and everything beside match', async () => {
    expect((await resolve('movies:\n  match: [ { audio: fra, genre: Comedy }, { subtitles: fra, year: 1981 } ]')).ids).toEqual(['m1', 'm3']);
    expect((await resolve('movies:\n  duration: "<=130m"\n  match: [ { subtitles: fra } ]')).ids).toEqual(['m5']);
  });
  it('takes a year, a range, a list, a title part and a rating; except removes', async () => {
    expect((await resolve('movies: { year: 1980-1989 }')).ids).toEqual(['m2', 'm3']);
    expect((await resolve('movies: { year: 1999 }')).ids).toEqual(['m5']);
    expect((await resolve('movies: { rating: [PG, R], title: "ghost" }')).ids).toEqual(['m5']);
    expect((await resolve('movies: { genre: [Comedy, Drama] }\nmovies2: 1'.split('\n')[0]!)).ids).toEqual(['m1', 'm2', 'm3', 'm4']);
    expect((await resolve('movies:\n  genre: [Comedy, Drama]\n  except: [ { tag: spoof }, { director: Jean-Pierre Jeunet } ]')).ids).toEqual(['m3', 'm4']);
    expect((await resolve('movies: { actor: leslie nielsen, studio: Paramount }')).ids).toEqual(['m2']);
  });
  it('asks the library once for a repeated lookup, and says plainly when it cannot', async () => {
    asked.length = 0;
    const reader = makeLibraryReader(source());
    await reader.pool(pool('movies: { audio: fra }'));
    await reader.pool(pool('movies: { audio: fra }'));
    expect(asked).toHaveLength(1);
    const blind = { ...source(), idsWhere: undefined } as LibrarySource;
    await expect(makeLibraryReader(blind).pool(pool('movies: { audio: fra }'))).rejects.toThrow(ResolveError);
  });
  it('rejects a rule with no conditions, which would match everything', () => {
    expect(() => pool('movies:\n  match: [ {} ]')).toThrow(/at least one condition/);
    expect(() => pool('shows:\n  - match: {}')).toThrow(/at least one condition/);
  });
  it('rejects an unknown language and an unknown key when the file is read', () => {
    expect(() => pool('movies: { audio: Klingon-ish }')).toThrow(/not a language/);
    expect(() => pool('movies: { colour: red }')).toThrow();
  });
});

describe('show rules', () => {
  it('finds shows by genre, which the library keeps on the episodes, and takes turns between them', async () => {
    const r = await resolve('shows:\n  - match: { genre: Comedy }');
    expect(r.members!.map((m) => m.title)).toEqual(['Parks', 'The Office']);
    expect(r.ids).toEqual(['p1', 'o0', 'p2', 'o1', 'o2', 'o3']);
  });
  it('puts a named show first and plays a show once when a rule finds it too', async () => {
    const r = await resolve('shows:\n  - The Office\n  - match: { genre: Comedy }');
    expect(r.members!.map((m) => m.title)).toEqual(['The Office', 'Parks']);
  });
  it('removes shows with except, by name, id or rule', async () => {
    expect((await resolve('shows:\n  - match: { tag: sitcom }\n    except: [ { show: The Office } ]')).members!.map((m) => m.title)).toEqual(['Parks']);
    expect((await resolve('shows:\n  - match: { year: 2000-2010 }\n    except: [ { tag: sitcom, year: 2005 } ]')).members!.map((m) => m.title)).toEqual(['Parks']);
    expect((await resolve('shows:\n  - match: { rating: CA-PG }\n    except: [ { show: x, id: s1 } ]')).members!.map((m) => m.title)).toEqual(['Parks', 'The Office']);
  });
  it('finds shows with an episode in a language', async () => {
    const f = source();
    f.idsWhere = async (_k, f2, v) => (f2 === 'audio' && v[0] === 'deu' ? new Set(['s4']) : new Set());
    const r = await makeLibraryReader(f).pool(pool('shows:\n  - match: { audio: German }'));
    expect(r.members!.map((m) => m.title)).toEqual(['Dark']);
  });
});

describe('episode rules', () => {
  it('skips specials and picks seasons and lengths', async () => {
    expect((await resolve('shows: [ The Office ]\nepisodes: { specials: skip }')).ids).toEqual(['o1', 'o2', 'o3']);
    expect((await resolve('shows: [ The Office ]\nepisodes: { seasons: 1 }')).ids).toEqual(['o1', 'o2']);
    expect((await resolve('shows: [ The Office ]\nepisodes: { seasons: 1-2, duration: ">=20m" }')).ids).toEqual(['o1', 'o2', 'o3']);
    expect((await resolve('shows: [ The Office ]\nepisodes: { duration: "<=15m" }')).ids).toEqual(['o0']);
  });
  it('orders by air date when asked, unknown dates last', async () => {
    expect((await resolve('shows: [ Parks ]\nepisodes: { order: airdate }')).ids).toEqual(['p2', 'p1']);
    expect((await resolve('shows: [ Parks ]')).ids).toEqual(['p1', 'p2']);
  });
  it('only goes with shows', () => {
    expect(() => pool('movies: {}\nepisodes: { specials: skip }')).toThrow();
  });
});

describe('saving a channel with rule pools from the schedule page', async () => {
  const { applyScheduleModel, scheduleModelOf } = await import('./schedulemodel.js');
  const TEXT = `channel: T
timezone: America/Toronto
grid: 15m
ads: { step: 15s, ratio: { min: 15%, max: 60% } }
pools:
  french:
    movies:
      match:
        - { audio: French }
        - { subtitles: fra }
      duration: "<=130m"
  sitcoms:
    shows:
      - The Office
      - match: { genre: Comedy }
        except: [ { show: Archer } ]
    episodes: { specials: skip, seasons: 1-3 }
  plain: { movies: { genre: Comedy } }
week:
  sun: [ { at: "08:00", pool: french }, { at: "20:00", pool: sitcoms } ]
`;
  it('carries rule pools as written and does not touch them when nothing changed', () => {
    const model = scheduleModelOf(parseScheduleFile(TEXT));
    expect(model.pools['french']!.raw).toMatchObject({ movies: { match: [{ audio: 'French' }, { subtitles: 'fra' }] } });
    expect(model.pools['plain']!.movies).toEqual({ genre: 'Comedy' });
    expect(applyScheduleModel(TEXT, model)).toBe(TEXT);
  });
  it('keeps the rules when another pool or the order is edited', () => {
    const model = scheduleModelOf(parseScheduleFile(TEXT));
    model.pools['plain'] = { movies: { genre: 'Horror' }, order: 'sequential' };
    model.pools['sitcoms'] = { ...model.pools['sitcoms']!, order: 'shuffle' };
    const out = parseScheduleFile(applyScheduleModel(TEXT, model));
    expect(out.pools['plain']!.movies!.genre).toEqual(['Horror']);
    expect(out.pools['sitcoms']!.order).toBe('shuffle');
    expect(out.pools['sitcoms']!.episodes).toMatchObject({ specials: 'skip', seasons: { from: 1, to: 3 } });
    expect(out.pools['sitcoms']!.shows).toHaveLength(2);
    expect(out.pools['french']!.movies!.match).toHaveLength(2);
  });
});
