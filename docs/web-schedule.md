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

## Open

- **The preview of the week** shown beside the grid: which numbers, and how fresh (planned on demand or on every edit).
- **Copying a day or a slot** to other days, and bulk edits ("every weekday at 20:00").
- **Small screens.** A week grid is wide; the page needs a narrower layout for a phone.
- **How the calendar learns the state of a day** (rule, staged, committed): it reads the staged slots and the committed
  edge from the store, which the staging editor design will fix.
