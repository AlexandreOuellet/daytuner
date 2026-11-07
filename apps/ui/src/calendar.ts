// Dates for the calendar of special days. Dates are plain "YYYY-MM-DD" strings in the schedule's own zone, so no
// time zone arithmetic is needed: only which day of the week a date is, and how many days a month has.

import type { ExceptionModel } from './api';

export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export const pad = (n: number): string => String(n).padStart(2, '0');
export const dateText = (y: number, m: number, d: number): string => `${y}-${pad(m)}-${pad(d)}`;
export const weekdayOf = (y: number, m: number, d: number): number => new Date(Date.UTC(y, m - 1, d)).getUTCDay();
export const daysIn = (y: number, m: number): number => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** The twelve months from the one containing `today` ("2026-11-07"). */
export function monthsFrom(today: string, count = 12): { year: number; month: number }[] {
  const [y, m] = today.split('-').map(Number) as [number, number];
  return Array.from({ length: count }, (_, i) => ({ year: y + Math.floor((m - 1 + i) / 12), month: ((m - 1 + i) % 12) + 1 }));
}

/** Weeks of a month, Sunday first, with `null` where the month does not reach. */
export function monthWeeks(year: number, month: number): (number | null)[][] {
  const lead = weekdayOf(year, month, 1);
  const cells: (number | null)[] = [...Array<null>(lead).fill(null), ...Array.from({ length: daysIn(year, month) }, (_, i) => i + 1)];
  while (cells.length % 7 !== 0) cells.push(null);
  return Array.from({ length: cells.length / 7 }, (_, w) => cells.slice(w * 7, w * 7 + 7));
}

/** Does this special day fall on the date? */
export const fallsOn = (e: ExceptionModel, date: string): boolean => {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return e.on.month === m && e.on.day === d && (e.on.year === undefined || e.on.year === y);
};

export const playName = (e: ExceptionModel): string => ('movie' in e.play ? e.play.movie : `${e.play.show}: ${e.play.title}`);
