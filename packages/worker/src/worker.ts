// The worker: keeps a channel's committed lineup far enough ahead, by planning from where the lineup
// ends and appending. It only appends. Before it writes anything it checks that the store and Tunarr
// agree about where the lineup ends, and it records every commit so that a crash can be resolved.
// Rules: docs/architecture.md, "Worker".

import { adjustSequence, diffSlots, plan, type SlotChange, type Clock, type StagedWindow, type CursorAdjustment, type LockConflict, type PlannedSlot, type PlanWarning, type Schedule } from '@daytuner/engine';
import { parseScheduleFile, resolveSchedule } from '@daytuner/schedule';
import { cachedSource } from './chapters.js';
import type { ChannelRecord, CommitRecord, PinRecord, StagedSlotRecord, Store } from '@daytuner/store';
import { alignToGrid, appendVerified, toLineupItems, totalDuration, type LineupItem, type TunarrClient } from '@daytuner/tunarr-client';

/** Two ends closer than this are the same: Tunarr's durations carry fractions that are rounded. */
const EDGE_TOLERANCE_MS = 1;

/** The store and Tunarr disagree, or Tunarr is in a state the worker will not write to. Nothing was written. */
export class ConsistencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConsistencyError';
  }
}

export interface WorkerDeps {
  store: Store;
  /** Must have been created with writes allowed, and must point at a test copy or the real Tunarr on purpose. */
  client: TunarrClient;
  clock: Clock;
}

export type Recovery = 'completed' | 'dropped';

export interface TopUpOptions {
  /** Plan and report, but write nothing: not to Tunarr and not to the store. */
  dryRun?: boolean;
}

export interface TopUpResult {
  /** `none` when the lineup already reaches far enough ahead; `would-append` for a dry run. */
  action: 'none' | 'appended' | 'would-append';
  /** A commit left pending by an earlier crash, and how it was resolved. */
  recovered?: Recovery;
  /** How far ahead of now the lineup reached before this run, in milliseconds. */
  aheadBefore: number;
  items?: number;
  totalMs?: number;
  slots?: number;
  commitId?: number;
  edgeAfter?: number;
  /** What was planned (also for a dry run), for the metrics. */
  planned?: PlannedSlot[];
  warnings: PlanWarning[];
  /** Locked staged slots that could not be kept as stored and were planned again. */
  conflicts: LockConflict[];
}

const same = (a: number, b: number): boolean => Math.abs(a - b) <= EDGE_TOLERANCE_MS;

/** Settles a commit that was begun but never confirmed, by looking at where Tunarr's lineup really ends. */
function resolvePending(store: Store, pending: CommitRecord, edgeNow: number, at: number): Recovery {
  if (same(edgeNow, pending.toEdge)) {
    store.completeCommit(pending.id, edgeNow, at);
    return 'completed';
  }
  if (same(edgeNow, pending.fromEdge)) {
    store.abandonCommit(pending.id, at);
    return 'dropped';
  }
  throw new ConsistencyError(
    `commit ${pending.id} was started but Tunarr's lineup ends at ${edgeNow}, which is neither where it began (${pending.fromEdge}) nor where it should end (${pending.toEdge}). Nothing was written.`,
  );
}

/**
 * What staging adds to a plan: the locked slots as stored, and the pins of the others. A pinned program that no
 * pool uses is added to the library with the length it had when it was pinned.
 */
function stagedInputs(
  store: Store,
  ch: ChannelRecord,
  edge: number,
  library: { programs: Record<string, { duration: number }> },
  titles: Record<string, string>,
): { locked: PlannedSlot[]; pins: { start: number; blocks: Record<number, string> }[]; windows: StagedWindow[] } {
  const staged = store.stagedSlots(ch.id, edge);
  const pins: { start: number; blocks: Record<number, string> }[] = [];
  for (const s of staged) {
    if (s.locked || Object.keys(s.pins).length === 0) continue;
    const blocks: Record<number, string> = {};
    for (const [n, pin] of Object.entries(s.pins)) {
      blocks[Number(n)] = pin.id;
      library.programs[pin.id] ??= { duration: pin.duration };
      titles[pin.id] ??= pin.title;
    }
    pins.push({ start: s.start, blocks });
  }
  const windows = staged.filter((s) => s.edited && s.slotId).map((s) => ({ start: s.start, end: s.end, slotId: s.slotId! }));
  return { locked: staged.filter((s) => s.locked).map((s) => s.planned), pins, windows };
}

