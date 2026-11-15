// Geometry for the calendar page: the week's dates, the pieces of slots drawn in each day, and a slot's timeline of items.

import type { CalendarCommitted, CalendarItem, CalendarSlot, SlotTotals, StageWarning } from './api';
import { addDays, dayStart } from './staging';

/** The Sunday on or before a date ("2026-11-27" gives "2026-11-22"). */
export function weekStartOf(date: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return addDays(date, -new Date(Date.UTC(y, m - 1, d)).getUTCDay());
}

/** The seven dates of the week that holds `date`, Sunday first. */
export const weekDates = (date: string): string[] => Array.from({ length: 7 }, (_, i) => addDays(weekStartOf(date), i));

export type Place = 'committed' | 'staged' | 'planned';

/** One thing drawn on the calendar: a committed, staged or planned slot. */
export interface Entry {
  key: string;
  place: Place;
  start: number;
  end: number;
  label: string;
  /** Marks beyond the place: what was done by hand, "rule", "differs from the plan". */
  marks: string[];
  /** What plays in it, whichever place it is in. */
  view: View;
  /** The pool of a staged or planned slot (a committed run has none known to be right, a slot added by hand has none). */
  pool?: string;
  /** Staged and planned slots can be changed here; a committed one is already in Tunarr. */
  editable: boolean;
  locked: boolean;
}

/** The part of a committed block or a staged or planned slot the detail shows. */
export interface View {
  items: CalendarItem[];
  totals: SlotTotals;
  warnings: StageWarning[];
  /** The plan for the same stretch, when this differs from it. */
  plan: CalendarSlot['plan'];
  programs: string[];
  /** The blocks of the slot, in order (a long slot holds many). */
  blocks: { programId: string; start: number; end: number; pinned?: boolean }[];
}

/** A program's name, or a short piece of its id when nothing here knows its title. */
export const programName = (titles: Readonly<Record<string, string>>, id: string): string => titles[id] ?? `program ${id.slice(0, 8)}`;

export function entriesOf(committed: readonly CalendarCommitted[], slots: readonly CalendarSlot[], titles: Readonly<Record<string, string>>): Entry[] {
  const out: Entry[] = [];
  for (const c of committed) {
    out.push({ key: `c:${c.start}`, place: 'committed', start: c.start, end: c.end, label: c.pool ?? (c.programs.map((p) => programName(titles, p)).slice(0, 2).join(', ') || 'committed'), marks: [], editable: false, locked: false, view: { items: c.items, totals: c.totals, warnings: [], plan: [], programs: c.programs, blocks: c.blocks } });
  }
  for (const s of slots) {
    const marks = [...s.hand, ...(s.rule ? ['rule'] : []), ...(s.differs && s.hand.length === 0 ? ['differs from the plan'] : [])];
    out.push({ key: `${s.source}:${s.slot.start}`, place: s.source, start: s.slot.start, end: s.slot.end, label: s.slot.slotId.startsWith('added@') ? 'added' : s.slot.pool, marks, editable: true, locked: s.hand.includes('locked'), ...(s.slot.slotId.startsWith('added@') ? {} : { pool: s.slot.pool }), view: { items: s.slot.items, totals: s.totals, warnings: s.warnings, plan: s.plan, programs: s.slot.programs, blocks: s.slot.blocks } });
  }
  return out.sort((a, b) => a.start - b.start);
}

export interface Piece {
  entry: Entry;
  /** Milliseconds after the day's start. */
  from: number;
  to: number;
  carry: boolean;
  continues: boolean;
}

/** The pieces of entries drawn in the day that runs from `start` to `end`. */
export const piecesOf = (entries: readonly Entry[], start: number, end: number): Piece[] =>
  entries
    .filter((e) => e.end > start && e.start < end)
    .map((e) => ({ entry: e, from: Math.max(e.start, start) - start, to: Math.min(e.end, end) - start, carry: e.start < start, continues: e.end > end }));

export const dayBounds = (zone: string, date: string): { start: number; end: number } => ({ start: dayStart(zone, date), end: dayStart(zone, addDays(date, 1)) });

