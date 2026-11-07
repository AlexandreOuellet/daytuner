# Staging: design note

The behaviour is decided in [`architecture.md`](architecture.md) (the staging workflow, pins and locks,
conflicts, "Phase 4 storage"). This note says how the engine, the store and the worker change to build it,
in slices that can each be finished and tested alone.

## What exists

- `plan({schedule, library, state, from, to, exact})` turns the week into windows (`windowsFor`), then plans
  each window into a `PlannedSlot` (blocks, items), moving the state (rng, ordered shows' places, bags).
- Anchored planning (`exact`) cuts the last window at `to`.
- The store holds, per channel, the state at the committed edge; the worker plans forward from the edge and
  appends.
- Nothing is staged: the worker always plans fresh.

## The model

A **staged slot** is a planned slot kept in the store, keyed by channel and start instant:

| Field | Meaning |
|---|---|
| `start`, `end` | The window it owns. It may differ from the week's slot (resized), or have no week slot (added) |
| `pool` | The pool it draws from, or none for an added slot whose content is pins only |
| `link` | Optional slot link (`continue` or `rerun`), as in the week |
| `pins` | Block number (1 for the first block of the slot) to a program id |
| `locked` | True when the slot is frozen as it is |
| `planned` | The `PlannedSlot` as last generated (items and blocks), for the preview and for a lock |

A staged slot is a **fixed anchor at its start**: everything before it is planned so its last block ends
exactly there (existing rule).

## Engine changes

1. **`PlanInput.staged`**: a list of staged slots. `windowsFor` takes them as windows in place of the week's
   windows they overlap: a week slot entirely covered is dropped, one partly covered is cut back (the
   rule in `architecture.md`). A staged slot with no `pool` has only pinned blocks.
2. **Pins in `placeBlocks`.** A new `Source` kind `pinned` places the pinned programs at their block
   numbers and draws the other blocks from the slot's pool as today. Pinned programs are explicit picks:
   they never read or move a cursor or a bag. A pin that does not fit the window is an error warning
   (`pin-does-not-fit`, with how much it is over or under) and the block is planned from the pool instead.
   The window never resizes.
3. **Locks.** A locked slot is not planned: its stored `planned` items are used as they are, after a
   validity check (see Conflicts). Its effect on the state is applied as the planner would have: ordered
   shows advance by the episodes the slot took from the sequence, bags are marked with the programs and
   clips it used. The random generator's position is not replayed (it would need storing), so the plan after a lock can differ from the plan without it in which clips and movies come up next; it stays deterministic for the same inputs.
4. **Conflicts (built).** `PlanResult.conflicts`: for each locked slot that failed its check, the slot, the reason
   (`program-gone`, `duration-changed`, `clip-gone`, `window-changed`, `grid-changed`) and what was done.
   The engine regenerates the slot with its pins kept, as an unlocked slot, and reports it. A slot that
   passes is used as stored.
5. **`plan()` stays pure.** The staged slots come in as data. The engine does not read the store.

## Store changes

- A `staged_slots` table: channel, start, end, pool, link, pins (JSON), locked, planned (JSON), and when it
  was last generated. Primary key (channel, start).
- Staged slots only exist after the committed edge. Committing a staged slot removes it from staging in
  the same transaction that completes the commit.

## Worker changes

- `topUp` loads the channel's staged slots after the edge and passes them to `plan()`. Unlocked staged
  slots are a preview only: the worker plans them again, so they come out the same unless something
  changed (deterministic), and pins on an unlocked slot are kept.
- The commit log records each conflict.
- After a commit the staged slots it used are removed; the rest stay.

## CLI (first, before the web interface)

```
daytuner stage <channel> generate --from DATE --to DATE [--keep DATE..DATE]
daytuner stage <channel> show [--from DATE --to DATE]
daytuner stage <channel> pin <slot-start> <block> <program>     (a program picked by title or id)
daytuner stage <channel> unpin <slot-start> <block>
daytuner stage <channel> lock | unlock <slot-start>
daytuner stage <channel> delete <slot-start>
daytuner stage <channel> clear [--from DATE --to DATE]
```

`show` marks locked slots, pinned blocks, and any conflict the next commit would record.

## Slices, in order

1. **Store and read-only staging (built).** The table, `stage generate` (plan a range on a copy of the state, keep
   a part), `stage show`, `stage clear`. The worker ignores staging. Tests on the store and generate.
2. **Locks (built).** Engine: staged windows, lock replay with the state effect, the validity check. Worker uses
   staged slots. `stage lock`, `unlock`. Tests: a locked slot is committed exactly as stored; the shows' places
   afterwards equal planning it normally.
3. **Pins (built).** Engine `pinned` source and the pin warnings. `stage pin`, `unpin`. Tests: a pin never moves
   a cursor, never resizes the slot.
4. **Conflicts.** The validity checks, the regeneration and the log entry came with slice 2 (reasons: `window-changed`,
   `program-gone`, `duration-changed`, `clip-gone`). Regeneration keeps the slot's pins (slice 3). What is left: showing the conflicts a commit would record in `stage show`.
5. **Structure edits (built).** Delete, add, resize a slot; cutting the neighbours. Tests on the cut rules.
6. **Preview diff (built).** What a change did to the slots around it, before commit. Revision dry-run against
   locked slots (from `architecture.md`).

## Decided

- **A pin is addressed by block number** inside the slot (1 is the first block). Regenerating the slot can
  change how many blocks there are; a pin on a block that no longer exists is dropped with a warning.
- **A lock applies the state effect the slot would have had** (ordered shows advance, bags are marked), so
  locking a slot never changes what comes after it.
- **The range to keep is written in local dates and times** in the channel's time zone: `2026-10-31` is that
  whole local day from midnight, `2026-10-31T20:00` an exact local time.

## Choices made while building

- **`stage generate` over a locked slot keeps it.** Unlocked staged slots in the range are replaced (their pins stay);
  locked ones are used as stored. It does not refuse.
- **A pin needs an unlocked staged slot.** Unlock it to change its pins.
- **A pin keeps the program's length** as read when it was pinned, because the program may be in no pool. If a pool also
  holds it, the library's length is used.
- **Pins are written as text:** `movie:Title` or `episode:Show/Episode title`.
- **A pin that does not fit** is an alert, and the block is planned from the pool as if there were no pin; the
  warning says how many minutes the program lasts and how many remain.
- **Shaped windows.** A staged slot that was resized, cut back or added is `edited`, and is handed to the engine as a
  window (`PlanInput.windows`); the schedule's windows give way around it. A window that began before it ends where
  it starts, and one that reaches past it carries on from its end.
- **Delete** extends the staged slot just before it. **Resize** takes a new end on the grid: the start never moves,
  slots it covers are removed, one it partly covers starts where this one ends, and when it shrinks the slot after it
  starts earlier. **Add** takes a start, an end and a pin: it has no pool, only the pinned program (anything else in it
  is filler, then dead air), and slots it overlaps are cut around it, one that contains it split in two.
- **Any change plans everything staged after it again**, because it moves the places of the shows downstream.
- **The preview diff** (`SlotChange`, `diffSlots` in the engine) matches slots by where they start and reports only the
  ones that changed: new, removed, a different window or programs, with before and after and the dead air when it moved by
  15 s or more. Slots that kept their programs and only had their ads reshuffled are counted, not listed. It is printed
  after every edit and pin, and by `stage diff`, which compares the staged slots with planning the schedule fresh.
- **Saving a schedule revision with staged slots** dry-runs it (`revisionImpact`): the staged range planned under the
  current and the new schedule, with the same locks, pins and shapes. With locked slots that would not fit, nothing is saved
  until `--yes`; the slots are then planned again at commit time and the log records why.
