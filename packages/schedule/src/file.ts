// The channel file: strict parsing of the YAML into a typed description. Unknown keys are errors,
// so a typo never silently does nothing. See schedules/example.yaml for the format.

import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
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
const showRef = z.union([z.string(), z.object({ show: z.string(), id: z.string().optional() }).strict()]);

const pool = z.object({
  shows: z.array(showRef).min(1).optional(),
  movies: z.object({
    genre: z.string().optional(),
    duration: z.string().transform(via(parseDurationFilter)).optional(),
  }).strict().optional(),
  order: z.enum(['sequential', 'shuffle']).optional(),
}).strict().refine((p) => (p.shows === undefined) !== (p.movies === undefined), {
  message: 'a pool has either shows or movies, not both and not neither',
});

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
  pool: z.string(),
  link: z.string().optional(),
  linkMode: z.enum(['continue', 'rerun']).optional(),
}).strict().refine((s) => s.linkMode === undefined || s.link !== undefined, { message: 'linkMode needs a link name' });

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
  exceptions: z.array(exception).default([]),
  week,
}).strict();

export type ScheduleFile = z.output<typeof FileSchema>;
export type PoolDef = z.output<typeof pool>;
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
    }
  }
  return f;
}
