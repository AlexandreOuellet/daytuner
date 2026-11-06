# Status

The one place that tracks what is done, what is needed for 1.0, what is open and what is next.
Update it when a piece is finished or a gap is found or closed. The plan and the decided choices
are in [`roadmap.md`](roadmap.md); verified Tunarr facts are in [`tunarr-api.md`](tunarr-api.md).

## Where we are

| Phase | State | Notes |
|---|---|---|
| 0 Skeleton | done | Documentation, the verified API facts, the spike script |
| 1 Engine | done | Time and grid, breaks, blocks, pools, clips, `plan()`, metrics. 137 tests, a golden test |
| 2 Client and CLI | done | Reads the library, appends verified lineups, `preview`. Run end to end on the test copy |
| 3 State and worker | built, not fully verified | SQLite store, safe top-up worker, `channel`, `run`, `cursor` commands. Run end to end on the test copy. Playback, guides and a multi-year lineup not checked |
| 4 Schedules and staging | not started | Needs design first |
| 5 Web interface | not started | Needs design first |

Tests: 211 pass across the engine, client, store, schedule, worker and CLI, plus 3 client integration
tests that run only against a real Tunarr (`TUNARR_URL`).

## Needed for 1.0

Nothing is pushed publicly until all of this is done (see the roadmap).

**Phase 3, to finish**
- [ ] Real playback through ffmpeg and the media server for a lineup DayTuner wrote
- [ ] The XMLTV guide and the media server's guide after an append
- [ ] How a synthetic multi-year lineup behaves (memory, startup time, `now_playing`)

**Phase 4: schedules and staging**
- [ ] Schedules in the store with revisions and rollback (today: one stored copy of the YAML)
- [ ] Saving a revision dry-runs it against the locked staged slots and lists those that no longer fit
- [ ] Staging: generate into staging, edit, preview the difference with what is committed, commit
- [ ] Pins, locks and conflicts in the engine (anchored planning is done)
- [ ] YAML export (import exists as `channel add` and `channel set-schedule`)

**Phase 5: web interface**
- [ ] Plain configuration of ads, bumpers and filler: the main complaint about Tunarr
- [ ] Edit schedules, preview, see what is scheduled, link to the channel in Tunarr
- [ ] Stage a date range, edit a day in staging (delete, add, resize slots, pin programs), re-plan only what changed
- [ ] Cursor adjustments with a preview of which airing they change
- [ ] Metrics dashboard: the numbers in [`metrics.md`](metrics.md) per channel and over time (the metrics
      are computed today but not stored over time)

**Release**
- [ ] A verified end-to-end run on a test copy of Tunarr, including playback and the guide check
- [ ] A way to run it: a container image, and something that runs the worker daily

## Open decisions (the owner decides)

- **Ad and bumper interface.** The model is decided. Open: how the web interface shows the positions plainly (phase 5).
- **Exception that does not fit its slot.** The owner chose a warning and dead air; the engine plans
  the slot as usual with an alert. Confirm or change.
- **Mid-break offers** need refinement later (the owner's words): default chapter types, the minimum
  gap, how breaks are spread.
- **Ad settings per slot or pool.** One ad block per channel today. Is an override (for example a
  longer break interval for movies) part of 1.0?
- **Overflow and lateness above 0.** Decided to exist "as in Tunarr", but the engine and the channel
  file reject anything above 0. In 1.0 or not?
- **How a channel file names one of two shows with the same title** (an id, a year).
- **How it is run.** The architecture says one container running the interface, API and worker; today the
  worker is a one-shot command. Scheduler inside, or an outside cron or CronJob?
- **Phase 4 design.** To be settled with the owner before any code: how staged slots are stored, how
  pins and locks are addressed, what a conflict looks like, how revisions are diffed.

## Known gaps

Each is one of: **build** (clear what to do), **verify** (find out), **know** (accepted, worth knowing).

- **build** Chapters are not loaded, so mid breaks use the every-N-minutes fallback. Tunarr only gives
  chapters per program, in `stream_details` (one call each); load them for the programs that get scheduled.
- **build** Warnings name programs by id. They should use titles, which have to come from the library.
- **build** An exception that matches no slot is ignored silently. It should warn.
- **build** No `channel resync` to adopt Tunarr's current end after the worker refuses because the store
  and Tunarr disagree, or the lineup ran out, or a pending commit matches neither end.
- **build** A verified append that did not match leaves the commit pending, with no tool to inspect or close it.
- **build** Adding a channel starts from a fresh state: an existing channel's place in its shows is not
  read from its history, so ordered shows begin at episode 1 unless adjusted with `cursor set`.
- **build** The metrics are not stored over time, which the dashboard needs.
- **verify** Playback, the XMLTV and media-server guides, and a multi-year lineup (phase 3, above).
- **know** A lineup whose end is fractional (older lineups) gets one rounded flex to the next grid
  line, so it stays up to half a millisecond off the grid from there on.
- **know** A person must sort out any refusal by the worker until `channel resync` exists.

### Engine choices the rules do not state

Made while building phase 1. They are in the code and tested, but nobody has confirmed them. (The
exception fallback and the mid-break offers are under Open decisions above.)

- **A shuffled pool repeats when nothing left fits.** If nothing remaining in the bag fits the time
  left, a program already drawn this round that does fit is repeated (flagged), instead of leaving
  the time empty. With nothing fitting at all, there is no pick.
- **Rerun history after a manual adjustment.** A rewind by k removes k episodes of history. Setting
  the head backward removes the episodes between; setting it forward keeps the history unchanged, so
  the skipped episodes count as aired. Rewinding from the first episode wraps to the last.
- **Bumpers can cost a whole grid step.** A 26-minute show fits a 30-minute block, but with 20 s
  bumpers on each side it goes to 45 minutes, because the ratio minimum already nearly fills 30. It
  follows the rules as written, and is expensive on a sparse grid.
- **Best-fit clip search looks at the next 8 clips of the bag.** A tuning choice (it was 12; 8 kept
  planning fast). A larger window finds slightly better fits.
- **Starting inside a slot.** If planning starts partway through a slot's window, only the rest of
  that window is planned, with an info warning. This happens when the end of a lineup is not on a slot
  boundary.

## What is next

In this order:

1. **Finish verifying phase 3.** Playback and guides, then a multi-year lineup. These need the media
   server, and the multi-year lineup adds tens of megabytes to the shared test pod, so agree first.
2. **Close the small build gaps** that make the worker safe to leave running: `channel resync`, a
   way to inspect or close a pending commit, warnings with titles, the unmatched-exception warning,
   chapters, and reading an existing channel's place in its shows.
3. **Settle the open decisions that shape phase 4** (ad overrides, overflow, the duplicate-title
   syntax, how it is run), then design phase 4 with the owner: revisions, staging, pins and locks.
4. **Build phase 4**, then design and build phase 5, with the metrics history for the dashboard.
