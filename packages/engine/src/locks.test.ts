import { describe, expect, it } from 'vitest';
import { fixtureLibrary, fixtureSchedule, freshState, local, MONDAY_18, TUESDAY_00 } from './fixtures.js';
import { plan } from './plan.js';
import type { Library, PlanState, PlannedSlot, Schedule } from './schedule.js';

const run = (over: { schedule?: Schedule; library?: Library; state?: PlanState; locked?: PlannedSlot[]; from?: number; to?: number } = {}) =>
  plan({
    schedule: over.schedule ?? fixtureSchedule(),
    library: over.library ?? fixtureLibrary(),
    state: over.state ?? freshState(),
    from: over.from ?? MONDAY_18,
    to: over.to ?? TUESDAY_00,
    ...(over.locked ? { locked: over.locked } : {}),
  });

describe('locked slots', () => {
  const base = run();
  const [office, movie, rerun] = base.slots as [PlannedSlot, PlannedSlot, PlannedSlot];

  it('are used exactly as stored, even when planning from a different state would differ', () => {
    const other = run({ state: freshState(99), locked: [movie] });
    expect(other.slots[1]).toBe(movie);
    expect(other.conflicts).toEqual([]);
    expect(run({ state: freshState(99) }).slots[1]).not.toEqual(movie);
  });

  it('leave the slots around them planned normally and the day without a hole', () => {
    const r = run({ locked: [movie] });
    expect(r.slots.map((s) => [s.start, s.end])).toEqual(base.slots.map((s) => [s.start, s.end]));
    for (const s of r.slots) expect(s.items.reduce((a, i) => a + i.duration, 0)).toBe(s.end - s.start);
  });

  it('move an ordered show on as planning the slot would have', () => {
    const withLock = run({ locked: [office] });
    expect(withLock.state.sequences).toEqual(base.state.sequences);
    // The rerun slot after it replays what the locked slot aired.
    expect(withLock.slots[2]!.programs).toEqual(rerun.programs);
  });

  it('count a block pinned to another program (a rerun) as taking nothing from the show, as planning it does', () => {
    expect(office.blocks.length).toBeGreaterThan(1);
    const pinned: PlannedSlot = { ...office, blocks: office.blocks.map((b, i) => (i === 0 ? { ...b, programId: 'a-rerun', pinned: true as const } : b)) };
    const withPin = run({ locked: [pinned] }).state.sequences;
    for (const [key, seq] of Object.entries(base.state.sequences)) {
      const mine = withPin[key]!;
      if (seq.position === mine.position) continue; // a show this slot does not draw from
      expect(mine.position).toBe(seq.position - 1);
    }
    expect(JSON.stringify(withPin)).not.toBe(JSON.stringify(base.state.sequences));
  });

  it('say so when the list of an ordered show changed under the place they meet first (the later slots would find it corrected and say nothing)', () => {
    const key = Object.keys(base.state.sequences)[0]!;
    const list = fixtureSchedule().pools[office.pool]!.programs;
    // The place says 5, but the last episode taken sits at 2: the list changed behind it.
    const stale: PlanState = { ...freshState(), sequences: { ...freshState().sequences, [key]: { position: 5, history: 5, last: list[2]! } } };
    const r = run({ state: stale, locked: [office], to: office.end });
    expect(r.warnings.filter((w) => w.code === 'place-moved')).toHaveLength(1);
    // and only once: a second slot of the same show finds the place corrected
    const again = run({ state: stale, to: office.end });
    expect(again.warnings.filter((w) => w.code === 'place-moved')).toHaveLength(1);
  });

  it('mark their clips as drawn, so the next slot does not take them at once', () => {
    const state: PlanState = { ...freshState(), bags: { 'clips:Old Ads': { remaining: Array.from({ length: 40 }, (_, i) => `ad${i}`) } } };
    const r = run({ state, locked: [movie], to: movie.end });
    const used = new Set(movie.items.flatMap((i) => (i.kind === 'filler' && i.list === 'Old Ads' ? [i.clipId] : [])));
    expect(used.size).toBeGreaterThan(0);
    for (const id of r.state.bags['clips:Old Ads']!.remaining) expect(used.has(id)).toBe(false);
  });

  it('are ignored outside the planned range, with no conflict', () => {
    const r = run({ to: local(2026, 11, 9, 20), locked: [movie] });
    expect(r.conflicts).toEqual([]);
    expect(r.slots).toHaveLength(1);
  });
});

