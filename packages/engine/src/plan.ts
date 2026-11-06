// plan(): turns a schedule, a library and a state into planned slots. Pure and deterministic: the
// same inputs give the same lineup. Rules: docs/planning-rules.md. Nothing here reads the clock.

import { BlockDoesNotFit, buildBlock, type Block, type BlockAds, type BlockHead, type BlockInput, type BlockTail } from './block.js';
import { fillWithClips, pickClip, type Clip } from './clips.js';
import { dayOfWeek, startOfLocalDay, startOfNextLocalDay, toEpoch, toLocal, assertZone } from './clock.js';
import { emptyBag, markDrawn, orderedPick, pickFromBag, type BagState, type SequenceState } from './pools.js';
import type { RngState } from './rng.js';
import type {
  ExceptionDef, Item, ItemPosition, Library, PlanInput, PlanResult, PlanWarning, PlanWarningCode, PlannedSlot, Pool,
  Schedule, SlotDef, WarningSeverity,
} from './schedule.js';
import { DAY, HOUR, MINUTE, isOnGrid, type Ms } from './time.js';

const MAX_RERUN_EPISODES = 60;

interface Window {
  start: Ms;
  end: Ms;
  slot: SlotDef;
  slotId: string;
  exception?: ExceptionDef;
}

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

  const slots: PlannedSlot[] = [];
  for (const w of windowsFor(schedule, input.from, input.to, input.exact === true, work)) {
    slots.push(planWindow(ctx, work, w));
  }
  return { slots, state: { rng: work.rng, sequences: work.sequences, bags: work.bags }, warnings: work.warnings };
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
  if (schedule.week.length === 0) throw new RangeError('the schedule has no slots');
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

function windowsFor(schedule: Schedule, from: Ms, to: Ms, exact: boolean, work: Work): Window[] {
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
  return out;
}

function warn(work: Work, code: PlanWarningCode, severity: WarningSeverity, at: Ms, slotId: string, message: string): void {
  work.warnings.push({ code, severity, at, slotId, message });
}

// ---------------------------------------------------------------------------------------------
// One window: choose programs, build blocks, fill the clips.
// ---------------------------------------------------------------------------------------------

function planWindow(ctx: Ctx, work: Work, w: Window): PlannedSlot {
  const { schedule } = ctx;
  const pool = schedule.pools[w.slot.pool]!;
  let result: { placed: Placed[]; edges: Edges; explicit: boolean } | undefined;
  if (w.exception) {
    const trial = cloneWork(work);
    const attempt = placeBlocks(ctx, trial, w, { kind: 'list', ids: [w.exception.programId], explicit: true });
    if (attempt.placed.length === 1) {
      adopt(work, trial);
      countExceptionPick(ctx, work, w, pool);
      result = { placed: attempt.placed, edges: attempt.edges, explicit: true };
    } else {
      warn(work, 'exception-does-not-fit', 'alert', w.start, w.slotId,
        `the exception program (${w.exception.programId}) does not fit this slot, so the slot is planned as usual`);
    }
  }
  result ??= planNormally(ctx, work, w, pool);

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
  const seq = work.sequences[key] ?? { position: 0, history: 0 };
  const length = pool.programs.length;

  if (slot.link?.mode === 'rerun') {
    // Replay the episodes just behind the head: as many as fill the window, oldest first.
    const most = length === 0 ? 0 : Math.min(seq.history, MAX_RERUN_EPISODES);
    for (let n = most; n >= 1; n--) {
      const ids: string[] = [];
      for (let k = n; k >= 1; k--) ids.push(pool.programs[(((seq.position - k) % length) + length) % length]!);
      const trial = cloneWork(work);
      const r = placeBlocks(ctx, trial, w, { kind: 'list', ids, explicit: false });
      if (r.placed.length === n) {
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
  work.sequences[key] = { position: (seq.position + r.placed.length) % length, history: seq.history + r.placed.length };
  reportStop(work, w, r, 'ordered');
  return { placed: r.placed, edges: r.edges, explicit: false };
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
}

function reportStop(work: Work, w: Window, r: PlaceResult, kind: 'ordered' | 'shuffled'): void {
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
  let lastOnly = false;

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
    if (source.kind === 'list') {
      chosen = source.ids[placed.length];
      if (chosen === undefined) { stop = 'exhausted'; break; }
      if (!tryFit(chosen)) { stop = 'nofit'; unfit = chosen; break; }
    } else {
      const bag = trial.bags[source.key] ?? emptyBag();
      const r = pickFromBag(source.pool.programs, bag, trial.rng, (id) => tryFit(id) !== undefined);
      trial.rng = r.rng;
      if (r.pick === undefined) { stop = 'nofit'; break; }
      skipped += r.skipped;
      trial.bags[source.key] = r.bag;
      chosen = r.pick;
    }

    const fit = tryFit(chosen)!;
    adopt(work, trial);
    placed.push({
      programId: chosen,
      explicit: source.kind === 'list' && source.explicit,
      preBumper,
      postBumper,
      input: fit.input,
      block: fit.block,
    });
    if (fit.asLast) lastOnly = true;
    t = fit.block.end;
  }

  // The last block takes the tail and runs to the end of the slot.
  const last = placed[placed.length - 1];
  if (last && tail && !last.input.tail) {
    const input: BlockInput = { ...last.input, tail };
    last.input = input;
    last.block = buildBlock(input);
  }
  return { placed, edges, stop, unfit, skipped };
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
      warn(work, 'dead-air', left >= schedule.grid ? 'alert' : 'warning', at, w.slotId, `${Math.round(left / 1000)} s of dead air`);
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
