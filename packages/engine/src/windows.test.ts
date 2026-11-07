import { describe, expect, it } from 'vitest';
import { fixtureLibrary, fixtureSchedule, freshState, local, MONDAY_18, TUESDAY_00 } from './fixtures.js';
import { plan } from './plan.js';
import type { PlanResult, StagedWindow } from './schedule.js';

const T = (h: number, m = 0) => local(2026, 11, 9, h, m);
const run = (windows: StagedWindow[], over: { pins?: { start: number; blocks: Record<number, string> }[] } = {}): PlanResult =>
  plan({ schedule: fixtureSchedule(), library: fixtureLibrary(), state: freshState(), from: MONDAY_18, to: TUESDAY_00, windows, ...over });
const spans = (r: PlanResult) => r.slots.map((s) => [s.start, s.end, s.slotId]);

describe('windows shaped by hand', () => {
  it('change nothing when there are none', () => {
    expect(JSON.stringify(run([]).slots)).toBe(JSON.stringify(plan({ schedule: fixtureSchedule(), library: fixtureLibrary(), state: freshState(), from: MONDAY_18, to: TUESDAY_00 }).slots));
  });

  it('a slot added inside another splits it: the earlier part ends there, the rest carries on after', () => {
    // The 20:00 movie slot runs to 22:15. Add 20:30 to 21:30 with a pinned episode.
    const r = run([{ start: T(20, 30), end: T(21, 30), slotId: 'added@x' }], { pins: [{ start: T(20, 30), blocks: { 1: 'ep9' } }] });
    expect(spans(r)).toEqual([
      [T(18), T(20), '1@64800000'], [T(20), T(20, 30), '1@72000000'], [T(20, 30), T(21, 30), 'added@x'],
      [T(21, 30), T(22, 15), '1@72000000'], [T(22, 15), TUESDAY_00, '1@80100000'],
    ]);
    const added = r.slots[2]!;
    expect(added.programs).toEqual(['ep9']);
    expect(added.pool).toBe('');
  });

  it('every slot still adds up to its window, and the day has no hole', () => {
    const r = run([{ start: T(20, 30), end: T(21, 30), slotId: 'added@x' }], { pins: [{ start: T(20, 30), blocks: { 1: 'ep9' } }] });
    let t = MONDAY_18;
    for (const s of r.slots) {
      expect(s.start).toBe(t);
      expect(s.items.reduce((a, i) => a + i.duration, 0)).toBe(s.end - s.start);
      t = s.end;
    }
    expect(t).toBe(TUESDAY_00);
  });

  it('an added slot with nothing pinned is filler and dead air, never an error', () => {
    const r = run([{ start: T(20, 30), end: T(21, 30), slotId: 'added@x' }]);
    const added = r.slots.find((s) => s.slotId === 'added@x')!;
    expect(added.programs).toEqual([]);
    expect(added.items.every((i) => i.kind !== 'content')).toBe(true);
  });

  it('a resized slot takes its new span, and the slot it overlaps is cut back to start where it ends', () => {
    // The 18:00 office slot now runs to 20:15; the movie slot, which began at 20:00, starts at 20:15.
    const r = run([{ start: T(18), end: T(20, 15), slotId: '1@64800000' }, { start: T(20, 15), end: T(22, 15), slotId: '1@72000000' }]);
    expect(spans(r)).toEqual([[T(18), T(20, 15), '1@64800000'], [T(20, 15), T(22, 15), '1@72000000'], [T(22, 15), TUESDAY_00, '1@80100000']]);
    expect(r.slots[1]!.programs.length).toBeGreaterThan(0);
  });

  it('a week slot that carries on after a shaped window continues from the window end', () => {
    // Only the 20:00 slot's front part is shaped: 20:00 to 21:00 as an added slot.
    const r = run([{ start: T(20), end: T(21), slotId: 'added@y' }]);
    expect(spans(r).slice(1, 3)).toEqual([[T(20), T(21), 'added@y'], [T(21), T(22, 15), '1@72000000']]);
  });

  it('refuses two windows that overlap', () => {
    expect(() => run([{ start: T(20), end: T(21), slotId: 'added@a' }, { start: T(20, 30), end: T(22), slotId: 'added@b' }])).toThrow(/overlap/);
  });

  it('an unknown week slot falls back to an added slot with a warning', () => {
    const r = run([{ start: T(20), end: T(21), slotId: '9@1' }]);
    expect(r.warnings.some((w) => /no longer in the schedule/.test(w.message))).toBe(true);
    expect(r.slots.find((s) => s.start === T(20))!.pool).toBe('');
  });
});
