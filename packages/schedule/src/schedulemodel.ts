// The week and the pools of a channel file as plain data, for a page that edits them, and the way back: the same
// text with the week and pools changed. The ads, bumpers, special days and comments elsewhere are kept.

import { isMap, parseDocument } from 'yaml';
import { dayOfWeek, toEpoch, type Ms } from '@daytuner/engine';
import { formatDuration } from './adsettings.js';
import { DAY_NAMES, parseScheduleFile, type ScheduleFile } from './file.js';

export interface SlotModel {
  /** 0 is Sunday. */
  day: number;
  /** Milliseconds after local midnight. */
  at: number;
  pool: string;
  link?: string;
  linkMode?: 'continue' | 'rerun';
}

export type FilterOp = '<=' | '<' | '>=' | '>' | '=';

export interface PoolModel {
  /** A pool of shows (taken in turn, one episode each) ... */
  shows?: { show: string; id?: string }[];
  /** ... or of movies chosen by a filter. */
  movies?: { genre?: string; duration?: { op: FilterOp; ms: number } };
  order?: 'sequential' | 'shuffle';
}

/** A special day: the slot that starts at `at` on that date is replaced by one chosen program. */
export interface ExceptionModel {
  /** The date. Without a year it is every year. */
  on: { month: number; day: number; year?: number };
  /** Milliseconds after local midnight: the start of the slot it replaces. */
  at: number;
  play: { show: string; id?: string; title: string } | { movie: string; id?: string };
  /** The pool whose shuffle it counts against, or false for none; left out, the slot's own pool. */
  counts?: string | false;
}

export interface ScheduleModel {
  timezone: string;
  grid: number;
  week: SlotModel[];
  pools: Record<string, PoolModel>;
  exceptions: ExceptionModel[];
}

export function scheduleModelOf(file: ScheduleFile): ScheduleModel {
  const week: SlotModel[] = [];
  DAY_NAMES.forEach((name, day) => {
    for (const s of file.week[name] ?? []) week.push({ day, at: s.at, pool: s.pool, ...(s.link ? { link: s.link } : {}), ...(s.linkMode ? { linkMode: s.linkMode } : {}) });
  });
  const pools: Record<string, PoolModel> = {};
  for (const [name, p] of Object.entries(file.pools)) {
    pools[name] = {
      ...(p.shows ? { shows: p.shows.map((r) => (typeof r === 'string' ? { show: r } : { show: r.show, ...(r.id ? { id: r.id } : {}) })) } : {}),
      ...(p.movies ? { movies: { ...(p.movies.genre ? { genre: p.movies.genre } : {}), ...(p.movies.duration ? { duration: p.movies.duration } : {}) } } : {}),
      ...(p.order ? { order: p.order } : {}),
    };
  }
  const exceptions: ExceptionModel[] = file.exceptions.map((e) => ({
    on: { ...e.on }, at: e.at, play: 'show' in e.play ? { show: e.play.show, ...(e.play.id ? { id: e.play.id } : {}), title: e.play.title } : { movie: e.play.movie, ...(e.play.id ? { id: e.play.id } : {}) },
    ...(e.counts !== undefined ? { counts: e.counts } : {}),
  }));
  return { timezone: file.timezone, grid: file.grid, week, pools, exceptions };
}

/** 72,000,000 is "20:00". */
export const formatTimeOfDay = (ms: number): string => `${String(Math.floor(ms / 3_600_000)).padStart(2, '0')}:${String(Math.floor((ms % 3_600_000) / 60_000)).padStart(2, '0')}`;

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

const poolText = (p: PoolModel): Record<string, unknown> => ({
  ...(p.shows ? { shows: p.shows.map((r) => (r.id ? { show: r.show, id: r.id } : r.show)) } : {}),
  ...(p.movies ? { movies: { ...(p.movies.genre ? { genre: p.movies.genre } : {}), ...(p.movies.duration ? { duration: `${p.movies.duration.op}${formatDuration(p.movies.duration.ms)}` } : {}) } } : {}),
  ...(p.order ? { order: p.order } : {}),
});

/**
 * The channel file with its week and pools replaced. Throws when the result would not be valid: a slot off the grid or
 * outside a day, two slots at the same moment, a slot with an unknown pool, a pool of both or neither kind, or a pool
 * still used by a special day that is removed. When nothing changes the text comes back as it was.
 */
