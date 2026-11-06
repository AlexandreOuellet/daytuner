# Roadmap

## Release 1.0

DayTuner is pushed publicly only when it is a good working 1.0. Scope: everything in phases 1 to 5,
plus a metrics dashboard in the web interface (the numbers in [`metrics.md`](metrics.md) per channel
and over time, not only the preview printout), and a verified end-to-end run on a test copy of
Tunarr, including playback and the guide check.

## Phase 0: skeleton (now)
Repository, documentation, the verified API facts, and the script that verified them.

## Phase 1: the engine
- Write the planning code in `packages/engine`, with its tests, from the rules in
  [`planning-rules.md`](planning-rules.md): ad planner, water-filling, packing, fit-aware picking,
  grid and clock handling. There is no earlier implementation to port; the rules came from
  measurements of earlier runs.
- A pure `plan(schedule, library, state, window)` that returns lineup items and new state.
- Golden tests: the same schedule and seed always give the same lineup.

## Phase 2: Tunarr client and CLI
- Read the library; write manual lineups by appending. DayTuner never uses replace on a committed future.
- `preview` prints the metrics in [`metrics.md`](metrics.md) for any window.
- Run end to end on a test copy of Tunarr for one channel.

## Phase 3: state and worker
- Per channel: next episode of ordered shows, seeds, end of the lineup written, commit log.
- A top-up job that plans from the end of the lineup and appends.
- Open the remaining unknowns from [`tunarr-api.md`](tunarr-api.md): playback and guide checks, and
  how a synthetic multi-year lineup behaves (memory, startup time, `now_playing`).

## Phase 4: schedules and staging
- Schedules stored in the SQLite store, with revisions and rollback. Saving a revision dry-runs it
  against the locked staged slots and lists the ones that would no longer fit.
- Cursor adjustments (rewind, set) with the preview of which airing they change.
- Staging: generate into staging, edit, preview the difference with what is committed, commit.
- YAML import and export (see [`schedules/example.yaml`](../schedules/example.yaml)).

## Phase 5: web interface
- Plain, understandable configuration of ads, bumpers and filler: the main complaint about Tunarr.
- Edit schedules, preview, see what is scheduled, link to the channel in Tunarr.
- Stage a date range, edit a day in staging (delete, add, resize slots; pin programs), re-plan only what changed.
- Metrics dashboard: the metrics per channel and over time.

## Decided
- Name: DayTuner. Licence: MIT.
- Language: TypeScript.
- Storage: SQLite, schedules included. YAML import and export. No git sync.
- Three tiers: speculative, staging, committed (see [`architecture.md`](architecture.md)).
- Ordered shows never skip (as in Tunarr), with a cursor per slot and slot linking
  (`continue` and `rerun`). Skip and defer is not in 1.0.
- Lineups are append-only in 1.0: no trimming or rebasing, and the start time is never touched.
  About 1.2 to 1.4 MB per week per channel is acceptable. Collapsing the past into one flex item
  of the same total duration is a possible later optimisation, if measurements show a problem.
- Committed is final: no edits, no undo, no rewriting Tunarr's future. Tunarr always holds at least
  7 days ahead (configurable per channel). The worker adds 24 hours per run (configurable), or
  fills up to the floor, taking staged slots first and the planner otherwise.
- Staging holds fully generated planned slots (everything on the grid), after the committed edge. A
  **pin** fixes one block's program to a specific program (never a dynamic list); the rest of the
  planned slot is regenerated around the pins. A pin never resizes the slot: if the program does not
  fit, it shows an error and the slot must be extended by a separate action. A **lock** freezes a whole planned slot. If a locked
  slot no longer fits when it is reached, its pins are kept, the rest is regenerated and a conflict
  is recorded.
- Exceptions are worked on in staging: generate through a date, keep only the target range, edit it,
  and re-plan the changed slot, then regenerate from the end of the last committed slot through the rejoin point
  (the first slot after the edit that can be generated normally), locked slots fixed, so that it
  ends exactly there with no dead air; if that is impossible, show the gap.
- Staging may be non-contiguous (islands far ahead). Staged slots are fixed anchors: the planner
  fills the gap before one so that it ends exactly on it.
- Exceptions (special events) are schedule rules, optionally staged early. A specific program chosen
  for one is an explicit pick: off-cursor, it never affects the order of an ordered show.
- An explicit pick counts against a shuffled pool by default (marked as drawn from the bag) and is
  off-cursor for an ordered one. Overridable per exception.
- An ordered show's cursor advances only when a sequence episode has aired.
- Extending a planned slot over the slots after it (a 20:00 to 20:30 slot made into a movie night
  until 22:30): slots it entirely covers are removed from that day, and a slot it partly covers is
  cut back. If the cut-back slot cannot accommodate it, the preview warns, and any time the planner
  cannot fill shows as dead air.
- Ads and bumpers are two kinds of clip, each with its own filler list per position. Ads use head,
  pre, mid, post and tail; bumpers use head, pre, post and tail (none in mid breaks). Bumpers are
  outermost at head and tail and nearest the program at pre and post. Bumpers do not
  count toward the ads ratio, but add to the block's length so it still ends on the grid. Optional
  **interstitial** clips (Tunarr's `fallback`; music videos, PSAs and the like, one or several) fill
  a gap nothing else fills; what is left is dead air.
- Grid: the rule is about the block (the program plus its pre, mid and post ads and bumpers), not
  the bare program. A planned slot starts and ends on the grid. So does every block, except the
  first block of a slot with a head (it starts when the head ends) and the last block of a slot
  with a tail (it ends where the tail starts).
  The head does not have to be a grid multiple; its ads come in ad-step multiples. The tail takes
  what is left to the window's end. Head and tail minimums are reserved before blocks are picked.
  If things do not fit: pick another program and warn; warn for a sequential episode; if nothing
  fits at commit time, interstitials then dead air, with a loud warning.
- One water level over the last block and the tail, so the slot ends exactly on the grid; time
  left after the budget is full (interstitials, then dead air) sits before the tail. Head and tail
  ads count toward the ads ratio (minimum and maximum), attributed to the first and last block.
- Ordered shows can be adjusted by hand: rewind by k, or set to an episode (for a missed week). It
  affects the first uncommitted airing onward and is logged. The interface shows which airing it
  changes, since the committed floor means the next week is usually already final.
- Mid-break offers come from the program's chapters when it has eligible ones, otherwise from a
  fixed interval. The planner uses as many offers as the budget pays for, evenly spread.
- Overflow and lateness exist as in Tunarr, per schedule and per slot, and default to 0 so the
  grid stays exact.

## Open decisions
- **Ad and bumper interface.** The model is decided (see "Decided"). Still open: how the web
  interface shows the positions plainly.
