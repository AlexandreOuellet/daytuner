import { describe, expect, it } from 'vitest';
import { episodes, fixtureLibrary, fixtureSchedule, freshState, local, MONDAY_18, TUESDAY_00, ZONE } from './fixtures.js';
import { plan } from './plan.js';
import type { Item, PlanResult, Schedule } from './schedule.js';
import { HOUR, MINUTE, SECOND } from './time.js';

const library = fixtureLibrary();
const GOLDEN_PROGRAMS: string[][] = [['ep1', 'ep2', 'ep3', 'ep4'], ['m4'], ['ep2', 'ep3', 'ep4']];
const GOLDEN_FINGERPRINT = '40a79fc4';
const run = (over: { schedule?: Schedule; state?: ReturnType<typeof freshState>; from?: number; to?: number; exact?: boolean } = {}): PlanResult =>
  plan({
    schedule: over.schedule ?? fixtureSchedule(),
    library,
    state: over.state ?? freshState(),
    from: over.from ?? MONDAY_18,
    to: over.to ?? TUESDAY_00,
    ...(over.exact ? { exact: true } : {}),
  });

const sum = (items: readonly Item[]) => items.reduce((a, i) => a + i.duration, 0);
const contentOf = (items: readonly Item[]) => items.filter((i) => i.kind === 'content');

/** Facts that must hold for every planned slot, whatever the schedule. */
function expectSound(result: PlanResult, from: number): void {
  let t = from;
  for (const s of result.slots) {
    expect(s.start).toBe(t);
    expect(sum(s.items)).toBe(s.end - s.start);
    for (const i of s.items) {
      expect(Number.isInteger(i.duration)).toBe(true);
      expect(i.duration).toBeGreaterThan(0);
    }
    const played = contentOf(s.items).reduce((a, i) => a + i.duration, 0);
    const expected = s.programs.reduce((a, id) => a + library.programs[id]!.duration, 0);
    expect(played).toBe(expected);
    t = s.end;
  }
}

describe('plan: a Monday evening', () => {
  const result = run();

  it('plans the three slots back to back, each adding up to its window', () => {
    expect(result.slots.map((s) => s.slotId)).toEqual([`1@${18 * HOUR}`, `1@${20 * HOUR}`, `1@${22 * HOUR + 15 * MINUTE}`]);
    expect(result.slots[0]!.start).toBe(MONDAY_18);
    expect(result.slots[2]!.end).toBe(TUESDAY_00);
    expectSound(result, MONDAY_18);
  });

  it('fills the 18:00 slot with the first four episodes, one per half hour', () => {
    expect(result.slots[0]!.programs).toEqual(episodes(4));
    expect(result.state.sequences['seq:office']).toEqual({ position: 4, history: 4, last: 'ep4' });
  });

  it('picks a movie that fits the 20:00 slot from the shuffled pool', () => {
    const programs = result.slots[1]!.programs;
    expect(programs).toHaveLength(1);
    expect(['m1', 'm2', 'm3', 'm4', 'm5']).toContain(programs[0]);
    expect(result.slots[1]!.end - result.slots[1]!.start).toBe(2 * HOUR + 15 * MINUTE);
  });

  it('replays the episodes just behind the head in the rerun slot, oldest first, without moving it', () => {
    const rerun = result.slots[2]!;
    // 1h45 holds three half-hour blocks: the three episodes before the head (position 4).
    expect(rerun.programs).toEqual(['ep2', 'ep3', 'ep4']);
    expect(result.state.sequences['seq:office']).toEqual({ position: 4, history: 4, last: 'ep4' });
  });

  it('splits each program at its mid breaks and breaks it with ads', () => {
    const first = result.slots[0]!;
    const pieces = contentOf(first.items).filter((i) => i.kind === 'content' && i.programId === 'ep1');
    expect(pieces.length).toBeGreaterThanOrEqual(2);
    expect(first.items.some((i) => i.kind === 'filler' && i.position === 'mid')).toBe(true);
  });

  it('is deterministic: the same inputs give the same lineup, and a different seed does not', () => {
    expect(run()).toEqual(result);
    const other = run({ state: freshState(99) });
    expect(JSON.stringify(other.slots)).not.toBe(JSON.stringify(result.slots));
  });

  it('continues the order where it stopped when planning resumes', () => {
    const next = run({ state: result.state, from: local(2026, 11, 16, 18), to: local(2026, 11, 16, 20) });
    expect(next.slots[0]!.programs).toEqual(['ep5', 'ep6', 'ep7', 'ep8']);
  });

  it('does not change the state it was given', () => {
    const state = freshState();
    const before = JSON.stringify(state);
    run({ state });
    expect(JSON.stringify(state)).toBe(before);
  });
});

