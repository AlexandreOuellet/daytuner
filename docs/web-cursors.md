# Web interface: the cursors page (design)

The page where an ordered show's place is moved by hand: after a missed week, to repeat an episode once, or to jump
ahead. It is the interface to the two cursor adjustments in [`architecture.md`](architecture.md) ("Cursor
adjustments"): **rewind by k** and **set to an episode**. Architecture is in [`web-architecture.md`](web-architecture.md).

An adjustment changes the planner's state at the committed edge, so it affects the first uncommitted airing onward and
never anything already in Tunarr. Each one is logged.

## Decided

- **One card per show, in plain words.** Each ordered show (or linked group of slots) is a card: the next episode with
  its title and place ("next up S2E3 ... 54 of 161"), the slots that read it (a rerun of it is shown as reading from the
  same place), and its next three airings with dates and whether each is staged or not planned yet.

  ```
  The Office                       [ Missed a week ]  [ Set episode... ]
    Next up:  S2E3 "Office Olympics"   (54 of 161)
    Slots:    Mon 08:00 (continues)  +  Mon 22:15 (rerun)
    Next airings:
      Mon 16 Nov 08:00  S2E3  (staged)
      Tue 17 Nov 08:00  S2E4  (staged)
      Wed 18 Nov 08:00  S2E5  (not planned yet)
  ```

- **Controls: "Missed a week", rewind by N, and set an episode.** "Missed a week" is the common case (it makes the
  coming week repeat the one that was missed); a stepper rewinds by 1, 2, 3 ...; "Set episode" opens a season and episode
  picker for jumping ahead or back. They are the model's two operations with a friendly shortcut on top.
- **A preview before applying.** The card lists the next airings with the episode each plays now and after the change,
  and says which are already committed and so unaffected ("the 15th is committed and stays; the 22nd plays S2E3").
  Applying also plans the show's staged slots again; locked slots keep their episode and are named in a warning. If the
  next week is already committed, the page suggests lowering the floor for that channel, so there is room to adjust.

## Built (the page is `apps/ui/src/pages/Cursors.tsx`)

The page lists a card per ordered show with its next episode, its slots and its next airings; "Missed a week" rewinds by the
number of episodes the show plays in a week (the slots that continue it), a number field rewinds by N, and another sets an
episode (numbered from 1). Each one shows the preview first, with Apply and Cancel. The card's airings load one after another,
since a channel runs one job at a time.

## Built for this page

- **A preview call** (`cursorPreview` in the worker, `POST .../cursors/preview`, and `cursor <name> preview <sequence> rewind|set <n>` in the CLI): for a sequence and an adjustment, the next airings of its slots, from the committed
  edge and through staging, with each episode before and after, and a flag for committed ones. It plans twice (with and
  without the adjustment) and compares, like the staging diff.
- **Applying an adjustment re-stages** the show's staged slots after it (`stageRefresh`), so the stored previews are not
  stale (`POST .../cursors/adjust` does this).

## Open

- **What "a week" is for a show on several days.** Proposed: "Missed a week" rewinds by the number of episodes the show
  plays in a week (the slots that continue it), with a stepper for more weeks. To confirm with the owner.
- **A show with reruns:** a rewind also lowers the history a rerun can replay (see the engine choices in `status.md`);
  the card says so.
- **Small screens:** cards stack naturally, so this page should work on a phone as it is.
