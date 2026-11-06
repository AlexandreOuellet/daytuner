# Planning rules

The rules the engine must implement. They come from running real schedules and measuring them.
Terms are defined in [`glossary.md`](glossary.md).

## The grid

- A planned slot starts and ends on the grid (for example every 15 minutes), exactly. So do the
  blocks, except at the two edges: the first block of a slot that has a head (head bumper and head
  ads) starts when the head ends, and the last block of a slot that has a tail ends where the tail
  starts. Either can be off the grid. Every other block start and end is on it. The grid rule is
  about the block (the program plus its pre, mid and post ads and bumpers), not the bare program.
- Every duration written to the lineup is a whole number of milliseconds, and the rounding error
  is carried into the next item. Without this, a few milliseconds a block added up to minutes
  over a year, and 93% of blocks ended up more than 10 seconds off the grid.
- A slot ends exactly where its window ends. No tolerance, no overflow, no lateness: a late window
  was shown to push the delay into the next window, again and again.

## Blocks

- A block is one program plus what is around it: pre, mid breaks, post, bumpers. A **planned slot**
  (a slot fully generated for a day) holds its head, one or more blocks, and its tail. The planned
  slot is what is staged, locked and committed (see [`glossary.md`](glossary.md)).
- A block ends at the first grid point at or after `start + content + bumpers + max(minimum ads,
  required ads)`. Required ads are the minimums of every position that applies (pre, mid and post
  for a program). A bumper's length is known once its clip is picked.
- The head is its bumper clips plus its ads (at least the range minimum, in multiples of the ad
  step). It does not have to be a grid multiple. The tail is reserved the same way (its minimum).
  Head and tail minimums belong to the planned slot and are reserved before blocks are picked.
- **One water level, tails included.** The last block and the tail are planned together and end
  exactly where the slot ends: head, pre, mid, post and tail rise together (see Ad positions). When
  the ad budget is full and time remains, that time (interstitials, then dead air) sits between the
  last block and the tail, so the tail stays at the slot's end. A slot with no tail has the same gap
  at its end, before the next slot.
- **Not enough room.** If the blocks plus the head and tail minimums do not fit the window, pick
  another program that does fit and warn (for example "20 episodes won't fit this slot", "20 movies
  won't fit this slot"). A sequential episode that cannot fit also warns (it is never skipped, see
  Picking programs). If nothing fits and the slot must be committed, the gap is filled by
  interstitials, then dead air, with a loud warning when scheduling and planning.
- **Head and tail ads count toward the ratio**, both its minimum and its maximum, attributed to
  the first block (head) and the last block (tail) of the planned slot. A one-block slot counts all
  five positions. Bumpers never count. The price is that the first and last blocks of a multi-block
  slot hold fewer ads in their breaks than the blocks between.
- **The ad ratio is a cap on ads inside the block, not a promise to fill it.** On a 15-minute
  grid a 22-minute show gets a 30-minute block; the 8 minutes of room are 36% of the show.
  Either ads fill it, or something else must.

## Ads, bumpers and interstitials

- Two kinds of clip, each with its own list per position. **Ads**: head, pre, mid, post, tail.
  **Bumpers**: head, pre, post, tail (none in mid breaks).
- Order at the edges: bumpers sit outermost at head and tail, and nearest the program at pre and
  post. A slot starts head bumper, head ads, pre ads, pre bumper, program. A program ends with post
  bumper, post ads, then tail ads and tail bumper at the end of the slot.
- **Bumpers do not count toward the ads ratio**, but they do add to the block's length, which is how
  the block still ends on the grid (see Blocks), except before a tail.
- Leftover time that nothing fits is filled by **interstitials**: one or several clips from an
  optional list (music videos, PSAs and the like), chosen to fit. What they cannot fill is dead air.
  With no interstitial list configured it is all dead air.

## Ad positions

- Mid-break positions are *offers*, and the planner chooses which offers become breaks. Times are
  **content time** (ads and bumpers do not count). Offers come from the program's chapters when it
  has eligible ones: a break at the end of each eligible chapter (types `break` and `chapter` by
  default), never at the very end. A program with no eligible chapters gets an offer every N
  minutes instead. A tail buffer removes offers close to the end, for both sources.
- **Choosing among offers**: use every offer if all the minimums fit the budget. Otherwise use the
  largest number whose minimums fit, taking the subset whose gaps (including the start and the end)
  are closest to equal. An optional minimum gap drops offers too close to the previous break or the
  start.
- Each position has a range (for example mid 2 to 3 minutes, post 0 to 5, tail 0 to 25). A
  minimum of 0 means the position may stay empty. Planned lengths are multiples of a step
  (15 seconds), because ad clips are about 15 to 30 seconds.