describe('plan: golden', () => {
  /** A short fingerprint of a whole lineup (FNV-1a over its JSON). */
  const fingerprint = (r: PlanResult): string => {
    let h = 0x811c9dc5;
    const text = JSON.stringify(r.slots);
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16);
  };

  it('pins the Monday evening for seed 7', () => {
    const r = run();
    expect(r.slots.map((s) => s.programs)).toEqual(GOLDEN_PROGRAMS);
    expect(fingerprint(r)).toBe(GOLDEN_FINGERPRINT);
  });
});

describe('plan: a rerun with too little history', () => {
  it('warns and fills the slot when nothing has aired', () => {
    const r = plan({
      schedule: fixtureSchedule(), library, state: freshState(),
      from: local(2026, 11, 9, 22, 15), to: TUESDAY_00,
    });
    expect(r.slots[0]!.programs).toEqual([]);
    expect(r.warnings.some((w) => w.code === 'rerun-short-history' && w.severity === 'alert')).toBe(true);
    expectSound(r, local(2026, 11, 9, 22, 15));
  });

  it('plays what has aired and fills the rest', () => {
    const state = freshState();
    state.sequences['seq:office'] = { position: 1, history: 1 };
    const r = plan({ schedule: fixtureSchedule(), library, state, from: local(2026, 11, 9, 22, 15), to: TUESDAY_00 });
    expect(r.slots[0]!.programs).toEqual(['ep1']);
    expect(r.warnings.some((w) => w.code === 'rerun-short-history')).toBe(true);
    expectSound(r, local(2026, 11, 9, 22, 15));
  });
});

describe('plan: exceptions', () => {
  const withException = (programId: string, counts?: string | false): Schedule =>
    fixtureSchedule({ exceptions: [{ on: { month: 11, day: 9 }, at: 20 * HOUR, programId, ...(counts !== undefined ? { counts } : {}) }] });

  it('replaces the slot at that time and counts the pick against the shuffled pool', () => {
    const r = run({ schedule: withException('m2') });
    expect(r.slots[1]!.exception).toBe(true);
    expect(r.slots[1]!.programs).toEqual(['m2']);
    expect(r.state.bags['pool:movies']!.remaining).not.toContain('m2');
    expectSound(r, MONDAY_18);
  });

  it('can be told not to count', () => {
    const r = run({ schedule: withException('m2', false) });
    expect(r.state.bags['pool:movies']?.remaining ?? []).not.toContain('m2');
    expect(r.slots[1]!.programs).toEqual(['m2']);
  });

  it('applies to every year when no year is given, and to one year when it is', () => {
    const oneYear = fixtureSchedule({ exceptions: [{ on: { month: 11, day: 9, year: 2027 }, at: 20 * HOUR, programId: 'm2' }] });
    expect(run({ schedule: oneYear }).slots[1]!.exception).toBe(false);
  });

  it('warns and plans the slot as usual when the program does not fit', () => {
    const r = run({ schedule: withException('epic') });
    expect(r.slots[1]!.exception).toBe(false);
    expect(r.slots[1]!.programs).not.toContain('epic');
    expect(r.warnings.some((w) => w.code === 'exception-does-not-fit' && w.severity === 'alert')).toBe(true);
    expectSound(r, MONDAY_18);
  });

  it('leaves the order of an ordered show alone', () => {
    const s = fixtureSchedule({ exceptions: [{ on: { month: 11, day: 9 }, at: 18 * HOUR, programId: 'm4' }] });
    const r = run({ schedule: s });
    expect(r.slots[0]!.programs).toEqual(['m4']);
    expect(r.state.sequences['seq:office']).toBeUndefined();
  });
});

