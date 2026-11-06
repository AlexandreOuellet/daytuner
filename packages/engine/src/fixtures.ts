// Test fixtures: a small channel that exercises ordered shows, movies, reruns and breaks.
// Not exported from the package.

import type { Clip } from './clips.js';
import { toEpoch } from './clock.js';
import type { Library, PlanState, Schedule } from './schedule.js';
import { emptyPlanState } from './schedule.js';
import { HOUR, MINUTE, SECOND } from './time.js';

export const ZONE = 'America/Toronto';

/** A local wall-clock instant in the fixture's time zone. */
export const local = (year: number, month: number, day: number, hour = 0, minute = 0): number =>
  toEpoch(ZONE, { year, month, day, hour, minute });

const clips = (prefix: string, count: number, minSeconds: number, spanSeconds: number): Clip[] =>
  Array.from({ length: count }, (_, i) => ({
    id: `${prefix}${i}`,
    // Whole milliseconds that are not whole seconds, as real clips are.
    duration: (minSeconds + ((i * 7) % spanSeconds)) * SECOND + ((i * 137) % 1000),
  }));

export const episodes = (count: number): string[] => Array.from({ length: count }, (_, i) => `ep${i + 1}`);

export function fixtureLibrary(): Library {
  const programs: Library['programs'] = {};
  for (const id of episodes(12)) programs[id] = { duration: 22 * MINUTE + 17 * SECOND + 431 };
  for (const [id, minutes] of [['m1', 97], ['m2', 108], ['m3', 117], ['m4', 90], ['m5', 101]] as const) {
    programs[id] = { duration: minutes * MINUTE + 12_345 };
  }
  programs['epic'] = { duration: 5 * HOUR };
  return {
    programs,
    clips: {
      'Old Ads': clips('ad', 40, 15, 16),
      Idents: clips('id', 6, 5, 4),
      Fillers: clips('fl', 8, 180, 120),
      Short: clips('sh', 3, 15, 3),
    },
  };
}

export function fixtureSchedule(over: Partial<Schedule> = {}): Schedule {
  return {
    grid: 15 * MINUTE,
    zone: ZONE,
    ads: {
      step: 15 * SECOND,
      ratio: { min: 0.15, max: 0.6 },
      mid: { list: 'Old Ads', range: { min: 2 * MINUTE, max: 3 * MINUTE }, offers: { every: 8 * MINUTE, tailBuffer: MINUTE } },
      post: { list: 'Old Ads', range: { min: 0, max: 5 * MINUTE } },
    },
    bumpers: {},
    interstitial: { list: 'Fillers' },
    pools: {
      office: { order: 'ordered', programs: episodes(12) },
      movies: { order: 'shuffled', programs: ['m1', 'm2', 'm3', 'm4', 'm5'] },
    },
    week: [
      { day: 1, at: 18 * HOUR, pool: 'office', link: { name: 'office', mode: 'continue' } },
      { day: 1, at: 20 * HOUR, pool: 'movies' },
      { day: 1, at: 22 * HOUR + 15 * MINUTE, pool: 'office', link: { name: 'office', mode: 'rerun' } },
      { day: 2, at: 0, pool: 'movies' },
    ],
    exceptions: [],
    ...over,
  };
}

export const freshState = (seed = 7): PlanState => emptyPlanState(seed);

/** Monday 9 November 2026, 18:00, to the start of Tuesday. */
export const MONDAY_18 = local(2026, 11, 9, 18);
export const TUESDAY_00 = local(2026, 11, 10, 0);
