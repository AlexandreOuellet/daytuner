// What a pool holds, for the schedule designer: how many programs it matches and how long each is, so the page can say
// how many fit a slot. Works on pools that are not saved yet.

import { makeLibraryReader, poolDefOf, type LibrarySource, type PoolModel } from '@daytuner/schedule';

export interface PoolStats {
  /** Programs the pool holds. */
  count: number;
  /** Their lengths in milliseconds, shortest first. */
  durations: number[];
  /** The shows of a pool of shows, with how many episodes each gives. */
  members?: { title: string; episodes: number }[];
  /** The names of up to 300 of its programs (movies, or episodes), in the order they come. */
  sample?: string[];
  /** Why the pool could not be read (a show that is not in the library, for example). */
  error?: string;
}

export async function poolStats(source: Pick<LibrarySource, 'movies' | 'shows' | 'episodes' | 'idsWhere'>, pools: Record<string, PoolModel>): Promise<Record<string, PoolStats>> {
  const reader = makeLibraryReader(source);
  const out: Record<string, PoolStats> = {};
  for (const [name, def] of Object.entries(pools)) {
    try {
      const r = await reader.pool(poolDefOf(def));
      const durations = r.ids.map((id) => r.programs[id]!.duration).sort((a, b) => a - b);
      out[name] = { count: durations.length, durations, ...(r.members ? { members: r.members.map((m) => ({ title: m.title, episodes: m.episodes })) } : {}), sample: r.ids.slice(0, 300).map((id) => r.titles[id] ?? id) };
    } catch (e) {
      out[name] = { count: 0, durations: [], error: e instanceof Error ? e.message : String(e) };
    }
  }
  return out;
}