export type SegClass = 'content' | 'ad' | 'bumper' | 'interstitial' | 'dead-air';

export interface TimelineSeg {
  /** Milliseconds after the slot's start. */
  at: number;
  ms: number;
  cls: SegClass;
  /** "head", "pre", "mid", "post", "tail", "gap", or "program" / "dead air". */
  group: string;
  /** What it is: the program's title, or the clip. */
  what: string;
  /** The list the clip came from. */
  list?: string;
}

/** A slot's items as a timeline: each with when it starts, what it is and which group (break position or program) it belongs to. */
export function timelineOf(items: readonly CalendarItem[], titles: Readonly<Record<string, string>>, clips: Readonly<Record<string, string>> = {}): TimelineSeg[] {
  const out: TimelineSeg[] = [];
  let at = 0;
  const parts = new Map<string, number>();
  for (const i of items) {
    if (i.kind === 'content') {
      const n = (parts.get(i.programId) ?? 0) + 1;
      parts.set(i.programId, n);
      out.push({ at, ms: i.duration, cls: 'content', group: 'program', what: `${programName(titles, i.programId)}${n > 1 || i.startOffset > 0 ? ` (part ${n})` : ''}` });
    } else if (i.kind === 'flex') out.push({ at, ms: i.duration, cls: 'dead-air', group: 'dead air', what: 'dead air' });
    else out.push({ at, ms: i.duration, cls: i.role === 'interstitial' ? 'interstitial' : i.role, group: i.position, what: clips[i.clipId] || `${i.role} ${i.clipId.slice(0, 8)}`, list: i.list });
    at += i.duration;
  }
  return out;
}

export interface Group { group: string; at: number; ms: number }

/** Neighbouring segments of one group (a break, a program) joined, for the labels above the strip. */
export function groupsOf(segs: readonly TimelineSeg[]): Group[] {
  const out: Group[] = [];
  for (const s of segs) {
    const last = out[out.length - 1];
    if (last && last.group === s.group && s.group !== 'program') last.ms += s.ms;
    else out.push({ group: s.group, at: s.at, ms: s.ms });
  }
  return out;
}

/** "20:14:05" for an instant in the zone. */
export function clockSec(zone: string, ms: number): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: zone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(snapSecond(ms)));
}

/**
 * The nearest whole second. A lineup that ends a few milliseconds before the hour (Tunarr's durations carry fractions) would
 * otherwise read 19:59:59 and, with minutes cut off, 19:59, for a slot that begins at 20:00.
 */
export const snapSecond = (ms: number): number => Math.round(ms / 1000) * 1000;

/** One line of a slot's timeline: a piece (a program, dead air), or a whole break (bumpers, ads, filler between programs). */
export type Row = { kind: 'piece'; seg: TimelineSeg } | { kind: 'break'; group: string; at: number; ms: number; segs: TimelineSeg[] };

/** The pieces in order, with neighbouring bumpers, ads and filler of one break position gathered into a single row. */
export function rowsOf(segs: readonly TimelineSeg[]): Row[] {
  const out: Row[] = [];
  for (const s of segs) {
    if (s.cls === 'content' || s.cls === 'dead-air') { out.push({ kind: 'piece', seg: s }); continue; }
    const last = out[out.length - 1];
    if (last && last.kind === 'break' && last.group === s.group) { last.ms += s.ms; last.segs.push(s); }
    else out.push({ kind: 'break', group: s.group, at: s.at, ms: s.ms, segs: [s] });
  }
  return out;
}

/** "3 ads, 1 bumper" for what a break holds. */
export function breakCounts(segs: readonly TimelineSeg[]): string {
  const n = (c: TimelineSeg['cls']): number => segs.filter((s) => s.cls === c).length;
  return [[n('ad'), 'ad', 'ads'], [n('bumper'), 'bumper', 'bumpers'], [n('interstitial'), 'filler clip', 'filler clips']]
    .filter(([c]) => (c as number) > 0).map(([c, one, many]) => `${c} ${c === 1 ? one : many}`).join(', ');
}

export interface BreakSummary { group: string; ms: number; parts: string[] }

