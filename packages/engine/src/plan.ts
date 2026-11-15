// plan(): turns a schedule, a library and a state into planned slots. Pure and deterministic: the
// same inputs give the same lineup. Rules: docs/planning-rules.md. Nothing here reads the clock.

import { BlockDoesNotFit, buildBlock, type Block, type BlockAds, type BlockHead, type BlockInput, type BlockTail } from './block.js';
import { fillWithClips, pickClip, type Clip } from './clips.js';
import { dayOfWeek, startOfLocalDay, startOfNextLocalDay, toEpoch, toLocal, assertZone } from './clock.js';
import { advanceSequence, emptyBag, markDrawn, orderedPick, pickFromBag, placeInList, type BagState, type SequenceState } from './pools.js';
import type { RngState } from './rng.js';
import type {
  ExceptionDef, Item, ItemPosition, LockConflict, Library, PlanInput, PlanResult, PlanWarning, PlanWarningCode, PlannedSlot, Pool,
  Schedule, SlotDef, StagedWindow, WarningSeverity,
} from './schedule.js';
import { DAY, HOUR, MINUTE, isOnGrid, type Ms } from './time.js';

const MAX_RERUN_EPISODES = 60;

interface Window {
  start: Ms;
  end: Ms;
  slot: SlotDef;
  slotId: string;
  exception?: ExceptionDef;
  /** Block number to a pinned program id. */
  pins?: Readonly<Record<number, string>>;
  /** A slot added by hand: no pool, only pinned blocks. */
  added?: true;
}

const ADDED_PREFIX = 'added@';
/** The pool name of a slot added by hand. It is in no schedule. */
const ADDED_POOL = '';

/** The planner's working copy of the state. Cloned for trials, adopted on success. */
interface Work {
  rng: RngState;
  bags: Record<string, BagState>;
  sequences: Record<string, SequenceState>;
  warnings: PlanWarning[];
}

const cloneWork = (w: Work): Work => ({ rng: w.rng, bags: { ...w.bags }, sequences: { ...w.sequences }, warnings: [...w.warnings] });
const adopt = (into: Work, from: Work): void => {
  into.rng = from.rng;
  into.bags = from.bags;
  into.sequences = from.sequences;
  into.warnings = from.warnings;
};

const slotIdOf = (s: SlotDef): string => `${s.day}@${s.at}`;
const bagKey = (list: string): string => `clips:${list}`;
const poolKey = (pool: string): string => `pool:${pool}`;
const sequenceKey = (s: SlotDef): string => `seq:${s.link ? s.link.name : slotIdOf(s)}`;

interface Placed {
  programId: string;
  explicit: boolean;
  /** Chosen by a pin, not taken from the pool. */
  pinned: boolean;
  preBumper: Clip | undefined;
  postBumper: Clip | undefined;
  /** The block as planned. The last one is rebuilt with the tail. */
  input: BlockInput;
  block: Block;
}

interface Edges {
  head: BlockHead | undefined;
  tail: BlockTail | undefined;
  headBumper: Clip | undefined;
  tailBumper: Clip | undefined;
}

type Source =
  | { kind: 'list'; ids: readonly string[]; explicit: boolean }
  | { kind: 'bag'; pool: Pool; key: string };

export function plan(input: PlanInput): PlanResult {
  const { schedule, library } = input;
  validate(schedule, library);
  const ctx: Ctx = { schedule, library, blockAds: blockAdsOf(schedule) };

  const work: Work = {
    rng: input.state.rng,
    bags: { ...input.state.bags },
    sequences: { ...input.state.sequences },
    warnings: [],
  };

  const locked = new Map((input.locked ?? []).map((s) => [s.start, s]));
  const pinsLeft = new Map((input.pins ?? []).map((p) => [p.start, p.blocks]));
  const conflicts: LockConflict[] = [];
  const slots: PlannedSlot[] = [];
  for (const w of windowsFor(schedule, input.from, input.to, input.exact === true, work, input.windows ?? [])) {
    const held = locked.get(w.start);
    locked.delete(w.start);
    if (held) {
      const conflict = checkLocked(ctx, w, held);
      if (!conflict) {
        slots.push(held);
        applyLockedEffect(ctx, work, w, held);
        continue;
      }
      conflicts.push(conflict);
      warn(work, 'locked-slot-conflict', 'alert', w.start, w.slotId, `the locked slot could not be kept: ${conflict.message}. It was planned again.`);
    }
    const pins = pinsLeft.get(w.start);
    pinsLeft.delete(w.start);
    slots.push(planWindow(ctx, work, pins ? { ...w, pins } : w));
  }
  for (const [start, blocks] of pinsLeft) {
    if (start >= input.from && start < input.to && Object.keys(blocks).length > 0) {
      warn(work, 'pin-dropped', 'warning', start, '', 'pins were set on a slot starting here, but no slot of the schedule starts here any more');
    }
  }
  // A locked slot in the planned range that no window starts at any more.
  for (const [start, held] of locked) {
    if (start < input.from || start >= input.to) continue;
    const c: LockConflict = { start, slotId: held.slotId, reason: 'window-changed', message: 'no slot of the schedule starts there any more' };
    conflicts.push(c);
    warn(work, 'locked-slot-conflict', 'alert', start, held.slotId, `the locked slot could not be kept: ${c.message}`);
  }
  warnAboutUnmatchedExceptions(schedule, input.from, input.to, work);
  return { slots, state: { rng: work.rng, sequences: work.sequences, bags: work.bags }, warnings: work.warnings, conflicts };
}

