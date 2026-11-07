// A sample of what ad settings do: plans one real program from the channel's own library with the settings as they
// would be, and reports its block piece by piece. Uses the real planner, so what it shows is what would air.

import { ceilToGrid, emptyPlanState, plan, toEpoch, type Item, type Library, type Schedule } from '@daytuner/engine';
import { applyAdSettings, parseScheduleFile, resolveSchedule, type AdSettings } from '@daytuner/schedule';
import { cachedSource } from './chapters.js';
import { ConsistencyError, type WorkerDeps } from './worker.js';

export interface SampleSegment {
  type: 'content' | 'ad' | 'bumper' | 'interstitial' | 'dead-air';
  /** head, pre, mid, post, tail or gap; for content, "" */
  position: string;
  ms: number;
  list?: string;
}

export interface AdSample {
  kind: 'episode' | 'movie';
  title: string;
  programMs: number;
  /** The slot the sample was planned in: the program with its minimum ads, rounded up to the grid (or a step more if it did not fit). */
  windowMs: number;
  segments: SampleSegment[];
  adMs: number;
  /** Ad time over the program's own length. */
  adShare: number;
  midBreaks: number;
  deadAirMs: number;
  warnings: string[];
}

const MIN = 60_000;

function segmentsOf(items: readonly Item[]): SampleSegment[] {
  const out: SampleSegment[] = [];
  const push = (s: SampleSegment, merge: boolean): void => {
    const last = out[out.length - 1];
    if (merge && last && last.type === s.type && last.position === s.position && last.list === s.list) last.ms += s.ms;
    else out.push(s);
  };
  for (const i of items) {
    if (i.kind === 'content') push({ type: 'content', position: '', ms: i.duration }, false);
    else if (i.kind === 'flex') push({ type: 'dead-air', position: 'gap', ms: i.duration }, true);
    else push({ type: i.role, position: i.position, ms: i.duration, list: i.list }, i.role !== 'bumper');
  }
  return out;
}

function pick(library: Library, schedule: Schedule, titles: Record<string, string>) {
  const ordered = Object.values(schedule.pools).filter((p) => p.order === 'ordered').flatMap((p) => p.programs);
  const shuffled = Object.values(schedule.pools).filter((p) => p.order === 'shuffled').flatMap((p) => p.programs);
  const within = (ids: string[], lo: number, hi: number): string | undefined => ids.find((id) => library.programs[id]!.duration >= lo && library.programs[id]!.duration <= hi);
  const ids = Object.keys(library.programs);
  const episode = within(ordered, 15 * MIN, 50 * MIN) ?? within(ids, 15 * MIN, 50 * MIN);
  const movie = within(shuffled, 75 * MIN, 130 * MIN) ?? within(ids, 75 * MIN, 130 * MIN);
  return [
    ...(episode ? [{ kind: 'episode' as const, id: episode, title: titles[episode] ?? episode }] : []),
    ...(movie ? [{ kind: 'movie' as const, id: movie, title: titles[movie] ?? movie }] : []),
  ];
}

/**
 * Plans a sample episode and a sample movie with `settings` applied to the channel's schedule, without saving anything.
 * Nothing is written to the store or to Tunarr.
 */
export async function adSamples(deps: Pick<WorkerDeps, 'store' | 'client' | 'clock'>, channelName: string, settings: AdSettings): Promise<AdSample[]> {
  const { store, client, clock } = deps;
  const ch = store.channel(channelName);
  if (!ch) throw new ConsistencyError(`no channel named "${channelName}" in the store`);
  const candidate = applyAdSettings(ch.schedule, settings);
  const { schedule, library, titles } = await resolveSchedule(parseScheduleFile(candidate), cachedSource(client, store, clock));
  const start = toEpoch(schedule.zone, { year: 2026, month: 1, day: 5, hour: 18, minute: 0 }); // a Monday evening: the day does not matter
  const out: AdSample[] = [];
  for (const sample of pick(library, schedule, titles)) {
    const program = library.programs[sample.id]!;
    // The smallest slot the program fits in with its minimum ads; if the planner says it does not fit, a grid step more, a few times.
    const smallest = Math.ceil(program.duration * (1 + settings.ratio.min));
    for (let extra = 0; extra < 4; extra++) {
      const windowMs = ceilToGrid(smallest, schedule.grid) + extra * schedule.grid;
      const slotId = 'added@sample';
      const r = plan({ schedule, library, state: emptyPlanState(1), from: start, to: start + 1, windows: [{ start, end: start + windowMs, slotId }], pins: [{ start, blocks: { 1: sample.id } }] });
      const slot = r.slots.find((s) => s.slotId === slotId);
      if (!slot || slot.programs.length === 0) continue;
      const segments = segmentsOf(slot.items);
      const adMs = segments.filter((x) => x.type === 'ad').reduce((a, x) => a + x.ms, 0);
      out.push({
        kind: sample.kind, title: sample.title, programMs: program.duration, windowMs, segments, adMs, adShare: adMs / program.duration,
        midBreaks: segments.filter((x) => x.type === 'ad' && x.position === 'mid').length,
        deadAirMs: segments.filter((x) => x.type === 'dead-air').reduce((a, x) => a + x.ms, 0),
        warnings: r.warnings.filter((w) => w.slotId === slotId && w.code !== 'started-mid-slot').map((w) => w.message),
      });
      break;
    }
  }
  return out;
}
