# Web interface: the schedule designer (design)

The page where the weekly plan is made: timed slots, which pool each draws from, and how slots are linked. What it
edits is the channel file's `week`, `pools` and `exceptions` (see [`schedules/example.yaml`](../schedules/example.yaml));
the ads, bumpers and filler are on their own page ([`web-ads.md`](web-ads.md)). How the interface is built and run is in
[`web-architecture.md`](web-architecture.md).

The weekly plan is what the worker plans from: every new stretch of lineup comes from the current revision of this
schedule. Committed days never change, and the floor keeps at least a week committed, so an edit shows up in Tunarr
after the days already committed have run out.

## Decided

- **A week grid, slots as blocks.** Seven day columns and a time axis. Each slot is a block from its start to the next
  slot's start, coloured by pool and labelled with the pool and a link mark. You see the whole week, and every gap-free
  stretch and every short or long slot, like a TV guide.

  ```
          Mon        Tue        Wed   ...
   08:00 +----------+----------+---------
         | Sitcoms  | Sitcoms  | Sitcoms
         | (office) | (office) |
   20:00 +----------+----------+---------
         | Movies   | Movies   | Movies
         | comedy   | comedy   |
   00:00 +----------+----------+---------
         | Office   | (rerun   |
         | rerun    |  of Mon) |

    [ + slot ]  [ Pools ]  [ Special days ]
  ```

- **Drag and type; the length is implicit.** A slot lasts until the next slot starts, as the model says, and the week
  wraps (the last slot of Sunday runs to the first of Monday). You drag a block's top edge or type its start time; the
  previous slot's length changes with it. Everything snaps to the grid. The page warns about a slot that is very long,
  or shorter than the shortest program in its pool.
- **A Pools panel, picked from the slot.** A separate page defines each pool: a list of shows with an order (in order or
  shuffled), or a movie filter by genre and length. It shows a live count of what matches and how many of those fit a
  slot. A slot only picks a pool from a list and, if wanted, a link (`continue` shares a head with another slot, `rerun`
  replays the episodes behind it), shown as a coloured chip so linked slots are visible across the week.

  ```
  Pool: Sitcoms
    Shows: [The Office] [Parks and Recreation] [30 Rock]  (+ add)
    Order: (o) in order  ( ) shuffled
    161 episodes

  Pool: Comedy movies
    Genre: [Comedy v]   Length: [<= 117 min]
    34 movies match; 31 fit a 2h15 slot
  ```

## Templates dragged onto the week (decided and built)

The first designer moved slot boundaries by dragging a block's top edge. In use that was clunky: one drag changes the
neighbours too, and a slot has no length of its own. Replaced by:

- **A slot list beside the week: named templates.** A template is a name, a pool, a default length and an optional link
  (`continue` or `rerun`), for example "Sitcom block, 12h" or "Prime-time movie, 2h30". You drag a template onto the
  week as many times as you like. Editing a template offers to update every use of it (a use that has been changed on
  its own keeps its change). Templates are kept in the channel file.
- **Every placed slot has its own start and length.** Drop to set the start (snapped to the grid); drag the bottom edge
  to extend or shorten it; drag the block to move it. Moving or resizing never changes another slot. A slot cannot
  overlap another: it stops at the next one.
- **Gaps are allowed.** Time no slot covers is drawn as empty and is filled by one **default pool** per channel
  ("whatever nothing else fills"), which the page asks for as soon as there is a gap. The file format gains an optional
  length on a slot; a file without lengths keeps today's meaning, "until the next slot starts", so existing channel
  files and the engine's grid rules do not change.
- **A template says what is in it.** Its card shows the name, the length, the pool and the pool's contents in a line (the
  first shows, or the movie filter), the link if any, and how many slots on the week come from it. A template's length is
  **2 hours when none is given**.

### How it is stored and planned

- The channel file gets `templates:` (name → `pool`, `length`, optional `link` and `linkMode`), `fill:` (a pool name) and,
  on a slot, an optional `length` and a `template` label. A slot's own fields are what play; `template` is only a label,
  so a slot changed by hand keeps its change, and changing a template offers to update the slots that still match it.
- A slot without `length` lasts until the next slot starts, as before; the page reads it as that length and writes a
  `length` only when it differs from that, so files without gaps stay as they were.
- Two slots may not overlap, and a length is a positive multiple of the grid, at most 7 days. A gap with no `fill` pool is a
  file error (the page will not save it).
- **The engine did not change.** When the file is resolved, each gap becomes one more start-only slot of the `fill` pool at the
  gap's start; all of them share the link name `~fill`, so the fill pool keeps one place across the week.