// ---------------------------------------------------------------------------------------------
// Locked slots: used as stored when the window and everything in it still holds.
// ---------------------------------------------------------------------------------------------

function checkLocked(ctx: Ctx, w: Window, held: PlannedSlot): LockConflict | undefined {
  const fail = (reason: LockConflict['reason'], message: string): LockConflict => ({ start: held.start, slotId: held.slotId, reason, message });
  if (held.slotId !== w.slotId || held.start !== w.start || held.end !== w.end) {
    return fail('window-changed', `the slot's window is now ${w.slotId} from ${w.start} to ${w.end}`);
  }
  if (held.pool !== w.slot.pool) return fail('window-changed', `the slot now draws from pool ${w.slot.pool}, not ${held.pool}`);
  if (held.exception !== (w.exception !== undefined)) return fail('window-changed', 'the exception for this slot was added or removed');
  if (w.exception && !held.programs.every((p) => p === w.exception!.programId)) return fail('window-changed', 'the exception now plays a different program');
  const reach = new Map<string, number>();
  for (const it of held.items) {
    if (it.kind === 'content') {
      const p = ctx.library.programs[it.programId];
      if (!p) return fail('program-gone', `program ${it.programId} is no longer in the library`);
      reach.set(it.programId, Math.max(reach.get(it.programId) ?? 0, it.startOffset + it.duration));
    } else if (it.kind === 'filler') {
      const clip = (ctx.library.clips[it.list] ?? []).find((c) => c.id === it.clipId);
      if (!clip) return fail('clip-gone', `clip ${it.clipId} is no longer in list ${it.list}`);
      if (clip.duration !== it.duration) return fail('duration-changed', `clip ${it.clipId} now lasts ${clip.duration} ms, not ${it.duration}`);
    }
  }
  for (const [id, end] of reach) {
    const now = ctx.library.programs[id]!.duration;
    if (now !== end) return fail('duration-changed', `program ${id} now lasts ${now} ms, not ${end}`);
  }
  return undefined;
}

/**
 * What planning the slot would have done to the state, apart from the random generator: ordered shows
 * advance, programs and clips are marked as drawn. The slot's own items are used as stored.
 */
function applyLockedEffect(ctx: Ctx, work: Work, w: Window, held: PlannedSlot): void {
  const pool = ctx.schedule.pools[w.slot.pool];
  if (!pool) {
    // A slot added by hand has no pool: only its clips count.
  } else if (held.exception) {
    countExceptionPick(ctx, work, w, pool);
  } else if (pool.order === 'shuffled') {
    for (const id of held.programs) work.bags[poolKey(w.slot.pool)] = markDrawn(work.bags[poolKey(w.slot.pool)] ?? emptyBag(), id);
  } else if (w.slot.link?.mode !== 'rerun' && pool.programs.length > 0) {
    const key = sequenceKey(w.slot);
    // A place that moved because the list changed is reported here too (this slot may be the first to meet the change; the later
    // slots find the place already corrected and would say nothing).
    const seq = currentPlace(work, key, pool.programs, w, true);
    // A block pinned to another program (a rerun) takes nothing from the show, as when the slot is planned.
    work.sequences[key] = advanceSequence(seq, pool.programs, (held.blocks.length > 0 ? held.blocks.filter((b) => !b.pinned).length : held.programs.length));
  }
  for (const it of held.items) {
    if (it.kind === 'filler') work.bags[bagKey(it.list)] = markDrawn(work.bags[bagKey(it.list)] ?? emptyBag(), it.clipId);
  }
}

