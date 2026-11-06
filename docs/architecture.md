# Architecture

## Components

**Engine** (`packages/engine`) is pure code: durations in, lineup out. No network, no database,
no clock except the one it is given. It contains the slot packing, the ad planner, the pool
picking (shuffled, ordered, fit-aware), the grid and clock handling, and the rounding rules
([`planning-rules.md`](planning-rules.md)). Because it is pure, it is tested with plain unit tests
and can run anywhere: the CLI, a CI job, the web interface, a worker.

**Tunarr client** (`packages/tunarr-client`) reads the library and writes lineups. It wraps only
the endpoints in [`tunarr-api.md`](tunarr-api.md).

**Store** is a SQLite database on a volume. It holds, per channel: the schedule and its revisions,
the staged lineup, the next episode of each ordered show (for committed and for staged), shuffle
seeds, the end of the lineup already written, and a log of every commit. It is what makes
"continue where we left off" survive. One file to back up.

## Three tiers

A channel's lineup exists in three tiers, from the most uncertain to the most final:

| Tier | What it is | Where it lives |
|---|---|---|
| **Speculative** | What the engine could generate beyond what is staged. A projection, never stored. | Computed on demand |
| **Staging** | Fully generated planned slots written into DayTuner, after the committed edge. A planned slot holds everything: head, its blocks (pre, content, mid breaks, post, bumpers) and tail, on the grid. It can be edited or locked as a whole planned slot, and it can be committed. Optional: it may be empty. | The store |
| **Committed** | What is in Tunarr. **Final: once committed, a planned slot can never be edited or undone.** | Tunarr, plus the commit log |

As a timeline for one channel:

```
 now                                                                        time ->
  |<-- committed -->|<- staged ->|~~ planner ~~|<- staged: Halloween ->|~~ planner ~~ ...
   in Tunarr, final  next days     generic week   a month ahead         generated on demand
   at least 7 days   (optional)                   (an island)
```

The committed part is always at least the floor long. Staging has no fixed length and is not
contiguous: it may be empty, a day, a week, or islands far ahead, like a special night prepared a
month early. Everything between and after staged slots is whatever the planner would generate,
shown in the preview and used by the worker when staging has nothing for that stretch.

**Staged slots are fixed anchors at their start.** The planner fills the gap before a staged slot
so that its last block ends exactly where the staged one starts (the same rule as the end of a
window). If that cannot be done, a conflict is recorded rather than leaving a hole.

**Exceptions.** A special event is mainly done by working on the day in staging:
1. **Stage a range.** "Generate everything from now until the 31st, keep only the 31st." The
   planner simulates the whole stretch on a copy of the state (so cursors and bags are right on the
   31st), and stores only the kept range as a staged island. The days in between are discarded and
   generated normally later.
2. **Work on it.** The structure of the staged day can be edited (delete a slot, add a slot, extend
   or shorten a slot), and so can its content (pin a specific program, change a break). These edits
   apply to that planned day only and never change the schedule. For example, for "something unique
   from 20:00 to 22:30" on the 31st, either:
   - **replace:** delete the planned slots between 20:00 and 22:30, add a new slot there and pin a
     program to it (a new slot has no pool, so its content is a pin); or
   - **extend:** take the existing 20:00 slot, extend it to 22:30 and pin a program to it (it keeps
     its settings, such as its ad rules).

   Extending a slot over the slots after it removes the ones it covers entirely and cuts back a
   slot it covers partly; if that slot cannot accommodate the cut, the preview warns, and any time
   the planner cannot fill shows as dead air.

   A pin never resizes a slot. If a pinned program does not fit, the pin shows an error (how much
   it is over or under) and someone has to extend or shorten the slot as a separate action.
3. **Re-plan the slot.** The slot gets its ads, breaks and bumpers built for its pins and its
   length.
4. **Re-plan the day around it.** A change to one slot moves its neighbours, and planning only runs
   forward, so this means regenerating from the end of the last committed slot (the only point where
   the state is certain) through to the **rejoin point**: the first slot after the edited one
   that the planner can generate normally. Locked staged slots are fixed constraints inside that run.
   Unlocked ones before and after adjust (program, length, fit-aware picks) so the last block ends
   exactly where the rejoin slot starts, with no dead air. Only the kept range is stored.
5. **Check, then lock.** The preview reports the day's metrics and what the change did to the slots
   before and after it (dead air, a neighbour that no longer fits, long ad runs). If locked slots make a gap-free day
   impossible, it shows where the gap is instead of hiding or silently filling it. Lock the slots
   that are right. The worker commits them when it reaches the day.

A recurring event can also be a rule in the schedule (see `exceptions` in `schedules/example.yaml`),
which is a shortcut that generates the same thing every year. It can be staged early like any day.

A specific program chosen this way is an **explicit pick**. It is off-cursor (see below).

Generating writes speculative slots into staging. Committing appends staging to Tunarr. The
speculative tier is planned on a copy of the state and never saved.