- **The week is a FullCalendar time grid** (`@fullcalendar/*`, MIT), not drag code of our own: the first version's hand-made
  pointer handling went wrong at midnight and over other slots, and a calendar library already does moving, resizing, snapping,
  overlap checks and external drops. The page keeps only the model: seven fixed reference dates (a Sunday to a Saturday, in UTC)
  stand for the week; a slot is an event; a slot running past Saturday has a fixed second piece at the start of Sunday; gaps are
  background events. The page's own rules (`week.ts`: `place`, `moveTo`, `resizeTo`) still check every change, because the page
  state, not the calendar, is the truth.
- Placing is by dragging a card onto the week, by picking a card up and clicking a spot, or by a form; moving and resizing by
  dragging the block or its bottom edge. A slot dragged over another is refused (the calendar shows it as not allowed and the
  slot springs back); dropped before another slot it is also refused, so shorten the template or the slot first. A slot that runs
  over midnight is drawn in two pieces. Start, day and length can also be typed in the editor under the week, which replaces the
  arrow keys of the first version.

## Built (`apps/ui/src/pages/Schedule.tsx`, the week and the pools)

*The first version, with start-only slots and a drag handle on a slot's top edge, was replaced by the template design above;
what follows about the grid, notes and pools still holds, except that a slot has its own length.*

The week grid draws a block per slot to scale (30 px an hour), coloured by pool, with the link as a chip; a slot that runs past
midnight, or wraps round the week, is drawn faded and dashed where it carries on. A slot's start changes by dragging the handle on
its top edge (snapped to the grid, kept one step clear of its neighbours), by the arrow keys on the focused block, or by typing the
time in the editor under the grid. The editor also sets the pool and the link (`continues` or `reruns`, with a name), and removes
the slot; a form adds one. Slots are never two at one moment or off the grid. A slot gets a note when it lasts over 12 hours or when
no program of its pool is short enough for it. The Pools panel shows each pool's programs counted from the real library (and how many
fit the shortest slot that uses it), adds and removes shows, sets a movie filter (genre and longest length), sets the order, adds a
pool, and removes one no slot uses. Pools cannot be renamed yet.

Saving applies the week and pools to the channel file (`applyScheduleModel`), keeping its comments, the ads and the special days, and
is a new revision with the dry run against locked staged slots.

### Special days (`apps/ui/src/pages/SpecialDays.tsx`)