interface Ctx {
  schedule: Schedule;
  library: Library;
  blockAds: BlockAds;
}

function validate(schedule: Schedule, library: Library): void {
  assertZone(schedule.zone);
  if (!Number.isSafeInteger(schedule.grid) || schedule.grid <= 0) throw new RangeError('grid must be a positive whole number of milliseconds');
  const lists = [
    schedule.ads.head?.list, schedule.ads.pre?.list, schedule.ads.mid?.list, schedule.ads.post?.list, schedule.ads.tail?.list,
    schedule.bumpers.head?.list, schedule.bumpers.pre?.list, schedule.bumpers.post?.list, schedule.bumpers.tail?.list,
    schedule.interstitial?.list,
  ];
  for (const l of lists) if (l !== undefined && !(l in library.clips)) throw new RangeError(`unknown clip list: ${l}`);
  const seen = new Set<string>();
  for (const s of schedule.week) {
    if (!(s.pool in schedule.pools)) throw new RangeError(`slot ${slotIdOf(s)} uses unknown pool ${s.pool}`);
    if (!isOnGrid(s.at, schedule.grid)) throw new RangeError(`slot ${slotIdOf(s)} is not on the ${schedule.grid} ms grid`);
    if (s.at < 0 || s.at >= DAY) throw new RangeError(`slot ${slotIdOf(s)} is not within a day`);
    if (seen.has(slotIdOf(s))) throw new RangeError(`slot ${slotIdOf(s)} is listed twice`);
    seen.add(slotIdOf(s));
  }
  for (const p of Object.values(schedule.pools)) {
    for (const id of p.programs) if (!(id in library.programs)) throw new RangeError(`unknown program: ${id}`);
  }
  for (const e of schedule.exceptions) if (!(e.programId in library.programs)) throw new RangeError(`unknown program: ${e.programId}`);
}

function blockAdsOf(schedule: Schedule): BlockAds {
  const a = schedule.ads;
  return {
    step: a.step,
    ratio: a.ratio,
    ...(a.pre ? { pre: a.pre.range } : {}),
    ...(a.post ? { post: a.post.range } : {}),
    ...(a.mid ? { mid: { range: a.mid.range, offers: a.mid.offers, ...(a.mid.minGap ? { minGap: a.mid.minGap } : {}) } } : {}),
  };
}

// ---------------------------------------------------------------------------------------------
// Windows: the stretch of time each slot owns, on the schedule's clock.
// ---------------------------------------------------------------------------------------------

function windowsFor(schedule: Schedule, from: Ms, to: Ms, exact: boolean, work: Work, staged: readonly StagedWindow[]): Window[] {
  if (to <= from) return [];
  const starts: { start: Ms; slot: SlotDef }[] = [];
  let day = startOfLocalDay(schedule.zone, from - 8 * DAY);
  while (day <= to + 8 * DAY) {
    const dow = dayOfWeek(schedule.zone, day);
    const l = toLocal(schedule.zone, day);
    for (const slot of schedule.week) {
      if (slot.day !== dow) continue;
      const hour = Math.floor(slot.at / HOUR);
      const minute = Math.floor((slot.at % HOUR) / MINUTE);
      starts.push({ start: toEpoch(schedule.zone, { year: l.year, month: l.month, day: l.day, hour, minute }), slot });
    }
    day = startOfNextLocalDay(schedule.zone, day);
  }
  starts.sort((a, b) => a.start - b.start);
  for (let i = 1; i < starts.length; i++) {
    if (starts[i]!.start === starts[i - 1]!.start) throw new RangeError(`two slots start at the same instant: ${starts[i]!.start}`);
  }

  const out: Window[] = [];
  for (let i = 0; i + 1 < starts.length; i++) {
    const s = starts[i]!;
    const nextStart = starts[i + 1]!.start;
    if (nextStart <= from || s.start >= to) continue;
    const start = Math.max(s.start, from);
    const end = exact ? Math.min(nextStart, to) : nextStart;
    const slotId = slotIdOf(s.slot);
    if (start > s.start && start === from) {
      warn(work, 'started-mid-slot', 'info', start, slotId, 'planning starts inside a slot, so it plans only the rest of that slot');
    }
    const l = toLocal(schedule.zone, s.start);
    const exception = schedule.exceptions.find(
      (e) => e.at === s.slot.at && e.on.month === l.month && e.on.day === l.day && (e.on.year === undefined || e.on.year === l.year),
    );
    out.push({ start, end, slot: s.slot, slotId, ...(exception ? { exception } : {}) });
  }
  return staged.length === 0 ? out : shapeWindows(schedule, out, staged, from, to, exact, work);
}

