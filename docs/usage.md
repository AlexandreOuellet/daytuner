# Using DayTuner

DayTuner decides what plays and when, and appends that to a Tunarr channel's lineup ahead of time. Tunarr keeps streaming; you
keep your schedule, with revisions, a preview and a staging area, in DayTuner.

## The idea in four steps

1. **Design the schedule** (the week: what plays in each slot, from which pools, with which ads).
2. **Look at it:** the calendar shows exactly what would play, day by day, and the checks list problems.
3. **Stage changes** to particular days if you need them (swap a rerun in, move a slot, pin a movie).
4. **Run.** The daily run (or *Run now*) writes the next days to Tunarr. Nothing reaches Tunarr before that.

## The pages

- **Channels (dashboard):** a card per channel with its health (how far ahead is written, warnings), metrics over the commits,
  and the log of commits and runs.
- **Add a channel:** create a new hidden channel in Tunarr, or attach an existing one. It starts with an empty week.
- **Schedule:** the week as a grid. Drag a slot to move it, drag its bottom edge to resize, pick a pool for it. The **Pools** panel
  edits pools as lists or as rules (with suggestions from your library), and the **special days** page holds exceptions. *Check*
  resolves the schedule against your library and lists problems; *Save* stores it as a new revision (every revision can be diffed
  and rolled back).
- **Calendar:** the planned one to seven days as the same time grid, with each slot's blocks inside it. Changes here are made in
  staging: drag a slot to move or resize it, pick a block to pin a specific program or replay an earlier episode instead of the
  next. Nothing goes to Tunarr until it is committed.
- **Staging:** the list form of the same edits (delete, add, resize slots, lock, pin), with a difference against what the schedule
  alone would give, and a *Commit*.
- **Cursors:** where each ordered show stands (the next episode). Rewind or set it, with a preview of which airings change.
- **Ads:** the ad, bumper and filler setup for a channel, drawn as the break it makes, with a live sample from your library.

## Running it

- **Daily:** with writing on, each channel runs at its own time and tops its lineup up to the floor.
- **Now:** *Run now* on the channel page, or `daytuner run <channel> --yes`; without `--yes` it is a dry run.
- A run first commits staged days, plans the rest from the saved schedule, checks it, and appends. If something looks wrong
  (a warning), the run says so and the notes explain it; if the lineup in Tunarr was changed outside DayTuner, it stops and tells
  you rather than guess (`daytuner channel resync` takes Tunarr's end after you have checked).

## The command line

`daytuner` (inside the container: `docker exec daytuner daytuner`) prints every command. The common ones:

```
daytuner preview my-channel.yaml --days 7        # plan without a server or a store
daytuner channel add my-channel.yaml
daytuner channel list | status <name> | commits <name>
daytuner channel set-schedule <name> my-channel.yaml
daytuner channel revisions <name> | diff <name> | rollback <name> <n>
daytuner channel export <name> --out my-channel.yaml
daytuner stage <name> show --from 2026-11-20 --to 2026-11-23
daytuner cursor <name> list
daytuner pool <name> <pool>                     # what a pool holds right now
daytuner run <name> --yes
```

## Things worth knowing

- A schedule is a week; it repeats. Special days and staged edits are exceptions to it.
- An ordered show remembers its place across weeks. *Adopt history* takes the place from a lineup that already exists.
- Programs start on the channel's grid. Ad breaks fit the time that is left in the block, within the ad ratio you set.
- The first save of a new channel needs at least one slot.
