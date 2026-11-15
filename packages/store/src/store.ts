// The store: per channel, the planner's state at the committed edge, a copy of the schedule, and the
// commit log. SQLite through Node's built-in node:sqlite (no native build). Times are passed in, so
// the store never reads the clock.

import { DatabaseSync } from 'node:sqlite';
import type { Metrics, PlannedSlot, PlanState } from '@daytuner/engine';

/** What good looks like for a channel, for the dashboard's health cards. */
export interface Targets {
  /** The most dead air, as a share of air time. */
  deadAirMaxShare: number;
  /** The ad load around a show (the median of pre + mid + post over its length) must lie in this range; null: the schedule's own ratio. */
  adLoadRange: { min: number; max: number } | null;
  /** The 90th percentile of the wait at the end of a slot, in minutes. */
  endOfSlotP90MaxMinutes: number;
  /** Alerts allowed in the last commit. */
  maxAlerts: number;
  /** Repeats of an ordered show's cycle allowed. */
  maxRepeats: number;
}

export const DEFAULT_TARGETS: Targets = { deadAirMaxShare: 0.005, adLoadRange: null, endOfSlotP90MaxMinutes: 30, maxAlerts: 0, maxRepeats: 0 };

/** What is kept about a commit for the dashboard. */
export interface CommitMetricsRecord {
  commitId: number;
  /** When the commit was completed. */
  at: number;
  fromEdge: number;
  toEdge: number;
  metrics: Metrics;
  alerts: number;
  warnings: number;
}

export type RunOutcome = 'appended' | 'nothing-to-do' | 'refused' | 'failed' | 'skipped';

export interface RunRecord {
  id: number;
  channelId: number;
  at: number;
  outcome: RunOutcome;
  message: string;
}

export interface ChannelRecord {
  id: number;
  name: string;
  /** Tunarr's id for the channel. */
  tunarrId: string;
  /** How far ahead the committed lineup must always reach. */
  floorMs: number;
  /** How much one worker run adds. */
  stepMs: number;
  /** The YAML text of the current revision of the channel file. */
  schedule: string;
  /** The number of the current revision (1 for the first). */
  revision: number;
  /** When the scheduled run happens, in minutes after local midnight in the schedule's zone. */
  runAtMinutes: number;
  targets: Targets;
  state: PlanState;
  /** Where the committed lineup ends, as Tunarr reported it (it can carry a fraction). */
  edge: number;
}

export interface NewChannel {
  name: string;
  tunarrId: string;
  floorMs: number;
  stepMs: number;
  schedule: string;
  state: PlanState;
  edge: number;
  /** When the channel is added; recorded as the first revision's time. */
  at?: number;
  runAtMinutes?: number;
}

/** One saved version of a channel's schedule. Revisions are never edited or removed. */
export interface RevisionRecord {
  channelId: number;
  number: number;
  yaml: string;
  savedAt: number;
}

/** A program pinned to a block of a staged slot. The length is kept because the program may not be in any pool. */
export interface PinRecord {
  id: string;
  title: string;
  /** Whole milliseconds, as read from Tunarr when it was pinned. */
  duration: number;
}

/** A planned slot kept ahead of the committed edge, to look at, edit and lock before it is committed. */
export interface StagedSlotRecord {
  channelId: number;
  /** Where its window starts (the key, with the channel). */
  start: number;
  end: number;
  /** The week slot it came from (`day@time`), or none for a slot added by hand. */
  slotId: string | null;
  pool: string | null;
  /** Block number (1 is the first) to the program pinned there. */
  pins: Record<number, PinRecord>;
  locked: boolean;
  /** Shaped by hand (resized, cut back or added), so its window is not the schedule's own. */
  edited: boolean;
  /** The slot as last generated: its blocks and items. */
  planned: PlannedSlot;
  generatedAt: number;
}

export type ChapterKind = 'chapter' | 'intro' | 'outro' | 'break' | 'recap';

