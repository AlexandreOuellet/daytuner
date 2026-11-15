# Adding a channel from the page

Status: **built** (decided with the owner). Until now a channel could only be added from a channel file (command line or
API) and only to a Tunarr channel that already existed. The deployed page had no way to attach or create one.

## What the page offers

An "Add a channel" page (from the dashboard) with two ways in:

1. **Create a new channel in Tunarr.** A form with: **name**, **number** (the next free number is suggested; a number in use is
   refused), **hidden** (Tunarr's `stealth`; on by default, so a new channel is never shown in guides by accident), and the
   **ad list** and **filler list** to use, chosen from the lists Tunarr has (none chosen means no ads, no filler). DayTuner creates
   the empty Tunarr channel, then adds it to its store. This is the only thing DayTuner creates in Tunarr, and it needs writing to
   be switched on (`DAYTUNER_ALLOW_WRITES`). It never deletes or edits a Tunarr channel's settings afterwards.
2. **Attach a Tunarr channel that exists.** A list of the Tunarr channels DayTuner does not manage yet; pick one, and set the same
   ad and filler lists. Attaching only reads Tunarr (the places of ordered shows are read from the lineup as before), so it works
   with writing off.

Both start from an **empty week** (no slots, no pools). The schedule page is where the week is designed. A channel with no slots
plans nothing: a run says "no slots yet" and writes nothing, so the daily run cannot fill an empty channel with dead air.

The form also asks for the **grid** (5, 10, 15, 20, 30 or 60 minutes; 15 by default), written into the channel's file; the
channel's start time is rounded down to it. The grid must fit the server's time zone: a slot sits on the zone's clock (20:00) and
the lineup's grid lines on the epoch, and they agree only when the grid divides the zone's offset from UTC (all six do in Toronto
or UTC; India, +5:30, allows 5, 10, 15 and 30). The page offers only the grids that fit, the server refuses the others, and a run
for a channel file whose grid does not fit its zone stops with that reason before writing.

## What is not asked

- **The time zone is not a choice.** It is the server's (`TZ`, else the system's), written into the channel's file and shown on
  the page.

## The Tunarr channel that is created

- `duration` 0 and a `startTime` on the grid at the moment of creation (now, rounded down to the grid). `startTime` is set once
  here and never changed afterwards (see `tunarr-api.md`).
- A transcode configuration: Tunarr's default one.
- Everything else as Tunarr's defaults (no watermark, no offline picture, `hls`).
- Refused when the name is empty, the number is not a whole number from 1, the number or the name is used by another Tunarr or
  DayTuner channel, or writing is off.

## What was found building it

- Tunarr ignores the `id` sent with a new channel and makes its own, so DayTuner reads the id from the answer. (An earlier note in
  `tunarr-api.md` said a client-supplied id was kept; it is not.)
- A channel nothing was ever written to has only a start time, and that goes stale: a channel created on Monday and given its
  schedule on Friday starts four days in the past. The first run for such a channel appends a **flex** from the start time to the
  grid line just before now and plans from there, so nothing is planned in the past and the start time is not touched. The
  "lineup has run out" refusal stays for a channel that has had a lineup.
- A schedule with no slots plans nothing (the engine returns no slots; it used to refuse), so the daily run for a channel still
  waiting for its week writes nothing and says nothing is wrong. The schedule page cannot save a week with no slots, so the first
  save needs at least one.
- If a create fails after Tunarr made the channel (before DayTuner took it over), sending the form again takes that channel over: a
  channel with the same name and number, no lineup and not managed here is adopted, not refused and not made twice. Attaching a
  Tunarr channel that is already managed here under another name is refused.
- Everything that plans ahead (the run, staging, the calendar, the cursor and revision previews) starts from the same place
  (`originOf` / `planOrigin` in the worker): the grid line after the lineup's end, or, for a channel nothing was written to, the
  grid line just before now. So the calendar and the staging never show days before now that the first run will not write, and
  the episodes of an ordered show they show are the ones the run writes.
- The channel page of a channel with no commits reads "needs attention" (nothing is committed ahead). That is true, and goes
  once a schedule is saved and run.
