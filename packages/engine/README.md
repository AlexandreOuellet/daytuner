# @daytuner/engine

Pure planning code: no network, no database, no system clock. The same schedule, library, state and
seed always give the same lineup.

Rules: [`docs/planning-rules.md`](../../docs/planning-rules.md). Terms: [`docs/glossary.md`](../../docs/glossary.md).

## Layers

| File | What it does |
|---|---|
| `time.ts` | Whole-millisecond durations, grid arithmetic, rounding error carried between items |
| `clock.ts` | The schedule's time zone and daylight saving, with a stated rule for ambiguous times |
| `breaks.ts` | The rising water level: splits an ad budget across head, pre, mid, post and tail |
| `offers.ts` | Where mid breaks may go (chapters, else a fixed interval) and which to use |
| `block.ts` | One program with its ads and bumpers; the first block carries the head, the last the tail |
| `rng.ts` | A seeded random generator whose state is one number |
| `pools.ts` | Shuffled bags (fit-aware), ordered cursors, and manual cursor adjustments |
| `clips.ts` | Fills a planned length with whole clips (best fit, shortfall carried to the next break) |
| `schedule.ts` | The input and output shapes of `plan()` |
| `plan.ts` | `plan(input)`: slots on the clock, programs that fit, blocks, clips, reruns, exceptions, anchors |

## Not here yet

Pins, locks and staging (phase 4), and overflow and lateness above 0. Everything open is tracked in [`docs/status.md`](../../docs/status.md).

```
pnpm --filter @daytuner/engine test
```