export type CommitStatus = 'pending' | 'done' | 'abandoned';

export interface SlotSummary {
  slotId: string;
  start: number;
  end: number;
  programs: string[];
}

export interface CommitRecord {
  id: number;
  channelId: number;
  status: CommitStatus;
  fromEdge: number;
  toEdge: number;
  /** The state after this commit. It becomes the channel's state when the commit is done. */
  state: PlanState;
  items: number;
  totalMs: number;
  slots: SlotSummary[];
  startedAt: number;
  finishedAt: number | null;
  /** Why a commit was left pending or abandoned, when known (for example what verification found). */
  note: string | null;
}

export interface NewCommit {
  channelId: number;
  fromEdge: number;
  toEdge: number;
  state: PlanState;
  items: number;
  totalMs: number;
  slots: SlotSummary[];
  at: number;
}

export interface AdjustmentRecord {
  id: number;
  channelId: number;
  at: number;
  sequenceKey: string;
  kind: 'rewind' | 'set';
  /** The k of a rewind, or the episode index of a set. */
  amount: number;
  positionBefore: number;
  positionAfter: number;
  historyAfter: number;
}

export class StoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoreError';
  }
}

const SCHEMA = `
create table if not exists channels (
  id integer primary key autoincrement,
  name text not null unique,
  tunarr_id text not null,
  floor_ms integer not null,
  step_ms integer not null,
  schedule text not null,
  revision integer not null default 1,
  run_at_minutes integer not null default 180,
  targets text,
  state text not null,
  edge real not null
);
create table if not exists revisions (
  channel_id integer not null references channels(id),
  number integer not null,
  yaml text not null,
  saved_at integer not null,
  primary key (channel_id, number)
);
create table if not exists commits (
  id integer primary key autoincrement,
  channel_id integer not null references channels(id),
  status text not null check (status in ('pending', 'done', 'abandoned')),
  from_edge real not null,
  to_edge real not null,
  state text not null,
  items integer not null,
  total_ms integer not null,
  slots text not null,
  started_at integer not null,
  finished_at integer
);
create table if not exists adjustments (
  id integer primary key autoincrement,
  channel_id integer not null references channels(id),
  at integer not null,
  sequence_key text not null,
  kind text not null check (kind in ('rewind', 'set')),
  amount integer not null,
  position_before integer not null,
  position_after integer not null,
  history_after integer not null
);
create table if not exists staged_slots (
  channel_id integer not null references channels(id),
  start real not null,
  end real not null,
  slot_id text,
  pool text,
  pins text not null default '{}',
  locked integer not null default 0,
  edited integer not null default 0,
  planned text not null,
  generated_at integer not null,
  primary key (channel_id, start)
);
create table if not exists chapter_cache (
  program_id text primary key,
  duration integer not null,
  chapters text not null,
  fetched_at integer not null
);
create table if not exists pool_seen (
  channel_id integer primary key references channels(id),
  pools text not null,
  at integer not null
);
create table if not exists commit_metrics (
  commit_id integer primary key references commits(id),
  metrics text not null,
  alerts integer not null,
  warnings integer not null
);
create table if not exists channel_runs (
  id integer primary key autoincrement,
  channel_id integer not null references channels(id),
  at integer not null,
  outcome text not null,
  message text not null
);
create index if not exists commits_by_channel on commits(channel_id, id);
-- At most one pending commit per channel: a second one would mean two writers.
create unique index if not exists one_pending_per_channel on commits(channel_id) where status = 'pending';
`;

type Row = Record<string, unknown>;

