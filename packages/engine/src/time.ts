// Time and grid arithmetic. Pure: everything here works on integer milliseconds.
// Rules: docs/planning-rules.md, "The grid".

/** A duration or an instant, in whole milliseconds. Never a fraction. */
export type Ms = number;

export const SECOND: Ms = 1_000;
export const MINUTE: Ms = 60 * SECOND;
export const HOUR: Ms = 60 * MINUTE;
export const DAY: Ms = 24 * HOUR;

/** Throws unless `value` is a whole number of milliseconds. */
export function assertMs(value: number, what = 'duration'): asserts value is Ms {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${what} must be a whole number of milliseconds, got ${value}`);
  }
}

function assertGrid(grid: Ms): void {
  assertMs(grid, 'grid');
  if (grid <= 0) throw new RangeError(`grid must be positive, got ${grid}`);
}

/** Distance of `t` past the previous grid line, always in [0, grid). */
function offsetOnGrid(t: Ms, grid: Ms, origin: Ms): Ms {
  const r = (t - origin) % grid;
  return r < 0 ? r + grid : r;
}

/** The first grid line at or after `t`. The grid lines are `origin + k * grid`. */
export function ceilToGrid(t: Ms, grid: Ms, origin: Ms = 0): Ms {
  assertMs(t, 'time');
  assertGrid(grid);
  const r = offsetOnGrid(t, grid, origin);
  return r === 0 ? t : t + (grid - r);
}

/** The last grid line at or before `t`. */
export function floorToGrid(t: Ms, grid: Ms, origin: Ms = 0): Ms {
  assertMs(t, 'time');
  assertGrid(grid);
  return t - offsetOnGrid(t, grid, origin);
}

export function isOnGrid(t: Ms, grid: Ms, origin: Ms = 0): boolean {
  assertMs(t, 'time');
  assertGrid(grid);
  return offsetOnGrid(t, grid, origin) === 0;
}

/**
 * Turns real-valued durations into whole milliseconds without drift. The rounding error of each
 * value is carried into the next one, so the running total is always the exact total rounded:
 * `sum(result) === Math.round(sum(values))`, and no prefix is off by more than half a millisecond.
 */
export function roundWithCarry(values: readonly number[]): Ms[] {
  const out: Ms[] = [];
  let exact = 0;
  let emitted = 0;
  for (const v of values) {
    if (!Number.isFinite(v) || v < 0) throw new RangeError(`cannot round ${v}`);
    exact += v;
    const upTo = Math.round(exact);
    out.push(upTo - emitted);
    emitted = upTo;
  }
  return out;
}

/** Splits `total` into `parts` whole-millisecond pieces that differ by at most 1 and sum to `total`. */
export function splitEvenly(total: Ms, parts: number): Ms[] {
  assertMs(total, 'total');
  if (!Number.isInteger(parts) || parts <= 0) throw new RangeError(`parts must be a positive integer, got ${parts}`);
  if (total < 0) throw new RangeError(`total must not be negative, got ${total}`);
  const out: Ms[] = [];
  let emitted = 0;
  for (let i = 1; i <= parts; i++) {
    const upTo = Math.floor((total * i) / parts);
    out.push(upTo - emitted);
    emitted = upTo;
  }
  return out;
}
