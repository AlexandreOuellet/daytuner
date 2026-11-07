// The store: per channel, the planner's state at the committed edge, a copy of the schedule, and the
// commit log. SQLite through Node's built-in node:sqlite (no native build). Times are passed in, so
// the store never reads the clock.

import { DatabaseSync } from 'node:sqlite';
import type { PlanState } from '@daytuner/engine';

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
}

/** One saved version of a channel's schedule. Revisions are never edited or removed. */
export interface RevisionRecord {
  channelId: number;
  number: number;
  yaml: string;
  savedAt: number;
}

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
          .prepare('insert into channels (name, tunarr_id, floor_ms, step_ms, schedule, revision, state, edge) values (?, ?, ?, ?, ?, 1, ?, ?)')
          .run(c.name, c.tunarrId, c.floorMs, c.stepMs, c.schedule, JSON.stringify(c.state), c.edge);
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

  /** Attaches a note to a commit, for the person who has to look at it later. */
  noteCommit(commitId: number, note: string): void {
    const r = this.db.prepare('update commits set note = ? where id = ?').run(note, commitId);
    if (Number(r.changes) === 0) throw new StoreError(`no commit ${commitId}`);
  }

  /** The append happened: the channel's state and edge move to the commit's, in one step. */
  completeCommit(commitId: number, actualEdge: number, at: number): void {
    this.tx(() => {
      const row = this.db.prepare('select * from commits where id = ?').get(commitId);
      if (!row) throw new StoreError(`no commit ${commitId}`);
      const c = commitOf(row as Row);
      if (c.status !== 'pending') throw new StoreError(`commit ${commitId} is ${c.status}, not pending`);
      this.db.prepare("update commits set status = 'done', finished_at = ? where id = ?").run(at, commitId);
      this.db.prepare('update channels set state = ?, edge = ? where id = ?').run(JSON.stringify(c.state), actualEdge, c.channelId);
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
    a: { at: number; sequenceKey: string; kind: 'rewind' | 'set'; amount: number; positionBefore: number; next: { position: number; history: number } },
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

  commits(channelId: number, limit = 50): CommitRecord[] {
    return this.db
      .prepare('select * from commits where channel_id = ? order by id desc limit ?')
      .all(channelId, limit)
      .map((r) => commitOf(r as Row));
  }
}
