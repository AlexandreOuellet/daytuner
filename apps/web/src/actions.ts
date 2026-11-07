// The calls that change things. Anything that reads the library or plans runs as a job (it can take a minute
// the first time), answered at once with the job; quick store changes answer directly. Nothing here writes to
// Tunarr except `run`, and that only when the server was started with writing switched on.

import type { Context, Hono } from 'hono';
import type { Clock } from '@daytuner/engine';
import { addIds, adSettingsOf, applyAdSettings, applyScheduleModel, exceptionOccurrences, scheduleModelOf, type ExceptionModel, type ScheduleModel, findProgram, parseLocalDateTime, parseScheduleFile, resolveSchedule, type AdSettings } from '@daytuner/schedule';
import type { ChannelRecord, PinRecord, Store } from '@daytuner/store';
import type { TunarrClient } from '@daytuner/tunarr-client';
import {
  adSamples, poolStats, adjustCursor, adoptHistory, addChannel, cachedSource, cursorPreview, listSequences, resync, revisionImpact, stageCheck, stageDiff, stageEdit, stageGenerate,
  runAndRecord, stageRefresh, stageReset, topUp, type StageEdit, type StageResult,
} from '@daytuner/worker';
import { Jobs } from './jobs.js';

export class BadRequest extends Error {}
export class Forbidden extends Error {}

export interface ActionDeps {
  store: Store;
  clock: Clock;
  jobs: Jobs;
  /** Reads the library from Tunarr. Cannot write. */
  client: TunarrClient;
  /** Writes to Tunarr. Present only when the server was started with writing switched on. */
  writeClient?: TunarrClient;
  channel(name: string): ChannelRecord;
}

type Body = Record<string, unknown>;

async function bodyOf(c: Context): Promise<Body> {
  try {
    const b = (await c.req.json()) as unknown;
    if (typeof b === 'object' && b !== null && !Array.isArray(b)) return b as Body;
  } catch {
    /* falls through */
  }
  throw new BadRequest('the request needs a JSON object as its body');
}
const needString = (b: Body, k: string): string => {
  if (typeof b[k] !== 'string' || b[k] === '') throw new BadRequest(`"${k}" must be text`);
  return b[k] as string;
};
const needInt = (b: Body, k: string): number => {
  if (typeof b[k] !== 'number' || !Number.isInteger(b[k])) throw new BadRequest(`"${k}" must be a whole number`);
  return b[k] as number;
};
const flag = (b: Body, k: string): boolean => b[k] === true;

/** A time as epoch milliseconds, or as a local date or date-time in the channel's zone ("2026-10-31", "2026-10-31T20:00"). */
function when(zone: string, b: Body, k: string, optional = false): number | undefined {
  const v = b[k];
  if (v === undefined && optional) return undefined;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    try {
      return parseLocalDateTime(zone, v);
    } catch (e) {
      throw new BadRequest(e instanceof Error ? e.message : String(e));
    }
  }
  throw new BadRequest(`"${k}" must be epoch milliseconds or a local date`);
}

const stageOut = (r: StageResult) => ({ staged: r.kept.length, planned: r.planned, warnings: r.warnings, changes: r.changes, titles: r.titles });

