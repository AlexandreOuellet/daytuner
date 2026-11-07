// Compares two plans of the same stretch, slot by slot, for the preview: what a change did. Pure.

import type { PlannedSlot } from './schedule.js';
import type { Ms } from './time.js';

export interface SlotChange {
  /** Where the slot starts (after the change, or before it for a removed slot). */
  start: Ms;
  end: Ms;
  slotId: string;
  /**
   * `new`: no slot started here before. `removed`: none starts here now. `changed`: the slot's window or programs
   * differ. `ads-only`: same window and programs, but different clips (a change earlier in the day reshuffles them).
   */
  kind: 'new' | 'removed' | 'changed' | 'ads-only';
  before: string[];
  after: string[];
  /** Set when the window's end moved. */
  endBefore?: Ms;
  /** Dead air in the slot, in milliseconds. */
  deadAirBefore: number;
  deadAirAfter: number;
}

const deadAir = (s: PlannedSlot | undefined): number => (s ? s.items.reduce((a, i) => a + (i.kind === 'flex' ? i.duration : 0), 0) : 0);

const sameList = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

const sameItems = (a: PlannedSlot, b: PlannedSlot): boolean => JSON.stringify(a.items) === JSON.stringify(b.items);

/** Slots that differ between `before` and `after`, in time order. Slots are matched by where they start. */
export function diffSlots(before: readonly PlannedSlot[], after: readonly PlannedSlot[]): SlotChange[] {
  const was = new Map(before.map((s) => [s.start, s]));
  const now = new Map(after.map((s) => [s.start, s]));
  const out: SlotChange[] = [];
  for (const s of after) {
    const old = was.get(s.start);
    if (!old) {
      out.push({ start: s.start, end: s.end, slotId: s.slotId, kind: 'new', before: [], after: s.programs, deadAirBefore: 0, deadAirAfter: deadAir(s) });
    } else if (old.end !== s.end || !sameList(old.programs, s.programs)) {
      out.push({
        start: s.start, end: s.end, slotId: s.slotId, kind: 'changed', before: old.programs, after: s.programs,
        ...(old.end !== s.end ? { endBefore: old.end } : {}), deadAirBefore: deadAir(old), deadAirAfter: deadAir(s),
      });
    } else if (!sameItems(old, s)) {
      out.push({ start: s.start, end: s.end, slotId: s.slotId, kind: 'ads-only', before: old.programs, after: s.programs, deadAirBefore: deadAir(old), deadAirAfter: deadAir(s) });
    }
  }
  for (const s of before) {
    if (!now.has(s.start)) out.push({ start: s.start, end: s.end, slotId: s.slotId, kind: 'removed', before: s.programs, after: [], deadAirBefore: deadAir(s), deadAirAfter: 0 });
  }
  return out.sort((a, b) => a.start - b.start);
}