export async function topUp(deps: WorkerDeps, channelName: string, opts: TopUpOptions = {}): Promise<TopUpResult> {
  const { store, client, clock } = deps;
  let ch = store.channel(channelName);
  if (!ch) throw new ConsistencyError(`no channel named "${channelName}" in the store`);

  const tun = await client.channel(ch.tunarrId);
  const edgeNow = tun.startTime + tun.duration;

  let recovered: Recovery | undefined;
  const pending = store.pendingCommit(ch.id);
  if (pending && opts.dryRun) {
    throw new ConsistencyError('a commit is pending from an earlier run; run the worker for real to settle it first');
  }
  if (pending) {
    recovered = resolvePending(store, pending, edgeNow, clock.now());
    ch = store.channel(channelName)!;
  }

  if (!same(edgeNow, ch.edge)) {
    throw new ConsistencyError(
      `Tunarr's lineup for "${channelName}" ends at ${edgeNow} but the store recorded ${ch.edge}. Someone changed the channel outside DayTuner, or its database was restored. Nothing was written.`,
    );
  }
  const now = clock.now();
  if (edgeNow < now) {
    throw new ConsistencyError(
      `the lineup for "${channelName}" has already run out (it ended ${Math.round((now - edgeNow) / 60_000)} minutes ago). Appending now would shift Tunarr's whole timeline, so nothing was written.`,
    );
  }

  const ahead = edgeNow - now;
  const base = { ...(recovered ? { recovered } : {}), aheadBefore: ahead, warnings: [] as PlanWarning[], conflicts: [] as LockConflict[] };
  if (ahead >= ch.floorMs + ch.stepMs) return { action: 'none', ...base };

  const { schedule, library, fillerListIds, titles } = await resolveSchedule(parseScheduleFile(ch.schedule), cachedSource(client, store, clock));
  const { from, flex } = alignToGrid(edgeNow, schedule.grid);
  const { locked, pins, windows } = stagedInputs(store, ch, edgeNow, library, titles);
  const result = plan({ schedule, library, state: ch.state, from, to: now + ch.floorMs + ch.stepMs, locked, pins, windows });
  if (result.slots.length === 0) return { action: 'none', ...base, warnings: result.warnings };

  const items: LineupItem[] = [...(flex > 0 ? [{ type: 'flex' as const, duration: flex }] : []), ...toLineupItems(result.slots, fillerListIds)];
  const totalMs = totalDuration(items);
  if (opts.dryRun) {
    return { action: 'would-append', ...base, warnings: result.warnings, conflicts: result.conflicts, items: items.length, totalMs, slots: result.slots.length, planned: result.slots };
  }

  // Record the intent first, so a crash between here and the confirmation can be resolved later.
  const commit = store.beginCommit({
    channelId: ch.id,
    fromEdge: edgeNow,
    toEdge: edgeNow + totalMs,
    state: result.state,
    items: items.length,
    totalMs,
    slots: result.slots.map((s) => ({ slotId: s.slotId, start: s.start, end: s.end, programs: s.programs })),
    at: now,
  });

  let report;
  try {
    report = await appendVerified(client, ch.tunarrId, items);
  } catch (e) {
    // The call failed, but the lineup may or may not have changed. Look, and settle the record now.
    try {
      const after = await client.channel(ch.tunarrId);
      resolvePending(store, commit, after.startTime + after.duration, clock.now());
    } catch {
      /* leave it pending: the next run resolves it, or reports it */
    }
    throw e;
  }
  if (!report.ok) {
    const what = report.problems.join('; ');
    store.noteCommit(commit.id, `verification failed: ${what}`);
    throw new ConsistencyError(`Tunarr stored something different from what was sent (${what}). The commit stays pending; see \`channel commits ${channelName}\` and \`channel resync ${channelName}\`.`);
  }
  store.completeCommit(commit.id, report.edgeAfter, clock.now());
  if (result.conflicts.length > 0) {
    store.noteCommit(commit.id, `locked slots that could not be kept: ${result.conflicts.map((c) => `${c.slotId} at ${c.start} (${c.reason}: ${c.message})`).join('; ')}`);
  }
  return {
    action: 'appended',
    ...base,
    warnings: result.warnings,
    conflicts: result.conflicts,
    items: items.length,
    totalMs,
    slots: result.slots.length,
    commitId: commit.id,
    edgeAfter: report.edgeAfter,
    planned: result.slots,
  };
}