export function registerActions(app: Hono, d: ActionDeps): void {
  const zoneOf = (ch: ChannelRecord): string => parseScheduleFile(ch.schedule).timezone;
  const deps = { store: d.store, client: d.client, clock: d.clock };
  const job = (c: Context, channel: string, kind: string, run: (say: (m: string) => void) => Promise<unknown>) => c.json({ job: d.jobs.start(channel, kind, run) }, 202);

  app.post('/api/channels', async (c) => {
    const b = await bodyOf(c);
    const yaml = needString(b, 'yaml');
    const name = parseScheduleFile(yaml).channel;
    const opts = {
      yaml, floorMs: typeof b['floorMs'] === 'number' ? b['floorMs'] : 7 * 86_400_000,
      stepMs: typeof b['stepMs'] === 'number' ? b['stepMs'] : 86_400_000, seed: typeof b['seed'] === 'number' ? b['seed'] : 1,
      ...(typeof b['tunarrChannel'] === 'string' ? { tunarrChannel: b['tunarrChannel'] } : {}),
    };
    return job(c, name, 'add channel', async () => {
      const r = await addChannel(deps, opts);
      return { name: r.name, tunarrName: r.tunarrName, edge: r.edge, notes: r.notes, places: r.places.map((p) => ({ key: p.key, pool: p.pool, length: p.length, lastProgramId: p.lastProgramId ?? null, next: p.place.position + 1, title: p.lastProgramId ? r.titles[p.lastProgramId] ?? null : null })) };
    });
  });

  app.post('/api/channels/:name/stage/generate', async (c) => {
    const ch = d.channel(c.req.param('name'));
    const b = await bodyOf(c);
    const zone = zoneOf(ch);
    const to = when(zone, b, 'to')!;
    const keepFrom = when(zone, b, 'keepFrom', true);
    const keepTo = when(zone, b, 'keepTo', true);
    return job(c, ch.name, 'stage', async () => stageOut(await stageGenerate(deps, ch.name, { to, ...(keepFrom !== undefined ? { keepFrom } : {}), ...(keepTo !== undefined ? { keepTo } : {}) })));
  });

  app.post('/api/channels/:name/stage/lock', async (c) => {
    const ch = d.channel(c.req.param('name'));
    const b = await bodyOf(c);
    d.store.setLocked(ch.name, when(zoneOf(ch), b, 'start')!, flag(b, 'locked'));
    return c.json({ ok: true });
  });

  app.post('/api/channels/:name/stage/clear', async (c) => {
    const ch = d.channel(c.req.param('name'));
    const b = await bodyOf(c).catch(() => ({}) as Body);
    const zone = zoneOf(ch);
    return c.json({ cleared: d.store.clearStaged(ch.name, when(zone, b, 'from', true), when(zone, b, 'to', true)) });
  });

  app.post('/api/channels/:name/stage/pin', async (c) => {
    const ch = d.channel(c.req.param('name'));
    const b = await bodyOf(c);
    const start = when(zoneOf(ch), b, 'start')!;
    const block = needInt(b, 'block');
    if (block < 1) throw new BadRequest('"block" is a whole number from 1');
    const p = b['program'];
    return job(c, ch.name, 'pin', async () => {
      const program: PinRecord =
        typeof p === 'string'
          ? await findProgram(d.client, p)
          : typeof p === 'object' && p !== null && typeof (p as PinRecord).id === 'string' && typeof (p as PinRecord).duration === 'number'
            ? { id: (p as PinRecord).id, title: String((p as PinRecord).title ?? (p as PinRecord).id), duration: (p as PinRecord).duration }
            : (() => { throw new BadRequest('"program" is movie:Title, episode:Show/Title, or {id, title, duration}'); })();
      d.store.setPin(ch.name, start, block, program);
      return stageOut(await stageRefresh(deps, ch.name, start));
    });
  });

  app.post('/api/channels/:name/stage/unpin', async (c) => {
    const ch = d.channel(c.req.param('name'));
    const b = await bodyOf(c);
    const start = when(zoneOf(ch), b, 'start')!;
    const block = needInt(b, 'block');
    return job(c, ch.name, 'unpin', async () => {
      d.store.removePin(ch.name, start, block);
      return stageOut(await stageRefresh(deps, ch.name, start));
    });
  });

  app.post('/api/channels/:name/stage/edit', async (c) => {
    const ch = d.channel(c.req.param('name'));
    const b = await bodyOf(c);
    const zone = zoneOf(ch);
    const kind = needString(b, 'kind');
    const start = when(zone, b, 'start')!;
    let edit: StageEdit;
    if (kind === 'delete') edit = { kind, start };
    else if (kind === 'resize') edit = { kind, start, end: when(zone, b, 'end')! };
    else if (kind === 'add') {
      const end = when(zone, b, 'end')!;
      const spec = b['program'];
      return job(c, ch.name, 'add slot', async () => {
        const o = spec as Partial<PinRecord> | null;
        const pin: PinRecord | undefined =
          typeof spec === 'string' ? await findProgram(d.client, spec)
          : o && typeof o === 'object' && typeof o.id === 'string' && typeof o.duration === 'number' ? { id: o.id, title: String(o.title ?? o.id), duration: o.duration }
          : undefined;
        return stageOut(await stageEdit(deps, ch.name, { kind: 'add', start, end, ...(pin ? { pin } : {}) }));
      });
    } else throw new BadRequest('"kind" is delete, resize or add');
    return job(c, ch.name, kind, async () => stageOut(await stageEdit(deps, ch.name, edit)));
  });

  app.post('/api/channels/:name/stage/reset', async (c) => {
    const ch = d.channel(c.req.param('name'));
    const b = await bodyOf(c);
    const zone = zoneOf(ch);
    const from = when(zone, b, 'from')!;
    const to = when(zone, b, 'to')!;
    return job(c, ch.name, 'reset', async () => stageOut(await stageReset(deps, ch.name, { from, to })));
  });

  app.post('/api/channels/:name/stage/check', (c) => {
    const ch = d.channel(c.req.param('name'));
    return job(c, ch.name, 'check staging', async () => {
      const r = await stageCheck(deps, ch.name);
      return { conflicts: r.conflicts, pinProblems: r.pinProblems, titles: r.titles };
    });
  });

  app.post('/api/channels/:name/stage/diff', (c) => {
    const ch = d.channel(c.req.param('name'));
    return job(c, ch.name, 'diff staging', async () => stageDiff(deps, ch.name));
  });

  app.post('/api/channels/:name/schedule/check', async (c) => {
    const ch = d.channel(c.req.param('name'));
    const yaml = needString(await bodyOf(c), 'yaml');
    parseScheduleFile(yaml);
    return job(c, ch.name, 'check schedule', async () => revisionImpact(deps, ch.name, yaml));
  });

  /** Saves a new revision unless locked staged slots would stop fitting (then only with `force`). */
  const saveSchedule = async (ch: ChannelRecord, yaml: string, force: boolean) => {
    await resolveSchedule(parseScheduleFile(yaml), cachedSource(d.client, d.store, d.clock));
    const impact = yaml === ch.schedule ? undefined : await revisionImpact(deps, ch.name, yaml);
    if (impact && impact.conflicts.length > 0 && !force) return { saved: false, revision: ch.revision, impact };
    return { saved: true, revision: d.store.setSchedule(ch.name, yaml, d.clock.now()), ...(impact ? { impact } : {}) };
  };

  app.post('/api/channels/:name/schedule', async (c) => {
    const ch = d.channel(c.req.param('name'));
    const b = await bodyOf(c);
    const yaml = needString(b, 'yaml');
    parseScheduleFile(yaml);
    const force = flag(b, 'force');
    return job(c, ch.name, 'save schedule', () => saveSchedule(ch, yaml, force));
  });

  /** The week's slots and the pools, as plain data for the schedule designer. */
  app.get('/api/channels/:name/schedule/model', (c) => {
    const ch = d.channel(c.req.param('name'));
    return c.json({ revision: ch.revision, model: scheduleModelOf(parseScheduleFile(ch.schedule)) });
  });

  /** Saves a changed week and pools as a new revision; with `check: true` only reports what it would do to locked staged slots. */
  app.post('/api/channels/:name/schedule/model', async (c) => {
    const ch = d.channel(c.req.param('name'));
    const b = await bodyOf(c);
    const m = b as unknown as Pick<ScheduleModel, 'week' | 'pools'> & { exceptions?: ExceptionModel[] };
    if (!Array.isArray(m.week) || typeof m.pools !== 'object' || m.pools === null) throw new BadRequest('the request needs "week" (a list of slots) and "pools"');
    let yaml: string;
    try {
      yaml = applyScheduleModel(ch.schedule, m);
    } catch (e) {
      throw new BadRequest(e instanceof Error ? e.message : String(e));
    }
    const force = flag(b, 'force');
    if (flag(b, 'check')) {
      return job(c, ch.name, 'check schedule', async () => ({ saved: false, revision: ch.revision, impact: yaml === ch.schedule ? undefined : await revisionImpact(deps, ch.name, yaml) }));
    }
    return job(c, ch.name, 'save schedule', () => saveSchedule(ch, yaml, force));
  });

  /**
   * Where the special days fall in the coming year, and what state each is in: `committed` (already in Tunarr), `staged`, or
   * `rule` (the schedule will plan it when its time comes). Takes the special days (and week) being edited, or the saved ones.
   */
  app.post('/api/channels/:name/special-days', async (c) => {
    const ch = d.channel(c.req.param('name'));
    const b = await bodyOf(c).catch(() => ({}) as Body);
    const saved = scheduleModelOf(parseScheduleFile(ch.schedule));
    const exceptions = Array.isArray(b['exceptions']) ? (b['exceptions'] as ExceptionModel[]) : saved.exceptions;
    const week = Array.isArray(b['week']) ? (b['week'] as ScheduleModel['week']) : saved.week;
    const now = d.clock.now();
    const staged = d.store.stagedSlots(ch.id);
    return c.json(
      exceptionOccurrences({ timezone: saved.timezone, week, exceptions }, now - 31 * 86_400_000, now + 400 * 86_400_000).map((o) => ({
        ...o,
        state: o.start < ch.edge ? 'committed' : staged.some((r) => r.start <= o.start && o.start < r.end) ? 'staged' : 'rule',
      })),
    );
  });

  /** Movies of the library whose title contains `q` (up to 30), for choosing what a special day plays. */
  app.get('/api/library/movies', async (c) => {
    const q = (c.req.query('q') ?? '').trim().toLowerCase();
    if (q.length < 2) return c.json([]);
    const all = await d.client.movies();
    return c.json(all.filter((m) => m.title.toLowerCase().includes(q)).slice(0, 30).map((m) => ({ id: m.id, title: m.title, duration: m.duration })));
  });

  /** The episodes of one show, in viewing order. */
  app.get('/api/library/shows/:id/episodes', async (c) => {
    const eps = await d.client.episodes(c.req.param('id'));
    return c.json(eps.map((e) => ({ id: e.id, title: e.title, season: e.season, episode: e.episode, duration: e.duration })));
  });

  /** What pools hold (how many programs, how long each), for pools that may not be saved yet. */
  app.post('/api/channels/:name/pools/stats', async (c) => {
    const ch = d.channel(c.req.param('name'));
    const pools = (await bodyOf(c))['pools'];
    if (typeof pools !== 'object' || pools === null || Array.isArray(pools)) throw new BadRequest('the request needs "pools"');
    return job(c, ch.name, 'read pools', async () => poolStats(d.client, pools as Parameters<typeof poolStats>[1]));
  });

  /** The shows and movie genres the library has, for pickers. */
  let libraryCache: { at: number; value: { shows: { id: string; title: string }[]; genres: string[] } } | undefined;
  app.get('/api/library', async (c) => {
    if (!libraryCache || d.clock.now() - libraryCache.at > 60_000) {
      const [shows, movies] = await Promise.all([d.client.shows(), d.client.movies()]);
      const genres = [...new Set(movies.flatMap((m) => m.genres))].sort((a, b) => a.localeCompare(b));
      libraryCache = { at: d.clock.now(), value: { shows: shows.map((x) => ({ id: x.id, title: x.title })).sort((a, b) => a.title.localeCompare(b.title)), genres } };
    }
    return c.json(libraryCache.value);
  });

  /** The ad, bumper and filler settings as plain numbers, with the filler lists Tunarr has to choose from. */
  app.get('/api/channels/:name/ads', async (c) => {
    const ch = d.channel(c.req.param('name'));
    return c.json({ revision: ch.revision, settings: adSettingsOf(parseScheduleFile(ch.schedule)), lists: await d.client.fillerLists() });
  });

  const settingsOf = (b: Body): AdSettings => {
    const s = b['settings'] as AdSettings | undefined;
    const num = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v) && v >= 0;
    if (!s || typeof s !== 'object' || !num(s.step) || !s.ratio || !num(s.ratio.min) || !num(s.ratio.max) || s.ratio.max < s.ratio.min || typeof s.positions !== 'object' || typeof s.bumpers !== 'object') {
      throw new BadRequest('"settings" must be the ad settings (step, ratio, positions, bumpers)');
    }
    return s;
  };

  app.post('/api/channels/:name/ads/sample', async (c) => {
    const ch = d.channel(c.req.param('name'));
    const settings = settingsOf(await bodyOf(c));
    return job(c, ch.name, 'sample ads', async () => ({ samples: await adSamples(deps, ch.name, settings) }));
  });

  app.post('/api/channels/:name/ads', async (c) => {
    const ch = d.channel(c.req.param('name'));
    const b = await bodyOf(c);
    const yaml = (() => {
      try {
        return applyAdSettings(ch.schedule, settingsOf(b));
      } catch (e) {
        throw e instanceof BadRequest ? e : new BadRequest(e instanceof Error ? e.message : String(e));
      }
    })();
    const force = flag(b, 'force');
    return job(c, ch.name, 'save ad settings', () => saveSchedule(ch, yaml, force));
  });

  app.post('/api/channels/:name/schedule/rollback', async (c) => {
    const ch = d.channel(c.req.param('name'));
    const n = needInt(await bodyOf(c), 'revision');
    const rev = d.store.revisions(ch.id).find((r) => r.number === n);
    if (rev) parseScheduleFile(rev.yaml);
    d.store.useRevision(ch.name, n);
    return c.json({ revision: n });
  });

  app.get('/api/channels/:name/cursors', async (c) => {
    const ch = d.channel(c.req.param('name'));
    const { schedule, titles } = await resolveSchedule(parseScheduleFile(ch.schedule), cachedSource(d.client, d.store, d.clock));
    return c.json(
      listSequences(schedule).map((s) => {
        const st = ch.state.sequences[s.key] ?? { position: 0, history: 0 };
        const id = schedule.pools[s.pool]!.programs[st.position];
        const slotInfo = s.slots.map((slot) => ({ id: slot, mode: schedule.week.find((w) => `${w.day}@${w.at}` === slot)?.link?.mode === 'rerun' ? ('rerun' as const) : ('continue' as const) }));
        // The episodes it plays in a week: what "missed a week" rewinds by. A rerun replays, so it does not count.
        const perWeek = slotInfo.filter((x) => x.mode === 'continue').length;
        return { key: s.key, pool: s.pool, length: s.length, slots: s.slots, slotInfo, perWeek, position: st.position, history: st.history, next: id ? { programId: id, title: titles[id] ?? id } : null };
      }),
    );
  });

  app.post('/api/channels/:name/cursors/preview', async (c) => {
    const ch = d.channel(c.req.param('name'));
    const b = await bodyOf(c);
    const key = needString(b, 'key');
    const kind = needString(b, 'kind');
    const amount = needInt(b, 'amount');
    if (kind !== 'rewind' && kind !== 'set') throw new BadRequest('"kind" is rewind or set');
    if (amount < 0) throw new BadRequest('"amount" is a whole number from 0');
    const count = typeof b['count'] === 'number' ? b['count'] : undefined;
    return job(c, ch.name, 'preview cursor', async () => cursorPreview(deps, ch.name, key, kind === 'rewind' ? { kind, by: amount } : { kind, index: amount }, count !== undefined ? { count } : {}));
  });

  app.post('/api/channels/:name/cursors/adjust', async (c) => {
    const ch = d.channel(c.req.param('name'));
    const b = await bodyOf(c);
    const key = needString(b, 'key');
    const kind = needString(b, 'kind');
    const amount = needInt(b, 'amount');
    if (kind !== 'rewind' && kind !== 'set') throw new BadRequest('"kind" is rewind or set');
    if (amount < 0) throw new BadRequest('"amount" is a whole number from 0 (for set: the episode index, from 0)');
    return job(c, ch.name, 'adjust cursor', async () => {
      const r = await adjustCursor(deps, ch.name, key, kind === 'rewind' ? { kind, by: amount } : { kind, index: amount });
      const first = d.store.stagedSlots(ch.id)[0];
      const staged = first ? stageOut(await stageRefresh(deps, ch.name, first.start)) : undefined;
      return { before: r.before, after: r.after, ...(staged ? { staged } : {}) };
    });
  });

  app.post('/api/channels/:name/run', async (c) => {
    const ch = d.channel(c.req.param('name'));
    const b = await bodyOf(c).catch(() => ({}) as Body);
    const dryRun = b['dryRun'] !== false; // writing must be asked for
    if (!dryRun && !d.writeClient) throw new Forbidden('writing to Tunarr is switched off on this server (start it with DAYTUNER_ALLOW_WRITES=1)');
    return job(c, ch.name, dryRun ? 'plan (dry run)' : 'commit', async () => {
      const wdeps = { store: d.store, client: dryRun ? d.client : d.writeClient!, clock: d.clock };
      const r = dryRun ? await topUp(wdeps, ch.name, { dryRun: true }) : await runAndRecord(wdeps, ch.name);
      return { action: r.action, recovered: r.recovered ?? null, aheadBefore: r.aheadBefore, items: r.items ?? 0, totalMs: r.totalMs ?? 0, slots: r.slots ?? 0, commitId: r.commitId ?? null, edgeAfter: r.edgeAfter ?? null, conflicts: r.conflicts, warnings: r.warnings };
    });
  });

  app.post('/api/channels/:name/resync', async (c) => {
    const ch = d.channel(c.req.param('name'));
    const b = await bodyOf(c).catch(() => ({}) as Body);
    return c.json(await resync(deps, ch.name, { dryRun: !flag(b, 'apply') }));
  });

  app.post('/api/channels/:name/adopt-history', async (c) => {
    const ch = d.channel(c.req.param('name'));
    const b = await bodyOf(c).catch(() => ({}) as Body);
    const apply = flag(b, 'apply');
    return job(c, ch.name, 'adopt history', async () => {
      const r = await adoptHistory(deps, ch.name, { dryRun: !apply });
      return { applied: apply, places: r.found.map((p) => ({ key: p.key, pool: p.pool, length: p.length, lastProgramId: p.lastProgramId ?? null, next: p.place.position + 1, title: p.lastProgramId ? r.titles[p.lastProgramId] ?? null : null })) };
    });
  });

  app.get('/api/channels/:name/export', async (c) => {
    const ch = d.channel(c.req.param('name'));
    return c.json({ revision: ch.revision, yaml: await addIds(ch.schedule, d.client) });
  });
}
