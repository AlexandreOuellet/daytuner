# Run slots (design)

Status: **built** in the engine, the channel file and the web pages (see "What is built" at the end); not yet run against a real Tunarr. Proposed from the Rock Hard Television channel (an MTV-style music channel) and agreed in
principle by the owner, including the positions (the same as a block, plus `rotation` with a range; `pre` and `post` around the run;
`mid` at the nearest item boundary). Open points are listed at the end; settle them before building. Terms are in
[`glossary.md`](glossary.md); the rules this changes are in [`planning-rules.md`](planning-rules.md).

## The problem

Every program is a block, and a block ends on the grid. On a music channel the programs are music videos of 2 to 8 minutes. On a
30-minute grid, a 4-minute video becomes a 30-minute block, and on a 5-minute grid a 4:10 video becomes a 5-minute block: the
leftover is filled with ads, bumpers or dead air after every video. A music channel wants the opposite: back-to-back videos, a
bumper now and then, and nothing special at all until the end of the window.

Two more things the block model cannot say:

- **Bumpers every few videos.** Bumper positions (head, pre, post, tail) belong to a block, so the bumpers would play around every
  video, with no way to say "one every 3 or 4".
- **Filling the end of a window with something worth watching.** A 1h30 movie in a 2h30 window needs 50 minutes more, which should be
  a live performance or two, not ads or dead air (see "Filling the gap: the closer").

## The rule that stays

**The window (slot) starts and ends on the grid, exactly.** For RHTV the grid is 30 minutes, so every window starts and ends at
:00 or :30. Nothing changes for the existing slot kind.

## What a run slot is

A slot with `run: true` (or `kind: run`) is planned as one **run** of short items instead of a series of blocks.

- **No grid inside the window.** Items play back to back, each starting when the previous one ends. Only the window's start and
  end are on the grid. Every duration is still a whole number of milliseconds, with the rounding carried (see "The grid" in
  planning-rules).
- **Items come from the slot's pool.** A shuffled pool (a bag: each item once before any repeats) is the normal case. Picking is
  fit-aware as today.
- **Same positions as a block, plus `rotation`.** A run has `head` and `tail` (the slot's edges), `pre` and `post` (right before the
  first item and right after the last), `mid`, and a new one, `rotation`. Each position is configured as today: an optional ad list
  and length range, and (except `mid`) a bumper list. A position with length 0 is not a position. The ad ratio, the step and the
  ordering rules at the edges are the ones of "Ad positions" in planning-rules.
- **`rotation`: after every N items, N a range.** `every: 3-4` puts a break (a bumper, ads, or both, as configured) after 3 or 4
  items. The range is for the planner: it picks N each time, and how many breaks to take, so the window's end can be hit exactly
  (a bumper of 5 seconds more or less is a lever to absorb the last seconds, along with the choice of items). Bumpers come from the
  list's own bag, so the same one never plays twice in a row. A bumper never counts toward the ad ratio.
- **`mid` in a run:** the same time-based offers as in a block (`every: 8m`), but a break can only fall between two items, so each
  offer is moved to the nearest boundary. **Not in the first version** (decided): a run uses `rotation` instead.
- **Where ads go is configuration, not a rule.** RHTV sets ads on `tail` only (and `rotation` has bumpers only), so ads play at the very
  end and never between videos. The ratio's maximum (10%) caps them over the window. Another channel could put ads in `rotation`.
- **The end of the window,** in order: the `tail` bumper (short ones cover the last seconds), then `tail` ads within the cap, then the
  interstitial list, then dead air. The existing ordering rules for the tail apply.
- **No item is cut off, and none runs past the window's end.** The overflow and lateness settings stay 0.

## How it is configured

Exactly like a block slot: the channel's `ads` and `bumpers` sections, one entry per position. A slot only says that it is a run, and
which pool it draws from.

```yaml
ads:
  step: 15s
  ratio: { min: 0%, max: 10% }   # the cap over a run window
  tail: { list: Old Ads, length: 0-5m }   # ads only at the very end
bumpers:
  rotation: { list: RHTV Idents, every: 3-4 }   # new position: a break after every 3 to 4 items of a run
  tail:    { list: RHTV Idents }               # as today
week:
  mon:
    - { at: "17:00", length: 90m, pool: punk-and-alt, run: true }
```

- `rotation` is the only addition to the channel file's `ads` and `bumpers`. It is used by run slots and ignored by block slots.
- Block slots use `pre`, `mid` and `post` around one program; a run uses them around the whole run (`pre`, `post`) or at the nearest
  item boundary (`mid`). One channel can hold both kinds, such as RHTV's music windows (runs) and its 20:00 cinema slot (a block).
