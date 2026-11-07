import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { adSettingsOf, applyAdSettings, formatDuration, formatPercent } from './adsettings.js';
import { parseScheduleFile } from './file.js';

const EXAMPLE = readFileSync(new URL('../../../schedules/example.yaml', import.meta.url), 'utf8');

describe('formatting', () => {
  it('writes durations the way the file reads them', () => {
    expect(formatDuration(0)).toBe('0');
    expect(formatDuration(15_000)).toBe('15s');
    expect(formatDuration(90_000)).toBe('1m30s');
    expect(formatDuration(3_600_000)).toBe('1h');
    expect(formatDuration(90_000_000)).toBe('1d1h');
    expect(() => formatDuration(1500)).toThrow(/whole number of seconds/);
    expect(formatPercent(0.15)).toBe('15%');
    expect(formatPercent(0.125)).toBe('12.5%');
  });
});

describe('the ad settings of a channel file', () => {
  const settings = adSettingsOf(parseScheduleFile(EXAMPLE));

  it('read as plain numbers and names', () => {
    expect(settings).toMatchObject({ step: 15_000, ratio: { min: 0.15, max: 0.6 }, interstitial: 'Fillers' });
    expect(settings.positions['post']).toEqual({ list: 'Old Ads', min: 0, max: 300_000 });
    expect(settings.mid).toMatchObject({ list: 'Old Ads', every: 480_000, min: 120_000, max: 180_000, tailBuffer: 60_000 });
    expect(settings.bumpers['pre']).toBe('Station Idents');
  });

  it('written back unchanged leave the file exactly as it was, comments and all', () => {
    expect(applyAdSettings(EXAMPLE, settings)).toBe(EXAMPLE);
  });

  it('change only what changed, and the result is a valid file that reads back as the new settings', () => {
    const next = { ...settings, ratio: { min: 0.2, max: 0.5 }, positions: { ...settings.positions, post: { list: 'Old Ads', min: 0, max: 480_000 } } };
    const text = applyAdSettings(EXAMPLE, next);
    expect(adSettingsOf(parseScheduleFile(text))).toEqual(next);
    expect(text).toContain('# matches the channel in Tunarr'); // comments elsewhere survive
    expect(text).toContain('# an explicit pick: off-cursor');
    expect(text).not.toBe(EXAMPLE);
  });

  it('add and remove positions, bumpers and the interstitial', () => {
    const next = { ...settings, positions: { post: settings.positions['post']!, head: { list: 'Old Ads', min: 0, max: 60_000 } }, bumpers: { tail: 'Station Idents' }, interstitial: undefined };
    const text = applyAdSettings(EXAMPLE, { ...next, interstitial: undefined } as typeof settings);
    const back = adSettingsOf(parseScheduleFile(text));
    expect(back.positions['head']).toEqual({ list: 'Old Ads', min: 0, max: 60_000 });
    expect(back.positions['tail']).toBeUndefined();
    expect(back.bumpers).toEqual({ tail: 'Station Idents' });
    expect(back.interstitial).toBeUndefined();
    const noMid = adSettingsOf(parseScheduleFile(applyAdSettings(EXAMPLE, { ...settings, mid: undefined } as typeof settings)));
    expect(noMid.mid).toBeUndefined();
  });

  it('refuses settings that make the file invalid', () => {
    expect(() => applyAdSettings(EXAMPLE, { ...settings, positions: { ...settings.positions, head: { min: 0, max: 60_000 } } })).toThrow(/needs a list/);
    expect(() => applyAdSettings(EXAMPLE, { ...settings, step: 1500 })).toThrow(/whole number of seconds/);
    expect(() => applyAdSettings('nonsense: true', settings)).toThrow(/problems/);
  });
});