**Committed floor.** Tunarr always holds at least a minimum of scheduled time ahead (7 days by
default, configurable per channel). Staging lives after that edge.

**Commit rule.** Each time it runs, the worker adds 24 hours (a configurable step), or fills up to
the floor if the channel is behind. For each stretch it regenerates everything from the end of the
last committed slot with the planner, keeping the locked staged slots as they are, and commits the
result. Unlocked staged slots are a pre-generated preview: because planning is deterministic, they
come out identical unless something changed. A locked slot is checked just before it is committed
(slot, grid, library, cursors). If it no longer fits, the worker keeps its pins and regenerates the
rest of that slot around them, and a conflict is recorded in the commit log and shown in the
preview. The floor is never missed.

**Editing: pin and lock.**
- A **pin** fixes the program of one block inside a staged slot. It chooses a specific program (a
  particular movie or episode), never a dynamic list such as "next episode of this show" or
  "something from this pool", so a pin is an explicit pick.
- When a slot has pins, everything else in that planned slot is regenerated around them: the other
  blocks, every ad and bumper (including those of the pinned blocks, rebuilt for their length), head,
  tail and padding. The regeneration stays inside the slot's window. A pin never changes the slot's
  length: if the pinned program does not fit, the pin reports an error and someone has to extend
  the slot (see the workflow above).
- A **lock** freezes a whole planned slot as it is, pins and generated parts alike, so it is not
  regenerated later. Any planned slot can be locked. Unlocked slots are regenerated before they are
  committed, with their pins kept.
- If a locked slot no longer fits when it is reached (the cursor moved, the grid changed, a program
  left the library), its pins are kept and the rest is regenerated, and a conflict is recorded. So
  your choices are never discarded, and the lineup never gets a hole.
- Nothing committed is ever edited, so DayTuner never rewrites Tunarr's future.

**Episode cursors.** An ordered show's cursor advances only when an episode produced by the
sequence has actually aired (its time has passed in the committed lineup). Planning ahead projects
the cursor through committed slots that have not aired yet and through staged slots produced by
the sequence. If such a staged slot is removed or its episode replaced, that episode is back in
line and plays next. Nothing is lost.

**Explicit picks are off-cursor.** A slot or block that plays a specific program chosen by the user (for
example the Doctor Who Halloween special) never reads or moves any cursor. The show's order is
untouched, and the special airs in addition to the sequence. If the same program later comes up in
the sequence, it plays again.

**Counting against a shuffled pool.** A shuffled pool is a bag: each program is drawn once before
any repeats. An explicit pick can `count` against a pool, which marks the program as drawn from the
current bag, so the shuffle does not serve it again soon (for example *The Nightmare Before
Christmas* in a kids movies pool). Defaults when the pick belongs to a pool in the schedule: an
ordered pool is not counted, a shuffled pool is counted. Either can be overridden per exception.

**Worker** tops each channel up on a schedule (for example daily) following the commit rule above.
It only appends. It never touches the past, the present or anything already committed.

**CLI** (`apps/cli`) does the same planning on demand: `preview` prints the metrics for a
schedule, `apply` commits it. It also imports and exports schedules as YAML.

**Web interface** (`apps/web`) edits schedules, shows the preview and its metrics, shows what is
scheduled, and links to the matching channel in Tunarr. Later phase, but part of 1.0.

## Data flow

1. A channel's schedule (stored in DayTuner, see `schedules/example.yaml` for the YAML form) defines
   slots, pools and ad settings.
2. The client reads the library from Tunarr (programs, shows, filler lists).
3. The engine plans a window of time starting at the end of the staged lineup (or of the committed
   one if nothing is staged), and every slot it produces is complete.
4. The preview computes the metrics for that window, and the difference between staging and what
   is committed.
5. On commit, the client appends the planned slots to Tunarr and the store records what was written.
   Committing is final.
6. A guide refresh is requested for the media server that reads Tunarr's guide.

## Schedules and revisions

Saving a revision first dry-runs it against what is already staged: the preview lists the locked
slots that would stop fitting (for example after a grid change or a moved slot), so they can be
fixed or unlocked before the change is saved. The check at commit time stays as a safety net for
what cannot be known in advance, mainly a program that leaves Tunarr's library.

Schedules live in the store, like the configuration of the other *arr applications. Every change
is a revision, and the preview shows, before it is saved, what it does: for example that a new
layout lowers the median wait after a show but leaves 4% of windows with more than 30 minutes
unused. YAML import and export is there for backup and sharing. Syncing with git is not planned.

## Deployment

Runs next to Tunarr as one container with a config volume holding the SQLite database (the
interface, the API and the worker run together; the worker can also be run as a separate job). It
needs access to Tunarr's API, and the Tunarr address and any credentials come from environment
variables or secrets.

## Risks and rules

- Someone saving a channel in Tunarr's own interface will overwrite what this project wrote.
  Channels managed here should be marked as such, and edited only here.
- Tunarr is the source of truth for the library. If media moves, the plan is recomputed.
- Never move a channel's start time. See [`tunarr-api.md`](tunarr-api.md).
