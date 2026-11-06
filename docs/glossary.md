# Glossary

The words used in these documents, with one meaning each. When another document is loose with a
word, this one wins.

## Time

- **Grid**: the set of times at which blocks start and end, for example every 15 minutes. A hard rule.
  It applies to the block (the program plus its pre, mid and post ads and bumpers), not to the bare program.
- **Clock**: the schedule's own time zone and daylight-saving rules. Owned by this project.

## What a schedule says

- **Schedule**: everything that defines one channel: slots, pools, ad settings, exceptions.
  Stored in DayTuner, versioned as revisions, exportable to YAML.
- **Slot**: an entry in the schedule. It has a start time on the grid and a pool to draw from.
  Example: "13:00, comedy movies". A slot is a template: it repeats (every week, say) and gives
  different content each time.
- **Window**: the stretch of time a slot owns, from its start until the next slot starts. A slot's
  length is its window's length. A window can hold one block or several.
- **Planned slot**: a slot once it has been fully generated for a given day (or hand-modified): its
  head, its blocks and its tail, starting and ending on the grid. This is the unit that is staged,
  locked and committed. Example: "Tuesday 13:00, Anchorman, with all its ads".
- **Pool**: a set of programs a slot draws from. Either **ordered** (a sequence with a cursor) or
  **shuffled** (a bag).
- **Cursor**: an ordered pool's position. It advances only when a sequence episode has aired.
- **Bag**: a shuffled pool's memory of what was drawn. Each program is drawn once before any repeats.
- **Cursor adjustment**: moving an ordered pool's place in its order by hand: rewind by k, or set
  to an episode. It changes the first uncommitted airing onward and never the past.
- **Head**: the cursor of an ordered pool, the next episode to play.
- **Slot linking**: slots that share one head (`continue`), or a slot that replays the episodes just
  behind the head without moving it (`rerun`).
- **Exception**: a special event that overrides the schedule for a time, as a rule or by working on
  the day in staging.

## What is planned

- **Program**: one piece of content: a movie, an episode, a special.
- **Block**: one program plus what is around it: pre, mid breaks, post and bumpers. A planned slot
  holds one block or several (for example four hour-long episodes in a 4-hour window). It starts and
  ends on the grid, except the first block of a planned slot with a head (it starts when the head
  ends) and the last block of one with a tail (it ends where the tail starts). Blocks are not locked
  or committed on their own: the planned slot is.
- **Position**: where inserted clips can go: **head** (start of a planned slot), **pre** (before a
  program), **mid** (breaks inside a program), **post** (after a program), **tail** (end of a planned
  slot). Head and tail belong to the planned slot; pre, mid and post belong to a block.
- **Ad**: a commercial clip. Ads can use head, pre, mid, post and tail.
- **Bumper**: a short fixed clip, such as a station ident. Bumpers can use head, pre, post and tail,
  never mid. Each position has its own list of clips, for ads and for bumpers.
- **Interstitial**: optional clips (music videos, PSAs, a "Heritage Minute") from a list, used to
  fill a gap that ads and bumpers cannot. One or several clips. It is the last resort before dead
  air. (Tunarr calls it `fallback`.)
- **Flex**: time with no content that Tunarr fills with its own filler or silence.
- **Dead air**: flex or silence the viewer sees. Counts as advertising when judging a schedule.
- **Item**: one entry in a lineup: a piece of content, an ad clip, a bumper or flex, with a
  duration in whole milliseconds. A block is made of items.
- **Lineup**: the ordered list of items a channel plays.

## The three tiers

- **Committed**: in Tunarr. Final: it can never be edited or undone.
- **Staging**: fully generated planned slots stored in DayTuner, after the committed part. Optional,
  and may be in islands.
- **Speculative**: what the planner would generate beyond that. Never stored.
- **Floor**: the minimum amount of committed time ahead (7 days by default, configurable per channel).
- **Commit**: appending planned slots to Tunarr. The commit log records every one.
- **Worker**: the job that keeps the committed part at or above the floor.

## Editing

- **Explicit pick**: a specific program chosen by the user, never a dynamic list. Off-cursor, and it
  counts against a shuffled pool by default.
- **Structure edit**: deleting, adding, extending or shortening a planned slot in staging. It applies
  to that day only and never changes the schedule.
- **Pin**: fixes the program of one block inside a planned slot, to a specific program (never a
  dynamic list). It is an explicit pick. Everything else in the slot is regenerated around pins.
- **Lock**: freezes a whole planned slot as it is, so it is not regenerated later. If it no longer
  fits at commit time, its pins are kept and the rest is regenerated.
- **Anchor**: a fixed time that planning must end on exactly, such as the start of a staged slot or
  the rejoin point.
- **Rejoin point**: the first slot after an edit that the planner can generate normally. A re-plan
  runs from the end of the last committed slot to here.
- **Conflict**: a locked planned slot that no longer fits when the worker reaches it. The planner generates
  that stretch instead and the conflict is recorded.
- **Overflow** and **lateness**: as in Tunarr. How far a slot may run past its end, and how late the
  next slot may start. Both default to 0.
