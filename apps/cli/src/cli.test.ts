import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeTunarr } from '@daytuner/tunarr-client';
import { runCli } from './cli.js';

const DAY = 86_400_000;
const MIN = 60_000;
const NOW = Date.UTC(2026, 10, 6, 12, 0, 0);

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
  movies:  { movies: { genre: Comedy, duration: "<=117m" } }
week:
  sun: [ { at: "08:00", pool: sitcoms, link: a }, { at: "20:00", pool: movies } ]
  mon: [ { at: "08:00", pool: sitcoms, link: a }, { at: "20:00", pool: movies } ]
  tue: [ { at: "08:00", pool: sitcoms, link: a }, { at: "20:00", pool: movies } ]
  wed: [ { at: "08:00", pool: sitcoms, link: a }, { at: "20:00", pool: movies } ]
  thu: [ { at: "08:00", pool: sitcoms, link: a }, { at: "20:00", pool: movies } ]
  fri: [ { at: "08:00", pool: sitcoms, link: a }, { at: "20:00", pool: movies } ]
  sat: [ { at: "08:00", pool: sitcoms, link: a }, { at: "20:00", pool: movies } ]
`;

describe('the command line', () => {
  let dir: string;
  let fake: FakeTunarr;
  let out: string[];
  let errs: string[];
  const run = (...args: string[]) =>
    runCli([...args, '--tunarr', 'http://tunarr.test', '--db', join(dir, 'd.db')], {
      clock: { now: () => NOW }, out: (l) => out.push(l), err: (l) => errs.push(l), env: {}, fetch: fake.fetch,
    });
  const said = () => out.join('\n');

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'daytuner-cli-'));
    writeFileSync(join(dir, 'test.yaml'), YAML);
    out = [];
    errs = [];
    const startTime = NOW - 10 * DAY;
    fake = new FakeTunarr({
      shows: [{ id: 'show-a', title: 'Show A', episodes: Array.from({ length: 300 }, (_, i) => ({ id: `ep${i + 1}`, title: `Ep ${i + 1}`, duration: 22 * MIN + 1000, season: 1 + Math.floor(i / 20), episode: (i % 20) + 1 })) }],
      movies: Array.from({ length: 12 }, (_, i) => ({ id: `mov${i}`, title: `Movie ${i}`, duration: (85 + i * 2) * MIN, genres: ['Comedy'] })),
      fillerLists: [
        { id: 'fl-ads', name: 'Ads', clips: Array.from({ length: 40 }, (_, i) => ({ id: `ad${i}`, duration: 15_000 + (i % 7) * 1000 + i * 13 })) },
        { id: 'fl-fill', name: 'Fillers', clips: Array.from({ length: 10 }, (_, i) => ({ id: `fl${i}`, duration: 180_000 + i * 1000 })) },
      ],
      channel: { id: 'chan-1', number: 1, name: 'Test', startTime },
      lineup: [{ type: 'flex', duration: NOW + 3 * DAY - startTime }],
    });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('adds a channel, shows it, and runs a dry run that writes nothing', async () => {
    expect(await run('channel', 'add', join(dir, 'test.yaml'), '--seed', '5')).toBe(0);
    expect(said()).toContain('Added channel "Test"');
    expect(await run('channel', 'list')).toBe(0);
    expect(said()).toContain('Test  (Tunarr chan-1)');
    out.length = 0;
    expect(await run('run', 'Test')).toBe(0);
    expect(said()).toContain('Would append (dry run, nothing was written)');
    expect(said()).toContain('Add --yes');
    expect(fake.lineup).toHaveLength(1);
    expect(fake.requests.some((r) => r.startsWith('POST /api/channels'))).toBe(false);
  });

  it('appends with --yes, then has nothing left to do', async () => {
    await run('channel', 'add', join(dir, 'test.yaml'));
    out.length = 0;
    expect(await run('run', 'Test', '--yes')).toBe(0);
    expect(said()).toMatch(/Appended: \d+ slots/);
    expect(fake.lineup.length).toBeGreaterThan(500);
    out.length = 0;
    expect(await run('run', 'Test', '--yes')).toBe(0);
    expect(said()).toContain('Nothing to do');
    out.length = 0;
    expect(await run('channel', 'status', 'Test')).toBe(0);
    expect(said()).toContain('The store and Tunarr agree');
    expect(said()).toMatch(/commit 1 done/);
  });

  it('rewinds a show after a missed week and says what it affects', async () => {
    await run('channel', 'add', join(dir, 'test.yaml'));
    await run('run', 'Test', '--yes');
    out.length = 0;
    expect(await run('cursor', 'Test', 'list')).toBe(0);
    const before = /next episode (\d+) of 300/.exec(said());
    expect(before).not.toBeNull();
    out.length = 0;
    expect(await run('cursor', 'Test', 'rewind', 'seq:a', '2')).toBe(0);
    expect(said()).toContain(`was ${before![1]}, now ${Number(before![1]) - 2}`);
    expect(said()).toContain('already in Tunarr stays as it is');
    out.length = 0;
    await run('channel', 'status', 'Test');
    expect(said()).toContain('adjustment 1: seq:a rewind 2');
  });

  it('stops and writes nothing when the channel was changed outside DayTuner', async () => {
    await run('channel', 'add', join(dir, 'test.yaml'));
    fake.appendExternally([{ type: 'flex', duration: 5 * MIN }]);
    const before = fake.lineup.length;
    expect(await run('run', 'Test', '--yes')).toBe(3);
    expect(errs.join('\n')).toContain('Stopped, nothing was written');
    expect(fake.lineup).toHaveLength(before);
    out.length = 0;
    await run('channel', 'status', 'Test');
    expect(said()).toContain('WARNING');
  });

  it('recovers with resync after the channel was changed outside DayTuner', async () => {
    await run('channel', 'add', join(dir, 'test.yaml'));
    fake.appendExternally([{ type: 'flex', duration: 5 * MIN }]);
    expect(await run('run', 'Test', '--yes')).toBe(3);
    out.length = 0;
    expect(await run('channel', 'resync', 'Test')).toBe(0); // a dry run
    expect(said()).toContain('Would do: record');
    expect(said()).toContain('dry run');
    expect(await run('run', 'Test', '--yes')).toBe(3);
    out.length = 0;
    expect(await run('channel', 'resync', 'Test', '--yes')).toBe(0);
    expect(said()).toContain('Done: record');
    expect(said()).toContain('may no longer match');
    out.length = 0;
    expect(await run('run', 'Test', '--yes')).toBe(0);
    expect(said()).toMatch(/Appended: \d+ slots/);
  });

  it('lists commits and shows why one is pending', async () => {
    await run('channel', 'add', join(dir, 'test.yaml'));
    fake.corruptNextAppend = true;
    expect(await run('run', 'Test', '--yes')).toBe(3);
    out.length = 0;
    expect(await run('channel', 'commits', 'Test')).toBe(0);
    expect(said()).toMatch(/commit 1 pending: \d+ slots/);
    expect(said()).toContain('note: verification failed');
    expect(said()).toContain('A commit is pending');
    out.length = 0;
    expect(await run('channel', 'resync', 'Test', '--yes')).toBe(0);
    expect(said()).toContain('differs from the plan');
    out.length = 0;
    await run('channel', 'commits', 'Test');
    expect(said()).toMatch(/commit 1 done/);
  });

  it('shows the places found in an existing lineup when adding, and applies them with --yes', async () => {
    fake.lineup = [...fake.lineup, { type: 'content', id: 'ep7', startOffsetMs: 0, duration: 0 }];
    await run('channel', 'add', join(dir, 'test.yaml'));
    expect(said()).toMatch(/seq:a: the lineup's last one is .*, so next is episode 8 of/);
    expect(said()).toContain('adopt-history Test --yes');
    out.length = 0;
    expect(await run('channel', 'adopt-history', 'Test')).toBe(0);
    expect(said()).toContain('dry run');
    out.length = 0;
    await run('cursor', 'Test', 'list');
    expect(said()).toContain('next episode 1 of');
    out.length = 0;
    expect(await run('channel', 'adopt-history', 'Test', '--yes')).toBe(0);
    expect(said()).toContain('Applied.');
    out.length = 0;
    await run('cursor', 'Test', 'list');
    expect(said()).toContain('next episode 8 of');
  });

  it('keeps revisions of the schedule, shows what changed, and goes back', async () => {
    const original = readFileSync(join(dir, 'test.yaml'), 'utf8');
    await run('channel', 'add', join(dir, 'test.yaml'));
    writeFileSync(join(dir, 'v2.yaml'), original.replace('ratio: { min: 15%', 'ratio: { min: 20%'));
    out.length = 0;
    expect(await run('channel', 'set-schedule', 'Test', join(dir, 'v2.yaml'))).toBe(0);
    expect(said()).toContain('Saved revision 2');
    out.length = 0;
    await run('channel', 'set-schedule', 'Test', join(dir, 'v2.yaml'));
    expect(said()).toContain('unchanged (still revision 2)');
    out.length = 0;
    await run('channel', 'revisions', 'Test');
    expect(said()).toMatch(/revision 1[^\n]*\n\* revision 2/);
    out.length = 0;
    await run('channel', 'diff', 'Test');
    expect(said()).toContain('Revision 1 to revision 2');
    expect(said()).toMatch(/- .*min: 15%/);
    expect(said()).toMatch(/\+ .*min: 20%/);
    out.length = 0;
    expect(await run('channel', 'rollback', 'Test', '1')).toBe(0);
    expect(said()).toContain('Revision 1 of "Test" is now current');
    out.length = 0;
    await run('channel', 'revisions', 'Test');
    expect(said()).toMatch(/\* revision 1[^\n]*\n  revision 2/);
    expect(await run('channel', 'rollback', 'Test', '7')).not.toBe(0);
  });

  it('stages a range, shows it, and clears it, without writing to Tunarr', async () => {
    await run('channel', 'add', join(dir, 'test.yaml'));
    const before = fake.lineup.length;
    out.length = 0;
    expect(await run('stage', 'Test', 'generate', '--to', '2026-11-20', '--keep', '2026-11-18..2026-11-20')).toBe(0);
    expect(said()).toMatch(/Staged \d+ slot/);
    out.length = 0;
    expect(await run('stage', 'Test', 'show')).toBe(0);
    expect(said()).toMatch(/2026-11-1[89] \d\d:\d\d to 2026-11-\d\d \d\d:\d\d/);
    expect(said()).not.toContain('Nothing is staged');
    expect(fake.lineup).toHaveLength(before);
    out.length = 0;
    expect(await run('stage', 'Test', 'lock', '2026-11-18T08:00')).toBe(0);
    expect(said()).toContain('Locked the slot starting 2026-11-18 08:00');
    out.length = 0;
    await run('stage', 'Test', 'show');
    expect(said()).toMatch(/2026-11-18 08:00 to [^\n]*\[locked\]/);
    out.length = 0;
    expect(await run('stage', 'Test', 'generate', '--to', '2026-11-20', '--keep', '2026-11-18..2026-11-20')).toBe(0);
    out.length = 0;
    await run('stage', 'Test', 'show');
    expect(said()).toMatch(/2026-11-18 08:00 to [^\n]*\[locked\]/); // generating again kept the locked slot
    out.length = 0;
    expect(await run('stage', 'Test', 'unlock', '2026-11-18T08:00')).toBe(0);
    expect(await run('stage', 'Test', 'lock', '2026-11-18T08:07')).not.toBe(0);
    out.length = 0;
    expect(await run('stage', 'Test', 'clear')).toBe(0);
    expect(said()).toMatch(/Cleared \d+ staged slot/);
    out.length = 0;
    await run('stage', 'Test', 'show');
    expect(said()).toContain('Nothing is staged');
    expect(await run('stage', 'Test', 'generate')).not.toBe(0);
    expect(await run('stage', 'Test', 'generate', '--to', 'soon')).not.toBe(0);
  });

  it('pins a program to a block, shows it, and removes it', async () => {
    await run('channel', 'add', join(dir, 'test.yaml'));
    await run('stage', 'Test', 'generate', '--to', '2026-11-20', '--keep', '2026-11-18..2026-11-20');
    out.length = 0;
    expect(await run('stage', 'Test', 'pin', '2026-11-18T20:00', '1', 'movie:Movie 3')).toBe(0);
    expect(said()).toContain('Pinned Movie 3 to block 1');
    expect(said()).toContain('The pin holds.');
    out.length = 0;
    await run('stage', 'Test', 'show');
    expect(said()).toMatch(/2026-11-18 20:00 to [^\n]*pinned: block 1 = Movie 3/);
    out.length = 0;
    expect(await run('stage', 'Test', 'pin', '2026-11-18T20:00', '2', 'movie:Nonexistent')).not.toBe(0);
    expect(errs.join('\n')).toContain('no movie titled');
    out.length = 0;
    expect(await run('stage', 'Test', 'unpin', '2026-11-18T20:00', '1')).toBe(0);
    await run('stage', 'Test', 'show');
    expect(said()).not.toContain('pinned:');
  });

  it('shows in `stage show` what the next commit would find wrong', async () => {
    await run('channel', 'add', join(dir, 'test.yaml'));
    await run('stage', 'Test', 'generate', '--to', '2026-11-20', '--keep', '2026-11-18..2026-11-20');
    await run('stage', 'Test', 'lock', '2026-11-18T20:00');
    out.length = 0;
    await run('stage', 'Test', 'show');
    expect(said()).not.toContain('CONFLICT');
    for (const m of fake.data.movies) m.duration += 1000; // the library changed under the locked slot
    out.length = 0;
    await run('stage', 'Test', 'show');
    expect(said()).toMatch(/2026-11-18 20:00 to [^\n]*\[locked\][^\n]*\n    CONFLICT \(duration-changed\)/);
  });

  it('deletes, resizes and adds staged slots, and shows the shaped result', async () => {
    await run('channel', 'add', join(dir, 'test.yaml'));
    await run('stage', 'Test', 'generate', '--to', '2026-11-21', '--keep', '2026-11-18..2026-11-21');
    out.length = 0;
    expect(await run('stage', 'Test', 'delete', '2026-11-18T20:00')).toBe(0);
    expect(said()).toContain('the slot before it now runs through its time');
    out.length = 0;
    await run('stage', 'Test', 'show');
    expect(said()).toMatch(/2026-11-18 08:00 to 2026-11-19 08:00[^\n]*\[shaped\]/);
    expect(said()).not.toContain('2026-11-18 20:00 to');
    out.length = 0;
    expect(await run('stage', 'Test', 'add', '2026-11-19T10:00', '--end', '2026-11-19T11:00', 'episode:Show A/Ep 9')).toBe(0);
    expect(said()).toContain('Added a slot from 2026-11-19 10:00 to 2026-11-19 11:00 with Show A "Ep 9" pinned to block 1');
    out.length = 0;
    await run('stage', 'Test', 'show');
    expect(said()).toMatch(/2026-11-19 10:00 to 2026-11-19 11:00 +added[^\n]*pinned: block 1 = Show A "Ep 9"/);
    expect(said()).toMatch(/2026-11-19 11:00 to 2026-11-19 20:00[^\n]*\[shaped\]/);
    out.length = 0;
    expect(await run('stage', 'Test', 'resize', '2026-11-19T08:00', '--end', '2026-11-19T10:07')).not.toBe(0);
    expect(errs.join('\n')).toContain('grid');
    expect(await run('stage', 'Test', 'resize', '2026-11-19T08:00', '--end', '2026-11-19T09:00')).toBe(0);
    out.length = 0;
    await run('stage', 'Test', 'show');
    expect(said()).toMatch(/2026-11-19 08:00 to 2026-11-19 09:00/);
    expect(said()).toMatch(/2026-11-19 09:00 to 2026-11-19 11:00 +added/); // the freed hour went to the slot after it
  });

  it('shows what an edit changed, what staging changes overall, and checks a new schedule against locked slots', async () => {
    await run('channel', 'add', join(dir, 'test.yaml'));
    await run('stage', 'Test', 'generate', '--to', '2026-11-21', '--keep', '2026-11-18..2026-11-21');
    out.length = 0;
    await run('stage', 'Test', 'diff');
    expect(said()).toContain('no slot changed');
    out.length = 0;
    await run('stage', 'Test', 'delete', '2026-11-18T20:00');
    expect(said()).toMatch(/Changed by this edit \(\d+ slots?\):/);
    expect(said()).toMatch(/\[removed\]/);
    expect(said()).toMatch(/ends: +2026-11-18 20:00 -> 2026-11-19 08:00/);
    out.length = 0;
    await run('stage', 'Test', 'diff');
    expect(said()).toContain('What staging changes compared with planning the schedule fresh');
    out.length = 0;

    await run('stage', 'Test', 'lock', '2026-11-19T20:00');
    const moved = YAML.replaceAll('at: "20:00"', 'at: "21:00"');
    writeFileSync(join(dir, 'moved.yaml'), moved);
    out.length = 0;
    expect(await run('channel', 'set-schedule', 'Test', join(dir, 'moved.yaml'))).toBe(0);
    expect(said()).toContain('CONFLICT: the locked slot at 2026-11-19 20:00 no longer fits (window-changed)');
    expect(said()).toContain('Nothing was saved');
    out.length = 0;
    await run('channel', 'revisions', 'Test');
    expect(said()).not.toContain('revision 2');
    out.length = 0;
    expect(await run('channel', 'set-schedule', 'Test', join(dir, 'moved.yaml'), '--yes')).toBe(0);
    expect(said()).toContain('Saved revision 2');
  });

  it('previews without a store', async () => {
    expect(await run('preview', join(dir, 'test.yaml'), '--days', '2', '--from', '2026-11-09T00:00:00Z')).toBe(0);
    expect(said()).toContain('grid accuracy');
    expect(fake.lineup).toHaveLength(1); // a preview never writes
  });

  it('explains itself on a mistake', async () => {
    expect(await run('nonsense')).toBe(2);
    expect(errs.join('\n')).toContain('Usage:');
    errs.length = 0;
    expect(await run('run', 'Ghost')).toBe(3);
    expect(errs.join('\n')).toContain('no channel named');
  });
});
