// The dashboard's health of a channel: a few checks against the owner's targets (see docs/web-dashboard.md).

import type { Clock } from '@daytuner/engine';
import { parseScheduleFile } from '@daytuner/schedule';
import type { ChannelRecord, CommitMetricsRecord, RunRecord } from '@daytuner/store';

export interface HealthCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface Health {
  status: 'ok' | 'needs-attention';
  checks: HealthCheck[];
  /** The numbers on the card. Those from the last commit are missing until a commit with metrics exists. */
  headline: { aheadMs: number; adLoad?: number; deadAirShare?: number; repeats?: number; alerts?: number };
}

const days = (ms: number): string => `${(ms / 86_400_000).toFixed(1)} days`;
const pct = (n: number, d = 2): string => `${(n * 100).toFixed(d)}%`;

export function evaluateHealth(input: {
  channel: ChannelRecord;
  last: CommitMetricsRecord | undefined;
  lastRun: RunRecord | undefined;
  clock: Clock;
}): Health {
  const { channel: ch, last, lastRun } = input;
  const t = ch.targets;
  const aheadMs = ch.edge - input.clock.now();
  const checks: HealthCheck[] = [];
  const check = (name: string, ok: boolean, detail: string): void => void checks.push({ name, ok, detail });

  check('Committed ahead', aheadMs >= ch.floorMs, `${days(aheadMs)} ahead (the floor is ${days(ch.floorMs)})`);
  if (lastRun) {
    const bad = lastRun.outcome === 'refused' || lastRun.outcome === 'failed';
    check('Last run', !bad, bad ? `the last run ${lastRun.outcome}: ${lastRun.message}` : `the last run: ${lastRun.outcome}`);
  }

  const headline: Health['headline'] = { aheadMs };
  if (last) {
    const m = last.metrics;
    const ratio = t.adLoadRange ?? parseScheduleFile(ch.schedule).ads.ratio;
    headline.adLoad = m.adLoadRatio.median;
    headline.deadAirShare = m.deadAirShare;
    headline.repeats = m.repeatedProgramAirings;
    headline.alerts = last.alerts;
    check('Dead air', m.deadAirShare <= t.deadAirMaxShare, `${pct(m.deadAirShare)} of air time (target: at most ${pct(t.deadAirMaxShare)})`);
    check('Ad load', m.adLoadRatio.count === 0 || (m.adLoadRatio.median >= ratio.min && m.adLoadRatio.median <= ratio.max), `median ${pct(m.adLoadRatio.median, 1)} of a show's length (target: ${pct(ratio.min, 0)} to ${pct(ratio.max, 0)})`);
    check('End of a slot', m.endOfSlotMinutes.p90 <= t.endOfSlotP90MaxMinutes, `90% of slot ends wait at most ${m.endOfSlotMinutes.p90.toFixed(1)} min (target: ${t.endOfSlotP90MaxMinutes})`);
    check('Alerts in the last commit', last.alerts <= t.maxAlerts, `${last.alerts} alert(s) (target: at most ${t.maxAlerts})`);
    check('Repeats', m.repeatedProgramAirings <= t.maxRepeats, `${m.repeatedProgramAirings} repeated airing(s) (target: at most ${t.maxRepeats})`);
  }
  return { status: checks.every((c) => c.ok) ? 'ok' : 'needs-attention', checks, headline };
}