/** Lets windows shaped by hand take their span; the schedule's windows are cut around them. */
function shapeWindows(schedule: Schedule, base: Window[], staged: readonly StagedWindow[], from: Ms, to: Ms, exact: boolean, work: Work): Window[] {
  const mine = [...staged].sort((a, b) => a.start - b.start);
  for (let i = 1; i < mine.length; i++) {
    if (mine[i]!.start < mine[i - 1]!.end) throw new RangeError(`two shaped windows overlap at ${mine[i]!.start}`);
  }
  const out: Window[] = [];
  for (const b of base) {
    let at = b.start;
    for (const m of mine) {
      if (m.end <= at || m.start >= b.end) continue;
      if (m.start > at) out.push({ ...b, start: at, end: m.start });
      at = Math.max(at, m.end);
    }
    if (at < b.end) out.push({ ...b, start: at, end: b.end });
  }
  for (const m of mine) {
    const start = Math.max(m.start, from);
    const end = exact ? Math.min(m.end, to) : m.end;
    if (start >= to || end <= start) continue;
    if (m.slotId.startsWith(ADDED_PREFIX)) {
      out.push({ start, end, slot: { day: -1, at: -1, pool: ADDED_POOL }, slotId: m.slotId, added: true });
      continue;
    }
    const slot = schedule.week.find((s) => slotIdOf(s) === m.slotId);
    if (!slot) {
      warn(work, 'pin-dropped', 'warning', start, m.slotId, 'a slot shaped by hand came from a week slot that is no longer in the schedule, so it was treated as an added slot');
      out.push({ start, end, slot: { day: -1, at: -1, pool: ADDED_POOL }, slotId: m.slotId, added: true });
      continue;
    }
    out.push({ start, end, slot, slotId: m.slotId });
  }
  return out.filter((w) => w.end > w.start && w.start < to).sort((a, b) => a.start - b.start);
}

/**
 * An exception replaces the slot that starts at its time. One that falls inside the planned range
 * but has no slot starting then would otherwise do nothing, silently.
 */
function warnAboutUnmatchedExceptions(schedule: Schedule, from: Ms, to: Ms, work: Work): void {
  if (schedule.exceptions.length === 0 || to <= from) return;
  const first = toLocal(schedule.zone, from).year;
  const last = toLocal(schedule.zone, to).year;
  for (const e of schedule.exceptions) {
    const hour = Math.floor(e.at / HOUR);
    const minute = Math.floor((e.at % HOUR) / MINUTE);
    for (let year = e.on.year ?? first; year <= (e.on.year ?? last); year++) {
      const at = toEpoch(schedule.zone, { year, month: e.on.month, day: e.on.day, hour, minute });
      if (at < from || at >= to) continue;
      const l = toLocal(schedule.zone, at);
      const dow = dayOfWeek(schedule.zone, at);
      if (l.month !== e.on.month || l.day !== e.on.day) continue; // a date that does not exist that year
      if (!schedule.week.some((s) => s.day === dow && s.at === e.at)) {
        warn(work, 'exception-matches-no-slot', 'warning', at, `${dow}@${e.at}`,
          `the exception for ${e.on.month}/${e.on.day} at ${Math.floor(e.at / HOUR)}:${String(minute).padStart(2, '0')} replaces nothing: no slot starts then, so it was ignored`);
      }
    }
  }
}

function warn(work: Work, code: PlanWarningCode, severity: WarningSeverity, at: Ms, slotId: string, message: string): void {
  work.warnings.push({ code, severity, at, slotId, message });
}

// ---------------------------------------------------------------------------------------------
// One window: choose programs, build blocks, fill the clips.
// ---------------------------------------------------------------------------------------------