describe('plan: an exception that matches no slot', () => {
  const ex = (at: number, on: { month: number; day: number; year?: number }): Schedule =>
    fixtureSchedule({ exceptions: [{ on, at, programId: 'm2' }] });

  it('warns when it falls in the planned range and no slot starts then', () => {
    const r = run({ schedule: ex(19 * HOUR, { month: 11, day: 9 }) }); // slots start at 18:00 and 20:00
    expect(r.warnings.filter((w) => w.code === 'exception-matches-no-slot')).toHaveLength(1);
    expect(r.slots[1]!.exception).toBe(false);
  });
  it('stays quiet when a slot starts then, or when the date is outside the range', () => {
    expect(run({ schedule: ex(20 * HOUR, { month: 11, day: 9 }) }).warnings.some((w) => w.code === 'exception-matches-no-slot')).toBe(false);
    expect(run({ schedule: ex(19 * HOUR, { month: 12, day: 25 }) }).warnings.some((w) => w.code === 'exception-matches-no-slot')).toBe(false);
    expect(run({ schedule: ex(19 * HOUR, { month: 11, day: 9, year: 2031 }) }).warnings.some((w) => w.code === 'exception-matches-no-slot')).toBe(false);
  });
});

describe('plan: anchors and windows', () => {
  it('cuts the window that contains the anchor and ends exactly there', () => {
    const anchor = local(2026, 11, 9, 21);
    const r = run({ to: anchor, exact: true });
    expect(r.slots[r.slots.length - 1]!.end).toBe(anchor);
    expect(r.slots[r.slots.length - 1]!.programs).not.toContain('m3'); // 117 minutes cannot fit 1 hour
    expectSound(r, MONDAY_18);
  });

  it('plans only the rest of a slot when starting inside it', () => {
    const r = run({ from: local(2026, 11, 9, 19), to: local(2026, 11, 9, 20) });
    expect(r.slots[0]!.start).toBe(local(2026, 11, 9, 19));
    expect(r.warnings.some((w) => w.code === 'started-mid-slot')).toBe(true);
    expectSound(r, local(2026, 11, 9, 19));
  });

  it('plans nothing for an empty range', () => {
    expect(run({ from: MONDAY_18, to: MONDAY_18 }).slots).toEqual([]);
  });

  it('handles the daylight-saving days: 23 and 25 hours', () => {
    const daily = fixtureSchedule({ week: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, at: 0, pool: 'movies' })) });
    const spring = plan({ schedule: daily, library, state: freshState(), from: local(2026, 3, 7), to: local(2026, 3, 10) });
    expect(spring.slots.map((s) => (s.end - s.start) / HOUR)).toEqual([24, 23, 24]);
    expectSound(spring, local(2026, 3, 7));
    const fall = plan({ schedule: daily, library, state: freshState(), from: local(2026, 10, 31), to: local(2026, 11, 3) });
    expect(fall.slots.map((s) => (s.end - s.start) / HOUR)).toEqual([24, 25, 24]);
    expectSound(fall, local(2026, 10, 31));
  });
});

