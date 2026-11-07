import { describe, expect, it } from 'vitest';
import { fixtureLibrary, fixtureSchedule, freshState, local, MONDAY_18, TUESDAY_00 } from './fixtures.js';
import { plan } from './plan.js';
import type { Library, PlannedSlot } from './schedule.js';

const MOVIES = local(2026, 11, 9, 20); // the 20:00 movie slot, 135 minutes
const OFFICE = MONDAY_18;

const run = (pins: { start: number; blocks: Record<number, string> }[], over: { library?: Library; locked?: PlannedSlot[]; to?: number } = {}) =>
  plan({
    schedule: fixtureSchedule(), library: over.library ?? fixtureLibrary(), state: freshState(), from: MONDAY_18, to: over.to ?? TUESDAY_00, pins,
    ...(over.locked ? { locked: over.locked } : {}),
  });

describe('pins', () => {
  it('put the chosen program at its block, marked as pinned, and the slot still adds up', () => {
    const r = run([{ start: MOVIES, blocks: { 1: 'm1' } }]);
    const slot = r.slots.find((s) => s.start === MOVIES)!;
    expect(slot.programs[0]).toBe('m1');
    expect(slot.blocks[0]).toMatchObject({ programId: 'm1', pinned: true });
    expect(slot.items.reduce((a, i) => a + i.duration, 0)).toBe(slot.end - slot.start);
    expect(r.warnings.filter((w) => w.code.startsWith('pin-'))).toEqual([]);
  });

  it('never move a shuffle bag', () => {
    const pinned = run([{ start: MOVIES, blocks: { 1: 'm1' } }]);
    expect(pinned.state.bags['pool:movies']).toBeUndefined();
    expect(run([]).state.bags['pool:movies']).toBeDefined();
  });

  it("never move an ordered show's place: only the blocks taken from the show count", () => {
    const plain = run([]).slots[0]!;
    const r = run([{ start: OFFICE, blocks: { 2: 'ep9' } }]);
    const slot = r.slots[0]!;
    expect(slot.programs[1]).toBe('ep9');
    expect(slot.blocks[1]!.pinned).toBe(true);
    const taken = slot.programs.length - 1;
    expect(r.state.sequences['seq:office']!.position).toBe(taken);
    // The blocks around the pin are the show's next episodes, in order, with no gap in the order.
    expect(slot.programs.filter((p) => p !== 'ep9')).toEqual(plain.programs.slice(0, taken));
  });

  it('that do not fit are an alert, and the block is planned as usual instead', () => {
    const r = run([{ start: MOVIES, blocks: { 1: 'epic' } }]);
    const w = r.warnings.find((x) => x.code === 'pin-does-not-fit')!;
    expect(w.severity).toBe('alert');
    expect(w.message).toMatch(/epic.*does not fit/);
    const slot = r.slots.find((s) => s.start === MOVIES)!;
    expect(slot.programs[0]).not.toBe('epic');
    expect(slot.blocks[0]!.pinned).toBeUndefined();
    expect(slot.items.reduce((a, i) => a + i.duration, 0)).toBe(slot.end - slot.start);
  });

  it('on a block the slot does not have are dropped with a warning', () => {
    const r = run([{ start: MOVIES, blocks: { 9: 'm1' } }]);
    expect(r.warnings.find((x) => x.code === 'pin-dropped')!.message).toMatch(/block 9.*only \d+ block/);
  });

  it('of a program not in the library are dropped with a warning', () => {
    const r = run([{ start: MOVIES, blocks: { 1: 'ghost' } }]);
    expect(r.warnings.find((x) => x.code === 'pin-dropped')!.message).toMatch(/ghost.*not in the library/);
    expect(r.slots.find((s) => s.start === MOVIES)!.programs.length).toBeGreaterThan(0);
  });

  it('on a slot that no longer exists are dropped with a warning', () => {
    const r = run([{ start: MOVIES + 15 * 60_000, blocks: { 1: 'm1' } }]);
    expect(r.warnings.some((x) => x.code === 'pin-dropped' && /no slot of the schedule starts here/.test(x.message))).toBe(true);
  });

  it('are kept when a locked slot has to be planned again', () => {
    const base = run([]);
    const locked = base.slots.find((s) => s.start === MOVIES)!;
    const library = fixtureLibrary();
    library.programs[locked.programs[0]!] = { duration: library.programs[locked.programs[0]!]!.duration + 1000 };
    const r = run([{ start: MOVIES, blocks: { 1: 'm4' } }], { library, locked: [locked] });
    expect(r.conflicts).toHaveLength(1);
    expect(r.slots.find((s) => s.start === MOVIES)!.programs[0]).toBe('m4');
  });

  it('plan the same way twice', () => {
    const pins = [{ start: MOVIES, blocks: { 1: 'm1' } }];
    expect(JSON.stringify(run(pins).slots)).toBe(JSON.stringify(run(pins).slots));
  });
});