function planWindow(ctx: Ctx, work: Work, w: Window): PlannedSlot {
  const { schedule } = ctx;
  const pool = w.added ? undefined : schedule.pools[w.slot.pool]!;
  let result: { placed: Placed[]; edges: Edges; explicit: boolean } | undefined;
  if (w.added) {
    // No pool: only what is pinned. Anything not pinned is filler, then dead air.
    const r = placeBlocks(ctx, work, w, { kind: 'list', ids: [], explicit: false });
    result = { placed: r.placed, edges: r.edges, explicit: false };
  } else if (w.exception) {
    const trial = cloneWork(work);
    const attempt = placeBlocks(ctx, trial, w, { kind: 'list', ids: [w.exception.programId], explicit: true });
    if (attempt.placed.length === 1) {
      adopt(work, trial);
      countExceptionPick(ctx, work, w, pool!);
      result = { placed: attempt.placed, edges: attempt.edges, explicit: true };
    } else {
      warn(work, 'exception-does-not-fit', 'alert', w.start, w.slotId,
        `the exception program (${w.exception.programId}) does not fit this slot, so the slot is planned as usual`);
    }
  }
  result ??= planNormally(ctx, work, w, pool!);

  const { placed, edges } = result;
  const items = layoutItems(ctx, work, w, placed, edges);
  for (const p of placed) {
    for (const bw of p.block.warnings) warn(work, 'block', 'warning', p.block.start, w.slotId, `${p.programId}: ${bw.message}`);
  }
  const total = items.reduce((a, i) => a + i.duration, 0);
  if (total !== w.end - w.start) {
    throw new Error(`internal error: slot ${w.slotId} adds up to ${total} ms but its window is ${w.end - w.start} ms`);
  }
  return {
    slotId: w.slotId,
    start: w.start,
    end: w.end,
    pool: w.slot.pool,
    programs: placed.map((p) => p.programId),
    blocks: placed.map((p) => ({ programId: p.programId, start: p.block.start, end: p.block.end, ...(p.pinned ? { pinned: true as const } : {}) })),
    exception: result.explicit,
    items,
  };
}

function planNormally(ctx: Ctx, work: Work, w: Window, pool: Pool): { placed: Placed[]; edges: Edges; explicit: boolean } {
  const { slot } = w;
  if (pool.order === 'shuffled') {
    const r = placeBlocks(ctx, work, w, { kind: 'bag', pool, key: poolKey(slot.pool) });
    reportStop(work, w, r, 'shuffled');
    return { placed: r.placed, edges: r.edges, explicit: false };
  }

  const key = sequenceKey(slot);
  const seq = currentPlace(work, key, pool.programs, w, true);
  const length = pool.programs.length;

  if (slot.link?.mode === 'rerun') {
    // Replay the episodes just behind the head: as many as fill the window, oldest first.
    const most = length === 0 ? 0 : Math.min(seq.history, MAX_RERUN_EPISODES);
    for (let n = most; n >= 1; n--) {
      const ids: string[] = [];
      for (let k = n; k >= 1; k--) ids.push(pool.programs[(((seq.position - k) % length) + length) % length]!);
      const trial = cloneWork(work);
      const r = placeBlocks(ctx, trial, w, { kind: 'list', ids, explicit: false });
      if (r.placed.filter((p) => !p.pinned).length === n) {
        adopt(work, trial);
        const lastBlock = r.placed[r.placed.length - 1]!.block;
        const unfilled = lastBlock.gap + (w.end - lastBlock.end);
        if (n === seq.history && unfilled >= ctx.schedule.grid) {
          warn(work, 'rerun-short-history', 'warning', w.start, w.slotId,
            `only ${n} episode(s) have aired to replay, so the rest of this rerun slot is filler`);
        }
        return { placed: r.placed, edges: r.edges, explicit: false };
      }
    }
    warn(work, 'rerun-short-history', 'alert', w.start, w.slotId, 'no episode has aired to replay, so this rerun slot is filler');
    const r = placeBlocks(ctx, work, w, { kind: 'list', ids: [], explicit: false });
    return { placed: r.placed, edges: r.edges, explicit: false };
  }

  if (length === 0) {
    warn(work, 'nothing-fits', 'alert', w.start, w.slotId, `pool ${slot.pool} has no programs`);
    const r = placeBlocks(ctx, work, w, { kind: 'list', ids: [], explicit: false });
    return { placed: r.placed, edges: r.edges, explicit: false };
  }

  const ids: string[] = [];
  // Ordered shows never skip: the list is the episodes from the head onward, as far as they fit.
  for (let i = 0; i < Math.min(length, 200); i++) ids.push(orderedPick(pool.programs, seq.position, i)!.id);
  const r = placeBlocks(ctx, work, w, { kind: 'list', ids, explicit: false });
  const taken = r.placed.filter((p) => !p.pinned).length;
  work.sequences[key] = advanceSequence(seq, pool.programs, taken);
  reportStop(work, w, r, 'ordered');
  return { placed: r.placed, edges: r.edges, explicit: false };
}

