// The worker: keeps a channel's committed lineup far enough ahead, by planning from where the lineup
// ends and appending. It only appends. Before it writes anything it checks that the store and Tunarr
// agree about where the lineup ends, and it records every commit so that a crash can be resolved.
// Rules: docs/architecture.md, "Worker".

import { adjustSequence, placeInList, computeMetrics, diffSlots, emptyPlanState, plan, type SlotChange, type Clock, type StagedWindow, type CursorAdjustment, type LockConflict, type PlannedSlot, type PlanWarning, type Schedule } from '@daytuner/engine';
import { parseScheduleFile, resolveSchedule } from '@daytuner/schedule';
import { cachedSource } from './chapters.js';
import type { ChannelRecord, CommitRecord, PinRecord, StagedSlotRecord, Store } from '@daytuner/store';
import { resolveCached } from './resolvecache.js';
import { alignToGrid, appendVerified, snapToGrid, toLineupItems, totalDuration, type LineupItem, type TunarrClient } from '@daytuner/tunarr-client';

/** Two ends closer than this are the same: Tunarr's durations carry fractions that are rounded. */
const EDGE_TOLERANCE_MS = 1;
/** The most the end of a lineup may have drifted from what was written, when it has not left its grid line. */
const EDGE_DRIFT_TOLERANCE_MS = 1000;

/**
 * What changed in the pools since the channel was last planned: programs that joined and left, so a rule that starts to match
 * (or stops matching) something is seen. The first plan has nothing to compare with and says nothing.
 */
export function poolChanges(before: Record<string, string[]> | undefined, schedule: Schedule, titles: Record<string, string>, at: number): PlanWarning[] {
  if (!before) return [];
  const out: PlanWarning[] = [];
  const names = (ids: string[]): string => `${ids.slice(0, 3).map((i) => titles[i] ?? i).join('; ')}${ids.length > 3 ? ` and ${ids.length - 3} more` : ''}`;
  for (const [name, pool] of Object.entries(schedule.pools)) {
    const old = before[name];
    if (!old) continue;
    const was = new Set(old);
    const is = new Set(pool.programs);
    const joined = pool.programs.filter((i) => !was.has(i));
    const left = old.filter((i) => !is.has(i));
    if (joined.length === 0 && left.length === 0) continue;
    const grew = old.length > 0 && pool.programs.length > old.length * 2;
    out.push({
      code: 'pool-changed', severity: grew ? 'warning' : 'info', at, slotId: name,
      message: `pool ${name}: ${joined.length > 0 ? `${joined.length} joined (${names(joined)})` : ''}${joined.length > 0 && left.length > 0 ? ', ' : ''}${left.length > 0 ? `${left.length} left (${names(left)})` : ''}; it holds ${pool.programs.length} now${grew ? `, more than twice the ${old.length} before: check the rule` : ''}`,
    });
  }
  return out;
}

/**
 * Where planning starts for a channel whose lineup ends at `edge`: the grid line at or after it. A channel nothing was ever written
 * to has only its start time, and when that is in the past nothing before now can air: a flex bridges the gap, and the first plan
 * starts at the grid line just before `now` (the start time is never changed). Everything that plans ahead (the next run, staging,
 * the calendar, the previews) starts from here, so what they show is what the next run writes.
 */
export function originOf(edge: number, empty: boolean, grid: number, now: number): { from: number; flex: number } {
  const aligned = alignToGrid(edge, grid);
  const nowLine = Math.floor(now / grid) * grid;
  return empty && aligned.from < nowLine ? { from: nowLine, flex: Math.round(nowLine - edge) } : aligned;
}

/** `originOf` for a channel of the store: reads Tunarr once to learn whether anything was ever written to it. */
export async function planOrigin(deps: Pick<WorkerDeps, 'client' | 'clock'>, ch: { tunarrId: string; edge: number }, grid: number): Promise<{ from: number; flex: number }> {
  const tun = await deps.client.channel(ch.tunarrId);
  return originOf(ch.edge, tun.duration === 0, grid, deps.clock.now());
}

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

const sumMs = (items: readonly { duration: number }[]): number => items.reduce((a, i) => a + i.duration, 0);

