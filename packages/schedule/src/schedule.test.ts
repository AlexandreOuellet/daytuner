import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { plan, emptyPlanState, toLocalForTest } from './testing.js';
import { parseScheduleFile, ScheduleFileError } from './file.js';
import { findProgram, resolveSchedule, ResolveError, same, takeTurns } from './resolve.js';
import { addIds } from './export.js';
import { fakeSource } from './testing.js';

const EXAMPLE = readFileSync(new URL('../../../schedules/example.yaml', import.meta.url), 'utf8');

describe('the example channel file', () => {
  const file = parseScheduleFile(EXAMPLE);

  it('parses', () => {
    expect(file.channel).toBe('the-funny-bone');
    expect(file.timezone).toBe('America/Toronto');
    expect(file.grid).toBe(900_000);
    expect(file.ads.ratio.min).toBeCloseTo(0.15);
    expect(file.ads.mid).toMatchObject({ list: 'Old Ads', every: 480_000, tailBuffer: 60_000, length: { min: 120_000, max: 180_000 } });
    expect(file.ads.post?.length).toEqual({ min: 0, max: 300_000 });
    expect(file.week.sun?.map((s) => s.pool)).toEqual(['office-hours', 'comedy-movies-up-to-117']);
  });

  it('resolves against a library into what the engine takes', async () => {
    const r = await resolveSchedule(file, fakeSource());
    expect(r.schedule.pools['office-hours']!.order).toBe('ordered');
    expect(r.schedule.pools['kids-movies']!.order).toBe('shuffled');
    // Genre and length filters: only comedies of at most 117 minutes.
    expect([...r.schedule.pools['comedy-movies-up-to-117']!.programs].sort()).toEqual(['mov-comedy-100', 'mov-comedy-90']);
    // Head and pre have length 0, so they are not positions at all.
    expect(r.schedule.ads.head).toBeUndefined();
    expect(r.schedule.ads.pre).toBeUndefined();
    expect(r.schedule.ads.tail).toEqual({ list: 'Old Ads', range: { min: 0, max: 1_500_000 } });
    expect(r.fillerListIds['Old Ads']).toBe('fl-ads');
    expect(r.schedule.exceptions).toHaveLength(2);
    expect(r.schedule.exceptions[0]).toMatchObject({ on: { month: 10, day: 31 }, at: 72_000_000 });
    expect(r.library.programs[r.schedule.exceptions[0]!.programId]).toBeDefined();
  });

  it('gives every program a readable title', async () => {
    const r = await resolveSchedule(file, fakeSource());
    expect(r.titles['office-1']).toBe('The Office S1E1 "Episode 1"');
    expect(r.titles['mov-comedy-90']).toBe('Short Laughs');
    for (const id of Object.keys(r.library.programs)) expect(r.titles[id]).toBeTruthy();
  });

  it('plans a Sunday end to end with the engine', async () => {
    const r = await resolveSchedule(file, fakeSource());
    const from = toLocalForTest(2026, 11, 8, 0);
    const result = plan({ schedule: r.schedule, library: r.library, state: emptyPlanState(1), from, to: toLocalForTest(2026, 11, 8, 13) });
    expect(result.slots).toHaveLength(1);
    const s = result.slots[0]!;
    expect(s.items.reduce((a, i) => a + i.duration, 0)).toBe(13 * 3_600_000);
    expect(s.programs.length).toBeGreaterThan(10);
  });
});

describe('title matching', () => {
  it('ignores case, spacing and curly quotes', () => {
    expect(same("Schitt's Creek", 'Schitt\u2019s  creek ')).toBe(true);
    expect(same('The Office', 'the office')).toBe(true);
    expect(same('The Office', 'The Office (US)')).toBe(false);
  });
});

describe('ordered pools of several shows', () => {
  it('take turns, and a show that runs out drops out', () => {
    expect(takeTurns([['a1', 'a2', 'a3'], ['b1'], ['c1', 'c2']])).toEqual(['a1', 'b1', 'c1', 'a2', 'c2', 'a3']);
    expect(takeTurns([])).toEqual([]);
  });

  it('use the turns order in the resolved pool', async () => {
    const r = await resolveSchedule(parseScheduleFile(EXAMPLE), fakeSource());
    expect(r.schedule.pools['office-hours']!.programs.slice(0, 4)).toEqual(['office-1', 'parks-1', 'rock-1', 'office-2']);
  });
});

