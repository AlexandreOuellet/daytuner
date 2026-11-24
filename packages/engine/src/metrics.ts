// The numbers every schedule is judged on. Definitions: docs/metrics.md. Pure: planned slots in,
// numbers out. Counts what is written to the lineup (the guide hides ad filler).

import { isDstChangeDay, toLocal } from './clock.js';
import type { PlannedSlot } from './schedule.js';
import { MINUTE, type Ms } from './time.js';

export interface Distribution {
  count: number;
  median: number;
  p90: number;
  p99: number;
  max: number;
}

export interface Metrics {
  /** Slots measured, and how many were left out as daylight-saving change days. */
  slots: number;
  excludedDstDays: number;
  airTime: Ms;

  // Inside a show (ratios)
  midRollRatio: Distribution;
  adLoadRatio: Distribution;

  // Where a viewer waits (minutes)
  endOfSlotMinutes: Distribution;
  betweenProgramsMinutes: Distribution;
  beginningOfSlotMinutes: Distribution;
  slotEndsOver10: number;
  slotEndsOver30: number;

  // Whole lineup
  gridAccuracy: { checked: number; withinOneSecond: number; share: number; worstMissMs: number };
  adShare: { total: number; byPosition: Record<string, number> };
  deadAirShare: number;
  deadAirGaps: { under15s: number; under1m: number; under5m: number; over5m: number };
  deadAirGapsPerDay: number;
  blocksWithNoAds: number;
  longShowsWithoutMidBreak: number;
  longestRunOfFillerMinutes: number;
  repeatedProgramAirings: number;
}

/** Nearest-rank percentile of a list of numbers. */
export function distribution(values: readonly number[]): Distribution {
  if (values.length === 0) return { count: 0, median: 0, p90: 0, p99: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number): number => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]!;
  return { count: sorted.length, median: at(0.5), p90: at(0.9), p99: at(0.99), max: sorted[sorted.length - 1]! };
}

interface Occurrence {
  programId: string;
  content: number;
  mid: number;
  pre: number;
  post: number;
  hasAd: boolean;
  firstContent: Ms;
  lastContentEnd: Ms;
}

const SHOW_LENGTH_FOR_MID_BREAK = 25 * MINUTE;

export function computeMetrics(slots: readonly PlannedSlot[], opts: { grid: Ms; zone: string }): Metrics {
  const kept = slots.filter((s) => !isDstChangeDay(opts.zone, s.start));
  const excludedDstDays = slots.length - kept.length;

  const midRoll: number[] = [];
  const load: number[] = [];
  const endWaits: number[] = [];
  const betweenWaits: number[] = [];
  const beginWaits: number[] = [];
  const byPosition: Record<string, number> = {};
  let adTime = 0;
  let deadAir = 0;
  let airTime = 0;
  const gaps = { under15s: 0, under1m: 0, under5m: 0, over5m: 0 };
  const allDays = new Set<string>();
  let noAds = 0;
  let longNoMid = 0;
  let longestRun = 0;
  let checked = 0;
  let within = 0;
  let worst = 0;
  const airings = new Map<string, number>();

  const checkGrid = (t: Ms): void => {
    checked++;
    const r = ((t % opts.grid) + opts.grid) % opts.grid;
    const miss = Math.min(r, opts.grid - r);
    if (miss <= 1000) within++;
    worst = Math.max(worst, miss);
  };

  for (const slot of kept) {
    airTime += slot.end - slot.start;
    checkGrid(slot.start);
    checkGrid(slot.end);
    // A run slot's blocks are its items, which are not on the grid on purpose: only the slot's own edges are.
    if (!slot.run) for (let i = 0; i + 1 < slot.blocks.length; i++) checkGrid(slot.blocks[i]!.end);

    const l = toLocal(opts.zone, slot.start);
    allDays.add(`${l.year}-${l.month}-${l.day}`);

    const occs: Occurrence[] = [];
    let cur: Occurrence | undefined;
    let pendingPre = 0;
    let run = 0;
    let t = slot.start;
    for (const item of slot.items) {
      if (item.kind === 'content') {
        if (item.startOffset === 0 || !cur || cur.programId !== item.programId) {
          cur = { programId: item.programId, content: 0, mid: 0, pre: pendingPre, post: 0, hasAd: pendingPre > 0, firstContent: t, lastContentEnd: t };
          pendingPre = 0;
          occs.push(cur);
        }
        cur.content += item.duration;
        cur.lastContentEnd = t + item.duration;
        longestRun = Math.max(longestRun, run);
        run = 0;
      } else if (item.kind === 'flex') {
        deadAir += item.duration;
        if (item.duration < 15_000) gaps.under15s++;
        else if (item.duration < MINUTE) gaps.under1m++;
        else if (item.duration < 5 * MINUTE) gaps.under5m++;
        else gaps.over5m++;
        longestRun = Math.max(longestRun, run);
        run = 0;
      } else {
        run += item.duration;
        if (item.role === 'ad') {
          adTime += item.duration;
          byPosition[item.position] = (byPosition[item.position] ?? 0) + item.duration;
          if (item.position === 'pre') pendingPre += item.duration;
          else if (cur && item.position === 'mid') { cur.mid += item.duration; cur.hasAd = true; }
          else if (cur && item.position === 'post') { cur.post += item.duration; cur.hasAd = true; }
        }
      }
      t += item.duration;
    }
    longestRun = Math.max(longestRun, run);

    for (const o of occs) {
      midRoll.push(o.mid / o.content);
      load.push((o.pre + o.mid + o.post) / o.content);
      if (!o.hasAd) noAds++;
      if (o.content >= SHOW_LENGTH_FOR_MID_BREAK && o.mid === 0) longNoMid++;
      airings.set(o.programId, (airings.get(o.programId) ?? 0) + 1);
    }
    if (occs.length > 0) {
      beginWaits.push((occs[0]!.firstContent - slot.start) / MINUTE);
      endWaits.push((slot.end - occs[occs.length - 1]!.lastContentEnd) / MINUTE);
      for (let i = 0; i + 1 < occs.length; i++) betweenWaits.push((occs[i + 1]!.firstContent - occs[i]!.lastContentEnd) / MINUTE);
    }
  }

  let repeats = 0;
  for (const n of airings.values()) repeats += n - 1;
  const share: Record<string, number> = {};
  for (const [k, v] of Object.entries(byPosition)) share[k] = airTime > 0 ? v / airTime : 0;

  return {
    slots: kept.length,
    excludedDstDays,
    airTime,
    midRollRatio: distribution(midRoll),
    adLoadRatio: distribution(load),
    endOfSlotMinutes: distribution(endWaits),
    betweenProgramsMinutes: distribution(betweenWaits),
    beginningOfSlotMinutes: distribution(beginWaits),
    slotEndsOver10: endWaits.filter((m) => m > 10).length,
    slotEndsOver30: endWaits.filter((m) => m > 30).length,
    gridAccuracy: { checked, withinOneSecond: within, share: checked > 0 ? within / checked : 1, worstMissMs: worst },
    adShare: { total: airTime > 0 ? adTime / airTime : 0, byPosition: share },
    deadAirShare: airTime > 0 ? deadAir / airTime : 0,
    deadAirGaps: gaps,
    deadAirGapsPerDay: allDays.size > 0 ? (gaps.under15s + gaps.under1m + gaps.under5m + gaps.over5m) / allDays.size : 0,
    blocksWithNoAds: noAds,
    longShowsWithoutMidBreak: longNoMid,
    longestRunOfFillerMinutes: longestRun / MINUTE,
    repeatedProgramAirings: repeats,
  };
}