/**
 * What is wrong with the planned slots as they would be written, or an empty list. Checked before anything is sent, and the
 * rules are the grid rules of `planning-rules.md`: the first slot starts where the lineup is aligned to, slots touch, each starts
 * and ends on the grid, what is in each adds up to its length exactly (whole milliseconds), and every block boundary inside a slot
 * is on the grid (the first block of a slot may start after a head and the last may end where a tail starts). A run slot has no
 * block boundaries to check: its blocks are its items.
 */
export function layoutProblems(slots: readonly PlannedSlot[], from: number, grid: number): string[] {
  const out: string[] = [];
  const say = (m: string): void => { if (out.length < 8) out.push(m); };
  const on = (t: number): boolean => t % grid === 0;
  let at = from;
  slots.forEach((s, i) => {
    const name = `slot ${s.slotId} at ${s.start}`;
    if (s.start !== at) say(i === 0 ? `the first slot starts at ${s.start}, not where the lineup is aligned to (${from})` : `${name} does not start where the slot before it ends (${at})`);
    if (!on(s.start) || !on(s.end)) say(`${name} (to ${s.end}) is not on the ${grid / 60_000}-minute grid`);
    const items = sumMs(s.items);
    if (items !== s.end - s.start) say(`${name}: its items last ${items} ms but the slot lasts ${s.end - s.start} ms`);
    if (s.items.some((x) => !Number.isInteger(x.duration))) say(`${name} has an item whose length is not a whole number of milliseconds`);
    // A run slot's blocks are its items: only the slot's own edges are on the grid.
    if (!s.run) s.blocks.forEach((b, j) => {
      if (j > 0 && !on(b.start)) say(`${name}: block ${j + 1} starts at ${b.start}, off the grid`);
      if (j < s.blocks.length - 1 && !on(b.end)) say(`${name}: block ${j + 1} ends at ${b.end}, off the grid`);
    });
    at = s.end;
  });
  return out;
}

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

/** An item's length as Tunarr counts it: clips at their real length, and a program's last piece up to the program's real end. */
function realLengths(library: { programs: Record<string, { duration: number; exact?: number }>; clips: Record<string, readonly { id: string; duration: number; exact?: number }[]> }): (i: LineupItem) => number {
  const clip = new Map<string, number>();
  for (const list of Object.values(library.clips)) for (const c of list) if (c.exact !== undefined) clip.set(c.id, c.exact);
  return (i) => {
    if (i.type === 'filler') return clip.get(i.id) ?? i.duration;
    if (i.type === 'content') {
      const p = library.programs[i.id];
      return p?.exact !== undefined && i.startOffsetMs + i.duration === p.duration ? p.exact - i.startOffsetMs : i.duration;
    }
    return i.duration;
  };
}

const same = (a: number, b: number): boolean => Math.abs(a - b) <= EDGE_TOLERANCE_MS;