/**
 * A sequence's place for the list as it is now. The list changes (episodes arrive or go), so the place is found again after the
 * last episode taken; the first time that moves it, or the last episode is gone, the plan says so.
 */
function currentPlace(work: Work, key: string, list: readonly string[], w: Window, say: boolean): SequenceState {
  const stored = work.sequences[key] ?? { position: 0, history: 0 };
  const { seq, note } = placeInList(stored, list);
  if (note) {
    if (say) {
      warn(work, note.kind === 'moved' ? 'place-moved' : 'place-lost', note.kind === 'moved' ? 'info' : 'warning', w.start, w.slotId,
        note.kind === 'moved'
          ? `the list of ${w.slot.pool} changed since the last episode aired, so the next episode is now number ${note.to + 1} (it was ${note.from + 1}). An episode that arrived behind the place is skipped; rewind to play it`
          : `${stored.last} is no longer in ${w.slot.pool}, so the place is kept as number ${note.from + 1}; check that the next episode is the right one`);
    }
    work.sequences[key] = seq;
  }
  return seq;
}

function countExceptionPick(ctx: Ctx, work: Work, w: Window, pool: Pool): void {
  const e = w.exception!;
  let target: string | undefined;
  if (e.counts === false) target = undefined;
  else if (typeof e.counts === 'string') target = e.counts;
  else if (pool.order === 'shuffled' && pool.programs.includes(e.programId)) target = w.slot.pool;
  if (target === undefined) return;
  const p = ctx.schedule.pools[target];
  if (!p || p.order !== 'shuffled') return;
  const key = poolKey(target);
  work.bags[key] = markDrawn(work.bags[key] ?? emptyBag(), e.programId);
}

interface PlaceResult {
  placed: Placed[];
  edges: Edges;
  stop: 'full' | 'nofit' | 'exhausted';
  /** The program that did not fit (ordered shows), for the warning. */
  unfit: string | undefined;
  skipped: number;
  /** Programs shown again because nothing left in the pool's round fit. */
  repeats: string[];
}

function reportStop(work: Work, w: Window, r: PlaceResult, kind: 'ordered' | 'shuffled'): void {
  for (const id of r.repeats) {
    warn(work, 'repeat-pick', 'info', w.start, w.slotId,
      `${id} was shown again: nothing left in the pool's round fit the remaining time`);
  }
  if (r.skipped > 0) {
    warn(work, 'programs-skipped-for-fit', 'info', w.start, w.slotId,
      `${r.skipped} program(s) did not fit this slot's remaining time and were passed over`);
  }
  if (r.stop === 'nofit') {
    if (r.placed.length === 0) {
      warn(work, 'nothing-fits', 'alert', w.start, w.slotId, `no program in pool ${w.slot.pool} fits this ${Math.round((w.end - w.start) / MINUTE)}-minute slot`);
    } else if (kind === 'ordered') {
      warn(work, 'sequential-does-not-fit', 'warning', w.start, w.slotId,
        `the next episode (${r.unfit}) does not fit the rest of this slot, so the slot ends early and it plays next time`);
    }
  }
}

function drawBumper(ctx: Ctx, work: Work, list: string | undefined): Clip | undefined {
  if (list === undefined) return undefined;
  const bag = work.bags[bagKey(list)] ?? emptyBag();
  const r = pickClip(ctx.library.clips[list] ?? [], bag, work.rng);
  work.bags[bagKey(list)] = r.bag;
  work.rng = r.rng;
  return r.clip;
}