export interface ResyncReport {
  /** What was found, in words. */
  found: string[];
  /** What was done (or, for a dry run, would be done). */
  actions: string[];
  /** True when the planner state may no longer match what is in Tunarr, so a person should look at the cursors. */
  stateMayBeStale: boolean;
}

/**
 * Brings the store back in line with Tunarr after the worker refused to write. A commit left pending
 * is settled exactly as the worker would settle it. Anything else is adopted: the store takes
 * Tunarr's end as the new end, and says so when the state may now be out of step with the lineup.
 * It never writes to Tunarr. A dry run changes nothing.
 */
export async function resync(deps: WorkerDeps, channelName: string, opts: { dryRun?: boolean } = {}): Promise<ResyncReport> {
  const { store, client, clock } = deps;
  const ch = store.channel(channelName);
  if (!ch) throw new ConsistencyError(`no channel named "${channelName}" in the store`);
  const tun = await client.channel(ch.tunarrId);
  const edgeNow = tun.startTime + tun.duration;
  const report: ResyncReport = { found: [], actions: [], stateMayBeStale: false };
  const dry = opts.dryRun === true;

  const pending = store.pendingCommit(ch.id);
  if (pending) {
    report.found.push(`commit ${pending.id} is pending (it was to take the lineup from ${pending.fromEdge} to ${pending.toEdge})`);
    if (pending.note) {
      report.found.push(`commit ${pending.id} has a note: ${pending.note}`);
      if (same(edgeNow, pending.toEdge)) report.stateMayBeStale = true;
    }
    if (same(edgeNow, pending.toEdge)) {
      report.actions.push(
        pending.note
          ? `complete commit ${pending.id}: the lineup reaches where it should end, but what it holds differs from the plan (see the note)`
          : `complete commit ${pending.id}: Tunarr already has what it wrote`,
      );
      if (!dry) store.completeCommit(pending.id, edgeNow, clock.now());
      return report;
    }
    if (same(edgeNow, pending.fromEdge)) {
      report.actions.push(`drop commit ${pending.id}: its append never reached Tunarr`);
      if (!dry) store.abandonCommit(pending.id, clock.now());
      return report;
    }
    report.actions.push(`drop commit ${pending.id}: Tunarr's lineup matches neither end of it`);
    report.stateMayBeStale = true;
    if (!dry) store.abandonCommit(pending.id, clock.now());
  }

  if (same(edgeNow, ch.edge)) {
    report.found.push("Tunarr's lineup ends where the store says; nothing to adopt");
    return report;
  }
  report.found.push(`Tunarr's lineup ends at ${edgeNow} but the store recorded ${ch.edge}`);
  report.actions.push(`record ${edgeNow} as the end of the committed lineup`);
  report.stateMayBeStale = true;
  if (!dry) store.setEdge(channelName, edgeNow);
  return report;
}

export interface StageResult {
  /** The slots now staged (the kept part of what was planned). */
  kept: PlannedSlot[];
  /** How many slots were planned in all, including those before the kept range that only move the state. */
  planned: number;
  warnings: PlanWarning[];
  /** Readable names for the programs, for showing the slots. */
  titles: Record<string, string>;
  /** What changed in the kept range compared with what was staged there before. */
  changes: SlotChange[];
}

/**
 * Plans from the end of the committed lineup up to `to` on a copy of the state, and stages only the slots
 * that start inside `[keepFrom, keepTo)`. The days before the kept range are planned only so the shows'
 * places and the bags are right where the kept range begins; they are not stored and are generated normally
 * later. The channel's own state does not change. Replaces the staged slots in the kept range.
 */