describe('mistakes are reported clearly', () => {
  const withEdit = (from: string, to: string) => EXAMPLE.replace(from, to);

  it('rejects unknown keys', () => {
    expect(() => parseScheduleFile(withEdit('grid: 15m', 'grid: 15m\ngrdi: 5m'))).toThrow(ScheduleFileError);
  });
  it('says where a bad value is', () => {
    expect(() => parseScheduleFile(withEdit('grid: 15m', 'grid: fifteen'))).toThrow(/grid: .*not a duration/);
  });
  it('rejects a slot that uses an unknown pool', () => {
    expect(() => parseScheduleFile(withEdit('pool: office-hours', 'pool: nope'))).toThrow(/unknown pool "nope"/);
  });
  it('rejects overflow and lateness above zero, which are not supported yet', () => {
    expect(() => parseScheduleFile(withEdit('overflow: 0', 'overflow: 5'))).toThrow(ScheduleFileError);
  });
  it('rejects invalid YAML', () => {
    expect(() => parseScheduleFile('a: [1, 2')).toThrow(/not valid YAML/);
  });
  it('rejects ads in a position with no list', () => {
    expect(() => parseScheduleFile(withEdit('head: { length: 0 }', 'head: { length: 1m }'))).toThrow(/needs a list/);
  });
  it('reports a missing list, show, episode and empty pool when resolving', async () => {
    const file = parseScheduleFile(EXAMPLE);
    await expect(resolveSchedule({ ...file, interstitial: { list: 'Nope' } }, fakeSource())).rejects.toThrow(/no filler list named "Nope"/);
    await expect(resolveSchedule({ ...file, pools: { ...file.pools, 'office-hours': { shows: ['Ghost Show'] } } }, fakeSource())).rejects.toThrow(/no show named "Ghost Show"/);
    await expect(resolveSchedule({ ...file, pools: { ...file.pools, 'kids-movies': { movies: { genre: 'Western' } } } }, fakeSource())).rejects.toThrow(ResolveError);
    const badEx = { ...file, exceptions: [{ ...file.exceptions[0]!, play: { show: 'Doctor Who', title: 'Nope' } }] };
    await expect(resolveSchedule(badEx, fakeSource())).rejects.toThrow(/no episode titled "Nope"/);
  });
});

describe('shows picked by id with a title label', () => {
  const file = parseScheduleFile(EXAMPLE);
  const withShows = (shows: (string | { show: string; id?: string })[]) => ({ ...file, exceptions: [], pools: { ...file.pools, 'office-hours': { shows } } });

  it('a title shared by two shows is an error that lists the ids', async () => {
    await expect(resolveSchedule(withShows(['Doctor Who']), fakeSource({ duplicateWho: true }))).rejects.toThrow(/more than one show named "Doctor Who"; add an id: show-who, show-who-2005/);
  });
  it('an id picks the show and ignores the title', async () => {
    const r = await resolveSchedule(withShows([{ show: 'Doctor Who', id: 'show-who-2005' }]), fakeSource({ duplicateWho: true }));
    expect(r.schedule.pools['office-hours']!.programs[0]).toBe('who2005-1');
    expect(r.notes).toEqual([]);
  });
  it('a label that no longer matches the library only adds a note', async () => {
    const r = await resolveSchedule(withShows([{ show: 'The Office (US)', id: 'show-office' }]), fakeSource());
    expect(r.schedule.pools['office-hours']!.programs[0]).toBe('office-1');
    expect(r.notes).toEqual(['the show with id "show-office" is now titled "The Office", the file labels it "The Office (US)"']);
  });
  it('an unknown id is an error', async () => {
    await expect(resolveSchedule(withShows([{ show: 'The Office', id: 'nope' }]), fakeSource())).rejects.toThrow(/no show with id "nope"/);
  });
  it('exceptions take an id for a show or a movie', async () => {
    const ex = { ...file.exceptions[0]!, play: { show: 'Doctor Who', id: 'show-who-2005', title: 'Halloween Special' } };
    const r = await resolveSchedule({ ...file, exceptions: [ex] }, fakeSource({ duplicateWho: true }));
    expect(r.schedule.exceptions[0]!.programId).toBe('who2005-4');
    const mv = { ...file.exceptions[0]!, play: { movie: 'Old Name', id: 'mov-comedy-90' } };
    const r2 = await resolveSchedule({ ...file, exceptions: [mv] }, fakeSource());
    expect(r2.schedule.exceptions[0]!.programId).toBe('mov-comedy-90');
    expect(r2.notes[0]).toMatch(/now titled "Short Laughs"/);
  });
  it('the channel file accepts both forms', () => {
    const text = EXAMPLE.replace(/shows: \[The Office[^\n]*\]/, 'shows: [The Office, { show: Doctor Who, id: abc }]');
    expect(() => parseScheduleFile(text)).not.toThrow();
  });
});