function channelOf(r: Row): ChannelRecord {
  return {
    id: Number(r['id']),
    name: String(r['name']),
    tunarrId: String(r['tunarr_id']),
    floorMs: Number(r['floor_ms']),
    stepMs: Number(r['step_ms']),
    schedule: String(r['schedule']),
    revision: Number(r['revision']),
    runAtMinutes: Number(r['run_at_minutes']),
    targets: { ...DEFAULT_TARGETS, ...(r['targets'] ? (JSON.parse(String(r['targets'])) as Partial<Targets>) : {}) },
    state: JSON.parse(String(r['state'])) as PlanState,
    edge: Number(r['edge']),
  };
}

function commitOf(r: Row): CommitRecord {
  return {
    id: Number(r['id']),
    channelId: Number(r['channel_id']),
    status: String(r['status']) as CommitStatus,
    fromEdge: Number(r['from_edge']),
    toEdge: Number(r['to_edge']),
    state: JSON.parse(String(r['state'])) as PlanState,
    items: Number(r['items']),
    totalMs: Number(r['total_ms']),
    slots: JSON.parse(String(r['slots'])) as SlotSummary[],
    startedAt: Number(r['started_at']),
    finishedAt: r['finished_at'] === null ? null : Number(r['finished_at']),
    note: r['note'] === null || r['note'] === undefined ? null : String(r['note']),
  };
}

export class Store {
  private constructor(private readonly db: DatabaseSync) {}

  /** Opens (and creates, if needed) the database at `path`, or in memory with ':memory:'. */
  static open(path: string): Store {
    const db = new DatabaseSync(path);
    db.exec('pragma journal_mode = wal; pragma foreign_keys = on;');
    db.exec(SCHEMA);
    // A database made before commits had notes gets the column.
    const cols = db.prepare('pragma table_info(commits)').all() as { name: string }[];
    if (!cols.some((c) => c.name === 'note')) db.exec('alter table commits add column note text');
    const colsNow = db.prepare('pragma table_info(channels)').all() as { name: string }[];
    if (!colsNow.some((c) => c.name === 'run_at_minutes')) db.exec('alter table channels add column run_at_minutes integer not null default 180');
    if (!colsNow.some((c) => c.name === 'targets')) db.exec('alter table channels add column targets text');
    const stagedCols = db.prepare('pragma table_info(staged_slots)').all() as { name: string }[];
    if (!stagedCols.some((c) => c.name === 'edited')) db.exec('alter table staged_slots add column edited integer not null default 0');
    // A database made before revisions: its schedule becomes revision 1, saved at time 0 (unknown).
    const chCols = db.prepare('pragma table_info(channels)').all() as { name: string }[];
    if (!chCols.some((c) => c.name === 'revision')) db.exec('alter table channels add column revision integer not null default 1');
    db.exec('insert into revisions (channel_id, number, yaml, saved_at) select id, 1, schedule, 0 from channels where id not in (select channel_id from revisions)');
    return new Store(db);
  }

  close(): void {
    this.db.close();
  }

  private tx<T>(fn: () => T): T {
    this.db.exec('begin immediate');
    try {
      const out = fn();
      this.db.exec('commit');
      return out;
    } catch (e) {
      this.db.exec('rollback');
      throw e;
    }
  }

  addChannel(c: NewChannel): ChannelRecord {
    if (!(c.floorMs > 0) || !(c.stepMs > 0)) throw new StoreError('floor and step must be positive');
    return this.tx(() => {
      let id: number;
      try {
        const r = this.db
          .prepare('insert into channels (name, tunarr_id, floor_ms, step_ms, schedule, revision, run_at_minutes, state, edge) values (?, ?, ?, ?, ?, 1, ?, ?, ?)')
          .run(c.name, c.tunarrId, c.floorMs, c.stepMs, c.schedule, c.runAtMinutes ?? 180, JSON.stringify(c.state), c.edge);
        id = Number(r.lastInsertRowid);
      } catch (e) {
        if (String(e).includes('UNIQUE')) throw new StoreError(`a channel named "${c.name}" already exists`);
        throw e;
      }
      this.db.prepare('insert into revisions (channel_id, number, yaml, saved_at) values (?, 1, ?, ?)').run(id, c.schedule, c.at ?? 0);
      return this.channel(c.name)!;
    });
  }