- Ad settings stay per channel, as decided for 1.0 (see the roadmap). RHTV is a channel of its own, so that is not a limit here.

## Filling the gap: the closer

Both kinds of slot can end with time that nothing else fills. Example: a 2h30 window holds a 1h30 movie and 10 minutes of ads, and
50 minutes remain before the tail. A run has the same thing at its end. What fills it is a **closer**: one or several shorter items
(a 2 to 30 minute video or live performance), chosen so the window ends on the grid, placed after the content and before the tail.

The engine already has this, under another name: the **interstitial** list (`interstitial: { list: ... }`, "clips that fill a gap
nothing else fills"). It plays whole clips from a bag, takes one or several, picks the combination from the next few that leaves
the least unfilled, and never goes over. So **the closer is the interstitial list**, and there is no new concept. For RHTV the list
is a Tunarr filler list of live performances and shorter videos. What has to change, so that it does what is wanted:

1. **Do not repeat just because it fits, but never leave dead air or a long run of ads.** Today, when none of the next clips of the bag
   fits, the filler takes the first clip anywhere in the list that does, even one already played this round (`round()` in
   `clips.ts`). The owner prefers a repeat or a cut-off performance to dead air or a long stretch of ads. So the closer follows this
   order, and stops at the first step that works:
   1. Unplayed clips of the bag, the combination that leaves the least unfilled (as now).
   2. If what remains is more than the tail's ads (within the cap) and bumpers can absorb: the next unplayed clip of the bag, **cut
      off at the window's end** (a content item with a shorter duration, as the lineup already allows). A cut clip goes back to the
      front of the bag, so it plays whole next time.
   3. A clip played before, outside its cooldown, that fits (the one played longest ago first).
   4. A clip inside its cooldown. This is the last resort and the plan warns (`closer-repeat`, info).
   Dead air and long ads are never the answer to a gap that a clip can fill.
2. **Cooldown.** Besides the bag, a clip of the list does not repeat within a number of days (a setting of the list, default 14 days).
   Steps 3 and 4 above are the only places a repeat can happen, so cooldowns should rarely come into play.
3. **Aim at the window's end.** The closer targets the gap minus what the tail's ads and bumper can still take (within the ratio cap
   and the position's maximum, in steps of 15 seconds). If the channel has no tail ads or bumpers that is zero, so the closer tries
   to end exactly where the window ends (the next block starts), cutting the last clip if it must. With ads and bumpers, they take
   the remainder.
4. **Both kinds of slot use it.** The block planner already puts the gap before the tail; the run planner does the same.
5. **Length range per clip** (`length: 2m-30m`): clips outside it are not used as closers. The list can then hold sessions and
   short videos together.

Order of a window, in time: head, items (a block's program with its pre, mid and post, or a run's items with `rotation`), the closer
clips, then the tail ads and the tail bumper.

## Genre of an item

A closer should suit its window (not a slow acoustic set at the end of a punk window), and the genre shows are built from a CSV.
**Decided: a CSV**, RHTV's own `genres.csv` (columns `genre,file`), imported into the channel and mapping an item's file name to one or more tags. A
slot can then ask for tags (`tags: [punk, alt]`), for its items and for its closer, and a tag-less item is eligible anywhere. See "Decided" for where it lives and its columns.

## What changes in the code

- `packages/schedule`: the slot's `run` setting and the `rotation` position (with `every`, a range) in the channel model, the YAML
  reader and writer; the interstitial's `length` range and `cooldown`; the CSV of tags. Validation: a run slot needs a shuffled pool;
  `every` is at least 1; every list must exist in Tunarr's filler lists, like any other.
- `packages/engine/src/plan.ts`: a `planRun` path used for run slots in `planWindow`, with its own packing function. `block.ts` is not
  used for run slots. `clips.ts`: the no-repeat rule for the interstitial and the closer target (points 1 to 3 above).
- Items are the same kind (`content`, `filler`, flex), so the commit, the worker, the staging editor and Tunarr's API are unchanged.
- State: the bags (items, bumpers, closer) and the days each closer clip last played (for the cooldown).
- Metrics: grid accuracy is measured at the window's edges for a run slot. Ad share is over the window.
- The web schedule page: a slot's kind and tags; on the ads page ([`web-ads.md`](web-ads.md)) a `rotation` box like the others, drawn
  between two items of a run, and the interstitial's settings.
- Tests: a golden test for a run slot; a closer that fills the exact remainder; no clip repeated before its bag is spent or inside the
  cooldown; bumper spacing; ads only after the last item and within the cap; daylight-saving days.

## Not changed

Existing block slots (movies, episodes), the ad positions and ratio rules, the pool and cursor rules, the committed tier. Tunarr
needs no change: it receives a manual lineup as before.

## Open points

- **Cutting a clip off:** a hard cut (Tunarr cannot fade). It uses the same item shape as a program split at its ad breaks (a
  `content` item with `startOffsetMs` and a shorter `duration`), and a hard cut is what ad breaks already do, so it is expected to work.
  Still check it on the test copy of Tunarr, with the guide, when the first run slot is tried.
- **A pinned or explicit item in a run slot:** allowed, and how it counts against the bag (as it does for blocks today).

## Decided

- **Names:** run slot, closer (the interstitial list), `rotation` (the position that puts a break after every 3 to 4 items).
- **`mid` in a run:** not in the first version.
- **Genre of an item:** a CSV (`genre,file`), part of the channel; a slot can ask for tags in the first version.
- **Closer fallback:** a repeat or a cut-off clip is better than dead air or a long run of ads; a cooldown of 14 days per clip.
- **Cooldown default:** 14 days, per clip.
- **The CSV is part of the channel.** It is imported into the channel and stored with its schedule (so it is versioned with the
  revisions, exported with the YAML and re-importable from the page), not read from a path on disk at every plan.
- **The CSV's columns are the ones RHTV already has:** `genre,file`, one row per tag, `file` being the item's file name (an item with
  several tags has several rows). `genres.csv` today covers the 1,834 music videos only; the files in `Concerts` (KEXP and NPR Tiny
  Desk sessions, the full sets) need rows added, so that the closer's tags can match them.
- **Cut-off clips:** a hard cut, to be verified on the test copy.
- **Generating the CSV is manual for now.** RHTV's `genres.csv` was extended by hand with the 48 files of `Concerts` (84 rows), with
  my guess of their genres. A generator (from folder names, file names or the library's own metadata) is a later item.

## What is built

- **Engine** (`packages/engine`): `planRun` in `plan.ts`, the closer in `closer.ts` (the order of "Filling the gap", the cooldown, the
  cut-off, the tags), the `rotation` bumper position, `PlannedSlot.run`. Tests: `run.test.ts`.
- **Channel file** (`packages/schedule`): `run: true` and `tags` on a slot and on a template; `bumpers.rotation`; `interstitial` with
  `length`, `cooldown` and `cut`; `tagsCsv`; the `videos` pool (local videos by folder and tag). Resolving reads the library's local
  videos (`other_video` in Tunarr) through `TunarrClient.otherVideos()`. Tests: `runslots.test.ts`, `tags.test.ts`. A worked example:
  [`schedules/rock-hard-television.example.yaml`](../schedules/rock-hard-television.example.yaml).
- **Web pages:** the ads page has the "Between the items of a run" box and the closer rules; the schedule page has "A run of short
  items" and "Closer genres" on a slot and on a template.
- **Lineup:** a `rotation` bumper is written as a `mid` filler; a cut closer clip is a filler with a shorter duration. The layout check
  of the worker and the metrics skip the block boundaries of a run slot (only its edges are on the grid).

Choices made while building:

- **The closer rules are opt-in.** A channel whose `interstitial` has none of `length`, `cooldown` or `cut` behaves exactly as before.
- **A cut is at least a minute** (`MIN_CUT` in `closer.ts`): under that the remainder is left to dead air. The bag-order clip that is cut
  stays in the bag and plays whole next time.
- **The tail is planned last:** ads can only take what the closer left (within the cap), so the closer aims at the gap minus what the
  tail's ads and bumper can still take.
- **Not in a run slot:** pins (ignored with a warning, `run-pins-ignored`), exceptions (a special day on a run slot is planned as a block
  slot), links, `mid`. A pool must be shuffled.
- **Tags are checked when the file is read:** a slot or pool asking for a tag that is not in `tagsCsv` is an error, not a silent
  empty list. A clip with no tag suits any slot.
- **Item matching:** an item is matched to the CSV by its title, which Tunarr sets to the file name without the extension. The closer
  list is a Tunarr filler list: put the sessions in it (in Tunarr) and make sure their titles are the file names.

Still to do: a run against a test copy of Tunarr, with the guide, to see a cut clip and a long run play and display as expected.

