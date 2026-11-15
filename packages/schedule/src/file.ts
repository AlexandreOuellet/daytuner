// The channel file: strict parsing of the YAML into a typed description. Unknown keys are errors,
// so a typo never silently does nothing. See schedules/example.yaml for the format.

import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { languageCode } from './languages.js';
import { expandWeek } from './weekplan.js';
import {
  parseDuration, parseDurationFilter, parseMonthDay, parsePercent, parseRange, parseTimeOfDay,
  type DurationFilter, type MonthDay, type MsRange,
} from './units.js';

/** Runs a parser inside zod, turning its thrown message into a validation issue. */
function via<T>(fn: (s: string) => T) {
  return (value: string, ctx: z.RefinementCtx): T => {
    try {
      return fn(value);
    } catch (e) {
      ctx.addIssue({ code: 'custom', message: e instanceof Error ? e.message : String(e) });
      return z.NEVER;
    }
  };
}

const duration = z.string().transform(via(parseDuration));
const percent = z.string().transform(via(parsePercent));
const timeOfDay = z.string().transform(via(parseTimeOfDay));
const range = z.union([z.string(), z.number()]).transform((v, ctx): MsRange => {
  try {
    return parseRange(v);
  } catch (e) {
    ctx.addIssue({ code: 'custom', message: e instanceof Error ? e.message : String(e) });
    return z.NEVER;
  }
});

const chapterType = z.enum(['chapter', 'intro', 'outro', 'break', 'recap']);

const adPosition = z.object({ list: z.string().optional(), length: range }).strict();
const midPosition = z.object({
  list: z.string(),
  every: duration,
  length: range,
  tailBuffer: duration.default(0),
  minGap: duration.optional(),
  chapterTypes: z.array(chapterType).optional(),
}).strict();

const list = z.object({ list: z.string() }).strict();

/** A show is a title, or a title plus the library's id for it (the id decides when present). */
const showRef = z.object({ show: z.string(), id: z.string().optional() }).strict();

/** One value or a list of them; a list means any of. */
const oneOrMany = z.union([z.string(), z.array(z.string()).min(1)]).transform((v) => (Array.isArray(v) ? v : [v]));
const language = z.union([z.string(), z.array(z.string()).min(1)]).transform(via((v) => (Array.isArray(v) ? v : [v]).map(languageCode)) as never) as unknown as z.ZodType<string[]>;

/** A number or "a-b" for a span, "a-" / "-b" for one side open. Used for years (1980-1989) and seasons (1-3). */
export interface YearSpan { from: number; to: number }
function parseSpan(v: string | number, digits: string, what: string, example: string): YearSpan {
  if (typeof v === 'number') return { from: v, to: v };
  const m = new RegExp(`^\\s*(${digits})?\\s*(-)?\\s*(${digits})?\\s*$`).exec(v);
  if (!m || (!m[1] && !m[3])) throw new Error(`"${v}" is not ${what} (use ${example})`);
  if (!m[2]) return { from: Number(m[1]), to: Number(m[1]) };
  return { from: m[1] ? Number(m[1]) : -Infinity, to: m[3] ? Number(m[3]) : Infinity };
}
export const parseYears = (v: string | number): YearSpan => parseSpan(v, '\\d{4}', 'a year or a range of years', '1984 or 1980-1989');
export const parseSeasons = (v: string | number): YearSpan => parseSpan(v, '\\d{1,3}', 'a season or a range of seasons', '2 or 1-3');
const years = z.union([z.number().int(), z.string()]).transform(via((v) => parseYears(v as string | number)) as never) as unknown as z.ZodType<YearSpan>;

