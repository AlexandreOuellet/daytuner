# Web interface: the staging editor (design)

The page where planned days are looked at and shaped before they are committed. It is the interface to what
[`staging-design.md`](staging-design.md) built: staged slots, locks, pins, delete / resize / add, the diff and the
conflicts. Architecture is in [`web-architecture.md`](web-architecture.md); the special-days calendar hands off to this
page ("Plan this day in staging", see [`web-schedule.md`](web-schedule.md)).

Staging never changes the schedule and never writes to Tunarr. Committing is the worker's job (and the commit button,
when writing is switched on).

## Decided

- **A day timeline with the blocks inside each slot.** One day at a time on a time axis, with previous and next day, and a
  strip to jump between the staged days. Each staged slot is a block; inside it are its programs in order, with their pins,
  its padlock and any warning. It shows what will air, minute by minute.

  ```
   Thu 31 Oct          [ < ] [ > ]      staged: 29 Oct .. 3 Nov
   20:00 +-----------------------------------+  [lock]
         | Hocus Pocus   (pinned)   1h36     |
   21:36 | ads 4:10 ...                      |
   22:15 +-----------------------------------+
         | Sitcoms  (office)  [ Ep 12 ][ Ep 13 ][ Ep 14 ]
   24:00 +-----------------------------------+

   Changes: 3 slots   [ ALERT: Sat locked slot no longer fits ]
  ```

- **Edits are made directly on the blocks, with a search panel.**
  - Drag a slot's bottom edge to resize it; the next slot adjusts (the model's rule: slots it covers go, one it partly
    covers starts where this one ends, a slot after a shortened one starts earlier).
  - A padlock on each slot locks it (a locked slot is committed as it is, and is not changed by an edit).
  - **+ add special slot** asks for a time and a program from the search panel.
  - To pin, click a block and choose "Replace with..." to search the library, or drag a program from the panel onto the
    block. Deleting is a button on the slot.
  - A locked slot refuses an edit and says to unlock it first.
- **Every edit shows its diff**, in the page's Changes panel (the same changed-slots layout as `stage diff`), and any
  conflict or pin problem the next commit would find, without writing anything.
- **Reset a slot or a day to the plan; no step-by-step undo.** "Reset this slot" drops its shape and its pins; "Reset
  this day" stages the day again from the schedule. A locked slot is reset only after it is unlocked. There is no undo
  history because every edit plans everything after it again.

## Built (`apps/ui/src/pages/Staging.tsx`)

One local day at a time on a time axis (starting a little before the first slot, on a three-hour line), with a strip of the staged days
and previous and next. A staged slot is a box with its programs inside, drawn to scale, a padlock, and a handle on its bottom edge. A
slot that began the day before is drawn faded and dashed at the top; a locked slot has a double border. Dragging the bottom edge (snapped
to the grid) or typing a new end resizes; the padlock locks; a selected slot can be deleted or reset to the plan. A block can be pinned
through "Replace with…" (a movie by title, or a show and an episode) and unpinned; "Add…" makes a special slot from a start, an end and a
program; a field stages the days up to a date; "Reset this day" puts the day's unlocked slots back to the plan. A slot with a conflict or a
pin problem is marked and says what it is. After each change a panel shows the slots that changed, before and after, the count of slots
that only had their ads reshuffled, and the alerts. A locked slot refuses a change and says to unlock it. Every change is a job, one at a
time, and the page says what it is working on.

The special days page links to it ("Plan this day in staging", opening on that date).

## Backend pieces this page needed

- **Reset** is built (`stageReset` in the worker and `POST .../stage/reset`): it clears the unlocked staged slots in a range, plans
  them again from the schedule, and plans everything staged after them again. A slot's own span resets that slot; a day's
  span resets the day.
- **A program search for the panel**: the library is read from Tunarr (movies and episodes by title), cached, and
  returned with its length, so a pin can be checked for fit as it is dragged.

## Open

- **How fit is shown while dragging:** the page can ask the planner for the result of a pin or a resize before it is
  applied (a dry run), or only after.
- **What the Changes panel does with "ads only" slots** (the CLI counts them without listing): probably the same.
- **Several days at once:** whether the editor can show two or three days side by side, or only one.
- **Small screens.** A timeline with dragging is hard on a phone; the forms-and-buttons path must reach every action.
