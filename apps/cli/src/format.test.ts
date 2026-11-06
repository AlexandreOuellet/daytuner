import { describe, expect, it } from 'vitest';
import { formatMetrics, formatWarnings, inZone, slotLabel } from './format.js';
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
  it('prints metrics for an empty plan without failing', () => {
    expect(formatMetrics(computeMetrics([], { grid: 900_000, zone: 'America/Toronto' }))).toContain('Slots measured: 0');
  });
});