describe('a locked slot that no longer fits', () => {
  const base = run();
  const movie = base.slots[1]!;
  const movieId = movie.programs[0]!;

  it('is planned again, with the reason, when a program changed length', () => {
    const library = fixtureLibrary();
    library.programs[movieId] = { duration: library.programs[movieId]!.duration + 1000 };
    const r = run({ library, locked: [movie] });
    expect(r.conflicts).toHaveLength(1);
    expect(r.conflicts[0]).toMatchObject({ reason: 'duration-changed', slotId: movie.slotId, start: movie.start });
    expect(r.warnings.some((w) => w.code === 'locked-slot-conflict' && w.severity === 'alert')).toBe(true);
    expect(r.slots[1]!.items.reduce((a, i) => a + i.duration, 0)).toBe(movie.end - movie.start);
  });

  it('says so when a program is gone', () => {
    const library = fixtureLibrary();
    delete library.programs[movieId];
    const schedule = fixtureSchedule();
    schedule.pools['movies'] = { order: 'shuffled', programs: schedule.pools['movies']!.programs.filter((p) => p !== movieId) };
    const r = run({ library, schedule, locked: [movie] });
    expect(r.conflicts[0]).toMatchObject({ reason: 'program-gone' });
    expect(r.slots[1]!.programs).not.toContain(movieId);
  });

  it('says so when a clip is gone or changed', () => {
    const clip = movie.items.find((i) => i.kind === 'filler' && i.list === 'Old Ads');
    if (clip?.kind !== 'filler') throw new Error('the fixture slot has no ad');
    const gone = fixtureLibrary();
    gone.clips['Old Ads'] = gone.clips['Old Ads']!.filter((c) => c.id !== clip.clipId);
    expect(run({ library: gone, locked: [movie] }).conflicts[0]).toMatchObject({ reason: 'clip-gone' });
    const changed = fixtureLibrary();
    changed.clips['Old Ads'] = changed.clips['Old Ads']!.map((c) => (c.id === clip.clipId ? { ...c, duration: c.duration + 1 } : c));
    expect(run({ library: changed, locked: [movie] }).conflicts[0]).toMatchObject({ reason: 'duration-changed' });
  });

  it('says so when the slot is gone from the schedule, or its window moved', () => {
    const schedule = fixtureSchedule();
    schedule.week = schedule.week.filter((s) => !(s.day === 1 && s.at === 20 * 3_600_000));
    const gone = run({ schedule, locked: [movie] });
    expect(gone.conflicts[0]).toMatchObject({ reason: 'window-changed' });

    const endMoved = fixtureSchedule();
    endMoved.week = endMoved.week.map((s) => (s.day === 1 && s.at === 22 * 3_600_000 + 15 * 60_000 ? { ...s, at: 22 * 3_600_000 } : s));
    expect(run({ schedule: endMoved, locked: [movie] }).conflicts[0]).toMatchObject({ reason: 'window-changed' });
    const shorter = fixtureSchedule();
    shorter.week = shorter.week.map((s) => (s.day === 1 && s.at === 20 * 3_600_000 ? { ...s, at: 19 * 3_600_000 } : s));
    expect(run({ schedule: shorter, locked: [movie] }).conflicts[0]).toMatchObject({ reason: 'window-changed' });
  });

  it('says so when the slot now draws from another pool', () => {
    const schedule = fixtureSchedule();
    schedule.week = schedule.week.map((s) => (s.day === 1 && s.at === 20 * 3_600_000 ? { ...s, pool: 'office', link: { name: 'x', mode: 'continue' as const } } : s));
    expect(run({ schedule, locked: [movie] }).conflicts[0]).toMatchObject({ reason: 'window-changed', message: expect.stringContaining('pool') });
  });
});
