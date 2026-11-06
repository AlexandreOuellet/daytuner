#!/usr/bin/env -S npx tsx
// DayTuner command line.
//   daytuner preview <channel.yaml> --tunarr URL [--from ISO] [--days N] [--seed N] [--state FILE] [--json]
//   daytuner apply   <channel.yaml> --tunarr URL --channel NAME [--days N] [--seed N] [--state FILE] [--yes]
// preview only reads. apply only ever appends, and does nothing without --yes.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { alignToGrid, TunarrClient, toLineupItems, totalDuration } from '@daytuner/tunarr-client';
import { computeMetrics, emptyPlanState, plan, ceilToGrid, DAY, type PlanState } from '@daytuner/engine';
import { parseScheduleFile, resolveSchedule } from '@daytuner/schedule';
import { formatMetrics, formatWarnings, inZone } from './format.js';

const USAGE = `Usage:
  daytuner preview <channel.yaml> --tunarr URL [--from ISO] [--days N] [--seed N] [--state FILE] [--json]
  daytuner apply   <channel.yaml> --tunarr URL [--channel NAME] [--days N] [--seed N] [--state FILE] [--yes]`;

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function loadState(path: string | undefined, seed: number): PlanState {
  if (path && existsSync(path)) return JSON.parse(readFileSync(path, 'utf8')) as PlanState;
  return emptyPlanState(seed);
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      tunarr: { type: 'string' },
      channel: { type: 'string' },
      from: { type: 'string' },
      days: { type: 'string', default: '7' },
      seed: { type: 'string', default: '1' },
      state: { type: 'string' },
      json: { type: 'boolean', default: false },
      yes: { type: 'boolean', default: false },
    },
  });
  const [command, file] = positionals;
  if ((command !== 'preview' && command !== 'apply') || !file || !values.tunarr) {
    console.error(USAGE);
    return 2;
  }

  const days = Number(values.days);
  const seed = Number(values.seed);
  if (!Number.isInteger(days) || days <= 0) throw new Error('--days must be a positive whole number');
  if (!Number.isInteger(seed)) throw new Error('--seed must be a whole number');

  const parsed = parseScheduleFile(readFileSync(file, 'utf8'));
  const client = new TunarrClient(values.tunarr, undefined, command === 'apply' && values.yes === true);
  const { schedule, library, fillerListIds } = await resolveSchedule(parsed, client);
  const state = loadState(values.state, seed);

  let from: number;
  let flex = 0;
  let channelId: string | undefined;
  let channelName = parsed.channel;
  if (command === 'apply') {
    const wanted = values.channel ?? parsed.channel;
    const channels = await client.channels();
    const ch = channels.find((c) => c.id === wanted || String(c.number) === wanted || slug(c.name) === slug(wanted));
    if (!ch) throw new Error(`no channel matches "${wanted}" (channels: ${channels.map((c) => c.name).join(', ')})`);
    channelId = ch.id;
    channelName = ch.name;
    ({ from, flex } = alignToGrid(ch.startTime + ch.duration, schedule.grid));
  } else {
    from = values.from ? Date.parse(values.from) : ceilToGrid(Date.now(), schedule.grid);
    if (!Number.isFinite(from)) throw new Error(`--from "${values.from}" is not a date`);
    from = ceilToGrid(from, schedule.grid);
  }
  const to = from + days * DAY;

  const result = plan({ schedule, library, state, from, to });
  const metrics = computeMetrics(result.slots, { grid: schedule.grid, zone: schedule.zone });

  if (command === 'preview' || !values.yes) {
    if (values.json) {
      console.log(JSON.stringify({ from, to, metrics, warnings: result.warnings }, null, 2));
    } else {
      console.log(`DayTuner ${command}: ${channelName}, from ${inZone(from, schedule.zone)} (${schedule.zone}) for ${days} day(s), seed ${seed}`);
      if (command === 'apply') console.log(`Alignment flex before the first slot: ${flex} ms`);
      console.log(`\n${formatMetrics(metrics)}\n\n${formatWarnings(result.warnings, schedule.zone)}`);
      if (command === 'apply') console.log(`\nThis was a dry run. Nothing was written. Add --yes to append to ${values.tunarr}, channel "${channelName}".`);
    }
    return 0;
  }

  // apply --yes: append, then check what Tunarr stored.
  const items = [...(flex > 0 ? [{ type: 'flex' as const, duration: flex }] : []), ...toLineupItems(result.slots, fillerListIds)];
  const before = (await client.lineup(channelId!)).length;
  console.log(`Appending ${items.length} items (${totalDuration(items)} ms) to channel "${channelName}" at ${values.tunarr}`);
  await client.appendLineup(channelId!, items);
  const after = await client.lineup(channelId!);
  const stored = after.slice(before);
  const ok = stored.length === items.length && stored.every((s, i) => s['type'] === items[i]!.type && Math.round(Number(s['duration'])) === items[i]!.duration);
  console.log(ok ? `Verified: Tunarr stored exactly the ${items.length} items that were sent.` : 'MISMATCH: what Tunarr stored differs from what was sent.');
  if (values.state) writeFileSync(values.state, JSON.stringify(result.state, null, 2));
  console.log(`\n${formatMetrics(metrics)}\n\n${formatWarnings(result.warnings, schedule.zone)}`);
  return ok ? 0 : 1;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  },
);
