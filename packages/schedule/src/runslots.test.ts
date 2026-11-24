// The channel file side of run slots (docs/run-slots.md): `run: true`, `bumpers.rotation`, and the closer's settings.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { adSettingsOf, applyAdSettings } from './adsettings.js';
import { parseCountRange, parseScheduleFile, ScheduleFileError } from './file.js';
import { applyScheduleModel, scheduleModelOf } from './schedulemodel.js';

const FILE = `# RHTV
channel: rock-hard-television
timezone: America/Toronto
grid: 30m
ads:
  step: 15s
  ratio: { min: 0%, max: 10% }
  tail: { list: Old Ads, length: 0-5m }
bumpers:
  rotation: { list: RHTV Idents, every: 3-4 }   # a break after every 3 to 4 items
  tail: { list: RHTV Idents }
interstitial: { list: Sessions, length: 2m-30m, cooldown: 14d, cut: true }
pools:
  punk:
    shows: [Punk & Ska]
    order: shuffle
fill: punk
week:
  mon:
    - { at: "17:00", length: 90m, pool: punk, run: true }
    - { at: "18:30", length: 90m, pool: punk }
  tue:
    - { at: "00:00", length: 24h, pool: punk }
`;

describe('parseCountRange', () => {
  it('reads a number of items or a range of them', () => {
    expect(parseCountRange(3)).toEqual({ min: 3, max: 3 });
    expect(parseCountRange('3-4')).toEqual({ min: 3, max: 4 });
    expect(parseCountRange('4')).toEqual({ min: 4, max: 4 });
  });
  it('refuses zero, a reversed range, and anything with a unit', () => {
    expect(() => parseCountRange(0)).toThrow(/not a number of items/);
    expect(() => parseCountRange('4-3')).toThrow(/maximum below/);
    expect(() => parseCountRange('3m')).toThrow(/not a number of items/);
    expect(() => parseCountRange('1-2-3')).toThrow(/not a number of items/);
  });
});

describe('a channel file with run slots', () => {
  const file = parseScheduleFile(FILE);

  it('reads the run flag, the rotation and the closer', () => {
    expect(file.week.mon![0]!.run).toBe(true);
    expect(file.week.mon![1]!.run).toBeUndefined();
    expect(file.bumpers.rotation).toEqual({ list: 'RHTV Idents', every: { min: 3, max: 4 } });
    expect(file.interstitial).toEqual({ list: 'Sessions', length: { min: 120_000, max: 1_800_000 }, cooldown: 14 * 86_400_000, cut: true });
  });

  it('refuses a run slot that is linked, and a rotation of 0', () => {
    expect(() => parseScheduleFile(FILE.replace('pool: punk, run: true }', 'pool: punk, link: x, run: true }'))).toThrow(ScheduleFileError);
    expect(() => parseScheduleFile(FILE.replace('every: 3-4', 'every: 0'))).toThrow(/not a number of items/);
  });

  it('refuses an unknown key in the closer or the rotation', () => {
    expect(() => parseScheduleFile(FILE.replace('cut: true', 'cutt: true'))).toThrow(ScheduleFileError);
    expect(() => parseScheduleFile(FILE.replace('every: 3-4', 'every: 3-4, size: 2'))).toThrow(ScheduleFileError);
  });

  it('still reads a file with a plain interstitial and no rotation, as before', () => {
    const plain = FILE.replace(/interstitial:.*\n/, 'interstitial: { list: Sessions }\n').replace(/  rotation:.*\n/, '');
    const f = parseScheduleFile(plain);
    expect(f.interstitial).toEqual({ list: 'Sessions' });
    expect(f.bumpers.rotation).toBeUndefined();
  });
});

describe('what a page saves must not lose them', () => {
  it('the ad settings round-trip with the rotation and the closer, leaving the file as it was', () => {
    const settings = adSettingsOf(parseScheduleFile(FILE));
    expect(settings.rotation).toEqual({ list: 'RHTV Idents', every: { min: 3, max: 4 } });
    expect(settings.closer).toEqual({ length: { min: 120_000, max: 1_800_000 }, cooldown: 14 * 86_400_000, cut: true });
    expect(applyAdSettings(FILE, settings)).toBe(FILE);
  });

  it('a change to the rotation is written and read back', () => {
    const settings = adSettingsOf(parseScheduleFile(FILE));
    const text = applyAdSettings(FILE, { ...settings, rotation: { list: 'RHTV Idents', every: { min: 2, max: 5 } } });
    expect(adSettingsOf(parseScheduleFile(text)).rotation).toEqual({ list: 'RHTV Idents', every: { min: 2, max: 5 } });
    expect(text).toContain('# RHTV');
  });

  it('the week round-trips with the run flag, and a slot can be turned into a run slot', () => {
    const model = scheduleModelOf(parseScheduleFile(FILE));
    expect(model.week.find((s) => s.day === 1 && s.at === 17 * 3_600_000)!.run).toBe(true);
    expect(applyScheduleModel(FILE, model)).toBe(FILE);
    const week = model.week.map((s) => (s.day === 1 && s.at === 18.5 * 3_600_000 ? { ...s, run: true as const } : s));
    const text = applyScheduleModel(FILE, { ...model, week });
    expect(scheduleModelOf(parseScheduleFile(text)).week.filter((s) => s.run)).toHaveLength(2);
  });

  it('refuses to save a linked run slot', () => {
    const model = scheduleModelOf(parseScheduleFile(FILE));
    const week = model.week.map((s) => (s.run ? { ...s, link: 'x' } : s));
    expect(() => applyScheduleModel(FILE, { ...model, week })).toThrow(/run slot and cannot be linked/);
  });
});

describe('the example channel file for a music channel', () => {
  const text = readFileSync(new URL('../../../schedules/rock-hard-television.example.yaml', import.meta.url), 'utf8');
  it('parses, with run slots, tags, a rotation and a closer', () => {
    const f = parseScheduleFile(text);
    expect(f.week.mon!.filter((x) => x.run)).toHaveLength(4);
    expect(f.bumpers.rotation).toEqual({ list: 'RHTV Idents', every: { min: 3, max: 4 } });
    expect(f.interstitial).toMatchObject({ list: 'Sessions', cut: true });
    expect(f.pools['punk']!.videos).toMatchObject({ path: '/musicvideos', tag: ['Punk & Ska'] });
  });
  it('is left exactly as it is by the ads and week round trips', () => {
    expect(applyAdSettings(text, adSettingsOf(parseScheduleFile(text)))).toBe(text);
    expect(applyScheduleModel(text, scheduleModelOf(parseScheduleFile(text)))).toBe(text);
  });
});
