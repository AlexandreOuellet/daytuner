import { describe, expect, it } from 'vitest';
import { Store } from '@daytuner/store';
import { FakeTunarr, TunarrClient } from '@daytuner/tunarr-client';
import { Jobs } from './jobs.js';
import { Scheduler } from './scheduler.js';

const DAY = 86_400_000;
const MIN = 60_000;
const YAML = `
channel: Test
timezone: America/Toronto
grid: 15m
ads:
  step: 15s
  ratio: { min: 15%, max: 60% }
  mid:  { list: Ads, every: 8m, length: 2m-3m, tailBuffer: 1m }
  post: { list: Ads, length: 0-5m }
interstitial: { list: Fillers }
pools:
  sitcoms: { shows: [Show A] }
week:
  sun: [ { at: "08:00", pool: sitcoms } ]
  mon: [ { at: "08:00", pool: sitcoms } ]
  tue: [ { at: "08:00", pool: sitcoms } ]
  wed: [ { at: "08:00", pool: sitcoms } ]
  thu: [ { at: "08:00", pool: sitcoms } ]
  fri: [ { at: "08:00", pool: sitcoms } ]
  sat: [ { at: "08:00", pool: sitcoms } ]
`;

function setup(aheadDays: number) {
  // 11:00 UTC on 6 November 2026 is 06:00 in Toronto: after a 03:00 run time.
  const clock = { t: Date.UTC(2026, 10, 6, 11, 0), now() { return this.t; } };
  const startTime = clock.t - 10 * DAY;
  const fake = new FakeTunarr({
    shows: [{ id: 'show-a', title: 'Show A', episodes: Array.from({ length: 200 }, (_, i) => ({ id: `ep${i + 1}`, title: `Ep ${i + 1}`, duration: 22 * MIN + 1000, season: 1, episode: i + 1 })) }],
    movies: [],
    fillerLists: [
      { id: 'fl-ads', name: 'Ads', clips: Array.from({ length: 40 }, (_, i) => ({ id: `ad${i}`, duration: 15_000 + i * 13 })) },
      { id: 'fl-fill', name: 'Fillers', clips: Array.from({ length: 10 }, (_, i) => ({ id: `fl${i}`, duration: 180_000 + i * 1000 })) },
    ],
    channel: { id: 'chan-1', number: 1, name: 'Test', startTime },
    lineup: [{ type: 'flex', duration: clock.t + aheadDays * DAY - startTime }],
  });
  const store = Store.open(':memory:');
  store.addChannel({ name: 'Test', tunarrId: 'chan-1', floorMs: 7 * DAY, stepMs: DAY, schedule: YAML, state: { rng: 1, sequences: {}, bags: {} } as never, edge: clock.t + aheadDays * DAY });
  const jobs = new Jobs(clock);
  const scheduler = new Scheduler({ store, clock, jobs, writeClient: new TunarrClient('http://tunarr.test', fake.fetch, true) });
  const id = store.channel('Test')!.id;
  const finish = async () => { for (const j of jobs.list()) await jobs.settled(j.id); };
  return { clock, fake, store, jobs, scheduler, id, finish };
}

describe('the daily run', () => {
  it('runs a channel whose time has come, records it, and does not run it again the same day', async () => {
    const s = setup(2);
    const before = s.fake.lineup.length;
    expect(s.scheduler.tick()).toEqual(['Test']);
    await s.finish();
    expect(s.fake.lineup.length).toBeGreaterThan(before);
    expect(s.store.lastRuns(s.id, 1)[0]).toMatchObject({ outcome: 'appended', at: s.clock.t });
    s.clock.t += 60_000;
    expect(s.scheduler.tick()).toEqual([]);
    s.clock.t += DAY; // the next day's time has come
    expect(s.scheduler.tick()).toEqual(['Test']);
    await s.finish();
    expect(s.store.lastRuns(s.id, 2)).toHaveLength(2);
  });

  it('waits for its time of day, and makes up a missed run at the next start', async () => {
    const s = setup(2);
    s.store.recordRun('Test', s.clock.t, 'nothing-to-do', 'the run for today already happened');
    s.store.setSettings('Test', { runAtMinutes: 9 * 60 }); // moved to 09:00; it is 06:00
    expect(s.scheduler.tick()).toEqual([]);
    s.clock.t += 4 * 60 * MIN; // 10:00: past it, as if the server had been off at 09:00
    expect(s.scheduler.tick()).toEqual(['Test']); // 09:00 passed: a run is due
    await s.finish();
  });

  it('makes up a run missed while the server was off', async () => {
    const s = setup(2); // never run, and today's 03:00 has passed
    expect(s.scheduler.tick()).toEqual(['Test']);
    await s.finish();
  });

  it('does not try a failed or refused run again until the next day', async () => {
    const s = setup(2);
    s.fake.appendExternally([{ type: 'flex', duration: 5 * MIN }]); // someone changed the channel: the worker refuses
    expect(s.scheduler.tick()).toEqual(['Test']);
    await s.finish();
    expect(s.jobs.list()[0]).toMatchObject({ state: 'failed' });
    expect(s.store.lastRuns(s.id, 1)[0]).toMatchObject({ outcome: 'refused' });
    s.clock.t += 60 * MIN;
    expect(s.scheduler.tick()).toEqual([]);
  });

  it('skips a channel that is busy and tries again at the next tick', async () => {
    const s = setup(2);
    let release!: () => void;
    s.jobs.start('Test', 'manual plan', () => new Promise<void>((r) => { release = r; }));
    expect(s.scheduler.tick()).toEqual([]);
    release();
    await s.finish();
    expect(s.scheduler.tick()).toEqual(['Test']);
    await s.finish();
  });

  it('starts, ticks on a timer, and stops', async () => {
    const s = setup(2);
    const stop = s.scheduler.start(10);
    await s.finish();
    await new Promise((r) => setTimeout(r, 40));
    stop();
    expect(s.store.lastRuns(s.id, 5)).toHaveLength(1); // ticks while it is not due start nothing more
  });
});
