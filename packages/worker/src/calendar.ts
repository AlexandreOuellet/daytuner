// The calendar: what will air on the dates in view, and which of it was shaped by hand. Plans the stretch from the end of
// the committed lineup twice, once from the schedule alone (the plan) and once as the staged slots shape it, and says for
// each slot of the second which of the two it is. Writes nothing, stores nothing.
// Design: docs/web-schedule.md, "The calendar".

import { createHash } from 'node:crypto';
import { plan, type Item, type PlannedSlot, type PlanResult, type PlanWarning } from '@daytuner/engine';
import { adSettingsOf, parseScheduleFile, resolveSchedule } from '@daytuner/schedule';
import type { StagedSlotRecord } from '@daytuner/store';
import { alignToGrid, type TunarrClient } from '@daytuner/tunarr-client';
import { cachedSource } from './chapters.js';
import { ConsistencyError, stagedInputs, stageRefresh, type StageResult, type WorkerDeps } from './worker.js';

/**
 * Where a slot lives. `committed`: already in Tunarr's lineup. `staged`: stored in DayTuner, waiting to be committed (it may
 * be exactly what the plan makes, or shaped by hand). `planned`: stored nowhere; what the schedule would make if nothing changes.
 */
export type CalendarSource = 'committed' | 'staged' | 'planned';

/** What a slot's items add up to. */
export interface SlotTotals {
  programMs: number;
  adMs: number;
  bumperMs: number;
  interstitialMs: number;
  deadAirMs: number;
  /** Ads as a share of the program, 0 when there is no program. */
  adShare: number;
}

export interface CalendarSlot {
  slot: PlannedSlot;
  source: CalendarSource;
  /** In words, what was done by hand to a staged slot ("locked", "2 pins", "shaped", "slot added"). Empty when nothing was. */
  hand: string[];
  /** True when an exception rule of the schedule replaced the normal programming. */
  rule: boolean;
  /** True when this slot is not what the schedule alone would make there (done by hand, or moved by an edit before it). */
  differs: boolean;
  totals: SlotTotals;
  /** The plan for the same stretch (the slots of the plan that overlap this one), when this one differs from it. */
  plan: { start: number; end: number; slotId: string; pool: string; programs: string[]; totals: SlotTotals }[];
  warnings: PlanWarning[];
}

/**
 * One program of the committed lineup with what is around it (its head or pre break, its mid breaks, its post or tail),
 * rebuilt from Tunarr's stored lineup, which has no slot boundaries. Titles are known only for what the schedule's pools hold.
 */
export interface CommittedBlock {
  start: number;
  end: number;
  programs: string[];
  items: Item[];
  totals: SlotTotals;
}

type Resolved = Awaited<ReturnType<typeof resolveSchedule>>;

/**
 * The schedule resolved against the library (a read of every movie, show and episode: seconds), kept for a while and shared by
 * requests made together. The key is the channel's Tunarr id and its schedule text, so a saved schedule is read again.
 */
const resolved = new Map<string, { at: number; value: Promise<Resolved> }>();
const RESOLVE_KEEP_MS = 30 * 60_000;

async function resolveCached(deps: Pick<WorkerDeps, 'store' | 'client' | 'clock'>, ch: { tunarrId: string; schedule: string }): Promise<Resolved> {
  const key = `${ch.tunarrId}\u0000${ch.schedule}`;
  const now = deps.clock.now();
  let held = resolved.get(key);
  if (!held || now - held.at > RESOLVE_KEEP_MS) {
    held = { at: now, value: resolveSchedule(parseScheduleFile(ch.schedule), cachedSource(deps.client, deps.store, deps.clock)) };
    resolved.set(key, held);
    held.value.catch(() => resolved.delete(key));
  }
  const r = await held.value;
  // The planner and the staged inputs add to these (a pinned program, its title): hand out copies.
  return { ...r, library: { programs: { ...r.library.programs }, clips: r.library.clips }, titles: { ...r.titles } };
}

