export const DAY = 86_400_000;

export const days = (ms: number): string => `${(ms / DAY).toFixed(1)} days`;
export const pct = (n: number, digits = 1): string => `${(n * 100).toFixed(digits)}%`;

/** "2026-11-14 19:59" in the given time zone. */
export function inZone(ms: number, zone: string): string {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(ms));
  const g = (t: string): string => p.find((x) => x.type === t)?.value ?? '';
  return `${g('year')}-${g('month')}-${g('day')} ${g('hour')}:${g('minute')}`;
}

export const clock = (minutes: number): string => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
