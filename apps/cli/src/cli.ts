// The DayTuner command line, as a function so it can be tested against a fake Tunarr.
//
//   preview <channel.yaml>                      plan and print metrics; reads Tunarr, writes nothing
//   channel add <channel.yaml> [--channel NAME] [--seed N] [--floor 7d] [--step 24h]
//   channel set-schedule <name> <channel.yaml>
//   channel list
//   channel status <name>
//   channel resync <name> [--yes]               adopt Tunarr's real end after a refusal; a dry run unless --yes
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
import { diffLines, findProgram, formatDiff, parseDuration, parseLocalDateTime, parseScheduleFile, resolveSchedule } from '@daytuner/schedule';
import { Store } from '@daytuner/store';
import { adjustCursor, adoptHistory, ConsistencyError, listSequences, placesFromLineup, resync, stageCheck, stageGenerate, topUp } from '@daytuner/worker';
import { formatMetrics, formatWarnings, inZone, slotLabel } from './format.js';

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
  daytuner channel set-schedule <name> <channel.yaml>      (saves a new revision)
  daytuner channel revisions <name> | diff <name> [from [to]] | rollback <name> <number>
  daytuner channel list | status <name> | commits <name> | adopt-history <name> [--yes] | resync <name> [--yes]
  daytuner stage <name> generate --to DATE [--keep DATE..DATE] | show [--from DATE] [--to DATE] | lock DATETIME | unlock DATETIME
                   | pin DATETIME BLOCK movie:TITLE | pin DATETIME BLOCK episode:SHOW/TITLE | unpin DATETIME BLOCK | clear [--from DATE] [--to DATE]
                                        (dates are local to the channel: 2026-10-31 or 2026-10-31T20:00)
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
      to: { type: 'string' }, keep: { type: 'string' },
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
      const { schedule, library, titles, notes } = await resolveSchedule(parseScheduleFile(readFileSync(rest[0], 'utf8')), client);
      let from = values.from ? Date.parse(values.from) : io.clock.now();
      if (!Number.isFinite(from)) throw new Error(`--from "${values.from}" is not a date`);
      from = ceilToGrid(from, schedule.grid);
      const result = plan({ schedule, library, state: emptyPlanState(Number(values.seed)), from, to: from + days * DAY });
      io.out(`DayTuner preview from ${inZone(from, schedule.zone)} (${schedule.zone}) for ${days} day(s), seed ${values.seed}`);
      io.out(`\n${formatMetrics(computeMetrics(result.slots, { grid: schedule.grid, zone: schedule.zone }))}\n\n${formatWarnings(result.warnings, schedule.zone, titles)}`);
      for (const n of notes) io.out(`note: ${n}`);
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
        const resolved = await resolveSchedule(parsed, client); // fail now, not at the first run, if the file does not fit the library
        const found = placesFromLineup(resolved.schedule, await client.lineup(ch.id));
        const store = openStore();
        const added = store.addChannel({
          name: parsed.channel, tunarrId: ch.id, floorMs: parseDuration(values.floor), stepMs: parseDuration(values.step),
          schedule: text, state: emptyPlanState(Number(values.seed)), edge: ch.startTime + ch.duration, at: io.clock.now(),
        });
        io.out(`Added channel "${added.name}" (Tunarr channel "${ch.name}"). Its lineup ends ${inZone(added.edge, parsed.timezone)}; floor ${dayLabel(added.floorMs)}, step ${dayLabel(added.stepMs)}.`);
        for (const n of resolved.notes) io.out(`note: ${n}`);
        for (const f of found) {
          const where = f.lastProgramId === undefined
            ? `nothing of it in the lineup; it starts at episode 1`
            : `the lineup's last one is ${resolved.titles[f.lastProgramId] ?? f.lastProgramId}, so next is episode ${f.place.position + 1} of ${f.length} (${f.place.history} episodes seen)`;
          io.out(`  ${f.key}: ${where}`);
        }
        if (found.some((f) => f.lastProgramId !== undefined)) {
          io.out(`These places are not applied; every show starts at episode 1. \`channel adopt-history ${added.name} --yes\` applies them, or fix single ones with \`cursor set\`.`);
        }
        store.close();
        return 0;
      }
      if (sub === 'set-schedule' && a && b) {
        const text = readFileSync(b, 'utf8');
        await resolveSchedule(parseScheduleFile(text), reader());
        const store = openStore();
        const before = store.channel(a);
        const number = store.setSchedule(a, text, io.clock.now());
        io.out(before && number === before.revision ? `The schedule of "${a}" is unchanged (still revision ${number}).` : `Saved revision ${number} of the schedule of "${a}". It takes effect at the next run.`);
        store.close();
        return 0;
      }
      if (sub === 'revisions' && a) {
        const store = openStore();
        const ch = store.channel(a);
        if (!ch) throw new Error(`no channel named "${a}"`);
        const zone = parseScheduleFile(ch.schedule).timezone;
        for (const r of store.revisions(ch.id)) {
          io.out(`${r.number === ch.revision ? '*' : ' '} revision ${r.number}  ${r.savedAt === 0 ? 'saved before revisions were kept' : inZone(r.savedAt, zone)}`);
        }
        io.out('* is the current one. `channel diff <name> [from] [to]` shows what changed; `channel rollback <name> <number>` makes an earlier one current.');
        store.close();
        return 0;
      }
      if (sub === 'diff' && a) {
        const store = openStore();
        const ch = store.channel(a);
        if (!ch) throw new Error(`no channel named "${a}"`);
        const revs = store.revisions(ch.id);
        const toN = rest[3] !== undefined ? Number(rest[3]) : ch.revision;
        const fromN = b !== undefined ? Number(b) : ch.revision - 1;
        const find = (n: number) => revs.find((r) => r.number === n);
        const x = find(fromN);
        const y = find(toN);
        if (!y) throw new Error(`"${a}" has no revision ${toN}`);
        if (!x) throw new Error(fromN < 1 ? `revision ${toN} is the first; there is nothing before it to compare with` : `"${a}" has no revision ${fromN}`);
        const lines = diffLines(x.yaml, y.yaml);
        io.out(`Revision ${fromN} to revision ${toN} of "${a}":`);
        io.out(lines.every((l) => l.kind === 'same') ? '(no difference)' : formatDiff(lines));
        store.close();
        return 0;
      }
      if (sub === 'rollback' && a && b) {
        const store = openStore();
        const n = Number(b);
        if (!Number.isInteger(n)) throw new Error('give the revision number');
        const ch = store.channel(a);
        if (!ch) throw new Error(`no channel named "${a}"`);
        const rev = store.revisions(ch.id).find((r) => r.number === n);
        if (rev) parseScheduleFile(rev.yaml); // refuse a revision that no longer parses
        store.useRevision(a, n);
        io.out(`Revision ${n} of "${a}" is now current. It takes effect at the next run; what is already in Tunarr stays as it is. Nothing was lost: \`channel revisions ${a}\` lists them all.`);
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
      if (sub === 'adopt-history' && a) {
        const store = openStore();
        const client = reader();
        const r = await adoptHistory({ store, client, clock: io.clock }, a, { dryRun: !values.yes });
        for (const f of r.found) {
          io.out(`${f.key}: ${f.lastProgramId === undefined ? 'nothing of it in the lineup, stays at episode 1' : `the lineup's last one is ${r.titles[f.lastProgramId] ?? f.lastProgramId}, next is episode ${f.place.position + 1} of ${f.length} (${f.place.history} episodes seen)`}`);
        }
        io.out(values.yes ? 'Applied.' : 'This was a dry run. Add --yes to apply it.');
        store.close();
        return 0;
      }
      if (sub === 'resync' && a) {
        const store = openStore();
        const r = await resync({ store, client: reader(), clock: io.clock }, a, { dryRun: !values.yes });
        for (const line of r.found) io.out(`Found: ${line}`);
        for (const line of r.actions) io.out(`${values.yes ? 'Done' : 'Would do'}: ${line}`);
        if (r.actions.length === 0) io.out('Nothing to do.');
        if (r.stateMayBeStale) io.out("The planner's state may no longer match what is in Tunarr. Check the shows' places with `cursor " + a + ' list` and adjust them if needed.');
        if (!values.yes && r.actions.length > 0) io.out('This was a dry run. Add --yes to apply it. Nothing was written to Tunarr either way.');
        store.close();
        return 0;
      }
      if (sub === 'commits' && a) {
        const store = openStore();
        const ch = store.channel(a);
        if (!ch) throw new Error(`no channel named "${a}"`);
        const zone = parseScheduleFile(ch.schedule).timezone;
        const all = store.commits(ch.id, 20);
        io.out(all.length === 0 ? 'No commits yet.' : all.map((c) => `commit ${c.id} ${c.status}: ${c.slots.length} slots, ${c.items} items, ${dayLabel(c.totalMs)}, ${inZone(c.fromEdge, zone)} to ${inZone(c.toEdge, zone)}${c.note ? `\n  note: ${c.note}` : ''}`).join('\n'));
        if (store.pendingCommit(ch.id)) io.out(`\nA commit is pending. \`channel resync ${a}\` shows how it would be settled; add --yes to settle it.`);
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
        if (store.pendingCommit(ch.id)) io.out(`A commit is pending from an earlier run (see \`channel commits ${a}\`); the next run settles it, or \`channel resync ${a}\` explains why it cannot.`);
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
        const resolved = await resolveSchedule(parseScheduleFile(ch.schedule), client);
        if (r.planned) io.out(`\n${formatMetrics(computeMetrics(r.planned, { grid: resolved.schedule.grid, zone: resolved.schedule.zone }))}`);
        io.out(`\n${formatWarnings(r.warnings, zone, resolved.titles)}`);
        for (const n of resolved.notes) io.out(`note: ${n}`);
        if (r.action === 'would-append') io.out('\nAdd --yes to write this to Tunarr.');
      }
      store.close();
      return 0;
    }

    if (command === 'stage' && rest[0] && rest[1]) {
      const [name, sub] = rest;
      const store = openStore();
      const ch = store.channel(name!);
      if (!ch) throw new Error(`no channel named "${name}"`);
      const zone = parseScheduleFile(ch.schedule).timezone;
      const date = (t: string | undefined): number | undefined => (t === undefined ? undefined : parseLocalDateTime(zone, t));
      if (sub === 'generate') {
        const to = date(values.to);
        if (to === undefined) throw new Error('give the end of the range with --to DATE');
        const [kf, kt] = values.keep === undefined ? [undefined, undefined] : values.keep.split('..');
        if (values.keep !== undefined && (kf === undefined || kt === undefined)) throw new Error('--keep takes two dates: DATE..DATE');
        const r = await stageGenerate({ store, client: reader(), clock: io.clock }, name!, {
          to, ...(kf !== undefined ? { keepFrom: date(kf)! } : {}), ...(kt !== undefined ? { keepTo: date(kt)! } : {}),
        });
        io.out(`Staged ${r.kept.length} slot(s) (planned ${r.planned} from the end of the committed lineup, kept the part you asked for). Nothing was written to Tunarr, and the channel's state did not change.`);
        io.out(`\n${formatWarnings(r.warnings, zone, r.titles)}`);
        store.close();
        return 0;
      }
      if (sub === 'show') {
        const slots = store.stagedSlots(ch.id, date(values.from), date(values.to));
        if (slots.length === 0) io.out('Nothing is staged.');
        const check = slots.length === 0 ? undefined : await stageCheck({ store, client: reader() }, name!);
        const troubled = new Map<number, string[]>();
        for (const c of check?.conflicts ?? []) troubled.set(c.start, [...(troubled.get(c.start) ?? []), `CONFLICT (${c.reason}): ${c.message}`]);
        for (const w of check?.pinProblems ?? []) {
          const slot = slots.find((x) => w.at >= x.start && w.at < x.end);
          if (slot) troubled.set(slot.start, [...(troubled.get(slot.start) ?? []), `${w.severity.toUpperCase()}: ${w.message}`]);
        }
        for (const s of slots) {
          io.out(`${inZone(s.start, zone)} to ${inZone(s.end, zone)}  ${s.slotId ? slotLabel(s.slotId) : 'added'} ${s.pool ?? ''}${s.locked ? '  [locked]' : ''}  ${s.planned.programs.length} program(s)${Object.keys(s.pins).length ? `  pinned: ${Object.entries(s.pins).map(([n, p]) => `block ${n} = ${p.title}`).join(', ')}` : ''}`);
          for (const t of troubled.get(s.start) ?? []) io.out(`    ${t}`);
        }
        store.close();
        return 0;
      }
      if ((sub === 'lock' || sub === 'unlock') && rest[2]) {
        const start = parseLocalDateTime(zone, rest[2]);
        store.setLocked(name!, start, sub === 'lock');
        io.out(sub === 'lock'
          ? `Locked the slot starting ${inZone(start, zone)}. It will be committed exactly as it is staged; if it no longer fits when its time comes it is planned again and the commit log records why.`
          : `Unlocked the slot starting ${inZone(start, zone)}. It is planned again at commit time.`);
        store.close();
        return 0;
      }
      if (sub === 'pin' && rest[2] && rest[3] && rest[4]) {
        const start = parseLocalDateTime(zone, rest[2]);
        const block = Number(rest[3]);
        if (!Number.isInteger(block) || block < 1) throw new Error('the block is a whole number from 1');
        const client = reader();
        const program = await findProgram(client, rest.slice(4).join(' '));
        store.setPin(name!, start, block, program);
        const r = await stageGenerate({ store, client, clock: io.clock }, name!, { to: start + 1, keepFrom: start, keepTo: start + 1 });
        io.out(`Pinned ${program.title} to block ${block} of the slot starting ${inZone(start, zone)}. The slot was planned again around it; nothing was written to Tunarr.`);
        const trouble = r.warnings.filter((w) => w.code === 'pin-does-not-fit' || w.code === 'pin-dropped');
        for (const w of trouble) io.out(`${w.severity.toUpperCase()}: ${w.message}`);
        if (trouble.length === 0) io.out('The pin holds.');
        store.close();
        return 0;
      }
      if (sub === 'unpin' && rest[2] && rest[3]) {
        const start = parseLocalDateTime(zone, rest[2]);
        store.removePin(name!, start, Number(rest[3]));
        await stageGenerate({ store, client: reader(), clock: io.clock }, name!, { to: start + 1, keepFrom: start, keepTo: start + 1 });
        io.out(`Removed the pin on block ${rest[3]} of the slot starting ${inZone(start, zone)}. The slot was planned again.`);
        store.close();
        return 0;
      }
      if (sub === 'clear') {
        const n = store.clearStaged(name!, date(values.from), date(values.to));
        io.out(`Cleared ${n} staged slot(s).`);
        store.close();
        return 0;
      }
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