/** Plans from the committed edge, kept per set of inputs: a later week extends an earlier one instead of planning it all again. */
const planned = new Map<string, { to: number; fresh: PlanResult; shaped: PlanResult }>();
const PLAN_AHEAD_MS = 21 * 86_400_000;

/**
 * Neighbouring committed blocks of the same pool, as one run: the committed counterpart of a slot (the stored lineup has no
 * slot boundaries). `pool` is null for programs no pool of the schedule holds.
 */
export interface CommittedRun {
  start: number;
  end: number;
  pool: string | null;
  programs: string[];
  blocks: { programId: string; start: number; end: number }[];
  items: Item[];
  totals: SlotTotals;
}

export function runsOf(blocks: readonly CommittedBlock[], poolOf: ReadonlyMap<string, string>): CommittedRun[] {
  const out: CommittedRun[] = [];
  for (const b of blocks) {
    const pool = poolOf.get(b.programs[0] ?? '') ?? null;
    const last = out[out.length - 1];
    const piece = { programId: b.programs[0] ?? '', start: b.start, end: b.end };
    if (last && last.pool === pool && last.end === b.start) {
      last.end = b.end;
      last.blocks.push(piece);
      last.items.push(...b.items);
      for (const p of b.programs) if (!last.programs.includes(p)) last.programs.push(p);
    } else out.push({ start: b.start, end: b.end, pool, programs: [...b.programs], blocks: [piece], items: [...b.items], totals: b.totals });
  }
  for (const r of out) r.totals = totalsOf(r.items);
  return out;
}

export interface CalendarResult {
  /** Where the committed lineup ends: everything before is history and is not planned again. */
  committedUntil: number;
  from: number;
  to: number;
  /** The committed lineup in the range, as runs of one pool. */
  committed: CommittedRun[];
  slots: CalendarSlot[];
  titles: Record<string, string>;
  /** Clip titles by clip id, for the ads, bumpers and filler in the items. */
  clips: Record<string, string>;
  /** Programs in the slots that are an episode of an ordered show with an earlier episode: a block of one may be replayed as a rerun. */
  rerunnable: string[];
}

export function totalsOf(items: readonly Item[]): SlotTotals {
  const t: SlotTotals = { programMs: 0, adMs: 0, bumperMs: 0, interstitialMs: 0, deadAirMs: 0, adShare: 0 };
  for (const i of items) {
    if (i.kind === 'content') t.programMs += i.duration;
    else if (i.kind === 'flex') t.deadAirMs += i.duration;
    else if (i.role === 'ad') t.adMs += i.duration;
    else if (i.role === 'bumper') t.bumperMs += i.duration;
    else t.interstitialMs += i.duration;
  }
  t.adShare = t.programMs > 0 ? t.adMs / t.programMs : 0;
  return t;
}

const sameContent = (a: PlannedSlot, b: PlannedSlot): boolean =>
  a.start === b.start && a.end === b.end && a.slotId === b.slotId && a.programs.join('\u0000') === b.programs.join('\u0000');

function changesOf(row: StagedSlotRecord | undefined): string[] {
  if (!row) return [];
  const out: string[] = [];
  if (row.slotId?.startsWith('added@')) out.push('slot added');
  else if (row.edited) out.push('shaped');
  const pins = Object.keys(row.pins).length;
  if (pins) out.push(`${pins} pin${pins === 1 ? '' : 's'}`);
  if (row.locked) out.push('locked');
  return out;
}

