// The channel's tags (a CSV of genre,file in the channel file) and the `videos` pool (docs/run-slots.md).

import { describe, expect, it } from 'vitest';
import { plan, emptyPlanState, toEpoch } from '@daytuner/engine';
import { parseScheduleFile, ScheduleFileError, tagIndexOf } from './file.js';
import { resolveSchedule, ResolveError, type LibrarySource } from './resolve.js';
import { applyScheduleModel, scheduleModelOf } from './schedulemodel.js';
import { parseTagsCsv } from './tags.js';
import { fakeSource } from './testing.js';

const CSV = `genre,file
"80s, New Wave & Pop",a-ha - Take On Me.mp4
Metal,Angine - Live.mp4
Prog & Virtuoso,Angine - Live.mp4
Metal,Monolord Full Performance.mp4
Punk & Ska,Rancid - Ruby Soho.mp4
Punk & Ska,Bad Religion - American Jesus.mp4
`;

describe('the tags CSV', () => {
  const idx = parseTagsCsv(CSV.replace(/\n/g, '\r\n'));
  it('reads quoted genres, several rows per file and Windows line ends', () => {
    expect(idx.tagsOf('a-ha - Take On Me')).toEqual(['80s, New Wave & Pop']);
    expect(idx.tagsOf('Angine - Live')).toEqual(['Metal', 'Prog & Virtuoso']);
    expect([...idx.all].sort()).toEqual(['80s, New Wave & Pop', 'Metal', 'Prog & Virtuoso', 'Punk & Ska']);
  });
  it('matches a title with or without the extension, ignoring case and spacing', () => {
    expect(idx.tagsOf('ANGINE  -  live.mp4')).toEqual(['Metal', 'Prog & Virtuoso']);
    expect(idx.tagsOf('nobody')).toEqual([]);
  });
  it('refuses a missing header and a row without a file', () => {
    expect(() => parseTagsCsv('a,b\nx,y\n')).toThrow(/header/);
    expect(() => parseTagsCsv('genre,file\nMetal,\n')).toThrow(/row 2/);
    expect(() => parseTagsCsv('genre,file\n"Metal,x.mp4\n')).toThrow(/not closed/);
  });
});

const FILE = `channel: rhtv
timezone: America/Toronto
grid: 30m
ads:
  step: 15s
  ratio: { min: 0%, max: 10% }
bumpers:
  rotation: { list: Station Idents, every: 3-4 }
interstitial: { list: Fillers, length: 2m-30m, cooldown: 14d, cut: true }
pools:
  metal:
    videos: { path: /musicvideos, tag: Metal }
  all-videos:
    videos: { path: /musicvideos }
fill: all-videos
tagsCsv: |
  genre,file
  Metal,Monolord - Heavy.mp4
  Metal,Gojira - Stranded.mp4
  Punk & Ska,Rancid - Ruby Soho.mp4
  Metal,fl-ads-3.mp4
week:
  mon:
    - { at: "17:00", length: 90m, pool: metal, run: true, tags: [Metal] }
`;

const videos = [
  { id: 'v-monolord', title: 'Monolord - Heavy', duration: 300_000, path: '/musicvideos/Monolord - Heavy.mp4' },
  { id: 'v-gojira', title: 'Gojira - Stranded', duration: 250_000, path: '/musicvideos/Gojira - Stranded.mp4' },
  { id: 'v-rancid', title: 'Rancid - Ruby Soho', duration: 170_000, path: '/musicvideos/Rancid - Ruby Soho.mp4' },
  { id: 'v-ad', title: 'Some Ad', duration: 30_000, path: '/ads/Old Ads/Some Ad.mp4' },
];
const source = (): LibrarySource => ({
  ...fakeSource(),
  otherVideos: async () => videos,
  fillerListClips: async (id) => (id === 'fl-fill'
    ? Array.from({ length: 6 }, (_, i) => ({ id: `fl-${i}`, title: i < 3 ? 'fl-ads-3' : `x${i}`, duration: (10 + i * 3) * 60_000 }))
    : fakeSource().fillerListClips(id)),
});