  channel(name: string): ChannelRecord | undefined {
    const r = this.db.prepare('select * from channels where name = ?').get(name);
    return r ? channelOf(r as Row) : undefined;
  }

  channels(): ChannelRecord[] {
    return this.db.prepare('select * from channels order by name').all().map((r) => channelOf(r as Row));
  }

  /**
   * Saves a new revision of a channel's schedule and makes it current. Saving the text that is already
   * current does nothing. Returns the number of the current revision afterwards.
   */
  setSchedule(name: string, schedule: string, at: number): number {
    return this.tx(() => {
      const ch = this.channel(name);
      if (!ch) throw new StoreError(`no channel named "${name}"`);
      if (ch.schedule === schedule) return ch.revision;
      const last = this.db.prepare('select max(number) as n from revisions where channel_id = ?').get(ch.id) as { n: number };
      const number = last.n + 1;
      this.db.prepare('insert into revisions (channel_id, number, yaml, saved_at) values (?, ?, ?, ?)').run(ch.id, number, schedule, at);
      this.db.prepare('update channels set schedule = ?, revision = ? where id = ?').run(schedule, number, ch.id);
      return number;
    });
  }

  /** Makes an earlier revision current again. History is kept; the next save gets the next number. */
  useRevision(name: string, number: number): void {
    this.tx(() => {
      const ch = this.channel(name);
      if (!ch) throw new StoreError(`no channel named "${name}"`);
      const rev = this.db.prepare('select * from revisions where channel_id = ? and number = ?').get(ch.id, number) as Row | undefined;
      if (!rev) throw new StoreError(`"${name}" has no revision ${number}`);
      this.db.prepare('update channels set schedule = ?, revision = ? where id = ?').run(String(rev['yaml']), number, ch.id);
    });
  }

  revisions(channelId: number): RevisionRecord[] {
    return this.db
      .prepare('select * from revisions where channel_id = ? order by number')
      .all(channelId)
      .map((r) => ({ channelId, number: Number((r as Row)['number']), yaml: String((r as Row)['yaml']), savedAt: Number((r as Row)['saved_at']) }));
  }

  /** Replaces a channel's state by hand (a cursor adjustment). It does not move the edge. */
  setState(name: string, state: PlanState): void {
    const r = this.db.prepare('update channels set state = ? where name = ?').run(JSON.stringify(state), name);
    if (Number(r.changes) === 0) throw new StoreError(`no channel named "${name}"`);
  }

  /** Adopts a new end for the committed lineup by hand (a resync). The state is not touched. */
  setEdge(name: string, edge: number): void {
    const r = this.db.prepare('update channels set edge = ? where name = ?').run(edge, name);
    if (Number(r.changes) === 0) throw new StoreError(`no channel named "${name}"`);
  }

  pendingCommit(channelId: number): CommitRecord | undefined {
    const r = this.db.prepare("select * from commits where channel_id = ? and status = 'pending'").get(channelId);
    return r ? commitOf(r as Row) : undefined;
  }

