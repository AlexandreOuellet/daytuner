import { describe, expect, it } from 'vitest';
import { formatMetrics, formatWarnings, inZone, slotLabel, withTitles } from './format.js';
import { computeMetrics } from '@daytuner/engine';

describe('formatting', () => {
  it('labels a slot by day and time', () => {
    expect(slotLabel('1@72000000')).toBe('Mon 20:00');
    expect(slotLabel('0@0')).toBe('Sun 00:00');
    expect(slotLabel('weird')).toBe('weird');
  });
  it('shows a moment in the schedule clock, not UTC', () => {
    expect(inZone(Date.UTC(2027, 2, 1, 5, 0), 'America/Toronto')).toBe('2027-03-01 00:00');
    expect(inZone(Date.UTC(2026, 6, 1, 4, 0), 'America/Toronto')).toBe('2026-07-01 00:00');
  });
  it('lists the worst warnings first and counts them', () => {
    const text = formatWarnings(
      [
        { code: 'dead-air', severity: 'info', at: 0, slotId: '1@0', message: 'a' },
        { code: 'nothing-fits', severity: 'alert', at: 1, slotId: '1@0', message: 'b' },
      ],
      'America/Toronto',
    );
    expect(text).toContain('1 alert, 0 warning, 1 info');
    expect(text.indexOf('[alert]')).toBeLessThan(text.indexOf('[info]'));
    expect(formatWarnings([], 'America/Toronto')).toBe('No warnings.');
  });
  it('shows titles instead of ids in a warning', () => {
    const id = 'bedf888c-9112-41fa-86c4-cc6baf06090d';
    expect(withTitles(`the next episode (${id}) does not fit`, { [id]: 'Ted Lasso S2E3 "Headspace"' })).toBe('the next episode (Ted Lasso S2E3 "Headspace") does not fit');
    const text = formatWarnings([{ code: 'sequential-does-not-fit', severity: 'warning', at: 0, slotId: '1@0', message: `episode ${id} late` }], 'America/Toronto', { [id]: 'Show S1E1 "x"' });
    expect(text).toContain('Show S1E1 "x"');
    expect(text).not.toContain(id);
  });
  it('prints metrics for an empty plan without failing', () => {
    expect(formatMetrics(computeMetrics([], { grid: 900_000, zone: 'America/Toronto' }))).toContain('Slots measured: 0');
  });
});