export async function stageGenerate(
  deps: Pick<WorkerDeps, 'store' | 'client' | 'clock'>,
  channelName: string,
  range: { to: number; keepFrom?: number; keepTo?: number; before?: readonly PlannedSlot[] },
): Promise<StageResult> {
  const { store, client, clock } = deps;
  const ch = store.channel(channelName);
  if (!ch) throw new ConsistencyError(`no channel named "${channelName}" in the store`);
  const { schedule, library, titles } = await resolveSchedule(parseScheduleFile(ch.schedule), cachedSource(client, store, clock));
  const { from } = alignToGrid(ch.edge, schedule.grid);
  const keepFrom = range.keepFrom ?? from;
  const keepTo = range.keepTo ?? range.to;
  if (!(range.to > from)) throw new ConsistencyError('the end of the range is not after the end of the committed lineup');
  if (!(keepTo > keepFrom) || keepFrom < from || keepTo > range.to) throw new ConsistencyError('the part to keep must lie inside the range, after the committed lineup');
  const { locked, pins, windows } = stagedInputs(store, ch, from, library, titles);
  const result = plan({ schedule, library, state: ch.state, from, to: range.to, locked, pins, windows });
  const kept = result.slots.filter((s) => s.start >= keepFrom && s.start < keepTo);
  const before = range.before ?? store.stagedSlots(ch.id, keepFrom, keepTo).map((s) => s.planned);
  store.replaceStaged(channelName, keepFrom, keepTo, kept, clock.now());
  return { kept, planned: result.slots.length, warnings: result.warnings.filter((w) => kept.some((k) => w.at >= k.start && w.at < k.end)), titles, changes: diffSlots(before, kept) };
}

export interface StageDiff {
  /** What the staged slots, with their locks, pins and shapes, change compared with planning the schedule fresh. */
  changes: SlotChange[];
  /** Staged slots in the compared range. */
  staged: number;
  titles: Record<string, string>;
}

/**
 * The effect of everything done by hand: the staged slots as the next commit would plan them, compared with the
 * same stretch planned from the schedule alone. Writes nothing.
 */
export async function stageDiff(deps: Pick<WorkerDeps, 'store' | 'client' | 'clock'>, channelName: string): Promise<StageDiff> {
  const { store, client, clock } = deps;
  const ch = store.channel(channelName);
  if (!ch) throw new ConsistencyError(`no channel named "${channelName}" in the store`);
  const staged = store.stagedSlots(ch.id);
  if (staged.length === 0) return { changes: [], staged: 0, titles: {} };
  const { schedule, library, titles } = await resolveSchedule(parseScheduleFile(ch.schedule), cachedSource(client, store, clock));
  const { from } = alignToGrid(ch.edge, schedule.grid);
  const to = Math.max(...staged.map((s) => s.start)) + 1;
  const fresh = plan({ schedule, library, state: ch.state, from, to });
  const { locked, pins, windows } = stagedInputs(store, ch, from, library, titles);
  const shaped = plan({ schedule, library, state: ch.state, from, to, locked, pins, windows });
  const first = Math.min(...staged.map((s) => s.start));
  return { changes: diffSlots(fresh.slots.filter((s) => s.start >= first), shaped.slots.filter((s) => s.start >= first)), staged: staged.length, titles };
}

export interface RevisionImpact {
  /** Locked staged slots the new schedule would not let the next commit keep as stored. */
  conflicts: LockConflict[];
  /** What the new schedule changes in the staged range, compared with the current one. */
  changes: SlotChange[];
  staged: number;
  titles: Record<string, string>;
}

/**
 * A dry run of saving a new schedule text: plans the staged range under the current schedule and under the new
 * one, with the same locks, pins and shapes, and reports the locked slots that would no longer fit and what moved.
 * Writes nothing.
 */
export async function revisionImpact(deps: Pick<WorkerDeps, 'store' | 'client' | 'clock'>, channelName: string, yaml: string): Promise<RevisionImpact> {
  const { store, client, clock } = deps;
  const ch = store.channel(channelName);
  if (!ch) throw new ConsistencyError(`no channel named "${channelName}" in the store`);
  const staged = store.stagedSlots(ch.id);
  const parsed = parseScheduleFile(yaml);
  const next = await resolveSchedule(parsed, cachedSource(client, store, clock));
  if (staged.length === 0) return { conflicts: [], changes: [], staged: 0, titles: next.titles };
  const current = await resolveSchedule(parseScheduleFile(ch.schedule), cachedSource(client, store, clock));
  const to = Math.max(...staged.map((s) => s.start)) + 1;
  const planUnder = (r: typeof current) => {
    const { from } = alignToGrid(ch.edge, r.schedule.grid);
    const { locked, pins, windows } = stagedInputs(store, ch, from, r.library, r.titles);
    return plan({ schedule: r.schedule, library: r.library, state: ch.state, from, to, locked, pins, windows });
  };
  const [a, b] = [planUnder(current), planUnder(next)];
  return { conflicts: b.conflicts, changes: diffSlots(a.slots, b.slots), staged: staged.length, titles: { ...current.titles, ...next.titles } };
}