describe('a channel file with tags and a videos pool', () => {
  it('reads the CSV and keeps it in the channel, and tags on a slot', () => {
    const f = parseScheduleFile(FILE);
    expect([...tagIndexOf(f).all].sort()).toEqual(['Metal', 'Punk & Ska']);
    expect(f.week.mon![0]!.tags).toEqual(['Metal']);
  });

  it('refuses a tag that is not in the CSV, on a slot or a pool, and a CSV without a header', () => {
    expect(() => parseScheduleFile(FILE.replace('tags: [Metal]', 'tags: [Jazz]'))).toThrow(/"Jazz", which is not in tagsCsv/);
    expect(() => parseScheduleFile(FILE.replace('tag: Metal }', 'tag: Jazz }'))).toThrow(/"Jazz", which is not in tagsCsv/);
    expect(() => parseScheduleFile(FILE.replace('genre,file\n', 'a,b\n'))).toThrow(ScheduleFileError);
  });

  it('refuses a pool with two kinds of content, or none', () => {
    expect(() => parseScheduleFile(FILE.replace('all-videos:\n    videos: { path: /musicvideos }', 'all-videos:\n    videos: { path: /musicvideos }\n    shows: [X]'))).toThrow(/one of shows, movies or videos/);
  });

  it('resolves a videos pool by folder and tag, and gives the closer clips their tags', async () => {
    const r = await resolveSchedule(parseScheduleFile(FILE), source());
    expect([...r.schedule.pools['metal']!.programs].sort()).toEqual(['v-gojira', 'v-monolord']);
    expect([...r.schedule.pools['all-videos']!.programs].sort()).toEqual(['v-gojira', 'v-monolord', 'v-rancid']); // not the ad: other folder
    expect(r.schedule.pools['metal']!.order).toBe('shuffled');
    expect(r.schedule.week[0]).toMatchObject({ run: true, tags: ['Metal'] });
    expect(r.library.clips['Fillers']!.filter((c) => c.tags?.[0] === 'Metal')).toHaveLength(3);
    expect(r.schedule.bumpers.rotation).toEqual({ list: 'Station Idents', every: { min: 3, max: 4 } });
    expect(r.schedule.interstitial).toMatchObject({ list: 'Fillers', cooldown: 14 * 86_400_000, cut: true });
  });

  it('says so when the source cannot read local videos, or a pool matches nothing', async () => {
    const { otherVideos: _gone, ...noVideos } = source();
    await expect(resolveSchedule(parseScheduleFile(FILE), noVideos as LibrarySource)).rejects.toThrow(ResolveError);
    await expect(resolveSchedule(parseScheduleFile(FILE.replace('path: /musicvideos, tag', 'path: /nowhere, tag')), source())).rejects.toThrow(/matches nothing/);
  });

  it('plans a real run window from it: the closer only uses clips tagged Metal or untagged', async () => {
    const r = await resolveSchedule(parseScheduleFile(FILE), source());
    const from = toEpoch('America/Toronto', { year: 2026, month: 11, day: 9, hour: 17, minute: 0 });
    const result = plan({ schedule: r.schedule, library: r.library, state: emptyPlanState(3), from, to: from + 90 * 60_000 });
    const slot = result.slots[0]!;
    expect(slot.items.reduce((a, i) => a + i.duration, 0)).toBe(90 * 60_000);
    expect(slot.programs.length).toBeGreaterThan(10);
    for (const i of slot.items) {
      if (i.kind === 'filler' && i.role === 'interstitial') {
        const clip = r.library.clips['Fillers']!.find((c) => c.id === i.clipId)!;
        expect(clip.tags === undefined || clip.tags.includes('Metal')).toBe(true);
      }
    }
  });

  it('keeps the CSV and the tags of a slot when the page saves the week', () => {
    const model = scheduleModelOf(parseScheduleFile(FILE));
    expect(model.week[0]!.tags).toEqual(['Metal']);
    expect(applyScheduleModel(FILE, model)).toBe(FILE);
    const week = model.week.map((s) => ({ ...s, tags: ['Punk & Ska'] }));
    const text = applyScheduleModel(FILE, { ...model, week });
    expect(parseScheduleFile(text).week.mon![0]!.tags).toEqual(['Punk & Ska']);
    expect(text).toContain('tagsCsv: |');
  });
});