/** The slots that start in `[from, to)`, planned from the end of the committed lineup. `to` is capped at eight weeks past the edge. */
export async function calendarPlan(deps: Pick<WorkerDeps, 'store' | 'client' | 'clock'>, channelName: string, range: { from: number; to: number }): Promise<CalendarResult> {
  const { store, client, clock } = deps;
  const ch = store.channel(channelName);
  if (!ch) throw new ConsistencyError(`no channel named "${channelName}" in the store`);
  if (!(range.to > range.from)) throw new ConsistencyError('the end of the range must be after its start');
  const { schedule, library, titles } = await resolveCached(deps, ch);
  const { from: edge } = alignToGrid(ch.edge, schedule.grid);
  const horizon = edge + 56 * 86_400_000;
  const to = Math.min(range.to, horizon);
  const poolOf = new Map<string, string>();
  for (const [pool, def] of Object.entries(schedule.pools)) for (const id of def.programs) if (!poolOf.has(id)) poolOf.set(id, pool);
  const committed = runsOf(await committedIn(client, ch, range), poolOf);
  if (to <= edge) return { committedUntil: edge, from: range.from, to, committed, slots: [], titles, clips: await clipTitles(client, committed.flatMap((c) => c.items)), rerunnable: [] };

  const staged = store.stagedSlots(ch.id, edge);
  const rows = new Map(staged.map((r) => [r.start, r]));
  const inputs = stagedInputs(store, ch, edge, library, titles);
  // The same inputs give the same plan, so a plan that already reaches far enough is reused, and one that does not is
  // made to reach a few weeks beyond what was asked, so scrolling on does not plan again each time.
  const key = createHash('sha1').update(JSON.stringify([ch.tunarrId, ch.schedule, edge, ch.state, staged.map((r) => [r.start, r.end, r.slotId, r.locked, r.edited, r.pins])])).digest('hex');
  let held = planned.get(key);
  if (!held || held.to < to) {
    const reach = Math.min(horizon, to + PLAN_AHEAD_MS);
    const fresh = plan({ schedule, library, state: ch.state, from: edge, to: reach });
    // Nothing staged: what is shaped by hand is the plan itself.
    const shaped = staged.length === 0 ? fresh : plan({ schedule, library, state: ch.state, from: edge, to: reach, locked: inputs.locked, pins: inputs.pins, windows: inputs.windows });
    held = { to: reach, fresh, shaped };
    planned.delete(key);
    planned.set(key, held);
    while (planned.size > 6) planned.delete(planned.keys().next().value!);
  }
  const { fresh, shaped } = held;
  const freshByStart = new Map(fresh.slots.map((s) => [s.start, s]));

  const slots: CalendarSlot[] = [];
  for (const s of shaped.slots) {
    if (s.end <= range.from || s.start >= range.to) continue;
    const row = rows.get(s.start);
    const same = freshByStart.get(s.start);
    const hand = changesOf(row);
    const differs = hand.length > 0 || !same || !sameContent(same, s);
    slots.push({
      slot: s, source: row ? 'staged' : 'planned', hand, rule: s.exception, differs, totals: totalsOf(s.items),
      plan: differs
        ? fresh.slots.filter((f) => f.end > s.start && f.start < s.end).map((f) => ({ start: f.start, end: f.end, slotId: f.slotId, pool: f.pool, programs: f.programs, totals: totalsOf(f.items) }))
        : [],
      warnings: shaped.warnings.filter((w) => w.at >= s.start && w.at < s.end),
    });
  }
  const clips = await clipTitles(client, [...committed.flatMap((c) => c.items), ...slots.flatMap((x) => x.slot.items)]);
  const rerunnable = new Set<string>();
  for (const x of slots) for (const b of x.slot.blocks) if (!b.pinned && earlierEpisode(schedule.pools[x.slot.pool], b.programId, titles)) rerunnable.add(b.programId);
  return { committedUntil: edge, from: range.from, to, committed, slots, titles, clips, rerunnable: [...rerunnable] };
}