export interface StageCheck {
  /** Locked slots the next commit could not keep as stored. */
  conflicts: LockConflict[];
  /** Pins that do not fit, or were dropped, as the next commit would plan them. */
  pinProblems: PlanWarning[];
  titles: Record<string, string>;
}

/**
 * What the next commit would find wrong with the staged slots, without writing anything: plans from the
 * end of the committed lineup through the last staged slot with the locks and pins, and reports the lock
 * conflicts and the pin problems.
 */
export async function stageCheck(deps: Pick<WorkerDeps, 'store' | 'client' | 'clock'>, channelName: string): Promise<StageCheck> {
  const { store, client, clock } = deps;
  const ch = store.channel(channelName);
  if (!ch) throw new ConsistencyError(`no channel named "${channelName}" in the store`);
  const staged = store.stagedSlots(ch.id);
  if (staged.length === 0) return { conflicts: [], pinProblems: [], titles: {} };
  const { schedule, library, titles } = await resolveSchedule(parseScheduleFile(ch.schedule), cachedSource(client, store, clock));
  const { from } = alignToGrid(ch.edge, schedule.grid);
  const { locked, pins, windows } = stagedInputs(store, ch, from, library, titles);
  const to = Math.max(...staged.map((s) => s.start)) + 1;
  const result = plan({ schedule, library, state: ch.state, from, to, locked, pins, windows });
  return {
    conflicts: result.conflicts,
    pinProblems: result.warnings.filter((w) => w.code === 'pin-does-not-fit' || w.code === 'pin-dropped'),
    titles,
  };
}

/**
 * Plans the staged slots again from `from` to the last staged slot, keeping locks, pins and shapes. A change to
 * one slot moves the places of the shows after it, so everything staged after it is planned again too.
 */
export async function stageRefresh(
  deps: Pick<WorkerDeps, 'store' | 'client' | 'clock'>,
  channelName: string,
  from: number,
  before?: readonly PlannedSlot[],
): Promise<StageResult> {
  const ch = deps.store.channel(channelName);
  if (!ch) throw new ConsistencyError(`no channel named "${channelName}" in the store`);
  const last = Math.max(from, ...deps.store.stagedSlots(ch.id).map((s) => s.start));
  return stageGenerate(deps, channelName, { to: last + 1, keepFrom: from, keepTo: last + 1, ...(before ? { before } : {}) });
}

export type StageEdit =
  | { kind: 'delete'; start: number }
  | { kind: 'resize'; start: number; end: number }
  | { kind: 'add'; start: number; end: number; pin?: PinRecord };

type RowInput = Omit<StagedSlotRecord, 'channelId' | 'generatedAt'>;

/**
 * Changes the shape of the staged slots, then plans the affected stretch again. Nothing is written to Tunarr.
 * - delete: the staged slot just before it grows to take its time.
 * - resize (a new end): the start never moves. Slots it now covers are removed, one it partly covers starts where
 *   this one now ends, and when it shrinks the slot after it starts earlier, so no time is left empty.
 * - add: a slot with no pool, whose content is its pin. Slots it overlaps are cut around it (one that contains it
 *   is split in two).
 * A locked slot is never changed: unlock it first.
 */
