// Plain-text output for the CLI.
import type { Distribution, Metrics, PlanWarning } from '@daytuner/engine';

const f = (n: number, digits = 1): string => n.toFixed(digits);
const pct = (n: number, digits = 1): string => `${(n * 100).toFixed(digits)}%`;
const dist = (d: Distribution, scale = 1, digits = 1, unit = ''): string =>
  d.count === 0 ? 'no data' : `median ${f(d.median * scale, digits)}${unit}  p90 ${f(d.p90 * scale, digits)}${unit}  p99 ${f(d.p99 * scale, digits)}${unit}  max ${f(d.max * scale, digits)}${unit}  (n=${d.count})`;

export function formatMetrics(m: Metrics): string {
  const pos = Object.entries(m.adShare.byPosition).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k} ${pct(v)}`).join(', ');
  return [
    `Slots measured: ${m.slots}   Air time: ${f(m.airTime / 3_600_000)} h   Daylight-saving days left out: ${m.excludedDstDays}`,
    '',
    'Inside a show (ratio of the show length)',
    `  mid-roll / content        ${dist(m.midRollRatio, 100, 1, '%')}`,
    `  pre+mid+post / content    ${dist(m.adLoadRatio, 100, 1, '%')}`,
    '',
    'Where a viewer waits (minutes)',
    `  end of a slot             ${dist(m.endOfSlotMinutes)}`,
    `  between two programs      ${dist(m.betweenProgramsMinutes)}`,
    `  beginning of a slot       ${dist(m.beginningOfSlotMinutes)}`,
    `  slot ends over 10 min: ${m.slotEndsOver10}   over 30 min: ${m.slotEndsOver30}`,
    '',
    'Whole lineup',
    `  grid accuracy             ${pct(m.gridAccuracy.share)} of ${m.gridAccuracy.checked} boundaries, worst miss ${m.gridAccuracy.worstMissMs} ms`,
    `  ad time                   ${pct(m.adShare.total)} of air time (${pos || 'none'})`,
    `  dead air                  ${pct(m.deadAirShare, 2)} of air time; gaps <15s ${m.deadAirGaps.under15s}, <1m ${m.deadAirGaps.under1m}, <5m ${m.deadAirGaps.under5m}, longer ${m.deadAirGaps.over5m}; ${f(m.deadAirGapsPerDay, 2)} per day`,
    `  blocks with no ads        ${m.blocksWithNoAds}`,
    `  shows >= 25 min, no mid   ${m.longShowsWithoutMidBreak}`,
    `  longest run of filler     ${f(m.longestRunOfFillerMinutes)} min`,
    `  repeated airings          ${m.repeatedProgramAirings}`,
  ].join('\n');
}

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** `1@72000000` is Monday 20:00. */
export function slotLabel(slotId: string): string {
  const [day, at] = slotId.split('@').map(Number);
  if (day === undefined || at === undefined || Number.isNaN(day) || Number.isNaN(at)) return slotId;
  const h = String(Math.floor(at / 3_600_000)).padStart(2, '0');
  const m = String(Math.floor((at % 3_600_000) / 60_000)).padStart(2, '0');
  return `${DAY_LABELS[day] ?? day} ${h}:${m}`;
}

/** A moment in the schedule's own time zone, for example `2027-03-01 07:14`. */
export function inZone(ms: number, zone: string): string {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(ms));
  const g = (t: string): string => p.find((x) => x.type === t)?.value ?? '';
  return `${g('year')}-${g('month')}-${g('day')} ${g('hour')}:${g('minute')}`;
}

/** Replaces every program id in a message by its title. */
export function withTitles(message: string, titles: Readonly<Record<string, string>>): string {
  let out = message;
  for (const [id, title] of Object.entries(titles)) if (out.includes(id)) out = out.split(id).join(title);
  return out;
}

export function formatWarnings(warnings: readonly PlanWarning[], zone: string, titles: Readonly<Record<string, string>> = {}, max = 25): string {
  if (warnings.length === 0) return 'No warnings.';
  const order = { alert: 0, warning: 1, info: 2 } as const;
  const sorted = [...warnings].sort((a, b) => order[a.severity] - order[b.severity] || a.at - b.at);
  const counts = { alert: 0, warning: 0, info: 0 };
  for (const w of warnings) counts[w.severity]++;
  const lines = sorted.slice(0, max).map((w) => `  [${w.severity}] ${inZone(w.at, zone)} ${slotLabel(w.slotId)}: ${withTitles(w.message, titles)}`);
  if (sorted.length > max) lines.push(`  ... and ${sorted.length - max} more`);
  return `Warnings: ${counts.alert} alert, ${counts.warning} warning, ${counts.info} info\n${lines.join('\n')}`;
}