  /**
   * Records that a commit is about to be written to Tunarr. Call this before appending. Throws if
   * the channel already has a pending commit.
   */
  beginCommit(c: NewCommit): CommitRecord {
    return this.tx(() => {
      if (this.pendingCommit(c.channelId)) throw new StoreError('this channel already has a pending commit');
      const r = this.db
        .prepare(
          "insert into commits (channel_id, status, from_edge, to_edge, state, items, total_ms, slots, started_at) values (?, 'pending', ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(c.channelId, c.fromEdge, c.toEdge, JSON.stringify(c.state), c.items, c.totalMs, JSON.stringify(c.slots), c.at);
      return commitOf(this.db.prepare('select * from commits where id = ?').get(Number(r.lastInsertRowid)) as Row);
    });
  }

  /** Changes a channel's floor, step and the time of its scheduled run. Any of them may be left out. */
  setSettings(name: string, s: { floorMs?: number; stepMs?: number; runAtMinutes?: number }): void {
    const ch = this.channel(name);
    if (!ch) throw new StoreError(`no channel named "${name}"`);
    const floorMs = s.floorMs ?? ch.floorMs;
    const stepMs = s.stepMs ?? ch.stepMs;
    const runAt = s.runAtMinutes ?? ch.runAtMinutes;
    if (!(floorMs > 0) || !(stepMs > 0)) throw new StoreError('floor and step must be positive');
    if (!Number.isInteger(runAt) || runAt < 0 || runAt >= 1440) throw new StoreError('the run time must be a minute of the day, 0 to 1439');
    this.db.prepare('update channels set floor_ms = ?, step_ms = ?, run_at_minutes = ? where id = ?').run(floorMs, stepMs, runAt, ch.id);
  }

  /** Replaces a channel's targets. Fields left out keep their default. */
  setTargets(name: string, targets: Partial<Targets>): Targets {
    const ch = this.channel(name);
    if (!ch) throw new StoreError(`no channel named "${name}"`);
    const next: Targets = { ...DEFAULT_TARGETS, ...targets };
    const range = next.adLoadRange;
    if (!(next.deadAirMaxShare >= 0) || !(next.endOfSlotP90MaxMinutes > 0) || !(next.maxAlerts >= 0) || !(next.maxRepeats >= 0) || (range && !(range.min >= 0 && range.max >= range.min))) {
      throw new StoreError('the targets are not valid numbers');
    }
    this.db.prepare('update channels set targets = ? where id = ?').run(JSON.stringify(next), ch.id);
    return next;
  }

  /** The metrics kept for commits, oldest first, up to the last `limit`. */
  commitMetrics(channelId: number, limit = 100): CommitMetricsRecord[] {
    return this.db
      .prepare(
        `select c.id, c.finished_at, c.from_edge, c.to_edge, m.metrics, m.alerts, m.warnings
           from commit_metrics m join commits c on c.id = m.commit_id
          where c.channel_id = ? order by c.id desc limit ?`,
      )
      .all(channelId, limit)
      .map((r) => {
        const o = r as Row;
        return {
          commitId: Number(o['id']), at: Number(o['finished_at']), fromEdge: Number(o['from_edge']), toEdge: Number(o['to_edge']),
          metrics: JSON.parse(String(o['metrics'])) as Metrics, alerts: Number(o['alerts']), warnings: Number(o['warnings']),
        };
      })
      .reverse();
  }

  /** Records how a run of the worker ended, whoever started it. */
  recordRun(name: string, at: number, outcome: RunOutcome, message: string): void {
    const ch = this.channel(name);
    if (!ch) throw new StoreError(`no channel named "${name}"`);
    this.db.prepare('insert into channel_runs (channel_id, at, outcome, message) values (?, ?, ?, ?)').run(ch.id, at, outcome, message);
  }

  /** The last runs of a channel, newest first. */
  lastRuns(channelId: number, limit = 10): RunRecord[] {
    return this.db
      .prepare('select * from channel_runs where channel_id = ? order by id desc limit ?')
      .all(channelId, limit)
      .map((r) => {
        const o = r as Row;
        return { id: Number(o['id']), channelId, at: Number(o['at']), outcome: String(o['outcome']) as RunOutcome, message: String(o['message']) };
      });
  }

  /** Attaches a note to a commit, for the person who has to look at it later. */
  noteCommit(commitId: number, note: string): void {
    const r = this.db.prepare('update commits set note = ? where id = ?').run(note, commitId);
    if (Number(r.changes) === 0) throw new StoreError(`no commit ${commitId}`);
  }

  /** The append happened: the channel's state and edge move to the commit's, in one step. */
  completeCommit(commitId: number, actualEdge: number, at: number, kept?: { metrics: Metrics; alerts: number; warnings: number }): void {
    this.tx(() => {
      const row = this.db.prepare('select * from commits where id = ?').get(commitId);
      if (!row) throw new StoreError(`no commit ${commitId}`);
      const c = commitOf(row as Row);
      if (c.status !== 'pending') throw new StoreError(`commit ${commitId} is ${c.status}, not pending`);
      this.db.prepare("update commits set status = 'done', finished_at = ? where id = ?").run(at, commitId);
      this.db.prepare('update channels set state = ?, edge = ? where id = ?').run(JSON.stringify(c.state), actualEdge, c.channelId);
      if (kept) {
        this.db.prepare('insert or replace into commit_metrics (commit_id, metrics, alerts, warnings) values (?, ?, ?, ?)').run(commitId, JSON.stringify(kept.metrics), kept.alerts, kept.warnings);
      }
      // What was staged before the new end is now in Tunarr: it is no longer staged.
      this.db.prepare('delete from staged_slots where channel_id = ? and start < ?').run(c.channelId, actualEdge);
    });
  }

  /** The append did not happen: the channel is left exactly as it was. */
  abandonCommit(commitId: number, at: number): void {
    const r = this.db.prepare("update commits set status = 'abandoned', finished_at = ? where id = ? and status = 'pending'").run(at, commitId);
    if (Number(r.changes) === 0) throw new StoreError(`commit ${commitId} is not pending`);
  }

  /**
   * Applies a manual cursor adjustment and logs it, in one step. The sequence's new place replaces the
   * old one in the channel's state. Refused while a commit is pending, because the state is about to move.
   */
  applyAdjustment(
    name: string,
    a: { at: number; sequenceKey: string; kind: 'rewind' | 'set'; amount: number; positionBefore: number; next: { position: number; history: number; last?: string } },
  ): void {
    this.tx(() => {
      const ch = this.channel(name);
      if (!ch) throw new StoreError(`no channel named "${name}"`);
      if (this.pendingCommit(ch.id)) throw new StoreError('this channel has a pending commit; let the worker settle it first');
      const state = { ...ch.state, sequences: { ...ch.state.sequences, [a.sequenceKey]: a.next } };
      this.db.prepare('update channels set state = ? where id = ?').run(JSON.stringify(state), ch.id);
      this.db
        .prepare('insert into adjustments (channel_id, at, sequence_key, kind, amount, position_before, position_after, history_after) values (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(ch.id, a.at, a.sequenceKey, a.kind, a.amount, a.positionBefore, a.next.position, a.next.history);
    });
  }

  adjustments(channelId: number, limit = 50): AdjustmentRecord[] {
    return this.db
      .prepare('select * from adjustments where channel_id = ? order by id desc limit ?')
      .all(channelId, limit)
      .map((r) => {
        const o = r as Row;
        return {
          id: Number(o['id']), channelId: Number(o['channel_id']), at: Number(o['at']), sequenceKey: String(o['sequence_key']),
          kind: String(o['kind']) as 'rewind' | 'set', amount: Number(o['amount']), positionBefore: Number(o['position_before']),
          positionAfter: Number(o['position_after']), historyAfter: Number(o['history_after']),
        };
      });
  }

  /**
   * Stores generated slots as the staged slots that start inside `[from, to)`. Locked slots stay as they are
   * (a generated slot at the same start is ignored); the others are replaced, and keep their pins. Refuses a
   * slot that starts before the committed edge: staging only lives after it.
   */
  replaceStaged(name: string, from: number, to: number, slots: readonly PlannedSlot[], at: number): void {
    this.tx(() => {
      const ch = this.channel(name);
      if (!ch) throw new StoreError(`no channel named "${name}"`);
      for (const sl of slots) {
        if (sl.start < ch.edge) throw new StoreError('staged slots must start at or after the end of the committed lineup');
      }
      const old = this.stagedSlots(ch.id, from, to);
      const lockedStarts = new Set(old.filter((o) => o.locked).map((o) => o.start));
      const pinsOf = new Map(old.map((o) => [o.start, o.pins]));
      const editedOf = new Map(old.map((o) => [o.start, o.edited]));
      this.db.prepare('delete from staged_slots where channel_id = ? and start >= ? and start < ? and locked = 0').run(ch.id, from, to);
      const ins = this.db.prepare('insert into staged_slots (channel_id, start, end, slot_id, pool, pins, locked, edited, planned, generated_at) values (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)');
      for (const sl of slots) {
        if (lockedStarts.has(sl.start)) continue;
        ins.run(ch.id, sl.start, sl.end, sl.slotId, sl.pool === '' ? null : sl.pool, JSON.stringify(pinsOf.get(sl.start) ?? {}), editedOf.get(sl.start) ? 1 : 0, JSON.stringify(sl), at);
      }
    });
  }

  /**
   * Changes the shape of staged slots in one step: removes the rows that start at `remove`, then stores `put`
   * (replacing a row at the same start). The `planned` of a stored row may be stale until the slot is planned again.
   * Refuses a row that starts before the committed edge.
   */
  restructure(name: string, remove: readonly number[], put: readonly Omit<StagedSlotRecord, 'channelId' | 'generatedAt'>[], at: number): void {
    this.tx(() => {
      const ch = this.channel(name);
      if (!ch) throw new StoreError(`no channel named "${name}"`);
      for (const r of put) if (r.start < ch.edge) throw new StoreError('staged slots must start at or after the end of the committed lineup');
      const del = this.db.prepare('delete from staged_slots where channel_id = ? and start = ?');
      for (const start of remove) del.run(ch.id, start);
      const ins = this.db.prepare('insert or replace into staged_slots (channel_id, start, end, slot_id, pool, pins, locked, edited, planned, generated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      for (const r of put) ins.run(ch.id, r.start, r.end, r.slotId, r.pool, JSON.stringify(r.pins), r.locked ? 1 : 0, r.edited ? 1 : 0, JSON.stringify(r.planned), at);
    });
  }

  /** Pins a program to a block of an unlocked staged slot. */
  setPin(name: string, start: number, block: number, pin: PinRecord): void {
    this.changePins(name, start, (pins) => ({ ...pins, [block]: pin }));
  }

  /** Removes the pin on a block. Does nothing when there is none. */
  removePin(name: string, start: number, block: number): void {
    this.changePins(name, start, (pins) => {
      const { [block]: _gone, ...rest } = pins;
      return rest;
    });
  }

  private changePins(name: string, start: number, change: (pins: Record<number, PinRecord>) => Record<number, PinRecord>): void {
    this.tx(() => {
      const ch = this.channel(name);
      if (!ch) throw new StoreError(`no channel named "${name}"`);
      const slot = this.stagedSlots(ch.id, start, start + 1)[0];
      if (!slot) throw new StoreError('no slot is staged starting then');
      if (slot.locked) throw new StoreError('that slot is locked; unlock it to change its pins');
      this.db.prepare('update staged_slots set pins = ? where channel_id = ? and start = ?').run(JSON.stringify(change(slot.pins)), ch.id, start);
    });
  }

  /** Staged slots of a channel that start inside `[from, to)` (all of them when no range is given), earliest first. */
  stagedSlots(channelId: number, from = Number.MIN_SAFE_INTEGER, to = Number.MAX_SAFE_INTEGER): StagedSlotRecord[] {
    return this.db
      .prepare('select * from staged_slots where channel_id = ? and start >= ? and start < ? order by start')
      .all(channelId, from, to)
      .map((r) => {
        const o = r as Row;
        return {
          channelId, start: Number(o['start']), end: Number(o['end']),
          slotId: o['slot_id'] === null ? null : String(o['slot_id']), pool: o['pool'] === null ? null : String(o['pool']),
          pins: JSON.parse(String(o['pins'])) as Record<number, PinRecord>, locked: Number(o['locked']) === 1, edited: Number(o['edited']) === 1,
          planned: JSON.parse(String(o['planned'])) as PlannedSlot, generatedAt: Number(o['generated_at']),
        };
      });
  }

  /**
   * Locks or unlocks the staged slot that starts at `start`. A locked slot is committed as it is stored, and
   * is not replaced by generating again.
   */
  setLocked(name: string, start: number, locked: boolean): void {
    const ch = this.channel(name);
    if (!ch) throw new StoreError(`no channel named "${name}"`);
    const r = this.db.prepare('update staged_slots set locked = ? where channel_id = ? and start = ?').run(locked ? 1 : 0, ch.id, start);
    if (Number(r.changes) === 0) throw new StoreError('no slot is staged starting then');
  }

  /** Removes the unlocked staged slots that start inside `[from, to)`; locked ones stay. Returns how many. */
  clearUnlockedStaged(name: string, from: number, to: number): number {
    const ch = this.channel(name);
    if (!ch) throw new StoreError(`no channel named "${name}"`);
    return Number(this.db.prepare('delete from staged_slots where channel_id = ? and start >= ? and start < ? and locked = 0').run(ch.id, from, to).changes);
  }

  /** Removes staged slots that start inside `[from, to)`, locked ones too. Returns how many. */
  clearStaged(name: string, from = Number.MIN_SAFE_INTEGER, to = Number.MAX_SAFE_INTEGER): number {
    const ch = this.channel(name);
    if (!ch) throw new StoreError(`no channel named "${name}"`);
    return Number(this.db.prepare('delete from staged_slots where channel_id = ? and start >= ? and start < ?').run(ch.id, from, to).changes);
  }

  /**
   * Chapters read earlier for a program, or undefined when there are none, the program's length is not `duration`
   * any more, or they were read before `notBefore`.
   */
  cachedChapters(programId: string, duration: number, notBefore: number): { start: number; end: number; type: ChapterKind }[] | undefined {
    const r = this.db.prepare('select * from chapter_cache where program_id = ? and duration = ? and fetched_at >= ?').get(programId, duration, notBefore);
    return r ? (JSON.parse(String((r as Row)['chapters'])) as { start: number; end: number; type: ChapterKind }[]) : undefined;
  }

  /** Remembers a program's chapters (an empty list too: "has none" is also worth knowing). */
  cacheChapters(programId: string, duration: number, chapters: readonly { start: number; end: number; type: ChapterKind }[], at: number): void {
    this.db
      .prepare('insert or replace into chapter_cache (program_id, duration, chapters, fetched_at) values (?, ?, ?, ?)')
      .run(programId, duration, JSON.stringify(chapters), at);
  }

  /** Forgets every cached chapter list, so the next plan reads them again. Returns how many were dropped. */
  clearChapterCache(): number {
    return Number(this.db.prepare('delete from chapter_cache').run().changes);
  }

  /** The programs each pool held when the channel was last planned for real, or undefined before the first time. */
  poolsSeen(channelId: number): Record<string, string[]> | undefined {
    const r = this.db.prepare('select pools from pool_seen where channel_id = ?').get(channelId) as Row | undefined;
    return r ? (JSON.parse(String(r['pools'])) as Record<string, string[]>) : undefined;
  }

  setPoolsSeen(channelId: number, pools: Record<string, string[]>, at: number): void {
    this.db.prepare('insert or replace into pool_seen (channel_id, pools, at) values (?, ?, ?)').run(channelId, JSON.stringify(pools), at);
  }

  commits(channelId: number, limit = 50): CommitRecord[] {
    return this.db
      .prepare('select * from commits where channel_id = ? order by id desc limit ?')
      .all(channelId, limit)
      .map((r) => commitOf(r as Row));
  }
}
