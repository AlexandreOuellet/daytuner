// Test helpers: a fake library source and re-exports of the engine pieces the tests use.
import { emptyPlanState, plan, toEpoch } from '@daytuner/engine';
import type { LibrarySource } from './resolve.js';

export { emptyPlanState, plan };
export const toLocalForTest = (year: number, month: number, day: number, hour: number): number =>
  toEpoch('America/Toronto', { year, month, day, hour, minute: 0 });

const MIN = 60_000;
const shows: Record<string, { id: string; title: string; episodes: number; minutes: number }> = {
  'The Office': { id: 'show-office', title: 'The Office', episodes: 12, minutes: 22 },
  'Parks and Recreation': { id: 'show-parks', title: 'Parks and Recreation', episodes: 12, minutes: 22 },
  '30 Rock': { id: 'show-rock', title: '30 Rock', episodes: 12, minutes: 22 },
  'Doctor Who': { id: 'show-who', title: 'Doctor Who', episodes: 6, minutes: 45 },
};
const prefix: Record<string, string> = { 'show-office': 'office', 'show-parks': 'parks', 'show-rock': 'rock', 'show-who': 'who' };

export function fakeSource(opts: { duplicateWho?: boolean } = {}): LibrarySource {
  const movies = [
    { id: 'mov-comedy-90', title: 'Short Laughs', duration: 90 * MIN, genres: ['Comedy'] },
    { id: 'mov-comedy-100', title: 'Mid Laughs', duration: 100 * MIN, genres: ['comedy'] },
    { id: 'mov-comedy-130', title: 'Long Laughs', duration: 130 * MIN, genres: ['Comedy'] },
    { id: 'mov-family-95', title: 'The Nightmare Before Christmas', duration: 76 * MIN, genres: ['Family', 'Fantasy'] },
    { id: 'mov-family-110', title: 'Family Fun', duration: 110 * MIN, genres: ['Family'] },
    { id: 'mov-drama-120', title: 'Heavy Drama', duration: 120 * MIN, genres: ['Drama'] },
  ];
  return {
    movies: async () => movies,
    shows: async () => [
      ...Object.values(shows).map((s) => ({ id: s.id, title: s.title })),
      ...(opts.duplicateWho ? [{ id: 'show-who-2005', title: 'Doctor Who' }] : []),
    ],
    episodes: async (showId) => {
      const s = Object.values(shows).find((x) => x.id === showId) ?? shows['Doctor Who']!;
      return Array.from({ length: s.episodes }, (_, i) => ({
        id: `${prefix[showId] ?? 'who2005'}-${i + 1}`,
        title: (showId === 'show-who' || !prefix[showId]) && i === 3 ? 'Halloween Special' : `Episode ${i + 1}`,
        duration: s.minutes * MIN + 1000,
        season: 1,
        episode: i + 1,
      }));
    },
    fillerLists: async () => [
      { id: 'fl-ads', name: 'Old Ads' },
      { id: 'fl-idents', name: 'Station Idents' },
      { id: 'fl-fill', name: 'Fillers' },
    ],
    fillerListClips: async (listId) => {
      const spec = { 'fl-ads': [30, 16, 20], 'fl-idents': [6, 5, 4], 'fl-fill': [200, 180, 150] }[listId]!;
      return Array.from({ length: 24 }, (_, i) => ({ id: `${listId}-${i}`, duration: spec[0]! * 1000 - (i % 3) * spec[1]! * 100 + i * 37 }));
    },
  };
}
