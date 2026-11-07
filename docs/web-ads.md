# Web interface: ads, bumpers and filler (design)

The page that replaces what Tunarr makes hard: saying plainly where breaks go, what fills them and how much of
the show they take. The model it edits is decided (see [`glossary.md`](glossary.md) and
[`planning-rules.md`](planning-rules.md)): five **positions** (head, pre, mid, post, tail), each with an optional
**ad list and length range**, a **bumper list** per position except mid, an **ad share** (the ratio's minimum and
maximum), the **step** that padding is a multiple of, the **mid-break rules**, and the **interstitial** list for gaps.

This page is part of phase 5. The web server, how it is built and how it is served are a separate design, not yet
made. This note is only about what the page shows and does.

## Decided

- **One picture: a block, drawn in order.** A strip shows a program's block from head to tail. Each position is a
  box you click; it says what it holds (bumper, ads, nothing) and its size. The program in the middle carries mid-break
  ticks. The ad share and the interstitial sit beside it. The whole structure is visible at once.

  ```
   HEAD          PRE         PROGRAM                      POST        TAIL
  [bumper|ads] [bumper|ads] [=====|mid|=====|mid|=====] [bumper|ads] [ads|bumper]
   idents       -            Old Ads, 2-3 min each         idents      Old Ads
                                                          0-5 min     0-25 min

   Ads take 15%-60% of the show.   [ Preview a 30 min episode ]  [ Preview a movie ]
  ```

- **A live sample from the real library.** Changing a setting plans a sample from the channel's own lists, for
  example a 30-minute episode and a movie, with the real planner. The page shows the actual result: break lengths, the
  ad share, dead air and the same numbers as the metrics (`metrics.md`). What it shows is what will air.
- **Simple first, details on request.** By default: which positions have ads and bumpers, which list each uses, and
  the ad share. A "more" section on each position opens the length range, the padding step and the mid-break rules
  (every N minutes, tail buffer, minimum gap, chapter types).

## How it saves

It edits the `ads`, `bumpers` and `interstitial` sections of the channel's current schedule and saves a **new
revision** like any other schedule edit. So it gets the revision history, the diff, rollback, and the dry run against
locked staged slots for free. Nothing else about the schedule changes. It does not write to Tunarr.

## What the page checks (the rules from the model)

- A list must exist in Tunarr's filler lists. A position with a length of 0 is not a position at all.
- The ratio's minimum is at most its maximum, and both are shares of the program (bumpers are not counted).
- Lengths are multiples of the step. A head or tail reserves its bumper and its ads' minimum before anything else.
- Mid breaks are offers, not promises: the page says so next to the mid settings, and the sample shows how many were
  taken.
- Per-slot or per-pool overrides are not in 1.0, so there is one set of settings per channel.

## Open

- **Unplayable clips.** A filler list can hold clips that cannot play (the test library's "Funny Filler" tracks are
  audio only). Whether the page warns about this needs a per-clip check (Tunarr's stream details say `audioOnly`), which
  costs one call per clip. Decide when the page is built.
- **Which lists to offer.** All of Tunarr's filler lists, or only those that hold at least some clips. Probably all, with
  the clip count and total length shown beside each name.
- **Interstitial placement in the picture.** It fills gaps, not a position, so it needs a place beside the block (for
  example under "Whatever nothing else fills").