A calendar of the twelve months from this one, with the days that have a special day marked and the state in words as well as a mark
(★ planned from the schedule when its time comes, ◆ staged, ✓ already in Tunarr). A day opens a panel: what is planned there (with a
warning when no slot starts at that time on that weekday, so it would replace nothing), a switch for "counts as played", Remove, and an
Add form: the slot to replace (the week's slots on that weekday), a movie (searched by title) or an episode (a show, then an episode),
"this year only" (otherwise every year), and "counts as played". Saving is a new revision with the dry run, like the rest. The page points
to staging for a bigger event; the "Plan this day in staging" button waits for the staging editor, so for now it shows the CLI command.

## How it saves

Like every schedule edit: a new **revision** (with the diff and rollback), preceded by the dry run against locked staged
slots. The page can also show the week as it would be planned, with the metrics, before saving. It does not write to
Tunarr.

## Rules the page enforces (from the model)

- A slot starts on the grid, once per day and time; two slots cannot start at the same moment.
- Shows are chosen by title with their library id kept beside it (`web-ads.md` and the roadmap: the id decides, the title
  is the label).
- Overflow and lateness above 0, and per-slot ad overrides, are not in 1.0, so the page has no control for them.

## Special days (decided)

- **A calendar of the coming year.** A year calendar with the week's slots behind it. A day with a special event is
  marked with its state: a rule, staged, or already in Tunarr. Click a day to add one, or a mark to open it. You can see
  Halloween coming and whether it is planned.

  ```
          October 2026                  November 2026
   Mo Tu We Th Fr Sa Su            Mo Tu We Th Fr Sa Su
                1  2  3             2  3  4  5  6  7  8
    5  6  7  8  9 10 11            ...
   ...
   26 27 28 29 30 [31]*           * 31 Oct 20:00 Doctor Who, Halloween Special
                                      rule, every year   [ Plan this day in staging ]
  ```

- **A new special day repeats every year by default**, with a "this year only" choice. That is the file format's month and
  day (every year) or a full date (one year).
- **A rule is for one program in one slot**, as the model says (`exceptions`: the slot that starts at that time is
  replaced by the chosen program, which is an explicit, off-cursor pick). A bigger event goes through **"Plan this day in
  staging"**, which opens the staging editor on that date, where slots are deleted, resized or added and programs pinned.
  Staging never changes the schedule. The file format does not grow to describe ranges or several programs.

## The calendar: what is planned, and what was done by hand (decided)

The weekly-pattern designer says what the schedule is. The **Calendar** page (`#/channels/<name>/calendar`) says what will
actually air on each date, and which parts of it are the plan and which were changed by hand. The designer links to it.

- **Three places a slot can live, never confused:**
  - *Committed*: already in Tunarr's lineup. History; read only. It is read from Tunarr's stored lineup itself (not from
    DayTuner's commit records, which a channel that existed before DayTuner does not have). The lineup has no slot
    boundaries, so a committed block is one program with the head or pre break before it, its mid breaks and its post or tail,
    and its timeline is as complete as a planned one. A program's title is shown only when the channel's pools hold it.
  - *Staged*: stored in DayTuner, waiting to be committed. A staged slot is staged even if nobody edited it (December 2nd from
    16:00 to midnight can be staged today). It carries a mark of what was done by hand to it, if anything: locked, pins,
    shaped, slot added. Without a mark it is exactly what the plan makes, stored.
  - *Planned*: stored nowhere. What the schedule would make if nothing changes. Planning is deterministic, so it is
    recomputed on demand, and it is exactly what will be committed unless something changes first.
  The marks are separate from the place: a slot is committed, staged or planned, and may also be *from a rule* (an
  `exceptions:` rule replaced its programming) or *different from the plan* (done by hand, or moved by an edit before it).
  A day can hold all three: committed up to 14:00, staged 14:00 to 16:00, planned 16:00 to 20:00, and so on. The planner
  fills the time around a staged slot and ends exactly where it starts (the rule for staged anchors).
- **Two views, one above the other, so both are in sight without scrolling.**
  - *The days*, a vertical time grid of one, three or seven days (see "One grid" below). Each slot is a box (committed solid
    grey, staged solid with a thick border, planned dashed; the place is also written) with **its blocks inside it**. Every
    block is a bar showing how it is divided: the program, the ads, the bumpers, the filler, dead air. A block is named by what
    plays in it ("Ted Lasso S3E3"). Dead air of a minute or more is called out (red hatch and outline); a few seconds left at the
    end of a block is not. Clicking anywhere on a slot picks it; clicking a block picks the block.
  - *What plays*, one continuous vertical list of every slot, block and item (the titles, the ads by name), that loads a week at
    a time as it is scrolled, in both directions. Picking a slot or a block in the day brings the list to that point, and picking
    one in the list moves the day to its date. Each block has a heading; a break is one quiet line, opened to see each clip.
- **The slot's contents** are a line per break position (head, pre, mid, post, tail), the bumper, each ad by name and length, the
  interstitial (Tunarr's `fallback`), the program in its parts (a mid break splits it) and dead air, with the summary: pool,
  start and end, programs with season and episode, ad share against the target range, dead air and warnings. Clip names are
  the ones the plan picked, so "which ad would play" has an exact answer. Whether Tunarr can play a clip is not known to the
  calendar (see `status.md`).
- **Comparing with the plan** shows two columns for a slot that differs from it, planned and now, with the programs and times of each.
- **Changing things from the calendar (decided).** Every change is a staging change: it never writes to Tunarr, the slot becomes
  *staged*, and the plan stays available for comparison. A committed slot can only be looked at. A planned slot is staged first
  (everything from the committed lineup to its end), then changed, so a change to a slot that is not stored yet is one click.
  From the bar between the day and the list, for the picked slot: start earlier or later (this resizes the slot before it, as the
  staging editor does, since slots touch), end earlier or later, drag either edge on the day, lock or unlock, delete, and put it
  back to the plan. For the picked block: replace with a movie or an episode (a pin), unpin, and **play a rerun instead**.
- **A rerun in place of the next episode (decided).** An ordered show plays its episodes in order. If a week is missed, a block of
  it can be told to play the episode before it as a rerun. It is a pin of the earlier episode, and a pinned block takes nothing
  from the show, so the show's next new episode is not used up: the week after plays the one this block would have played. The
  button is offered only where the block is an episode of an ordered pool **of one show** and an earlier episode exists. In a
  pool that takes turns between several shows it is not offered: tried on the hidden channel, the pinned block takes no place
  in the list, so every later block moves up one (the same show twice in a row, the other show a block later). Settled with the
  owner: a rerun of one block is for one-show pools; to rerun a whole slot, give it a `rerun` link in the schedule. Unpinning puts the plan
  back. (It is not the same as a *rerun slot* of the weekly pattern, which replays what aired behind the head.)
- **Horizon:** eight weeks from the end of the committed lineup. Further out, a shuffled pool's picks depend on too many
  earlier draws to mean anything.
- Not built: a month view (days with something by hand marked, warnings counted), skipping a block, and changing the ads of a break.

## One grid for the schedule and the calendar (built, first version)

Today the two pages draw the same thing, blocks on a clock, with two pieces of code. The schedule's week is a FullCalendar time
grid (`WeekGrid.tsx`: drag, resize, drop a template, vertical, one week, Sunday to Saturday). The calendar's day is a hand-made
left-to-right timeline (`CalDay.tsx`, since removed: a box per slot with its blocks inside, grips on the two edges of a picked slot, zoom).
Moving a whole slot works on one and not on the other, and every fix to one view is missed by the other. The difference that
matters is the source of truth, not the picture: the schedule edits a template that repeats; the calendar shows dated slots
and edits only exceptions.

**Proposal: one grid component, fed a list of blocks.** A block is `{ key, start, end, label, hue, place, marks, editable,
locked, inner }`. `start` and `end` are absolute times (the schedule feeds them from a fixed reference week). `place` is
committed, staged, planned (the schedule's blocks are all one kind). `inner` is what is drawn inside a block when it is tall
enough (the calendar's program, ad and bumper bar; the schedule has the pool and the link chip). The component draws, snaps to
the grid, and reports what the user did: `move(key, start)`, `resize(key, edge, to)`, `pick(key)`, `drop(template, start)`.
It knows nothing about templates, staging or Tunarr.

**What a gesture means is the page's.**

| Gesture | Schedule page | Calendar page |
|---|---|---|
| move a block | changes the slot's day and start in the template (every week) | stages that slot at the new time as an exception for the date; the slot before it and the one after it take the gap, as the edge edits do now |
| resize | changes the slot's length | moves its end (and so the next slot's start), staged |
| drop a template | places a slot | not offered |
| committed block | n/a | drawn, picks, never drags |
| pick | edits the slot in the form below | the bar of buttons and the list below |

**What changes for the user.** The calendar gets the schedule's vertical week grid (one day, three days or seven days of the
real dates, so a month view can follow), and a whole planned slot can be dragged in one move.

**Built** (`components/CalGrid.tsx`, `calview.ts` `moveSlotPlan`, `staging.ts` `wallOf`/`msOf`): the calendar's days are the same
FullCalendar time grid as the week, vertical, shown as 1, 3 or 7 days. A slot is an event with its blocks inside it; dragging its
body moves it, dragging an edge resizes it, and "Move earlier / later" in the bar does the same one grid step at a time. A move is
two staged edge changes (neighbours give and take the time), refused with the reason when the slot before it is in Tunarr or
locked, nothing comes after it, or a neighbour would be left with no time. The left-to-right strip and its zoom are gone. The
grid draws each instant as its wall clock in the channel's zone, so across a daylight saving change an hour is drawn off. A slot
over midnight shows its blocks on the day it begins and a "continues" piece on the next. Settled as leaned: vertical, the
neighbours move, detail kept inside the block, FullCalendar kept.

**Settled with the owner (go ahead on the recommendations):**
1. Orientation for a day: vertical like the week, or keep today's left-to-right one-day view as a second layout of the same
   component.
2. Moving a block on the calendar: does it change the neighbours' edges (the slot before grows, the one after shrinks, as
   the edge edits do), or is it refused unless it swaps with a free gap?
3. The detail inside a block (program, ads, bumpers, dead air bar): kept inside the block when it is tall enough, or moved to
   the list below only.
4. Whether to keep FullCalendar for both (it already handles drag, resize, snapping and drop, and the schedule depends on it),
   or replace it. Recommended: keep it. Its limits (no custom hatch for dead air, text in a short block) are drawn with the
   event content.

Built: `packages/worker/src/calendar.ts` (`calendarPlan`, `stageRerun`, tested), `POST /api/channels/:name/calendar` and
`POST /api/channels/:name/stage/rerun`, `apps/ui/src/pages/Calendar.tsx`, `components/CalGrid.tsx` and `calview.ts`.

## Open

- **Copying a day or a slot** to other days, and bulk edits ("every weekday at 20:00").
- **Small screens.** A week grid is wide; the page needs a narrower layout for a phone.
- **How the calendar learns the state of a day** (rule, staged, committed): it reads the staged slots and the committed
  edge from the store, which the staging editor design will fix.
