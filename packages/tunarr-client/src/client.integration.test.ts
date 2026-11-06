// Runs only when TUNARR_URL points at a Tunarr (use a test copy). Makes GET and search calls only.
import { describe, expect, it } from 'vitest';
import { TunarrClient } from './client.js';

const url = process.env['TUNARR_URL'];

describe.skipIf(!url)('a real Tunarr (read only)', () => {
  const c = new TunarrClient(url ?? '');

  it('lists channels', async () => {
    const channels = await c.channels();
    expect(channels.length).toBeGreaterThan(0);
    for (const ch of channels) expect(Number.isInteger(ch.duration)).toBe(true);
  });

  it('reads filler lists and clips as whole milliseconds', async () => {
    const lists = await c.fillerLists();
    expect(lists.length).toBeGreaterThan(0);
    const clips = await c.fillerListClips(lists[0]!.id);
    expect(clips.length).toBeGreaterThan(0);
    for (const clip of clips) {
      expect(Number.isInteger(clip.duration)).toBe(true);
      expect(clip.duration).toBeGreaterThan(0);
    }
  });

  it('reads movies and the episodes of a show', async () => {
    const movies = await c.movies();
    expect(movies.length).toBeGreaterThan(0);
    expect(new Set(movies.map((m) => m.id)).size).toBe(movies.length); // no page counted twice
    expect(movies.every((m) => Number.isInteger(m.duration))).toBe(true);
    const shows = await c.shows();
    const columbo = shows.find((s) => s.title === 'Columbo');
    if (columbo) {
      const eps = await c.episodes(columbo.id);
      expect(eps.length).toBeGreaterThan(10);
      expect(eps[0]!.season).toBeLessThanOrEqual(eps[eps.length - 1]!.season);
    }
  }, 60_000);
});