/** The show an episode's title names ("Star Trek: Lower Decks S2E3 "Title"" is "Star Trek: Lower Decks"). */
const showOf = (title: string | undefined): string | undefined => title?.replace(/ S\d+E\d+ ".*$/, '');

/** True when every program of the pool is an episode of one show (a pool of several shows, or of movies, is not). */
export function isOneShow(pool: { programs: readonly string[] }, titles: Readonly<Record<string, string>>): boolean {
  const shows = new Set(pool.programs.map((id) => showOf(titles[id]) ?? id));
  return shows.size === 1;
}

/**
 * The episode before `programId` in an ordered pool of one show, when there is one. A pool of several shows takes turns between
 * them, so a rerun there would upset the turns (everything after it moves up a place): it is not offered (settled with the owner;
 * a rerun of a whole slot is the slot's `rerun` link instead).
 */
export function earlierEpisode(pool: { order: 'ordered' | 'shuffled'; programs: readonly string[] } | undefined, programId: string, titles: Readonly<Record<string, string>>): string | undefined {
  if (!pool || pool.order !== 'ordered' || !isOneShow(pool, titles)) return undefined;
  const i = pool.programs.indexOf(programId);
  return i > 0 ? pool.programs[i - 1] : undefined;
}

/**
 * Plays the episode before this block's episode instead (a rerun), by pinning it. A pinned block takes nothing from its
 * show, so the show's next new episode is not used up: the week after plays the one this block would have played. The slot
 * must be staged. Nothing is written to Tunarr.
 */
export async function stageRerun(
  deps: Pick<WorkerDeps, 'store' | 'client' | 'clock'>,
  channelName: string,
  at: { start: number; block: number; pool: string; programId: string },
): Promise<StageResult> {
  const ch = deps.store.channel(channelName);
  if (!ch) throw new ConsistencyError(`no channel named "${channelName}" in the store`);
  const { schedule, library, titles } = await resolveCached(deps, ch);
  const pool = schedule.pools[at.pool];
  if (!pool || pool.order !== 'ordered') throw new ConsistencyError(`"${at.pool}" does not play its programs in order, so there is no earlier episode to replay`);
  if (!isOneShow(pool, titles)) throw new ConsistencyError(`"${at.pool}" takes turns between several shows, and a rerun of one block would upset the turns. Use a rerun slot for it, or a pool of one show`);
  const earlier = earlierEpisode(pool, at.programId, titles);
  if (!earlier) throw new ConsistencyError('this is the first episode, so there is nothing earlier to replay');
  const program = library.programs[earlier];
  if (!program) throw new ConsistencyError('the earlier episode is not in the library');
  deps.store.setPin(channelName, at.start, at.block, { id: earlier, title: titles[earlier] ?? earlier, duration: program.duration });
  return stageRefresh(deps, channelName, at.start);
}

type Stored = Record<string, unknown>;

/**
 * Cuts a stored lineup into blocks: a block starts at a program's first piece (offset 0), together with the head or pre
 * filler just before it, and runs until the next block starts. Items laid end to end from `startTime`. Only blocks that
 * overlap `[from, to)` are returned.
 */
export function blocksFromLineup(
  lineup: readonly Stored[],
  startTime: number,
  range: { from: number; to: number },
  roleOf: (listId: string, type: string) => 'ad' | 'bumper' | 'interstitial',
  listName: (listId: string) => string,
): CommittedBlock[] {
  const starts: number[] = [];
  let at = startTime;
  for (const i of lineup) { starts.push(at); at += Number(i['duration']); }
  const isLead = (i: Stored): boolean => i['type'] === 'filler' && (i['fillerType'] === 'head' || i['fillerType'] === 'pre');
  const cuts: number[] = [];
  for (let k = 0; k < lineup.length; k++) {
    const i = lineup[k]!;
    if (i['type'] !== 'content' || Number(i['startOffsetMs'] ?? 0) !== 0) continue;
    let j = k;
    while (j > 0 && isLead(lineup[j - 1]!) && !cuts.includes(j - 1)) j--;
    cuts.push(j);
  }
  const out: CommittedBlock[] = [];
  for (let c = 0; c < cuts.length; c++) {
    const from = cuts[c]!;
    const to = c + 1 < cuts.length ? cuts[c + 1]! : lineup.length;
    const start = starts[from]!;
    const end = to < lineup.length ? starts[to]! : at;
    if (end <= range.from || start >= range.to) continue;
    const items: Item[] = [];
    const programs: string[] = [];
    for (let k = from; k < to; k++) {
      const i = lineup[k]!;
      const duration = Number(i['duration']);
      if (i['type'] === 'content') {
        items.push({ kind: 'content', programId: String(i['id']), startOffset: Number(i['startOffsetMs'] ?? 0), duration });
        if (!programs.includes(String(i['id']))) programs.push(String(i['id']));
      } else if (i['type'] === 'filler') {
        const listId = String(i['fillerListId']);
        const type = String(i['fillerType']);
        items.push({ kind: 'filler', role: roleOf(listId, type), position: type === 'fallback' ? 'gap' : (type as 'head'), list: listName(listId), clipId: String(i['id']), duration });
      } else items.push({ kind: 'flex', duration });
    }
    out.push({ start, end, programs, items, totals: totalsOf(items) });
  }
  return out;
}

/** The stored lineups already read, by channel, with the length they had: a lineup only grows, so the same length is the same lineup. */
const lineups = new Map<string, { duration: number; lineup: Stored[] }>();

async function committedIn(client: TunarrClient, ch: { tunarrId: string; schedule: string }, range: { from: number; to: number }): Promise<CommittedBlock[]> {
  const info = await client.channel(ch.tunarrId);
  let held = lineups.get(ch.tunarrId);
  if (!held || held.duration !== info.duration) {
    held = { duration: info.duration, lineup: await client.lineup(ch.tunarrId) };
    lineups.set(ch.tunarrId, held);
  }
  if (range.from >= info.startTime + info.duration) return [];
  const settings = adSettingsOf(parseScheduleFile(ch.schedule));
  const bumperLists = new Set(Object.values(settings.bumpers));
  const names = new Map((await client.fillerLists()).map((l) => [l.id, l.name]));
  const name = (id: string): string => names.get(id) ?? id;
  return blocksFromLineup(held.lineup, info.startTime, range, (id, type) => (type === 'fallback' ? 'interstitial' : bumperLists.has(name(id)) ? 'bumper' : 'ad'), name);
}

/** What each filler list's clips are called, by clip id, read once and kept for a while: the lists rarely change. */
const listClips = new Map<string, { at: number; titles: Record<string, string> }>();
const KEEP_MS = 10 * 60_000;

/** Titles for the clips the items use. A clip Tunarr no longer lists has no title. */
async function clipTitles(client: TunarrClient, items: readonly Item[]): Promise<Record<string, string>> {
  const used = new Set<string>();
  for (const i of items) if (i.kind === 'filler') used.add(i.list);
  if (used.size === 0) return {};
  const byName = new Map((await client.fillerLists()).map((l) => [l.name, l.id]));
  const out: Record<string, string> = {};
  for (const name of used) {
    const id = byName.get(name) ?? name;
    let held = listClips.get(id);
    if (!held || Date.now() - held.at > KEEP_MS) {
      try {
        held = { at: Date.now(), titles: Object.fromEntries((await client.fillerListClips(id)).map((c) => [c.id, c.title])) };
      } catch {
        held = { at: Date.now(), titles: {} };
      }
      listClips.set(id, held);
    }
    Object.assign(out, held.titles);
  }
  return out;
}

/**
 * Reads what the calendar will need (the library, the lineup, the clip names) and plans a few weeks, so the first time the
 * page is opened it does not wait for all of it. Errors are ignored: the page will meet them itself.
 */
export async function warmCalendar(deps: Pick<WorkerDeps, 'store' | 'client' | 'clock'>, channelName: string): Promise<void> {
  const ch = deps.store.channel(channelName);
  if (!ch) return;
  try {
    await calendarPlan(deps, channelName, { from: ch.edge - 86_400_000, to: ch.edge + 86_400_000 });
  } catch {
    /* nothing to warm */
  }
}
