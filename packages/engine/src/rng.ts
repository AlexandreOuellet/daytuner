// A seeded random generator whose whole state is one number, so it can be stored and replayed.
// Pure: every function takes a state and returns the next one. The same seed gives the same lineup.

/** The generator's state: an unsigned 32-bit integer. */
export type RngState = number;

/** Turns a seed (a number or a string, such as a channel name) into a starting state. */
export function seedFrom(seed: string | number): RngState {
  if (typeof seed === 'number') {
    if (!Number.isSafeInteger(seed)) throw new RangeError(`seed must be a whole number, got ${seed}`);
    return seed >>> 0;
  }
  // FNV-1a
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** The next number in [0, 1) and the next state (mulberry32). */
export function nextFloat(state: RngState): [value: number, next: RngState] {
  const next = (state + 0x6d2b79f5) >>> 0;
  let t = next;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return [((t ^ (t >>> 14)) >>> 0) / 4294967296, next];
}

/** A whole number from 0 up to but not including `n`. */
export function nextInt(state: RngState, n: number): [value: number, next: RngState] {
  if (!Number.isInteger(n) || n <= 0) throw new RangeError(`n must be a positive integer, got ${n}`);
  const [f, next] = nextFloat(state);
  return [Math.floor(f * n), next];
}

/** A shuffled copy (Fisher-Yates). The input is not changed. */
export function shuffle<T>(items: readonly T[], state: RngState): [shuffled: T[], next: RngState] {
  const out = [...items];
  let s = state;
  for (let i = out.length - 1; i > 0; i--) {
    let j: number;
    [j, s] = nextInt(s, i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return [out, s];
}