function placeBlocks(ctx: Ctx, work: Work, w: Window, source: Source): PlaceResult {
  const { schedule, library } = ctx;
  const grid = schedule.grid;

  // The slot's head and tail: their bumpers are drawn now, and their minimums are reserved.
  const headBumper = drawBumper(ctx, work, schedule.bumpers.head?.list);
  const tailBumper = drawBumper(ctx, work, schedule.bumpers.tail?.list);
  const head: BlockHead | undefined = schedule.ads.head || schedule.bumpers.head
    ? { bumper: headBumper?.duration ?? 0, ads: schedule.ads.head?.range ?? { min: 0, max: 0 } }
    : undefined;
  const tail: BlockTail | undefined = schedule.ads.tail || schedule.bumpers.tail
    ? { bumper: tailBumper?.duration ?? 0, ads: schedule.ads.tail?.range ?? { min: 0, max: 0 }, slotEnd: w.end }
    : undefined;
  const tailReserve = tail ? tail.bumper + tail.ads.min : 0;
  const edges: Edges = { head, tail, headBumper, tailBumper };

  const placed: Placed[] = [];
  let t = w.start;
  let stop: PlaceResult['stop'] = 'full';
  let unfit: string | undefined;
  let skipped = 0;
  const repeats: string[] = [];
  let lastOnly = false;
  let pulled = 0; // blocks taken from the source, which pinned blocks are not
  const usedPins = new Set<number>();

  while (!lastOnly) {
    if (t >= w.end - tailReserve) break;
    const first = placed.length === 0;
    const trial = cloneWork(work);
    const preBumper = drawBumper(ctx, trial, schedule.bumpers.pre?.list);
    const postBumper = drawBumper(ctx, trial, schedule.bumpers.post?.list);

    const inputFor = (programId: string, withTail: boolean): BlockInput => {
      const p = library.programs[programId]!;
      return {
        start: t,
        grid,
        content: p.duration,
        ...(p.chapters ? { chapters: p.chapters } : {}),
        bumpers: { pre: preBumper?.duration ?? 0, post: postBumper?.duration ?? 0 },
        ads: ctx.blockAds,
        ...(first && head ? { head } : {}),
        ...(withTail && tail ? { tail } : {}),
      };
    };
    const tryFit = (programId: string): { input: BlockInput; block: Block; asLast: boolean } | undefined => {
      const plain = inputFor(programId, false);
      const b = buildBlock(plain);
      if (b.end + tailReserve <= w.end) return { input: plain, block: b, asLast: false };
      if (!tail) return undefined;
      const withTail = inputFor(programId, true);
      try {
        return { input: withTail, block: buildBlock(withTail), asLast: true };
      } catch (e) {
        if (e instanceof BlockDoesNotFit) return undefined;
        throw e;
      }
    };

    let chosen: string | undefined;
    let pinned = false;
    const pin = w.pins?.[placed.length + 1];
    if (pin !== undefined) {
      usedPins.add(placed.length + 1);
      if (!(pin in library.programs)) {
        warn(trial, 'pin-dropped', 'warning', t, w.slotId, `the program pinned to block ${placed.length + 1} (${pin}) is not in the library, so the block is planned as usual`);
      } else if (tryFit(pin)) {
        chosen = pin;
        pinned = true;
      } else {
        const need = library.programs[pin]!.duration;
        const room = w.end - tailReserve - t;
        warn(trial, 'pin-does-not-fit', 'alert', t, w.slotId,
          `the program pinned to block ${placed.length + 1} (${pin}) does not fit: it lasts ${Math.round(need / MINUTE)} min with its breaks needing more, and ${Math.round(room / MINUTE)} min remain. The block is planned as usual; extend the slot or pin something shorter`);
      }
    }
    if (!pinned) {
      if (source.kind === 'list') {
        chosen = source.ids[pulled];
        if (chosen === undefined) { stop = 'exhausted'; work.warnings = trial.warnings; break; }
        if (!tryFit(chosen)) { stop = 'nofit'; unfit = chosen; work.warnings = trial.warnings; break; }
      } else {
        const bag = trial.bags[source.key] ?? emptyBag();
        const r = pickFromBag(source.pool.programs, bag, trial.rng, (id) => tryFit(id) !== undefined);
        trial.rng = r.rng;
        if (r.pick === undefined) { stop = 'nofit'; work.warnings = trial.warnings; break; }
        skipped += r.skipped;
        if (r.repeat) repeats.push(r.pick!);
        trial.bags[source.key] = r.bag;
        chosen = r.pick;
      }
      pulled++;
    }

    const fit = tryFit(chosen!)!;
    adopt(work, trial);
    placed.push({
      programId: chosen!,
      explicit: pinned || (source.kind === 'list' && source.explicit),
      pinned,
      preBumper,
      postBumper,
      input: fit.input,
      block: fit.block,
    });
    if (fit.asLast) lastOnly = true;
    t = fit.block.end;
  }

  for (const [n] of Object.entries(w.pins ?? {})) {
    if (!usedPins.has(Number(n))) {
      warn(work, 'pin-dropped', 'warning', w.start, w.slotId, `a program is pinned to block ${n}, but this slot has only ${placed.length} block(s), so the pin was dropped`);
    }
  }

  // The last block takes the tail and runs to the end of the slot.
  const last = placed[placed.length - 1];
  if (last && tail && !last.input.tail) {
    const input: BlockInput = { ...last.input, tail };
    last.input = input;
    last.block = buildBlock(input);
  }
  return { placed, edges, stop, unfit, skipped, repeats };
}

