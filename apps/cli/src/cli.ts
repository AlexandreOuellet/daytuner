// The DayTuner command line, as a function so it can be tested against a fake Tunarr.
//
//   preview <channel.yaml>                      plan and print metrics; reads Tunarr, writes nothing
//   channel add <channel.yaml> [--channel NAME] [--seed N] [--floor 7d] [--step 24h]
//   channel set-schedule <name> <channel.yaml>
//   channel list
//   channel status <name>
//   run <name> [--yes]                          top the channel up; a dry run unless --yes
//   cursor <name> list
//   cursor <name> rewind <sequence> <k>         for a missed week
//   cursor <name> set <sequence> <episode-number>

import { readFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { alignToGrid, TunarrClient, type FetchLike } from '@daytuner/tunarr-client';
import { ceilToGrid, computeMetrics, DAY, emptyPlanState, plan, type Clock } from '@daytuner/engine';
import { parseDuration, parseScheduleFile, resolveSchedule } from '@daytuner/schedule';
import { Store } from '@daytuner/store';
import { adjustCursor, ConsistencyError, listSequences, topUp } from '@daytuner/worker';
import { formatMetrics, formatWarnings, inZone } from './format.js';

export interface CliEnv {
  clock: Clock;
  out: (line: string) => void;
  err: (line: string) => void;
  env: Record<string, string | undefined>;
  /** For tests: a stand-in for Tunarr. */
  fetch?: FetchLike;
}

const USAGE = `Usage:
  daytuner preview <channel.yaml> [--from ISO] [--days N] [--seed N]
  daytuner channel add <channel.yaml> [--channel NAME] [--seed N] [--floor 7d] [--step 24h]
  daytuner channel set-schedule <name> <channel.yaml>
  daytuner channel list | status <name>
  daytuner run <name> [--yes]            (a dry run without --yes)
  daytuner cursor <name> list | rewind <sequence> <k> | set <sequence> <episode-number>
Common: --tunarr URL (or TUNARR_URL)  --db FILE (or DAYTUNER_DB, default state/daytuner.db)`;

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const dayLabel = (ms: number): string => `${(ms / DAY).toFixed(1)} days`;

export async function runCli(argv: string[], io: CliEnv): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      tunarr: { type: 'string' }, db: { type: 'string' }, channel: { type: 'string' }, from: { type: 'string' },
      days: { type: 'string', default: '7' }, seed: { type: 'string', default: '1' },
      floor: { type: 'string', default: '7d' }, step: { type: 'string', default: '24h' }, yes: { type: 'boolean', default: false },
    },
  });
  const [command, ...rest] = positionals;
  const tunarr = values.tunarr ?? io.env['TUNARR_URL'];
  const dbPath = values.db ?? io.env['DAYTUNER_DB'] ?? 'state/daytuner.db';
  const needTunarr = (): string => {
    if (!tunarr) throw new Error('give the Tunarr address with --tunarr URL (or TUNARR_URL)');
    return tunarr;
  };
  const openStore = (): Store => {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    return Store.open(dbPath);
  };
  const reader = (): TunarrClient => new TunarrClient(needTunarr(), io.fetch);
  const writer = (): TunarrClient => new TunarrClient(needTunarr(), io.fetch, true);

  try {
    if (command === 'preview' && rest[0]) {
      const days = Number(values.days);
      if (!Number.isInteger(days) || days <= 0) throw new Error('--days must be a positive whole number');
      const client = reader();
      const { schedule, library } = await resolveSchedule(parseScheduleFile(readFileSync(rest[0], 'utf8')), client);
      let from = values.from ? Date.parse(values.from) : io.clock.now();
      if (!Number.isFinite(from)) throw new Error(`--from "${values.from}" is not a date`);
      from = ceilToGrid(from, schedule.grid);
      const result = plan({ schedule, library, state: emptyPlanState(Number(values.seed)), from, to: from + days * DAY });
      io.out(`DayTuner preview from ${inZone(from, schedule.zone)} (${schedule.zone}) for ${days} day(s), seed ${values.seed}`);
      io.out(`\n${formatMetrics(computeMetrics(result.slots, { grid: schedule.grid, zone: schedule.zone }))}\n\n${formatWarnings(result.warnings, schedule.zone)}`);
      return 0;
    }

    if (command === 'channel') {
      const [sub, a, b] = rest;
      if (sub === 'add' && a) {
        const text = readFileSync(a, 'utf8');
        const parsed = parseScheduleFile(text);
        const client = reader();
        const wanted = values.channel ?? parsed.channel;
        const channels = await client.channels();
        const ch = channels.find((c) => c.id === wanted || String(c.number) === wanted || slug(c.name) === slug(wanted));
        if (!ch) throw new Error(`no Tunarr channel matches "${wanted}" (channels: ${channels.map((c) => c.name).join(', ')})`);
        await resolveSchedule(parsed, client); // fail now, not at the first run, if the file does not fit the library
        const store = openStore();
        const added = store.addChannel({
          name: parsed.channel, tunarrId: ch.id, floorMs: parseDuration(values.floor), stepMs: parseDuration(values.step),
          schedule: text, state: emptyPlanState(Number(values.seed)), edge: ch.startTime + ch.duration,
        });
        io.out(`Added channel "${added.name}" (Tunarr channel "${ch.name}"). Its lineup ends ${inZone(added.edge, parsed.timezone)}; floor ${dayLabel(added.floorMs)}, step ${dayLabel(added.stepMs)}.`);
        store.close();
        return 0;
      }
      if (sub === 'set-schedule' && a && b) {
        const text = readFileSync(b, 'utf8');
        await resolveSchedule(parseScheduleFile(text), reader());
        const store = openStore();
        store.setSchedule(a, text);
        io.out(`Replaced the schedule of "${a}". It takes effect at the next run.`);
        store.close();
        return 0;
      }
      if (sub === 'list') {
        const store = openStore();
        const all = store.channels();
        io.out(all.length === 0 ? 'No channels.' : all.map((c) => `${c.name}  (Tunarr ${c.tunarrId})  floor ${dayLabel(c.floorMs)}  step ${dayLabel(c.stepMs)}`).join('\n'));
        store.close();
        return 0;
      }
      if (sub === 'status' && a) {
        const store = openStore();
        const ch = store.channel(a);
        if (!ch) throw new Error(`no channel named "${a}"`);
        const tun = await reader().channel(ch.tunarrId);
        const edge = tun.startTime + tun.duration;
        const now = io.clock.now();
        const zone = parseScheduleFile(ch.schedule).timezone;
        io.out(`${ch.name}: lineup ends ${inZone(edge, zone)} (${dayLabel(edge - now)} ahead; floor ${dayLabel(ch.floorMs)} + step ${dayLabel(ch.stepMs)})`);
        io.out(Math.abs(edge - ch.edge) <= 1 ? 'The store and Tunarr agree about where it ends.' : `WARNING: the store recorded ${inZone(ch.edge, zone)}. The channel was changed outside DayTuner; the worker will refuse to write.`);
        if (store.pendingCommit(ch.id)) io.out('A commit is pending from an earlier run; the next run settles it.');
        for (const c of store.commits(ch.id, 5)) io.out(`  commit ${c.id} ${c.status}: ${c.items} items, ${dayLabel(c.totalMs)}, ${inZone(c.fromEdge, zone)} to ${inZone(c.toEdge, zone)}`);
        for (const x of store.adjustments(ch.id, 5)) io.out(`  adjustment ${x.id}: ${x.sequenceKey} ${x.kind} ${x.amount} (position ${x.positionBefore} to ${x.positionAfter})`);
        store.close();
        return 0;
      }
    }

    if (command === 'run' && rest[0]) {
      const store = openStore();
      const client = values.yes ? writer() : reader();
      // A reader cannot write, so a dry run is safe even by accident; the worker is also told so.
      const r = await topUp({ store, client, clock: io.clock }, rest[0], { dryRun: !values.yes });
      const ch = store.channel(rest[0])!;
      const zone = parseScheduleFile(ch.schedule).timezone;
      if (r.recovered) io.out(`A commit left pending by an earlier run was ${r.recovered}.`);
      if (r.action === 'none') {
        io.out(`Nothing to do: the lineup reaches ${dayLabel(r.aheadBefore)} ahead (floor ${dayLabel(ch.floorMs)} + step ${dayLabel(ch.stepMs)}).`);
      } else {
        const verb = r.action === 'appended' ? 'Appended' : 'Would append (dry run, nothing was written)';
        io.out(`${verb}: ${r.slots} slots, ${r.items} items, ${dayLabel(r.totalMs ?? 0)}. The lineup was ${dayLabel(r.aheadBefore)} ahead.`);
        if (r.planned) {
          const { schedule } = await resolveSchedule(parseScheduleFile(ch.schedule), client);
          io.out(`\n${formatMetrics(computeMetrics(r.planned, { grid: schedule.grid, zone: schedule.zone }))}`);
        }
        io.out(`\n${formatWarnings(r.warnings, zone)}`);
        if (r.action === 'would-append') io.out('\nAdd --yes to write this to Tunarr.');
      }
      store.close();
      return 0;
    }

    if (command === 'cursor' && rest[0] && rest[1]) {
      const [name, sub, key, amount] = rest;
      const store = openStore();
      const ch = store.channel(name!);
      if (!ch) throw new Error(`no channel named "${name}"`);
      const client = reader();
      if (sub === 'list') {
        const { schedule } = await resolveSchedule(parseScheduleFile(ch.schedule), client);
        for (const s of listSequences(schedule)) {
          const st = ch.state.sequences[s.key] ?? { position: 0, history: 0 };
          io.out(`${s.key}  pool ${s.pool}  next episode ${st.position + 1} of ${s.length}  (${st.history} behind it have aired)  slots ${s.slots.join(', ')}`);
        }
        store.close();
        return 0;
      }
      if ((sub === 'rewind' || sub === 'set') && key && amount !== undefined) {
        const n = Number(amount);
        if (!Number.isInteger(n) || n < 0) throw new Error('give a whole number');
        const adj = sub === 'rewind' ? { kind: 'rewind' as const, by: n } : { kind: 'set' as const, index: n - 1 };
        const r = await adjustCursor({ store, client, clock: io.clock }, name!, key, adj);
        io.out(`${key}: the next planned episode was ${r.before.position + 1}, now ${r.after.position + 1}. This changes the first uncommitted airing onward; what is already in Tunarr stays as it is.`);
        store.close();
        return 0;
      }
    }

    io.err(USAGE);
    return 2;
  } catch (e) {
    io.err(e instanceof Error ? `${e.name === 'ConsistencyError' ? 'Stopped, nothing was written: ' : ''}${e.message}` : String(e));
    return e instanceof ConsistencyError ? 3 : 1;
  }
}
