// The schedule resolved against the library, kept for a while and shared by whatever asks for the same text.
import { parseScheduleFile, resolveSchedule } from '@daytuner/schedule';
import { cachedSource } from './chapters.js';
import type { WorkerDeps } from './worker.js';

export type Resolved = Awaited<ReturnType<typeof resolveSchedule>>;

/**
 * The schedule resolved against the library (a read of every movie, show and episode: seconds), kept for a while and shared by
 * requests made together (the calendar, a check of the schedule and the save that follows it). The key is the channel's Tunarr id and
 * the schedule text, so a changed schedule is read again.
 */
const resolved = new Map<string, { at: number; value: Promise<Resolved> }>();
const RESOLVE_KEEP_MS = 30 * 60_000;

export async function resolveCached(deps: Pick<WorkerDeps, 'store' | 'client' | 'clock'>, ch: { tunarrId: string; schedule: string }): Promise<Resolved> {
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