describe('chapters', () => {
  const file = parseScheduleFile(EXAMPLE);
  const chaptersFor = (id: string) => (id === 'mov-comedy-100' ? [{ start: 0, end: 1_800_000, type: 'chapter' as const }, { start: 1_800_000, end: 6_000_000, type: 'chapter' as const }] : []);

  it('loads chapters for the programs that have them, when the schedule has mid breaks', async () => {
    const asked: string[] = [];
    const r = await resolveSchedule(file, { ...fakeSource(), chapters: async (id) => { asked.push(id); return chaptersFor(id); } });
    expect(r.library.programs['mov-comedy-100']!.chapters).toHaveLength(2);
    expect(r.library.programs['mov-comedy-90']!.chapters).toBeUndefined();
    expect(asked.sort()).toEqual(Object.keys(r.library.programs).sort());
    expect(r.notes).toEqual([]);
  });

  it('asks for none when the schedule has no mid breaks', async () => {
    let calls = 0;
    const noMid = { ...file, ads: { ...file.ads, mid: undefined } };
    await resolveSchedule(noMid, { ...fakeSource(), chapters: async () => { calls++; return []; } });
    expect(calls).toBe(0);
  });

  it('carries on without chapters when some cannot be read, and says so', async () => {
    const r = await resolveSchedule(file, { ...fakeSource(), chapters: async (id) => { if (id === 'mov-comedy-100') throw new Error('boom'); return []; } });
    expect(r.library.programs['mov-comedy-100']).toBeDefined();
    expect(r.notes[0]).toMatch(/chapters could not be read for 1 of \d+ programs/);
  });
});

describe('finding a program by text', () => {
  it('finds a movie or an episode, ignoring case', async () => {
    expect(await findProgram(fakeSource(), 'movie:mid laughs')).toMatchObject({ id: 'mov-comedy-100', title: 'Mid Laughs' });
    expect(await findProgram(fakeSource(), 'episode:the office/Episode 3')).toMatchObject({ id: 'office-3', title: 'The Office "Episode 3"' });
  });
  it('says what was wrong', async () => {
    await expect(findProgram(fakeSource(), 'movie:Nope')).rejects.toThrow(/no movie titled/);
    await expect(findProgram(fakeSource(), 'episode:The Office/Nope')).rejects.toThrow(/no episode titled/);
    await expect(findProgram(fakeSource({ duplicateWho: true }), 'episode:Doctor Who/Halloween Special')).rejects.toThrow(/more than one show/);
    await expect(findProgram(fakeSource(), 'Mid Laughs')).rejects.toThrow(/write movie:Title/);
  });
});

describe('exporting a channel file with ids', () => {
  it('adds the id beside every show and movie title, keeps comments, and the result resolves the same', async () => {
    const out = await addIds(EXAMPLE, fakeSource());
    expect(out).toContain('id: show-office');
    expect(out).toContain('id: show-who'); // the exception's show
    expect(out).toMatch(/# .*/); // comments survive
    const again = parseScheduleFile(out);
    const a = await resolveSchedule(parseScheduleFile(EXAMPLE), fakeSource());
    const b = await resolveSchedule(again, fakeSource());
    expect(b.schedule).toEqual(a.schedule);
    expect(b.notes).toEqual([]);
  });

  it('leaves a title that already has an id, and is stable when run twice', async () => {
    const once = await addIds(EXAMPLE, fakeSource());
    expect(await addIds(once, fakeSource())).toBe(once);
  });

  it('needs the owner to choose between two shows with the same title', async () => {
    await expect(addIds(EXAMPLE, fakeSource({ duplicateWho: true }))).rejects.toThrow(/more than one show titled "Doctor Who".*show-who, show-who-2005/);
  });

  it('says when a title is not in the library, and refuses a file that does not parse', async () => {
    await expect(addIds(EXAMPLE.replace('Parks and Recreation', 'Ghost Show'), fakeSource())).rejects.toThrow(/no show titled "Ghost Show"/);
    await expect(addIds('nonsense: true', fakeSource())).rejects.toThrow(/problems/);
  });
});