export async function stageEdit(deps: Pick<WorkerDeps, 'store' | 'client' | 'clock'>, channelName: string, edit: StageEdit): Promise<StageResult> {
  const { store, clock } = deps;
  const ch = store.channel(channelName);
  if (!ch) throw new ConsistencyError(`no channel named "${channelName}" in the store`);
  const grid = parseScheduleFile(ch.schedule).grid;
  const rows = store.stagedSlots(ch.id);
  const remove = new Set<number>();
  const put = new Map<number, RowInput>();
  const asInput = (r: StagedSlotRecord): RowInput => ({ start: r.start, end: r.end, slotId: r.slotId, pool: r.pool, pins: r.pins, locked: r.locked, edited: r.edited, planned: r.planned });
  const reshape = (row: StagedSlotRecord, patch: { start?: number; end?: number }): void => {
    if (row.locked) throw new ConsistencyError(`the slot starting ${row.start} is locked; unlock it first`);
    const next: RowInput = { ...(put.get(row.start) ?? asInput(row)), ...patch, edited: true };
    if (patch.start !== undefined && patch.start !== row.start) {
      remove.add(row.start);
      put.delete(row.start);
    }
    put.set(next.start, next);
  };
  const dropRow = (row: StagedSlotRecord): void => {
    if (row.locked) throw new ConsistencyError(`the slot starting ${row.start} is locked; unlock it first`);
    remove.add(row.start);
    put.delete(row.start);
  };
  const needGrid = (t: number, what: string): void => {
    if (t % grid !== 0) throw new ConsistencyError(`the ${what} must be on the ${grid / 60_000}-minute grid`);
  };
  const atStart = (start: number): StagedSlotRecord => {
    const r = rows.find((x) => x.start === start);
    if (!r) throw new ConsistencyError('no slot is staged starting then');
    return r;
  };

  if (edit.kind === 'delete') {
    const r = atStart(edit.start);
    const prev = rows.find((x) => x.end === r.start);
    if (!prev) throw new ConsistencyError('no staged slot ends where this one starts, so nothing could grow to take its time; resize the one before it instead');
    reshape(prev, { end: r.end });
    dropRow(r);
  } else if (edit.kind === 'resize') {
    const r = atStart(edit.start);
    needGrid(edit.end, 'new end');
    if (edit.end <= r.start) throw new ConsistencyError('the new end must be after the slot starts');
    if (edit.end > r.end) {
      for (const o of rows) {
        if (o.start < r.end || o.start >= edit.end) continue;
        if (o.end <= edit.end) dropRow(o);
        else reshape(o, { start: edit.end });
      }
    } else if (edit.end < r.end) {
      const next = rows.find((x) => x.start === r.end);
      if (next) reshape(next, { start: edit.end });
    }
    reshape(r, { end: edit.end });
  } else {
    if (!(edit.end > edit.start)) throw new ConsistencyError('the end must be after the start');
    needGrid(edit.start, 'start');
    needGrid(edit.end, 'end');
    if (edit.start < ch.edge) throw new ConsistencyError('a slot can only be added after the end of the committed lineup');
    for (const o of rows) {
      if (o.end <= edit.start || o.start >= edit.end) continue;
      if (o.start >= edit.start && o.end <= edit.end) dropRow(o);
      else if (o.start < edit.start && o.end > edit.end) {
        // The new slot sits inside this one: the earlier part stays, the rest carries on after it.
        reshape(o, { end: edit.start });
        put.set(edit.end, { ...asInput(o), start: edit.end, pins: {}, edited: true });
      } else if (o.start < edit.start) reshape(o, { end: edit.start });
      else reshape(o, { start: edit.end });
    }
    const id = `added@${edit.start}`;
    const empty: PlannedSlot = { slotId: id, start: edit.start, end: edit.end, pool: '', programs: [], blocks: [], exception: false, items: [] };
    put.set(edit.start, { start: edit.start, end: edit.end, slotId: id, pool: null, pins: edit.pin ? { 1: edit.pin } : {}, locked: false, edited: true, planned: empty });
  }

  const first = Math.min(...remove, ...put.keys());
  const before = rows.filter((r) => r.start >= first).map((r) => r.planned);
  store.restructure(channelName, [...remove], [...put.values()], clock.now());
  return stageRefresh(deps, channelName, first, before);
}

export interface SequenceInfo {
  /** The key the store uses for this ordered pool's place. */
  key: string;
  pool: string;
  /** Episodes in the pool's order. */
  length: number;
  /** The slots that read this sequence, for example "1@28800000". */
  slots: string[];
}

/** The ordered pools of a schedule that have a place to keep: one per slot, or one per linked group. */
export function listSequences(schedule: Schedule): SequenceInfo[] {
  const out = new Map<string, SequenceInfo>();
  for (const slot of schedule.week) {
    const pool = schedule.pools[slot.pool];
    if (!pool || pool.order !== 'ordered') continue;
    const id = `${slot.day}@${slot.at}`;
    const key = `seq:${slot.link ? slot.link.name : id}`;
    const info = out.get(key) ?? { key, pool: slot.pool, length: pool.programs.length, slots: [] };
    info.slots.push(id);
    out.set(key, info);
  }
  return [...out.values()].sort((a, b) => a.key.localeCompare(b.key));
}