describe('plan: head, tail and bumpers', () => {
  const rich = (): Schedule => fixtureSchedule({
    ads: {
      step: 15 * SECOND,
      ratio: { min: 0.15, max: 0.6 },
      head: { list: 'Old Ads', range: { min: 0, max: MINUTE } },
      pre: { list: 'Old Ads', range: { min: 0, max: MINUTE } },
      mid: { list: 'Old Ads', range: { min: 2 * MINUTE, max: 3 * MINUTE }, offers: { every: 8 * MINUTE, tailBuffer: MINUTE } },
      post: { list: 'Old Ads', range: { min: 0, max: 5 * MINUTE } },
      tail: { list: 'Old Ads', range: { min: 0, max: 25 * MINUTE } },
    },
    bumpers: { head: { list: 'Idents' }, pre: { list: 'Idents' }, post: { list: 'Idents' }, tail: { list: 'Idents' } },
  });

  it('starts with the head bumper, ends with the tail bumper, and adds up exactly', () => {
    const r = run({ schedule: rich() });
    expectSound(r, MONDAY_18);
    for (const s of r.slots.filter((x) => x.programs.length > 0)) {
      const first = s.items[0]!;
      const last = s.items[s.items.length - 1]!;
      expect(first.kind === 'filler' && first.role === 'bumper' && first.position === 'head').toBe(true);
      expect(last.kind === 'filler' && last.role === 'bumper' && last.position === 'tail').toBe(true);
    }
  });

  it('puts the pre bumper right before the program and the post bumper right after it', () => {
    const s = run({ schedule: rich() }).slots[1]!;
    const firstContent = s.items.findIndex((i) => i.kind === 'content');
    const before = s.items[firstContent - 1]!;
    expect(before.kind === 'filler' && before.role === 'bumper' && before.position === 'pre').toBe(true);
    const lastContent = s.items.map((i) => i.kind).lastIndexOf('content');
    const after = s.items[lastContent + 1]!;
    expect(after.kind === 'filler' && after.role === 'bumper' && after.position === 'post').toBe(true);
  });
});

describe('plan: dead air warnings', () => {
  it('stay quiet about a few seconds, which whole clips make unavoidable, and flag real gaps', () => {
    const r = run();
    const flex = r.slots.flatMap((s) => s.items).filter((i) => i.kind === 'flex');
    expect(flex.length).toBeGreaterThan(0); // dead air exists...
    for (const w of r.warnings.filter((x) => x.code === 'dead-air')) {
      expect(Number(/(\d+) s of dead air/.exec(w.message)![1])).toBeGreaterThanOrEqual(15); // ...but only 15 s or more warns
    }
    const empty = plan({ schedule: fixtureSchedule({ pools: { office: { order: 'ordered', programs: ['epic'] }, movies: { order: 'shuffled', programs: ['m1'] } } }), library, state: freshState(), from: local(2026, 11, 9, 18), to: local(2026, 11, 9, 20) });
    expect(empty.warnings.some((w) => w.code === 'nothing-fits' && w.severity === 'alert')).toBe(true);
  });
});

describe('plan: a show whose list changes', () => {
  const lib = fixtureLibrary();
  lib.programs['ep1b'] = { duration: 22 * MINUTE + 17 * SECOND + 431 };
  const list = ['ep1', 'ep1b', ...episodes(12).slice(1)];
  const withList = (programs: string[]) => fixtureSchedule({ pools: { office: { order: 'ordered', programs }, movies: { order: 'shuffled', programs: ['m1', 'm2', 'm3'] } } });
  const first = (state: ReturnType<typeof freshState>, programs: string[]) =>
    plan({ schedule: withList(programs), library: lib, state, from: MONDAY_18, to: TUESDAY_00 });

  it('plays an episode that arrived behind the place before the one after it, when nothing later was taken', () => {
    const state = freshState();
    state.sequences['seq:office'] = { position: 1, history: 1, last: 'ep1' };
    const r = first(state, list);
    expect(r.slots[0]!.programs.slice(0, 2)).toEqual(['ep1b', 'ep2']);
    expect(r.warnings.some((w) => w.code === 'place-moved')).toBe(false);
  });

  it('does not play an episode again when one arrived behind an episode that was already taken, and says so', () => {
    const state = freshState();
    state.sequences['seq:office'] = { position: 2, history: 2, last: 'ep2' }; // the list was [ep1, ep2, ep3, ...]
    const r = first(state, list);
    expect(r.slots[0]!.programs[0]).toBe('ep3');
    expect(r.warnings.filter((w) => w.code === 'place-moved')).toHaveLength(1);
    expect(r.state.sequences['seq:office']!.last).not.toBe('ep2');
  });

  it('keeps the number and warns when the last episode is no longer in the list', () => {
    const state = freshState();
    state.sequences['seq:office'] = { position: 2, history: 2, last: 'gone' };
    const r = first(state, list);
    expect(r.slots[0]!.programs[0]).toBe(list[2]);
    expect(r.warnings.some((w) => w.code === 'place-lost')).toBe(true);
  });

  it('works as before for a store that has no last episode yet', () => {
    const state = freshState();
    state.sequences['seq:office'] = { position: 2, history: 2 };
    expect(first(state, list).slots[0]!.programs[0]).toBe(list[2]);
  });
});