/** Each break position (head, pre, mid, post, tail, gap) with its total and what is in it ("bumper 0:20", "ads 1:30"), in play order. */
export function breaksOf(segs: readonly TimelineSeg[]): BreakSummary[] {
  const word = { bumper: 'bumper', ad: 'ads', interstitial: 'filler' } as const;
  const out = new Map<string, { ms: number; by: Map<string, number> }>();
  for (const s of segs) {
    if (s.cls === 'content' || s.cls === 'dead-air') continue;
    const b = out.get(s.group) ?? { ms: 0, by: new Map<string, number>() };
    b.ms += s.ms;
    b.by.set(word[s.cls], (b.by.get(word[s.cls]) ?? 0) + s.ms);
    out.set(s.group, b);
  }
  const m = (ms: number): string => `${Math.floor(ms / 60_000)}:${String(Math.round((ms % 60_000) / 1000)).padStart(2, '0')}`;
  return [...out].map(([group, b]) => ({ group, ms: b.ms, parts: [...b.by].map(([k, v]) => `${k} ${m(v)}`) }));
}

/** The segments of one block of a slot: those that start inside it (a slot's items are laid end to end from its start). */
export const segsOfBlock = (segs: readonly TimelineSeg[], slotStart: number, block: { start: number; end: number }): TimelineSeg[] =>
  segs.filter((s) => slotStart + s.at >= block.start && slotStart + s.at < block.end).map((s) => ({ ...s, at: slotStart + s.at - block.start }));

/** A warning's text with any program id in it replaced by the program's title. */
export const withTitles = (message: string, titles: Readonly<Record<string, string>>): string =>
  message.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\b[0-9a-f]{32}\b/gi, (id) => titles[id] ?? id);

/** A stable colour for a name (a pool), as a hue from 0 to 359. */
export const hueOf = (name: string): number => [...name].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 360, 7);

/** Dead air this long or longer is called out; a few seconds left over at the end of a block is not. */
export const NOTICED_DEAD_AIR_MS = 60_000;

/** One resize the server is asked for: the slot that starts at `start` now ends at `end` (the one after it starts there). */
export interface MoveStep { start: number; end: number }

/**
 * Moving a whole slot to start at `to`. Slots touch, so the slot before it ends where it now starts and the one after it
 * starts where it now ends: the neighbours give and take the time. That is two edge changes, in an order that never leaves
 * a gap or an overlap in between (later: the slot's end first; earlier: its start first). `reach` is where staging must
 * run to (the end of the slot after it), and `planned` says whether any of the three is still only planned.
 */
export function moveSlotPlan(entries: readonly Entry[], e: Entry, to: number, least: number): { error: string } | { steps: MoveStep[]; reach: number; planned: boolean } {
  const d = to - e.start;
  if (d === 0) return { steps: [], reach: e.end, planned: false };
  if (!e.editable) return { error: 'This slot is already in Tunarr, so it cannot be moved.' };
  if (e.locked) return { error: 'The slot is locked. Unlock it to move it.' };
  const prev = entries.find((x) => x.end === e.start);
  const next = entries.find((x) => x.start === e.end);
  if (!prev) return { error: 'Nothing comes before this slot, so there is no time to give it or take from.' };
  if (!prev.editable || prev.locked) return { error: prev.locked ? 'The slot before it is locked, so this one cannot move.' : 'The slot before it is already in Tunarr, so this one cannot move.' };
  if (!next) return { error: 'No slot comes after this one yet, so it cannot move. Change where it ends instead.' };
  if (!next.editable || next.locked) return { error: 'The slot after it is locked or already in Tunarr, so this one cannot move.' };
  if (to - prev.start < least) return { error: 'The slot before it would be left with no time.' };
  if (next.end - (e.end + d) < least) return { error: 'The slot after it would be left with no time.' };
  const steps: MoveStep[] = d > 0
    ? [{ start: e.start, end: e.end + d }, { start: prev.start, end: to }]
    : [{ start: prev.start, end: to }, { start: to, end: e.end + d }];
  return { steps, reach: next.end, planned: [prev, e, next].some((x) => x.place === 'planned') };
}
