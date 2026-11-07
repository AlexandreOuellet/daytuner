// What the daily run needs: when a channel is due, and a run that records how it ended. The timer itself is in
// apps/web; this stays free of timers so it can be tested with a clock.

import { startOfLocalDay, toEpoch, toLocal, type Ms } from '@daytuner/engine';
import { parseScheduleFile } from '@daytuner/schedule';
import type { ChannelRecord } from '@daytuner/store';
import { ConsistencyError, topUp, type TopUpResult, type WorkerDeps } from './worker.js';

/** The latest moment at or before `now` at which the channel's daily run was due, in the schedule's own zone. */
export function scheduledInstant(zone: string, runAtMinutes: number, now: Ms): Ms {
  const at = (epoch: Ms): Ms => {
    const l = toLocal(zone, epoch);
    return toEpoch(zone, { year: l.year, month: l.month, day: l.day, hour: Math.floor(runAtMinutes / 60), minute: runAtMinutes % 60 });
  };
  const today = at(now);
  return today <= now ? today : at(startOfLocalDay(zone, now) - 1);
}

/**
 * True when the channel's daily run has come due and has not been attempted since. A run that failed or was
 * refused counts as attempted: it is not tried again until the next day's time, so a problem is not hammered.
 * After a restart this makes up a run that was missed.
 */
export function isDue(ch: ChannelRecord, lastAttempt: Ms | undefined, now: Ms): boolean {
  const zone = parseScheduleFile(ch.schedule).timezone;
  return scheduledInstant(zone, ch.runAtMinutes, now) > (lastAttempt ?? Number.NEGATIVE_INFINITY);
}

/** Runs the worker for a channel (writing) and records how it ended, whoever started it. Rethrows a failure. */
export async function runAndRecord(deps: WorkerDeps, channelName: string): Promise<TopUpResult> {
  const { store, clock } = deps;
  const at = clock.now();
  try {
    const r = await topUp(deps, channelName);
    store.recordRun(channelName, at, r.action === 'appended' ? 'appended' : 'nothing-to-do', r.action === 'appended' ? `appended ${r.slots} slots` : 'the lineup reaches far enough ahead');
    return r;
  } catch (e) {
    store.recordRun(channelName, at, e instanceof ConsistencyError ? 'refused' : 'failed', e instanceof Error ? e.message : String(e));
    throw e;
  }
}