describe('plan: repeats', () => {
  it('says so when a shuffled pool shows a program again because nothing left in its round fit', () => {
    const week = fixtureSchedule({ week: [{ day: 0, at: 10 * HOUR, pool: 'movies' }, { day: 1, at: 20 * HOUR, pool: 'movies' }] });
    const found = new Set<string>();
    for (let seed = 1; seed <= 40; seed++) {
      const r = plan({ schedule: week, library, state: freshState(seed), from: local(2026, 11, 8, 10), to: local(2026, 11, 29, 10) });
      for (const w of r.warnings.filter((x) => x.code === 'repeat-pick')) { expect(w.severity).toBe('info'); found.add(w.message); }
    }
    expect(found.size).toBeGreaterThan(0);
  }, 60_000);
});

describe('plan: any seed, any day', () => {
  it('is always sound over many seeds and a week of windows', () => {
    const week = fixtureSchedule({
      week: [
        { day: 0, at: 10 * HOUR, pool: 'movies' },
        { day: 1, at: 18 * HOUR, pool: 'office', link: { name: 'office', mode: 'continue' } },
        { day: 1, at: 20 * HOUR, pool: 'movies' },
        { day: 3, at: 9 * HOUR + 45 * MINUTE, pool: 'office', link: { name: 'office', mode: 'rerun' } },
        { day: 5, at: 21 * HOUR, pool: 'movies' },
      ],
    });
    for (let seed = 1; seed <= 6; seed++) {
      const from = local(2026, 11, 8, 10);
      const to = local(2026, 11, 22, 10);
      const r = plan({ schedule: week, library, state: freshState(seed), from, to });
      expectSound(r, from);
      expect(r.slots.length).toBeGreaterThan(8);
      const again = plan({ schedule: week, library, state: freshState(seed), from, to });
      expect(again).toEqual(r);
    }
  }, 30_000);
});

describe('plan: bad input', () => {
  it('rejects an unknown pool, list or program, and a slot off the grid', () => {
    expect(() => run({ schedule: fixtureSchedule({ week: [{ day: 1, at: 0, pool: 'nope' }] }) })).toThrow(RangeError);
    expect(() => run({ schedule: fixtureSchedule({ interstitial: { list: 'Nope' } }) })).toThrow(RangeError);
    expect(() => run({ schedule: fixtureSchedule({ pools: { movies: { order: 'shuffled', programs: ['ghost'] } }, week: [{ day: 1, at: 0, pool: 'movies' }] }) })).toThrow(RangeError);
    expect(() => run({ schedule: fixtureSchedule({ week: [{ day: 1, at: 7 * MINUTE, pool: 'movies' }] }) })).toThrow(RangeError);
    expect(() => run({ schedule: fixtureSchedule({ zone: 'Mars/Olympus' }) })).toThrow(RangeError);
  });

  it('plans nothing, without failing, for a schedule that has no slots yet', () => {
    const r = run({ schedule: { ...fixtureSchedule(), week: [] } });
    expect(r.slots).toEqual([]);
  });
});

void ZONE;
