// The HTTP API. A thin layer over the same functions the command line calls, so the two cannot disagree. This
// first slice only reads. Writing to Tunarr stays off unless the server is started with it switched on.

import { Hono } from 'hono';
import type { Clock } from '@daytuner/engine';
import { diffLines, parseScheduleFile, ScheduleFileError } from '@daytuner/schedule';
import { StoreError, type ChannelRecord, type Store } from '@daytuner/store';
import { JobBusyError, Jobs } from './jobs.js';

export interface AppDeps {
  store: Store;
  clock: Clock;
  /** Whether this server may write to Tunarr. Reported by /api/health; nothing in this slice writes. */
  writesEnabled: boolean;
  jobs?: Jobs;
}

class NotFound extends Error {}

export const VERSION = '0.0.0';

export function createApp(deps: AppDeps): Hono {
  const { store, clock } = deps;
  const jobs = deps.jobs ?? new Jobs(clock);
  const app = new Hono();

  const channel = (name: string): ChannelRecord => {
    const ch = store.channel(name);
    if (!ch) throw new NotFound(`no channel named "${name}"`);
    return ch;
  };
  const timezoneOf = (ch: ChannelRecord): string => {
    try {
      return parseScheduleFile(ch.schedule).timezone;
    } catch {
      return 'UTC';
    }
  };
  const number = (v: string | undefined, what: string): number | undefined => {
    if (v === undefined || v === '') return undefined;
    const n = Number(v);
    if (!Number.isFinite(n)) throw new StoreError(`${what} must be a number`);
    return n;
  };
  const summary = (ch: ChannelRecord) => ({
    name: ch.name,
    tunarrId: ch.tunarrId,
    timezone: timezoneOf(ch),
    floorMs: ch.floorMs,
    stepMs: ch.stepMs,
    revision: ch.revision,
    edge: ch.edge,
    aheadMs: ch.edge - clock.now(),
    pendingCommit: store.pendingCommit(ch.id) !== undefined,
    staged: store.stagedSlots(ch.id).length,
  });

  app.onError((e, c) => {
    if (e instanceof NotFound) return c.json({ error: e.message }, 404);
    if (e instanceof JobBusyError) return c.json({ error: e.message, job: e.running }, 409);
    if (e instanceof StoreError || e instanceof ScheduleFileError) return c.json({ error: e.message }, 400);
    return c.json({ error: 'internal error' }, 500);
  });
  app.notFound((c) => c.json({ error: 'not found' }, 404));

  app.get('/api/health', (c) => c.json({ ok: true, version: VERSION, writes: deps.writesEnabled }));

  app.get('/api/channels', (c) => c.json(store.channels().map(summary)));

  app.get('/api/channels/:name', (c) => {
    const ch = channel(c.req.param('name'));
    return c.json({ ...summary(ch), commits: store.commits(ch.id, 5).map(({ state: _state, ...rest }) => rest) });
  });

  app.get('/api/channels/:name/schedule', (c) => {
    const ch = channel(c.req.param('name'));
    return c.json({ revision: ch.revision, yaml: ch.schedule });
  });

  app.get('/api/channels/:name/revisions', (c) => {
    const ch = channel(c.req.param('name'));
    return c.json(store.revisions(ch.id).map((r) => ({ number: r.number, savedAt: r.savedAt, current: r.number === ch.revision })));
  });

  app.get('/api/channels/:name/revisions/:number', (c) => {
    const ch = channel(c.req.param('name'));
    const n = Number(c.req.param('number'));
    const rev = store.revisions(ch.id).find((r) => r.number === n);
    if (!rev) throw new NotFound(`"${ch.name}" has no revision ${c.req.param('number')}`);
    return c.json({ number: rev.number, savedAt: rev.savedAt, yaml: rev.yaml });
  });

  app.get('/api/channels/:name/diff', (c) => {
    const ch = channel(c.req.param('name'));
    const revs = store.revisions(ch.id);
    const to = number(c.req.query('to'), 'to') ?? ch.revision;
    const from = number(c.req.query('from'), 'from') ?? to - 1;
    const a = revs.find((r) => r.number === from);
    const b = revs.find((r) => r.number === to);
    if (!b) throw new NotFound(`"${ch.name}" has no revision ${to}`);
    if (!a) throw new NotFound(from < 1 ? `revision ${to} is the first; there is nothing before it` : `"${ch.name}" has no revision ${from}`);
    return c.json({ from, to, lines: diffLines(a.yaml, b.yaml) });
  });

  app.get('/api/channels/:name/staged', (c) => {
    const ch = channel(c.req.param('name'));
    const withItems = c.req.query('items') === '1';
    const slots = store.stagedSlots(ch.id, number(c.req.query('from'), 'from'), number(c.req.query('to'), 'to'));
    return c.json(
      slots.map((s) => ({
        start: s.start, end: s.end, slotId: s.slotId, pool: s.pool, pins: s.pins, locked: s.locked, edited: s.edited,
        programs: s.planned.programs, blocks: s.planned.blocks, generatedAt: s.generatedAt,
        ...(withItems ? { items: s.planned.items } : {}),
      })),
    );
  });

  app.get('/api/channels/:name/commits', (c) => {
    const ch = channel(c.req.param('name'));
    return c.json(store.commits(ch.id, number(c.req.query('limit'), 'limit') ?? 20).map(({ state: _state, ...rest }) => rest));
  });

  app.get('/api/jobs', (c) => c.json(jobs.list()));
  app.get('/api/jobs/:id', (c) => {
    const j = jobs.get(c.req.param('id'));
    if (!j) throw new NotFound(`no job ${c.req.param('id')}`);
    return c.json(j);
  });

  return app;
}