const showFields = {
  title: oneOrMany.optional(),
  genre: oneOrMany.optional(),
  year: years.optional(),
  rating: oneOrMany.optional(),
  studio: oneOrMany.optional(),
  tag: oneOrMany.optional(),
  actor: oneOrMany.optional(),
  audio: language.optional(),
  subtitles: language.optional(),
};
/** A condition on shows. Everything in it must hold; a list inside it means any of. */
const showRule = z.object(showFields).strict().refine((r) => Object.keys(r).length > 0, { message: 'a rule needs at least one condition (an empty rule would match everything)' });
const movieFields = {
  ...showFields,
  director: oneOrMany.optional(),
  duration: z.string().transform(via(parseDurationFilter)).optional(),
};
const movieRule = z.object(movieFields).strict().refine((r) => Object.keys(r).length > 0, { message: 'a rule needs at least one condition (an empty rule would match everything)' });
const many = <T extends z.ZodTypeAny>(t: T) => z.union([t, z.array(t).min(1)]).transform((v): z.output<T>[] => (Array.isArray(v) ? v : [v]));

export type ShowRule = z.output<typeof showRule>;
export type MovieRule = z.output<typeof movieRule>;

/** A set of shows found by rules: any rule may match, and `except` takes away. */
const showMatch = z.object({
  match: many(showRule),
  except: z.array(z.union([showRule, showRef])).optional(),
}).strict();

const episodeRules = z.object({
  seasons: z.union([z.number().int(), z.string()]).transform(via((v) => parseSeasons(v as string | number)) as never).optional() as unknown as z.ZodOptional<z.ZodType<YearSpan>>,
  specials: z.enum(['skip', 'include']).optional(),
  duration: z.string().transform(via(parseDurationFilter)).optional(),
  order: z.enum(['season', 'airdate']).optional(),
}).strict();

const pool = z.object({
  shows: z.array(z.union([z.string(), showRef, showMatch])).min(1).optional(),
  episodes: episodeRules.optional(),
  /** Conditions beside `match` hold for every match; `match` is a list of rules, any of which may hold. */
  movies: z.object({
    ...movieFields,
    match: many(movieRule).optional(),
    except: z.array(movieRule).optional(),
  }).strict().optional(),
  order: z.enum(['sequential', 'shuffle']).optional(),
}).strict().refine((p) => (p.shows === undefined) !== (p.movies === undefined), {
  message: 'a pool has either shows or movies, not both and not neither',
}).refine((p) => p.episodes === undefined || p.shows !== undefined, { message: 'episodes only goes with shows' });

const play = z.union([
  z.object({ show: z.string(), id: z.string().optional(), title: z.string() }).strict(),
  z.object({ movie: z.string(), id: z.string().optional() }).strict(),
]);

const exception = z.object({
  on: z.string().transform(via(parseMonthDay)),
  at: timeOfDay,
  play,
  counts: z.union([z.string(), z.literal(false)]).optional(),
}).strict();

const slot = z.object({
  at: timeOfDay,
  /** How long it lasts; without it, until the next slot starts. */
  length: duration.optional(),
  pool: z.string(),
  link: z.string().optional(),
  linkMode: z.enum(['continue', 'rerun']).optional(),
  /** The template it was placed from (a label; the slot's own fields are what play). */
  template: z.string().optional(),
}).strict().refine((s) => s.linkMode === undefined || s.link !== undefined, { message: 'linkMode needs a link name' });

const template = z.object({
  pool: z.string(),
  length: duration,
  link: z.string().optional(),
  linkMode: z.enum(['continue', 'rerun']).optional(),
}).strict().refine((t) => t.linkMode === undefined || t.link !== undefined, { message: 'linkMode needs a link name' });

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
const week = z.object(Object.fromEntries(DAYS.map((d) => [d, z.array(slot).optional()])) as Record<(typeof DAYS)[number], z.ZodOptional<z.ZodArray<typeof slot>>>).strict();