// ---------------------------------------------------------------------------------------------
// Items: the blocks laid out in time, with real clips.
// ---------------------------------------------------------------------------------------------

function layoutItems(ctx: Ctx, work: Work, w: Window, placed: Placed[], edges: Edges): Item[] {
  const { schedule, library } = ctx;
  const items: Item[] = [];

  const clipItems = (clips: readonly Clip[], role: 'ad' | 'bumper' | 'interstitial', position: ItemPosition, list: string): Item[] =>
    clips.map((c) => ({ kind: 'filler', role, position, list, clipId: c.id, duration: c.duration }));
  const bumperItem = (clip: Clip | undefined, position: ItemPosition, list: string | undefined): Item[] =>
    clip && list ? clipItems([clip], 'bumper', position, list) : [];

  const fill = (room: Ms, list: string): { clips: Clip[]; shortfall: Ms } => {
    const f = fillWithClips(room, library.clips[list] ?? [], work.bags[bagKey(list)] ?? emptyBag(), work.rng);
    work.bags[bagKey(list)] = f.bag;
    work.rng = f.rng;
    return { clips: f.clips, shortfall: f.shortfall };
  };

  /** What no ad fills: interstitial clips first, then dead air. */
  const gapItems = (room: Ms, at: Ms): Item[] => {
    if (room <= 0) return [];
    const out: Item[] = [];
    let left = room;
    const list = schedule.interstitial?.list;
    if (list) {
      const f = fill(room, list);
      out.push(...clipItems(f.clips, 'interstitial', 'gap', list));
      left = f.shortfall;
    }
    if (left > 0) {
      out.push({ kind: 'flex', duration: left });
      // A few seconds is inherent (clips are whole) and is counted in the metrics. Only noticeable
      // dead air is a warning.
      if (left >= 15_000) {
        warn(work, 'dead-air', left >= schedule.grid ? 'alert' : left >= MINUTE ? 'warning' : 'info', at, w.slotId,
          `${Math.round(left / 1000)} s of dead air`);
      }
    }
    return out;
  };

  if (placed.length === 0) {
    // Nothing fits: the whole window is filler, then dead air.
    items.push(...gapItems(w.end - w.start, w.start));
    return items;
  }

  placed.forEach((p, index) => {
    const b = p.block;
    const isFirst = index === 0;
    const isLast = index === placed.length - 1;
    let carry = 0;
    const ads = (planned: Ms, list: string | undefined, position: ItemPosition): Item[] => {
      if (!list) { carry += planned; return []; }
      const f = fill(planned + carry, list);
      carry = f.shortfall;
      return clipItems(f.clips, 'ad', position, list);
    };

    if (isFirst && edges.head) {
      items.push(...bumperItem(edges.headBumper, 'head', schedule.bumpers.head?.list));
      items.push(...ads(b.adsHead, schedule.ads.head?.list, 'head'));
    }
    items.push(...ads(b.adsPre, schedule.ads.pre?.list, 'pre'));
    items.push(...bumperItem(p.preBumper, 'pre', schedule.bumpers.pre?.list));

    let offset = 0;
    for (const mb of b.midBreaks) {
      items.push({ kind: 'content', programId: p.programId, startOffset: offset, duration: mb.at - offset });
      items.push(...ads(mb.length, schedule.ads.mid?.list, 'mid'));
      offset = mb.at;
    }
    items.push({ kind: 'content', programId: p.programId, startOffset: offset, duration: b.content - offset });

    items.push(...bumperItem(p.postBumper, 'post', schedule.bumpers.post?.list));
    items.push(...ads(b.adsPost, schedule.ads.post?.list, 'post'));

    let gap = b.gap + carry;
    let tailItems: Item[] = [];
    if (isLast) {
      gap += w.end - b.end; // a slot with no tail may end after the grid end of its last block
      if (edges.tail) {
        const tailList = schedule.ads.tail?.list;
        if (tailList) {
          const f = fill(b.adsTail, tailList);
          gap += f.shortfall;
          tailItems = clipItems(f.clips, 'ad', 'tail', tailList);
        } else {
          gap += b.adsTail;
        }
        tailItems.push(...bumperItem(edges.tailBumper, 'tail', schedule.bumpers.tail?.list));
      }
    }
    items.push(...gapItems(gap, b.end - gap));
    items.push(...tailItems);
  });

  return items;
}
