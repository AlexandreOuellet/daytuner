import { describe, expect, it } from 'vitest';
import { TunarrClient } from './client.js';
import { FakeTunarr } from './fake.js';
import { appendVerified, type LineupItem } from './lineup.js';

const fake = () =>
  new FakeTunarr({
    shows: [], movies: [], fillerLists: [],
    channel: { id: 'c1', number: 1, name: 'Test', startTime: 1_000_000_000_000 },
    lineup: [{ type: 'flex', duration: 900_000 }],
  });
const items: LineupItem[] = [
  { type: 'content', id: 'p1', startOffsetMs: 0, duration: 600_000 },
  { type: 'filler', id: 'a1', fillerListId: 'l1', fillerType: 'mid', duration: 30_000 },
  { type: 'content', id: 'p1', startOffsetMs: 600_000, duration: 270_000 },
];

describe('appendVerified', () => {
  it('appends and confirms that Tunarr stored exactly what was sent', async () => {
    const t = fake();
    const client = new TunarrClient('http://t', t.fetch, true);
    const r = await appendVerified(client, 'c1', items);
    expect(r).toMatchObject({ ok: true, itemsBefore: 1, itemsAfter: 4, problems: [] });
    expect(r.edgeAfter - r.edgeBefore).toBe(900_000);
    expect(t.lineup).toHaveLength(4);
  });

  it('reports a store that differs from what was sent', async () => {
    const t = fake();
    const real = new TunarrClient('http://t', t.fetch, true);
    const lying = {
      channel: (id: string) => real.channel(id),
      appendLineup: (id: string, l: readonly unknown[]) => real.appendLineup(id, l),
      lineup: async (id: string) => (await real.lineup(id)).map((i) => (i['type'] === 'filler' ? { ...i, fillerType: 'post' } : i)),
    };
    const r = await appendVerified(lying, 'c1', items);
    expect(r.ok).toBe(false);
    expect(r.problems.join(' ')).toMatch(/item 1 differs/);
  });

  it('cannot write through a client that was not allowed to', async () => {
    const t = fake();
    await expect(appendVerified(new TunarrClient('http://t', t.fetch), 'c1', items)).rejects.toThrow(/allowWrites/);
    expect(t.lineup).toHaveLength(1);
  });
});

describe('the fake Tunarr', () => {
  it('refuses to replace a lineup and pages from 0', async () => {
    const t = fake();
    const bad = await t.fetch('http://t/api/channels/c1/programming', { method: 'POST', body: JSON.stringify({ type: 'manual', lineup: [], append: false }) });
    expect(bad.ok).toBe(false);
    expect(t.lineup).toHaveLength(1);
  });
});
