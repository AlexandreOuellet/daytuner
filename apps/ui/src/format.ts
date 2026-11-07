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

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** `1@72000000` is "Mon 20:00". */
export function slotLabel(slotId: string): string {
  const [day, at] = slotId.split('@').map(Number);
  if (day === undefined || at === undefined || Number.isNaN(day) || Number.isNaN(at) || day < 0) return slotId;
  return `${DAY_NAMES[day] ?? day} ${clock(Math.floor(at / 60_000))}`;
}

/** Up to two names, then "(+N)". */
export function nameList(ids: readonly string[], titles: Readonly<Record<string, string>>): string {
  if (ids.length === 0) return 'nothing';
  return ids.slice(0, 2).map((id) => titles[id] ?? id).join(', ') + (ids.length > 2 ? ` (+${ids.length - 2})` : '');
}

/** 150000 is "2:30". */
export const mmss = (ms: number): string => `${Math.floor(ms / 60_000)}:${String(Math.round((ms % 60_000) / 1000)).padStart(2, '0')}`;

/** Minutes with at most one decimal: 90000 is "1.5". */
export const minutes = (ms: number): string => String(Number((ms / 60_000).toFixed(1)));