const FileSchema = z.object({
  channel: z.string(),
  timezone: z.string(),
  grid: duration,
  ads: z.object({
    step: duration,
    ratio: z.object({ min: percent, max: percent }).strict(),
    head: adPosition.optional(),
    pre: adPosition.optional(),
    post: adPosition.optional(),
    tail: adPosition.optional(),
    mid: midPosition.optional(),
  }).strict(),
  bumpers: z.object({ head: list.optional(), pre: list.optional(), post: list.optional(), tail: list.optional() }).strict().default({}),
  interstitial: list.optional(),
  overflow: z.literal(0).default(0),
  lateness: z.literal(0).default(0),
  pools: z.record(z.string(), pool),
  /** Slot templates, by name. */
  templates: z.record(z.string(), template).default({}),
  /** The pool that plays in time no slot covers. */
  fill: z.string().optional(),
  exceptions: z.array(exception).default([]),
  week,
}).strict();

export type ScheduleFile = z.output<typeof FileSchema> & {
  /** The pools as written in the file, for a page that edits other things and must not lose what it does not know. */
  rawPools: Record<string, unknown>;
};
export type PoolDef = z.output<typeof pool>;
/** A pool as written in the file (rules and all), read into its typed form. */
export function parsePoolDef(raw: unknown): PoolDef {
  const r = pool.safeParse(raw);
  if (!r.success) throw new ScheduleFileError(`the pool has problems: ${r.error.issues.map((i) => `${i.path.join('.') || '(pool)'}: ${i.message}`).join('; ')}`);
  return r.data;
}
export type TemplateFile = z.output<typeof template>;
export type ExceptionFile = z.output<typeof exception>;
export const DAY_NAMES = DAYS;
export type { DurationFilter, MonthDay, MsRange };

export class ScheduleFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScheduleFileError';
  }
}

/** Parses the text of a channel file. Throws a `ScheduleFileError` that says where the problem is. */
export function parseScheduleFile(text: string): ScheduleFile {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (e) {
    throw new ScheduleFileError(`the file is not valid YAML: ${e instanceof Error ? e.message : String(e)}`);
  }
  const result = FileSchema.safeParse(raw);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  ${i.path.join('.') || '(file)'}: ${i.message}`);
    throw new ScheduleFileError(`the channel file has problems:\n${lines.join('\n')}`);
  }
  const f = result.data;
  for (const name of ['head', 'pre', 'post', 'tail'] as const) {
    const p = f.ads[name];
    if (p && p.length.max > 0 && !p.list) throw new ScheduleFileError(`ads.${name}: a position with ads needs a list`);
  }
  for (const [day, slots] of Object.entries(f.week)) {
    for (const s of slots ?? []) {
      if (!(s.pool in f.pools)) throw new ScheduleFileError(`week.${day}: slot at ${s.at} uses an unknown pool "${s.pool}"`);
      if (s.length !== undefined && (s.length <= 0 || s.length % f.grid !== 0 || s.length > 7 * 86_400_000)) {
        throw new ScheduleFileError(`week.${day}: slot at ${s.at} has a length that is not a positive multiple of the grid, at most 7 days`);
      }
    }
  }
  for (const [name, t] of Object.entries(f.templates)) {
    if (!(t.pool in f.pools)) throw new ScheduleFileError(`templates.${name}: uses an unknown pool "${t.pool}"`);
    if (t.length <= 0 || t.length % f.grid !== 0) throw new ScheduleFileError(`templates.${name}: the length is not a positive multiple of the grid`);
  }
  if (f.fill !== undefined && !(f.fill in f.pools)) throw new ScheduleFileError(`fill: "${f.fill}" is not a pool`);
  try {
    const flat = DAYS.flatMap((d, day) => (f.week[d] ?? []).map((s) => ({ day, at: s.at, ...(s.length !== undefined ? { length: s.length } : {}) })));
    expandWeek(flat, f.fill, (g) => g);
  } catch (e) {
    throw new ScheduleFileError(`week: ${e instanceof Error ? e.message : String(e)}`);
  }
  return { ...f, rawPools: ((raw as { pools?: Record<string, unknown> }).pools ?? {}) };
}
