// The ad, bumper and filler part of a channel file as plain numbers and names, for a page that edits it, and the
// way back: the same text with that part changed. Comments and layout elsewhere in the file are kept.

import { isMap, parseDocument, type Document } from 'yaml';
import { parseScheduleFile, type ScheduleFile } from './file.js';

export type Edge = 'head' | 'pre' | 'post' | 'tail';
export type ChapterKind = 'chapter' | 'intro' | 'outro' | 'break' | 'recap';

export interface AdSettings {
  /** Planned lengths are multiples of this (milliseconds). */
  step: number;
  /** Ads as a share of the show, inside its block: 0.15 is 15%. */
  ratio: { min: number; max: number };
  /** A position with ads. One that is absent (or has a maximum of 0) holds none. */
  positions: Partial<Record<Edge, { list?: string; min: number; max: number }>>;
  mid?: { list: string; every: number; min: number; max: number; tailBuffer: number; minGap?: number; chapterTypes?: ChapterKind[] };
  /** The clip list a position's bumper comes from. */
  bumpers: Partial<Record<Edge, string>>;
  /** Run slots (docs/run-slots.md): a bumper after every N items, N in this range. */
  rotation?: { list: string; every: { min: number; max: number } };
  interstitial?: string;
  /** The closer's rules (docs/run-slots.md): the length of clips it may use, a cooldown (ms) and whether the last clip may be cut off. */
  closer?: { length?: { min: number; max: number }; cooldown?: number; cut?: boolean };
}

const EDGES: readonly Edge[] = ['head', 'pre', 'post', 'tail'];

export function adSettingsOf(file: ScheduleFile): AdSettings {
  const positions: AdSettings['positions'] = {};
  for (const e of EDGES) {
    const p = file.ads[e];
    if (p) positions[e] = { ...(p.list ? { list: p.list } : {}), min: p.length.min, max: p.length.max };
  }
  const m = file.ads.mid;
  const bumpers: AdSettings['bumpers'] = {};
  for (const e of EDGES) if (file.bumpers[e]) bumpers[e] = file.bumpers[e]!.list;
  return {
    step: file.ads.step,
    ratio: { ...file.ads.ratio },
    positions,
    ...(m ? { mid: { list: m.list, every: m.every, min: m.length.min, max: m.length.max, tailBuffer: m.tailBuffer, ...(m.minGap !== undefined ? { minGap: m.minGap } : {}), ...(m.chapterTypes ? { chapterTypes: m.chapterTypes } : {}) } } : {}),
    bumpers,
    ...(file.bumpers.rotation ? { rotation: { list: file.bumpers.rotation.list, every: { ...file.bumpers.rotation.every } } } : {}),
    ...(file.interstitial ? { interstitial: file.interstitial.list } : {}),
    ...(file.interstitial && (file.interstitial.length || file.interstitial.cooldown !== undefined || file.interstitial.cut !== undefined)
      ? { closer: {
          ...(file.interstitial.length ? { length: { ...file.interstitial.length } } : {}),
          ...(file.interstitial.cooldown !== undefined ? { cooldown: file.interstitial.cooldown } : {}),
          ...(file.interstitial.cut !== undefined ? { cut: file.interstitial.cut } : {}),
        } }
      : {}),
  };
}

/** 90000 is "1m30s", 3600000 is "1h", 0 is "0". Whole seconds only. */
export function formatDuration(ms: number): string {
  if (!Number.isInteger(ms) || ms < 0 || ms % 1000 !== 0) throw new RangeError(`${ms} ms is not a whole number of seconds`);
  if (ms === 0) return '0';
  let s = ms / 1000;
  const parts: string[] = [];
  for (const [unit, size] of [['d', 86_400], ['h', 3600], ['m', 60], ['s', 1]] as const) {
    const n = Math.floor(s / size);
    if (n > 0) parts.push(`${n}${unit}`);
    s -= n * size;
  }
  return parts.join('');
}

const formatRange = (min: number, max: number): string | number =>
  min === 0 && max === 0 ? 0 : min === max ? formatDuration(min) : `${formatDuration(min)}-${formatDuration(max)}`;

/** 0.15 is "15%". Up to two decimals of a percent. */
export const formatPercent = (share: number): string => `${Number((share * 100).toFixed(2))}%`;

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** The new text of a part: sets it when it differs from what the document has, so untouched parts keep their layout. */
function put(doc: Document, path: string[], value: unknown): boolean {
  if (value === undefined) {
    if (!doc.hasIn(path)) return false;
    doc.deleteIn(path);
    return true;
  }
  const current = doc.getIn(path, true);
  const now = current && typeof current === 'object' && 'toJSON' in current ? (current as { toJSON(): unknown }).toJSON() : current;
  if (same(now, value)) return false;
  doc.setIn(path, doc.createNode(value));
  return true;
}

/**
 * The channel file with its ads, bumpers and interstitial replaced by `s`. Throws when the result is not a valid
 * channel file (for example a position with ads but no list). When nothing changes the text is returned as it was; when
 * something does, the file is written again with its comments kept (their spacing is tidied by the YAML writer).
 */
export function applyAdSettings(text: string, s: AdSettings): string {
  parseScheduleFile(text);
  const doc = parseDocument(text);
  if (!isMap(doc.contents)) throw new RangeError('the channel file is not a map');
  let changed = false;
  const set = (path: string[], value: unknown): void => { changed = put(doc, path, value) || changed; };
  set(['ads', 'step'], formatDuration(s.step));
  set(['ads', 'ratio'], { min: formatPercent(s.ratio.min), max: formatPercent(s.ratio.max) });
  for (const e of EDGES) {
    const p = s.positions[e];
    set(['ads', e], p === undefined ? undefined : p.max === 0 && p.min === 0 ? { length: 0 } : { ...(p.list ? { list: p.list } : {}), length: formatRange(p.min, p.max) });
  }
  const m = s.mid;
  set(['ads', 'mid'], m === undefined ? undefined : {
    list: m.list, every: formatDuration(m.every), length: formatRange(m.min, m.max), tailBuffer: formatDuration(m.tailBuffer),
    ...(m.minGap !== undefined ? { minGap: formatDuration(m.minGap) } : {}), ...(m.chapterTypes ? { chapterTypes: m.chapterTypes } : {}),
  });
  for (const e of EDGES) set(['bumpers', e], s.bumpers[e] ? { list: s.bumpers[e] } : undefined);
  const c = s.closer;
  set(['bumpers', 'rotation'], s.rotation ? { list: s.rotation.list, every: s.rotation.every.min === s.rotation.every.max ? s.rotation.every.min : `${s.rotation.every.min}-${s.rotation.every.max}` } : undefined);
  set(['interstitial'], s.interstitial
    ? { list: s.interstitial, ...(c?.length ? { length: formatRange(c.length.min, c.length.max) } : {}), ...(c?.cooldown !== undefined ? { cooldown: formatDuration(c.cooldown) } : {}), ...(c?.cut !== undefined ? { cut: c.cut } : {}) }
    : undefined);
  if (!changed) return text;
  const out = doc.toString({ lineWidth: 0 });
  parseScheduleFile(out);
  return out;
}