- **Distribution: a rising water level.** Reserve every minimum, then raise all positions together
  one step at a time, always the shortest first. Order on ties: tail, post, pre, head, then the
  mid breaks together as one group. A position that reached its maximum drops out. When only the
  mid breaks can still rise and a full round does not fit, single mid breaks take the leftover
  steps (so some are one step longer). Compared with "post and tail first", this moved mid-roll
  from 59% to 69% of the ad time and cut blocks with most ads after the show from 50% to 8%.
- The last block of a window may run to the window's end only if its ads stay within the ratio
  ceiling and each position's maximum. Otherwise the rest is interstitial or dead air.
- The last 10 to 15 seconds of a break often cannot be filled: the clip list has almost no short
  clips. Interstitial clips, or more short ads, close it.

## Picking programs

- Shuffled pools are **fit-aware**: if the next pick does not fit the time left in the window,
  take a later one that does.
- Ordered shows never skip, as in Tunarr. Each slot has its own episode cursor. When the next
  episode does not fit, the block is made longer (see Windows), or the window ends with unused
  time. Skip and defer is not part of 1.0.
- A cursor advances only when an episode produced by the sequence has aired, not when it is planned
  or staged. An episode that is taken out of a staged slot plays next time.
- An **explicit pick** (a specific program chosen for an exception, such as a Halloween special of
  an ordered show) is off-cursor: it does not read or move any cursor, so the show's order is
  unaffected. For a shuffled pool the pick counts against it by default (it is marked as drawn
  from the current bag, so it is not repeated soon). Either default can be overridden per exception.
- **Slot linking**, as in Tunarr: several slots can share one cursor. In `continue` mode they
  advance together, one episode each in turn. In `rerun` mode every linked slot plays the same
  episode before the group moves on.
- Reruns are acceptable. Pools should be large enough that repeats are not noticeable.

## Windows

- **One program per slot, with the slot length chosen from the program lengths.** Windows that
  hold exactly one program (or an exact multiple) leave nothing unused; mixed lengths leave a
  different leftover every time. For example, with a 15-minute grid and 15% minimum ads, a movie
  of up to 117 minutes needs a 2h15 block, up to 143 minutes 2h45, and so on.
- Hour-long episodes (about 43 to 57 minutes) take a 60-minute block, so four fit a 4-hour
  window exactly.
- Very different lengths belong in different slots. Specials of 30 to 70 minutes do not belong
  in movie slots.
- A theme is chosen *after* grouping by length, and the evening slots are the best groups.

## Overflow and lateness

Both exist as in Tunarr and mean the same thing, but **the default is 0**, which keeps the hard
grid above. They are settings for the whole schedule, with an override per slot.

- **Max overflow**: how far a slot may run past its end to fit one more program (none, up to N
  minutes, or one extra item).
- **Max lateness**: how late the next slot may start after an overrun. Within the limit it starts
  late. Otherwise it is skipped and flex fills the time until the slot after it.
- A program is never cut off. Setting either above 0 gives up the grid guarantee, and the preview
  must show the cost (grid accuracy under 100%).

## Re-planning a range in staging

- Planning only runs forward, because cursors, bags and carried rounding flow forward. A range is
  planned from the end of the last committed slot (the only point where the state is certain)
  through to the **rejoin point**: the first slot after the edited one that can be generated
  normally. Only the end is an anchor: the last block must end exactly where the rejoin slot starts.
- A **pin** fixes the program of one block and is a specific program, never a dynamic list. The rest
  of the planned slot (other blocks, ads, bumpers, head, tail, padding) is regenerated around the
  pins, inside the slot's window. A pin never changes the slot's length: if the pinned program does
  not fit, the pin shows an error and the slot must be extended or shortened by a separate action.
- A **lock** freezes a whole planned slot so it is not regenerated. Unlocked slots are regenerated
  before commit, with their pins kept. If a locked slot no longer fits at commit time, its pins are
  kept and the rest is regenerated, and a conflict is recorded.
- Locked slots never change otherwise. The unlocked slots around them are re-planned, and may change
  program, length and ads. Only the kept range is stored.
- Extending a slot over the slots after it removes those it covers entirely and cuts back one it
  covers partly. If that slot cannot accommodate the cut, a warning is shown and any time left
  unfilled counts as dead air.
- Extending or shortening a slot is a separate action. It re-plans the run to the rejoin point. A
  neighbouring slot that loses time may get a shorter program or a shorter length.
- Because generation is deterministic, everything the edit does not affect comes out identical.
- If no gap-free plan exists with the locked slots, the result is reported with the gap shown. It
  is never hidden, and it is not committed silently.

## Dead air and time

- Dead air at the end of a block counts as advertising when judging a schedule.
- Daylight saving and the schedule's clock are owned by this project, tested explicitly,
  and the day of a change is excluded from the metrics.
- A local time that happens twice (clocks go back) means the first occurrence. A local time that
  never happens (clocks go forward) moves ahead by the length of the gap, so 02:30 on the spring day
  is 03:30. Nothing is skipped or repeated. A change day is 23 or 25 hours long.
