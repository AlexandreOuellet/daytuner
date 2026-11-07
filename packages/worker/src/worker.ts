// The worker: keeps a channel's committed lineup far enough ahead, by planning from where the lineup
// ends and appending. It only appends. Before it writes anything it checks that the store and Tunarr
// agree about where the lineup ends, and it records every commit so that a crash can be resolved.
// Rules: docs/architecture.md, "Worker".

import { adjustSequence, plan, type Clock, type CursorAdjustment, type PlannedSlot, type PlanWarning, type Schedule } from '@daytuner/engine';
import { parseScheduleFile, resolveSchedule } from '@daytuner/schedule';
import type { CommitRecord, Store } from '@daytuner/store';
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
  const base = { ...(recovered ? { recovered } : {}), aheadBefore: ahead, warnings: [] as PlanWarning[] };
  if (ahead >= ch.floorMs + ch.stepMs) return { action: 'none', ...base };

  const { schedule, library, fillerListIds } = await resolveSchedule(parseScheduleFile(ch.schedule), client);
  const { from, flex } = alignToGrid(edgeNow, schedule.grid);
  const result = plan({ schedule, library, state: ch.state, from, to: now + ch.floorMs + ch.stepMs });
  if (result.slots.length === 0) return { action: 'none', ...base, warnings: result.warnings };

  const items: LineupItem[] = [...(flex > 0 ? [{ type: 'flex' as const, duration: flex }] : []), ...toLineupItems(result.slots, fillerListIds)];
  const totalMs = totalDuration(items);
  if (opts.dryRun) {
    return { action: 'would-append', ...base, warnings: result.warnings, items: items.length, totalMs, slots: result.slots.length, planned: result.slots };
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
  return {
    action: 'appended',
    ...base,
    warnings: result.warnings,
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
  const { schedule } = await resolveSchedule(parseScheduleFile(ch.schedule), deps.client);
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