/** Settles a commit that was begun but never confirmed, by looking at where Tunarr's lineup really ends. */
function resolvePending(store: Store, pending: CommitRecord, edgeNow: number, at: number): Recovery {
  if (same(edgeNow, pending.toEdge) || same(edgeNow, pending.fromEdge + pending.totalMs)) {
    store.completeCommit(pending.id, pending.toEdge, at);
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
export function stagedInputs(
  store: Store,
  ch: ChannelRecord,
  edge: number,
  library: { programs: Record<string, { duration: number }> },
  titles: Record<string, string>,
): { locked: PlannedSlot[]; pins: { start: number; blocks: Record<number, string> }[]; windows: StagedWindow[] } {
  const staged = store.stagedSlots(ch.id, edge);
  const pins: { start: number; blocks: Record<number, string> }[] = [];
  for (const s of staged) {
    if (Object.keys(s.pins).length === 0) continue;
    const blocks: Record<number, string> = {};
    for (const [n, pin] of Object.entries(s.pins)) {
      blocks[Number(n)] = pin.id;
      // A pinned program that no pool holds is still a program of the library: a locked slot keeps it too, and would otherwise
      // be dropped at commit as "no longer in the library".
      library.programs[pin.id] ??= { duration: pin.duration };
      titles[pin.id] ??= pin.title;
    }
    if (!s.locked) pins.push({ start: s.start, blocks });
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

  // Tunarr reads its filler clips back with their real lengths (fractions of a millisecond), so a long lineup's end drifts a little
  // from the whole milliseconds that were written. A drift of under a second that leaves the next grid line where it was is only that:
  // the new lineup starts on the grid line after a flex, as it does for any fractional end. Anything else is an outside change.
  const gridMs = parseScheduleFile(ch.schedule).grid;
  const drift = edgeNow - ch.edge;
  // A drift short of the grid line is only a small flex. A drift past a line the store wrote to is tolerated too, but it costs the
  // next slot a whole grid step of flex (it cannot start before the line after), so that case is a warning, not a note.
  const wroteToLine = same(alignToGrid(ch.edge, gridMs).from, ch.edge);
  const onlyDrift = !same(edgeNow, ch.edge) && Math.abs(drift) <= EDGE_DRIFT_TOLERANCE_MS
    && (alignToGrid(edgeNow, gridMs).from === alignToGrid(ch.edge, gridMs).from || (drift > 0 && wroteToLine));
  if (!same(edgeNow, ch.edge) && !onlyDrift) {
    throw new ConsistencyError(
      `Tunarr's lineup for "${channelName}" ends at ${edgeNow} but the store recorded ${ch.edge}. Someone changed the channel outside DayTuner, or its database was restored. Nothing was written.`,
    );
  }
  const now = clock.now();
  // A channel nothing was ever written to has only its start time. When that is in the past, a flex bridges the gap to the grid line
  // just before now, and the first plan starts there (nothing before now can air, and the start time is never changed).
  const empty = tun.duration === 0;
  if (edgeNow < now && !empty) {
    throw new ConsistencyError(
      `the lineup for "${channelName}" has already run out (it ended ${Math.round((now - edgeNow) / 60_000)} minutes ago). Appending now would shift Tunarr's whole timeline, so nothing was written.`,
    );
  }

  const ahead = edgeNow - now;
  const base = { ...(recovered ? { recovered } : {}), aheadBefore: ahead, warnings: [] as PlanWarning[], conflicts: [] as LockConflict[] };
  if (ahead >= ch.floorMs + ch.stepMs) return { action: 'none', ...base };

  const { schedule, library, fillerListIds, titles } = await resolveSchedule(parseScheduleFile(ch.schedule), cachedSource(client, store, clock));
  const zone = parseScheduleFile(ch.schedule).timezone;
  if (!gridFitsZone(zone, schedule.grid, now)) throw new ConsistencyError(`the ${schedule.grid / 60_000}-minute grid does not fit the time zone ${zone} (its offset from UTC is not a whole number of ${schedule.grid / 60_000}-minute steps), so the slots could not lie on the grid. Nothing was written. Use a grid that divides the offset (${gridsFor(zone, now).join(', ')} minutes).`);
  const { from, flex } = originOf(edgeNow, empty, schedule.grid, now);
  const { locked, pins, windows } = stagedInputs(store, ch, from, library, titles);
  const result = plan({ schedule, library, state: ch.state, from, to: now + ch.floorMs + ch.stepMs, locked, pins, windows });
  result.warnings.push(...poolChanges(store.poolsSeen(ch.id), schedule, titles, from));
  if (onlyDrift) {
    const lost = Math.round(from - edgeNow);
    result.warnings.push(drift > 0 && lost >= gridMs / 2
      ? { code: 'edge-drift', severity: 'warning', at: from, slotId: '', message: `Tunarr's lineup ends ${Math.round(drift)} ms after the grid line it was written to end on (it stores the filler clips with their real lengths), so the next slot has to wait for the next line: a flex of ${Math.round(lost / 60_000)} minutes (${gridMs / 60_000}-minute grid) is added` }
      : { code: 'edge-drift', severity: 'info', at: from, slotId: '', message: `Tunarr's lineup ends ${Math.abs(Math.round(drift))} ms ${drift < 0 ? 'before' : 'after'} where it was written to end (it stores the filler clips with their real lengths); a flex of ${lost} ms brings the next slot back to the grid` });
  }
  if (result.slots.length === 0) return { action: 'none', ...base, warnings: result.warnings };

  const planned = toLineupItems(result.slots, fillerListIds);
  const real = realLengths(library);
  const items: LineupItem[] = [
    ...(flex > 0 ? [{ type: 'flex' as const, duration: flex }] : []),
    ...snapToGrid(planned, { from, grid: schedule.grid, startReal: edgeNow + flex, real }),
  ];
  const totalMs = totalDuration(items);
  const planEnd = result.slots[result.slots.length - 1]!.end;
  const bad = layoutProblems(result.slots, from, schedule.grid);
  if (bad.length > 0) throw new ConsistencyError(`the plan does not lie on the grid as it should, so nothing was written: ${bad.join('; ')}`);
  if (opts.dryRun) {
    return { action: 'would-append', ...base, warnings: result.warnings, conflicts: result.conflicts, items: items.length, totalMs, slots: result.slots.length, planned: result.slots };
  }

  // Record the intent first, so a crash between here and the confirmation can be resolved later.
  const commit = store.beginCommit({
    channelId: ch.id,
    fromEdge: edgeNow,
    toEdge: planEnd,
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
  // Right after an append Tunarr counts the lengths that were written, so the lineup must end where they add up to. Counted at the
  // clips' real lengths, which is how it plays them and how it reads back later, the end is the plan's (a grid line): the items
  // were corrected for that (`snapToGrid`).
  const written = report.edgeBefore + totalMs;
  if (Math.abs(report.edgeAfter - written) > EDGE_TOLERANCE_MS) {
    const what = `the lineup now ends at ${report.edgeAfter}, but the items sent add up to an end at ${written}`;
    store.noteCommit(commit.id, `verification failed: ${what}`);
    throw new ConsistencyError(`Tunarr stored the items, but not where they were planned (${what}). The commit stays pending; see \`channel commits ${channelName}\` and \`channel resync ${channelName}\`.`);
  }
  store.setPoolsSeen(ch.id, Object.fromEntries(Object.entries(schedule.pools).map(([n, p]) => [n, [...p.programs]])), clock.now());
  store.completeCommit(commit.id, planEnd, clock.now(), {
    metrics: computeMetrics(result.slots, { grid: schedule.grid, zone: schedule.zone }),
    alerts: result.warnings.filter((w) => w.severity === 'alert').length,
    warnings: result.warnings.filter((w) => w.severity === 'warning').length,
  });
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
      if (same(edgeNow, pending.toEdge) || same(edgeNow, pending.fromEdge + pending.totalMs)) report.stateMayBeStale = true;
    }
    if (same(edgeNow, pending.toEdge) || same(edgeNow, pending.fromEdge + pending.totalMs)) {
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
  const { from } = await planOrigin(deps, ch, schedule.grid);
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
  const { from } = await planOrigin(deps, ch, schedule.grid);
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
  parseScheduleFile(yaml);
  // Read through the shared cache: a check followed by the save of the same text, and the calendar, read the library once.
  const next = await resolveCached(deps, { tunarrId: ch.tunarrId, schedule: yaml });
  if (staged.length === 0) return { conflicts: [], changes: [], staged: 0, titles: next.titles };
  const current = await resolveCached(deps, ch);
  const to = Math.max(...staged.map((s) => s.start)) + 1;
  const origin = await planOrigin(deps, ch, current.schedule.grid);
  const planUnder = (r: typeof current) => {
    const { from } = origin;
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
  const { from } = await planOrigin(deps, ch, schedule.grid);
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

/**
 * Puts the staged slots that start in `[from, to)` back to what the schedule plans: their shape and pins are dropped
 * and they are planned again, and so is everything staged after them (their places moved). Locked slots in the range
 * are kept: unlock one first to reset it. Returns what changed.
 */
export async function stageReset(deps: Pick<WorkerDeps, 'store' | 'client' | 'clock'>, channelName: string, range: { from: number; to: number }): Promise<StageResult> {
  const { store } = deps;
  const ch = store.channel(channelName);
  if (!ch) throw new ConsistencyError(`no channel named "${channelName}" in the store`);
  if (!(range.to > range.from)) throw new ConsistencyError('the end of the range must be after its start');
  const rows = store.stagedSlots(ch.id);
  const before = rows.filter((r) => r.start >= range.from).map((r) => r.planned);
  store.clearUnlockedStaged(channelName, range.from, range.to);
  const last = Math.max(range.to - 1, ...rows.map((r) => r.start));
  return stageGenerate(deps, channelName, { to: last + 1, keepFrom: range.from, keepTo: last + 1, before });
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

export interface AddChannelOptions {
  yaml: string;
  /** The Tunarr channel to manage: its id, number or name. Defaults to the name in the channel file. */
  tunarrChannel?: string;
  floorMs: number;
  stepMs: number;
  seed: number;
}

export interface AddedChannel {
  name: string;
  tunarrName: string;
  edge: number;
  /** Where each ordered show stands in the channel's existing lineup (not applied: see adoptHistory). */
  places: FoundPlace[];
  notes: string[];
  titles: Record<string, string>;
}

export interface ChannelFileOptions {
  name: string;
  /** The server's time zone. */
  timezone: string;
  /** Names of lists Tunarr has: the one the ad breaks draw from, and the one that fills gaps. */
  adList?: string | undefined;
  fillerList?: string | undefined;
  /** The planning grid in minutes, one of `GRID_CHOICES`. Defaults to 15. */
  gridMinutes?: number | undefined;
}

/** The grids a new channel may have, in minutes. */
export const GRID_CHOICES = [5, 10, 15, 20, 30, 60] as const;

/** How far `zone`'s clock is ahead of UTC at an instant, in whole milliseconds. */
export function utcOffsetMs(zone: string, ms: number): number {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(ms));
  const g = (t: string): number => Number(p.find((x) => x.type === t)?.value);
  return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second')) - Math.floor(ms / 1000) * 1000;
}

/**
 * Whether a grid fits a time zone. A slot sits on the zone's clock (20:00), the lineup's grid lines on the epoch, and the two agree
 * only when the grid divides the zone's offset from UTC, in winter and in summer. In Toronto (-5 h, -4 h) every choice does; in
 * India (+5:30) a 20-minute or an hour grid does not, and a lineup on it would be refused at every run.
 */
export function gridFitsZone(zone: string, gridMs: number, now: number): boolean {
  return [now, now + 91 * 86_400_000, now + 182 * 86_400_000, now + 273 * 86_400_000].every((t) => utcOffsetMs(zone, t) % gridMs === 0);
}

/** The grids, in minutes, that a new channel in `zone` may have. */
export const gridsFor = (zone: string, now: number): number[] => GRID_CHOICES.filter((m) => gridFitsZone(zone, m * 60_000, now));

const gridOf = (minutes: number | undefined, zone: string, now: number): number => {
  const m = minutes ?? 15;
  if (!(GRID_CHOICES as readonly number[]).includes(m)) throw new ConsistencyError(`the grid must be one of ${GRID_CHOICES.join(', ')} minutes`);
  if (!gridFitsZone(zone, m * 60_000, now)) throw new ConsistencyError(`a ${m}-minute grid does not fit the time zone ${zone} (its offset from UTC is not a whole number of ${m}-minute steps); choose one of ${gridsFor(zone, now).join(', ')} minutes`);
  return m * 60_000;
};

/** The text of a channel file with no slots and no pools yet: the week is designed on the schedule page. Grid 15 minutes unless given. */
export function newChannelFile(o: ChannelFileOptions, now: number = Date.now()): string {
  const q = (t: string): string => JSON.stringify(t);
  const ads = o.adList
    ? [`  mid:  { list: ${q(o.adList)}, every: 8m, length: 2m-3m, tailBuffer: 1m }`, `  post: { list: ${q(o.adList)}, length: 0-5m }`, `  tail: { list: ${q(o.adList)}, length: 0-25m }`]
    : [];
  return [
    `channel: ${q(o.name)}`, `timezone: ${q(o.timezone)}`, `grid: ${gridOf(o.gridMinutes, o.timezone, now) / 60_000}m`,
    'ads:', '  step: 15s', '  ratio: { min: 15%, max: 60% }', ...ads,
    ...(o.fillerList ? [`interstitial: { list: ${q(o.fillerList)} }`] : []),
    'pools: {}', 'week: {}', '',
  ].join('\n');
}

export interface CreateChannelOptions extends ChannelFileOptions {
  number: number;
  hidden: boolean;
  floorMs: number;
  stepMs: number;
  seed: number;
}


/**
 * Creates an empty channel in Tunarr (needs a client that may write) and adds it to the store with an empty week. Refuses a name
 * or number that is already used. The channel starts now, rounded down to the grid, and its start time is never changed again.
 */
export async function createChannel(deps: WorkerDeps, o: CreateChannelOptions): Promise<AddedChannel> {
  const { store, client, clock } = deps;
  const name = o.name.trim();
  if (name === '') throw new ConsistencyError('give the channel a name');
  if (!Number.isInteger(o.number) || o.number < 1) throw new ConsistencyError('the channel number must be a whole number from 1');
  if (store.channel(name)) throw new ConsistencyError(`DayTuner already manages a channel named "${name}"`);
  const existing = await client.channels();
  const managedIds = new Set(store.channels().map((x) => x.tunarrId));
  // A channel made by an earlier try that failed before DayTuner took it over (same name and number, nothing written, not managed) is
  // taken over now, not refused: otherwise the retry would say it exists and the channel would stay in Tunarr, unmanaged.
  const half = existing.find((c) => c.number === o.number && slugOf(c.name) === slugOf(name) && c.duration === 0 && !managedIds.has(c.id));
  const clash = half ? undefined : existing.find((c) => c.number === o.number || slugOf(c.name) === slugOf(name));
  if (clash) throw new ConsistencyError(`Tunarr already has a channel ${clash.number}, "${clash.name}": choose another ${clash.number === o.number ? 'number' : 'name'}`);
  const yaml = newChannelFile({ ...o, name }, clock.now());
  const parsed = parseScheduleFile(yaml);
  // The lists must exist before anything is created in Tunarr.
  await resolveSchedule(parsed, cachedSource(client, store, clock));
  const made = half ?? await client.createChannel({ name, number: o.number, startTime: Math.floor(clock.now() / gridOf(o.gridMinutes, o.timezone, clock.now())) * gridOf(o.gridMinutes, o.timezone, clock.now()), stealth: o.hidden });
  return addChannel(deps, { yaml, tunarrChannel: made.id, floorMs: o.floorMs, stepMs: o.stepMs, seed: o.seed });
}

const slugOf = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/**
 * Adds a channel to the store from a channel file: finds the Tunarr channel, checks that the file fits the library,
 * and starts from a fresh state at the end of the channel's lineup. Reads Tunarr; writes only to the store.
 */
export async function addChannel(deps: Pick<WorkerDeps, 'store' | 'client' | 'clock'>, o: AddChannelOptions): Promise<AddedChannel> {
  const { store, client, clock } = deps;
  const parsed = parseScheduleFile(o.yaml);
  const wanted = o.tunarrChannel ?? parsed.channel;
  const channels = await client.channels();
  const ch = channels.find((c) => c.id === wanted || String(c.number) === wanted || slugOf(c.name) === slugOf(wanted));
  if (!ch) throw new ConsistencyError(`no Tunarr channel matches "${wanted}" (channels: ${channels.map((c) => c.name).join(', ')})`);
  const resolved = await resolveSchedule(parsed, cachedSource(client, store, clock));
  const places = placesFromLineup(resolved.schedule, await client.lineup(ch.id));
  const already = store.channels().find((x) => x.tunarrId === ch.id);
  if (already && already.name !== parsed.channel) throw new ConsistencyError(`the Tunarr channel "${ch.name}" is already managed here as "${already.name}"`);
  const edge = ch.startTime + ch.duration;
  store.addChannel({ name: parsed.channel, tunarrId: ch.id, floorMs: o.floorMs, stepMs: o.stepMs, schedule: o.yaml, state: emptyPlanState(o.seed), edge, at: clock.now() });
  return { name: parsed.channel, tunarrName: ch.name, edge, places, notes: resolved.notes, titles: resolved.titles };
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
    for (const f of found) if (f.lastProgramId !== undefined) sequences[f.key] = { ...f.place, last: f.lastProgramId };
    store.setState(channelName, { ...ch.state, sequences });
  }
  return { found, titles };
}

export interface CursorAiring {
  /** Where the slot starts, and the week slot it comes from. */
  start: number;
  slotId: string;
  /** `continue` takes the show's next episodes; `rerun` replays the ones behind its place. */
  kind: 'continue' | 'rerun';
  /** The episodes it plays now, and after the adjustment. */
  before: string[];
  after: string[];
  /** Already staged, and locked (a locked slot keeps its episodes whatever the adjustment). */
  staged: boolean;
  locked: boolean;
}

export interface CursorPreview {
  key: string;
  pool: string;
  length: number;
  before: { position: number; history: number };
  after: { position: number; history: number };
  /** Everything before this is already committed to Tunarr and stays as it is. */
  committedUntil: number;
  /** The episode that is next up now, and after the adjustment (program ids; titles are in `titles`). */
  next: { before: string | undefined; after: string | undefined };
  airings: CursorAiring[];
  titles: Record<string, string>;
}

/**
 * What an adjustment would change, without applying it: the next airings of the show's slots, from the end of
 * the committed lineup and through what is staged, with the episodes each plays now and after the change.
 * Plans twice (without and with the adjustment) and compares. Writes nothing.
 */
export async function cursorPreview(
  deps: Pick<WorkerDeps, 'store' | 'client' | 'clock'>,
  channelName: string,
  sequenceKey: string,
  adjustment: CursorAdjustment,
  opts: { count?: number; days?: number } = {},
): Promise<CursorPreview> {
  const { store, client, clock } = deps;
  const ch = store.channel(channelName);
  if (!ch) throw new ConsistencyError(`no channel named "${channelName}" in the store`);
  const { schedule, library, titles } = await resolveSchedule(parseScheduleFile(ch.schedule), cachedSource(client, store, clock));
  const info = listSequences(schedule).find((x) => x.key === sequenceKey);
  if (!info) throw new ConsistencyError(`no ordered pool is called "${sequenceKey}" (known: ${listSequences(schedule).map((x) => x.key).join(', ') || 'none'})`);
  const before = placeInList(ch.state.sequences[sequenceKey] ?? { position: 0, history: 0 }, schedule.pools[info.pool]!.programs).seq;
  const after = adjustSequence(before, adjustment, info.length, schedule.pools[info.pool]!.programs);
  const { from } = await planOrigin(deps, ch, schedule.grid);
  const to = from + (opts.days ?? 14) * 86_400_000;
  const { locked, pins, windows } = stagedInputs(store, ch, from, library, titles);
  const run = (seq: { position: number; history: number }) =>
    plan({ schedule, library, state: { ...ch.state, sequences: { ...ch.state.sequences, [sequenceKey]: seq } }, from, to, locked, pins, windows });
  const [a, b] = [run(before), run(after)];
  const staged = new Map(store.stagedSlots(ch.id, from).map((r) => [r.start, r]));
  const modeOf = (slotId: string): 'continue' | 'rerun' => schedule.week.find((w) => `${w.day}@${w.at}` === slotId)?.link?.mode === 'rerun' ? 'rerun' : 'continue';
  const unpinned = (s: PlannedSlot): string[] => s.blocks.filter((x) => !x.pinned).map((x) => x.programId);
  const airings: CursorAiring[] = [];
  b.slots.forEach((slot, i) => {
    if (!info.slots.includes(slot.slotId) || slot.exception) return;
    const was = a.slots[i];
    const row = staged.get(slot.start);
    airings.push({ start: slot.start, slotId: slot.slotId, kind: modeOf(slot.slotId), before: was && was.start === slot.start ? unpinned(was) : [], after: unpinned(slot), staged: row !== undefined, locked: row?.locked === true });
  });
  return { key: sequenceKey, pool: info.pool, length: info.length, before, after, committedUntil: ch.edge, next: { before: schedule.pools[info.pool]!.programs[before.position], after: schedule.pools[info.pool]!.programs[after.position] }, airings: airings.slice(0, opts.count ?? 6), titles };
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
  const before = placeInList(ch.state.sequences[sequenceKey] ?? { position: 0, history: 0 }, schedule.pools[info.pool]!.programs).seq;
  const after = adjustSequence(before, adjustment, info.length, schedule.pools[info.pool]!.programs);
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