export function applyScheduleModel(text: string, model: Pick<ScheduleModel, 'week' | 'pools'> & { exceptions?: ExceptionModel[] }): string {
  const file = parseScheduleFile(text);
  const seen = new Set<string>();
  for (const s of model.week) {
    if (!Number.isInteger(s.day) || s.day < 0 || s.day > 6) throw new RangeError(`a slot is on day ${s.day}, which is not a day of the week`);
    if (!Number.isInteger(s.at) || s.at < 0 || s.at >= 86_400_000) throw new RangeError(`a slot starts at ${s.at} ms, which is not within a day`);
    if (s.at % file.grid !== 0) throw new RangeError(`the ${DAY_NAMES[s.day]} slot at ${formatTimeOfDay(s.at)} is not on the ${formatDuration(file.grid)} grid`);
    if (!(s.pool in model.pools)) throw new RangeError(`the ${DAY_NAMES[s.day]} slot at ${formatTimeOfDay(s.at)} uses an unknown pool "${s.pool}"`);
    if (s.linkMode && !s.link) throw new RangeError('a link mode needs a link name');
    const key = `${s.day}@${s.at}`;
    if (seen.has(key)) throw new RangeError(`two slots start at ${formatTimeOfDay(s.at)} on ${DAY_NAMES[s.day]}`);
    seen.add(key);
  }
  if (model.week.length === 0) throw new RangeError('the week has no slots');
  for (const e of model.exceptions ?? []) {
    const d = e.on;
    const probe = new Date(Date.UTC(d.year ?? 2000, d.month - 1, d.day));
    if (!Number.isInteger(d.month) || !Number.isInteger(d.day) || probe.getUTCMonth() !== d.month - 1 || probe.getUTCDate() !== d.day) throw new RangeError(`${d.month}/${d.day} is not a real date`);
    if (!Number.isInteger(e.at) || e.at < 0 || e.at >= 86_400_000 || e.at % file.grid !== 0) throw new RangeError(`a special day at ${formatTimeOfDay(e.at)} is not on the ${formatDuration(file.grid)} grid`);
    if (typeof e.counts === 'string' && !(e.counts in model.pools)) throw new RangeError(`a special day counts against an unknown pool "${e.counts}"`);
  }
  for (const [name, p] of Object.entries(model.pools)) {
    if ((p.shows === undefined) === (p.movies === undefined)) throw new RangeError(`pool "${name}" has either shows or movies, not both and not neither`);
    if (p.shows && p.shows.length === 0) throw new RangeError(`pool "${name}" has no shows`);
  }

  const doc = parseDocument(text);
  if (!isMap(doc.contents)) throw new RangeError('the channel file is not a map');
  // Only the days and pools that really differ are written, compared as data, so the rest keep their layout.
  const now = scheduleModelOf(file);
  let changed = false;
  const slotsOf = (week: SlotModel[], day: number): SlotModel[] => week.filter((s) => s.day === day).sort((a, b) => a.at - b.at);
  DAY_NAMES.forEach((name, day) => {
    const slots = slotsOf(model.week, day);
    if (same(slots, slotsOf(now.week, day))) return;
    changed = true;
    const value = slots.length === 0 ? undefined : slots.map((s) => ({ at: formatTimeOfDay(s.at), pool: s.pool, ...(s.link ? { link: s.link } : {}), ...(s.linkMode ? { linkMode: s.linkMode } : {}) }));
    if (value === undefined) doc.deleteIn(['week', name]);
    else doc.setIn(['week', name], doc.createNode(value));
  });
  for (const name of Object.keys(now.pools)) {
    if (name in model.pools) continue;
    changed = true;
    doc.deleteIn(['pools', name]);
  }
  for (const [name, p] of Object.entries(model.pools)) {
    if (same(p, now.pools[name])) continue;
    changed = true;
    doc.setIn(['pools', name], doc.createNode(poolText(p)));
  }
  if (model.exceptions && !same(model.exceptions, now.exceptions)) {
    changed = true;
    const value = model.exceptions.map((e) => ({
      on: `${e.on.year !== undefined ? `${e.on.year}-` : ''}${String(e.on.month).padStart(2, '0')}-${String(e.on.day).padStart(2, '0')}`, at: formatTimeOfDay(e.at), play: e.play,
      ...(e.counts !== undefined ? { counts: e.counts } : {}),
    }));
    if (value.length === 0) doc.deleteIn(['exceptions']);
    else doc.setIn(['exceptions'], doc.createNode(value));
  }
  if (!changed) return text;
  const out = doc.toString({ lineWidth: 0 });
  parseScheduleFile(out);
  return out;
}


export interface Occurrence {
  /** Which exception (its index in the model). */
  index: number;
  /** The local date, "2026-10-31". */
  date: string;
  /** When the slot it replaces starts. */
  start: Ms;
  /** True when a slot of the week starts at that time on that weekday: otherwise the special day replaces nothing. */
  matchesSlot: boolean;
}

/**
 * The dates the special days fall on between two moments, in the schedule's zone. An every-year day that does not exist in a
 * year (29 February) is skipped that year.
 */
export function exceptionOccurrences(model: Pick<ScheduleModel, 'week' | 'exceptions' | 'timezone'>, from: Ms, to: Ms): Occurrence[] {
  const out: Occurrence[] = [];
  const years = [new Date(from).getUTCFullYear() - 1, new Date(to).getUTCFullYear() + 1];
  model.exceptions.forEach((e, index) => {
    for (let year = e.on.year ?? years[0]!; year <= (e.on.year ?? years[1]!); year++) {
      const probe = new Date(Date.UTC(year, e.on.month - 1, e.on.day));
      if (probe.getUTCMonth() !== e.on.month - 1) continue; // 29 February in a year without one
      const start = toEpoch(model.timezone, { year, month: e.on.month, day: e.on.day, hour: Math.floor(e.at / 3_600_000), minute: Math.floor((e.at % 3_600_000) / 60_000) });
      if (start < from || start >= to) continue;
      const day = dayOfWeek(model.timezone, start);
      out.push({ index, date: `${year}-${String(e.on.month).padStart(2, '0')}-${String(e.on.day).padStart(2, '0')}`, start, matchesSlot: model.week.some((s) => s.day === day && s.at === e.at) });
    }
  });
  return out.sort((a, b) => a.start - b.start);
}