export interface FoundPlace {
  key: string;
  pool: string;
  length: number;
  /** The last item of this pool in the lineup, or undefined when the lineup holds none of it. */
  lastProgramId: string | undefined;
  /** What the sequence's state should be: the episode after the last one found, and how many distinct episodes have aired. */
  place: { position: number; history: number };
}

/**
 * Where each ordered show stands, read from a channel's existing lineup: the latest item in the
 * lineup that belongs to the pool is the last one scheduled, so "next" is the episode after it.
 * `history` is the number of distinct episodes of the pool the lineup holds. A rerun slot linked to
 * the same show counts like any other item, so a trailing rerun can pull the place back; the caller
 * shows the result and a person corrects it with `cursor set`.
 */
export function placesFromLineup(schedule: Schedule, lineup: readonly Record<string, unknown>[]): FoundPlace[] {
  const out: FoundPlace[] = [];
  for (const info of listSequences(schedule)) {
    const programs = schedule.pools[info.pool]!.programs;
    const index = new Map(programs.map((id, i) => [id, i]));
    let last: number | undefined;
    let lastId: string | undefined;
    const seen = new Set<string>();
    for (const item of lineup) {
      if (item['type'] !== 'content' || typeof item['id'] !== 'string') continue;
      const i = index.get(item['id']);
      if (i === undefined) continue;
      last = i;
      lastId = item['id'];
      seen.add(item['id']);
    }
    out.push({
      key: info.key,
      pool: info.pool,
      length: info.length,
      lastProgramId: lastId,
      place: last === undefined ? { position: 0, history: 0 } : { position: (last + 1) % info.length, history: seen.size },
    });
  }
  return out;
}

/**
 * Sets each ordered show's place from the channel's existing lineup (see `placesFromLineup`). Only for a
 * channel DayTuner has not yet written to: once it has commits its own state is the truth. A dry run
 * changes nothing.
 */
export async function adoptHistory(
  deps: WorkerDeps,
  channelName: string,
  opts: { dryRun?: boolean } = {},
): Promise<{ found: FoundPlace[]; titles: Record<string, string> }> {
  const { store, client, clock } = deps;
  const ch = store.channel(channelName);
  if (!ch) throw new ConsistencyError(`no channel named "${channelName}" in the store`);
  if (store.commits(ch.id, 1).length > 0) {
    throw new ConsistencyError(`DayTuner has already written to "${channelName}", so its own state is the truth; use \`cursor\` to move a show's place`);
  }
  const { schedule, titles } = await resolveSchedule(parseScheduleFile(ch.schedule), cachedSource(client, store, clock));
  const found = placesFromLineup(schedule, await client.lineup(ch.tunarrId));
  if (!opts.dryRun) {
    const sequences = { ...ch.state.sequences };
    for (const f of found) if (f.lastProgramId !== undefined) sequences[f.key] = f.place;
    store.setState(channelName, { ...ch.state, sequences });
  }
  return { found, titles };
}

/**
 * Moves an ordered show's place by hand (a missed week): rewind by k episodes, or set to an episode.
 * It changes the state at the committed edge, so it affects the first uncommitted airing onward and
 * never anything already in Tunarr.
 */
export async function adjustCursor(
  deps: Pick<WorkerDeps, 'store' | 'client' | 'clock'>,
  channelName: string,
  sequenceKey: string,
  adjustment: CursorAdjustment,
): Promise<{ before: { position: number; history: number }; after: { position: number; history: number } }> {
  const ch = deps.store.channel(channelName);
  if (!ch) throw new ConsistencyError(`no channel named "${channelName}" in the store`);
  const { schedule } = await resolveSchedule(parseScheduleFile(ch.schedule), cachedSource(deps.client, deps.store, deps.clock));
  const info = listSequences(schedule).find((s) => s.key === sequenceKey);
  if (!info) {
    throw new ConsistencyError(`no ordered pool is called "${sequenceKey}" (known: ${listSequences(schedule).map((s) => s.key).join(', ') || 'none'})`);
  }
  const before = ch.state.sequences[sequenceKey] ?? { position: 0, history: 0 };
  const after = adjustSequence(before, adjustment, info.length);
  deps.store.applyAdjustment(channelName, {
    at: deps.clock.now(),
    sequenceKey,
    kind: adjustment.kind,
    amount: adjustment.kind === 'rewind' ? adjustment.by : adjustment.index,
    positionBefore: before.position,
    next: after,
  });
  return { before, after };
}
