// What the engine is given: the schedule, the library and the state. Plain data, no behaviour.
// The schedule file format (YAML) and the reading of Tunarr's library are not the engine's job: the
// caller turns them into these shapes, with pools already resolved to program ids.

import type { Range } from './breaks.js';
import type { Chapter, OfferRule } from './offers.js';
import type { BagState, SequenceState } from './pools.js';
import type { RngState } from './rng.js';
import type { Clip } from './clips.js';
import type { Ms } from './time.js';

/** An ad position and the clip list its ads come from. */
export interface AdPosition {
  list: string;
  range: Range;
}

export interface AdSettings {
  /** Planned lengths are multiples of this (15 seconds). */
  step: Ms;
  /** Ads as a share of the program: 0.15 is 15%. Head and tail count; bumpers do not. */
  ratio: { min: number; max: number };
  head?: AdPosition;
  pre?: AdPosition;
  post?: AdPosition;
  tail?: AdPosition;
  mid?: AdPosition & { offers: OfferRule; minGap?: Ms };
}

/** Bumpers have no mid position. Each position names its own clip list. */
export interface BumperSettings {
  head?: { list: string };
  pre?: { list: string };
  post?: { list: string };
  tail?: { list: string };
}

export interface Pool {
  order: 'ordered' | 'shuffled';
  /** Program ids. For an ordered pool, the order of play. */
  programs: readonly string[];
}

export interface SlotDef {
  /** 0 is Sunday. */
  day: number;
  /** Time of day on the grid, in milliseconds after local midnight. */
  at: Ms;
  pool: string;
  /** `continue` shares one head with the other slots of the same name. `rerun` replays behind it. */
  link?: { name: string; mode: 'continue' | 'rerun' };
}

export interface ExceptionDef {
  /** A date in the schedule's time zone. Without `year` it repeats every year. */
  on: { month: number; day: number; year?: number };
  /** It replaces the slot that starts at this time of day. */
  at: Ms;
  programId: string;
  /** A shuffled pool this pick counts against. By default, the replaced slot's pool if it is shuffled
   *  and holds the program. `false` counts against none. */
  counts?: string | false;
}

export interface Schedule {
  grid: Ms;
  /** An IANA time zone, such as America/Toronto. */
  zone: string;
  ads: AdSettings;
  bumpers: BumperSettings;
  interstitial?: { list: string };
  pools: Record<string, Pool>;
  week: readonly SlotDef[];
  exceptions: readonly ExceptionDef[];
}

export interface Program {
  duration: Ms;
  /** The length with its fraction, as Tunarr counts it. Planning ignores it; writing a lineup uses it to keep programs on the grid. */
  exact?: number;
  chapters?: readonly Chapter[];
}

export interface Library {
  programs: Record<string, Program>;
  /** Clip lists by name: ads, bumpers and interstitials. */
  clips: Record<string, readonly Clip[]>;
}

/** Everything the next run needs from the last one. Plain data, so it can be stored. */
export interface PlanState {
  rng: RngState;
  /** Ordered pools, by sequence key. A linked group shares one key. */
  sequences: Record<string, SequenceState>;
  /** Shuffled pools and every clip list, by bag key. */
  bags: Record<string, BagState>;
}

export const emptyPlanState = (seed: number): PlanState => ({ rng: seed >>> 0, sequences: {}, bags: {} });

export type ItemPosition = 'head' | 'pre' | 'mid' | 'post' | 'tail' | 'gap';

export type Item =
  /** A piece of a program: a mid break splits one program into several pieces. */
  | { kind: 'content'; programId: string; startOffset: Ms; duration: Ms }
  | { kind: 'filler'; role: 'ad' | 'bumper' | 'interstitial'; position: ItemPosition; list: string; clipId: string; duration: Ms }
  /** Dead air. */
  | { kind: 'flex'; duration: Ms };

export interface PlannedSlot {
  /** `day@time`, for example `1@72000000`. */
  slotId: string;
  start: Ms;
  end: Ms;
  pool: string;
  programs: string[];
  /** The blocks in order. A block starts where the previous one ended; the first starts at the slot's
   *  start (head included) and the last ends at the slot's end (tail included). */
  blocks: { programId: string; start: Ms; end: Ms; pinned?: true }[];
  /** True when an exception replaced the slot's normal programming. */
  exception: boolean;
  items: Item[];
}

export type WarningSeverity = 'info' | 'warning' | 'alert';

export type PlanWarningCode =
  | 'dead-air'
  | 'nothing-fits'
  | 'programs-skipped-for-fit'
  | 'repeat-pick'
  | 'place-moved'
  | 'place-lost'
  | 'pool-changed'
  | 'edge-drift'
  | 'sequential-does-not-fit'
  | 'exception-does-not-fit'
  | 'rerun-short-history'
  | 'started-mid-slot'
  | 'exception-matches-no-slot'
  | 'locked-slot-conflict'
  | 'pin-does-not-fit'
  | 'pin-dropped'
  | 'block';

export interface PlanWarning {
  code: PlanWarningCode;
  severity: WarningSeverity;
  at: Ms;
  slotId: string;
  message: string;
}

export interface PlanInput {
  schedule: Schedule;
  library: Library;
  state: PlanState;
  /** Where planning starts: usually a slot start on the grid. */
  from: Ms;
  /** Plan every slot that starts before this. */
  to: Ms;
  /** True when planning must end exactly at `to`: a window that contains it is cut there. */
  exact?: boolean;
  /**
   * Slots that are locked: each is used exactly as it is stored when the window it came from still holds.
   * One that no longer fits is planned again and reported in `conflicts`.
   */
  locked?: readonly PlannedSlot[];
  /**
   * Programs pinned to blocks of the slot that starts at `start`: block number (1 is the first) to a program
   * id. A pinned block is an explicit pick: it never reads or moves a cursor or a bag. A pin never resizes the
   * slot; one that does not fit, or names a block the slot does not have, is dropped with a warning.
   */
  pins?: readonly { start: Ms; blocks: Readonly<Record<number, string>> }[];
  /**
   * Windows shaped by hand. Where one lies, the schedule's windows give way: one that began before it ends
   * where it starts, one that reaches past it carries on from its end.
   */
  windows?: readonly StagedWindow[];
}

/**
 * A window the owner shaped by hand (resized, cut back, or added): it replaces the schedule's own windows in
 * its span. `slotId` names the week slot it comes from (`day@time`), or begins with `added@` for a slot with no
 * pool, whose content is only what is pinned to it.
 */
export interface StagedWindow {
  start: Ms;
  end: Ms;
  slotId: string;
}

export type LockConflictReason = 'window-changed' | 'program-gone' | 'duration-changed' | 'clip-gone';

/** A locked slot that could not be used as stored. */
export interface LockConflict {
  /** The locked slot's start, and the week slot it came from. */
  start: Ms;
  slotId: string;
  reason: LockConflictReason;
  message: string;
}

export interface PlanResult {
  slots: PlannedSlot[];
  state: PlanState;
  warnings: PlanWarning[];
  /** Locked slots that failed their check and were planned again. */
  conflicts: LockConflict[];
}
