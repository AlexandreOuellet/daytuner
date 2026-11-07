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
| 3 State and worker | built, not fully verified | SQLite store, safe top-up worker, `channel`, `run`, `cursor` commands. Run end to end on the test copy. Ad and filler playback and the media server's guide not checked |
| 4 Schedules and staging | built, verified on the test copy | Design settled (architecture.md, "Phase 4 storage"). Revisions and all six slices of staging (store, `stage generate|show|clear|lock|unlock|pin|unpin`, locked slots committed as stored, lock conflicts, pins, conflicts shown by `stage show`, `stage delete|resize|add`) built), the preview diff and the revision dry-run against locked slots built; staging was run on the test copy and a locked, a pinned and an added slot were committed and read back identical (see `tunarr-api.md`) |
| 5 Web interface | not started | Needs design first |

Tests: 326 pass across the engine, client, store, schedule, worker and CLI, plus 3 client integration
tests that run only against a real Tunarr (`TUNARR_URL`).

## Needed for 1.0

Nothing is pushed publicly until all of this is done (see the roadmap).

**Phase 3, to finish**
- [x] Playback of programs in a lineup DayTuner wrote: right media, seek and remaining time to within
      44 ms across a split program (see `tunarr-api.md`)
- [ ] Playback of the ad and filler clips: needs a Tunarr that mounts a directory of video clips, set by configuration (DayTuner never reads that path; Tunarr does); the test
      library's other filler list is audio-only tracks, which the stock player cannot remux
- [x] Tunarr's XMLTV guide after an append: programme starts exactly on the grid, contiguous
- [ ] The media server's guide (Jellyfin reading Tunarr's XMLTV) after an append
- [-] Synthetic multi-year lineup: the owner decided not to run it

**Phase 4: schedules and staging**
- [x] Schedules in the store with revisions, a diff and rollback (`channel set-schedule`, `revisions`, `diff`, `rollback`)
- [x] Saving a revision dry-runs it against the locked staged slots and lists those that no longer fit
- [x] Staging: generate into staging (done), edit (done), preview the difference (done), commit (the worker commits staged slots first)
- [x] Pins, locks and lock conflicts in the engine (anchored planning too)
- [x] YAML export (`channel export <name> [--out FILE]`: the current schedule with the library's id beside every show and movie title; import is `channel add` and `channel set-schedule`)

**Phase 5: web interface**
- [ ] The server and its architecture (designed in `web-architecture.md`, not built): TypeScript server plus React app, no login, one process and container
- [ ] Plain configuration of ads, bumpers and filler: the main complaint about Tunarr (designed in `web-ads.md`, not built)
- [ ] Edit schedules, preview, see what is scheduled, link to the channel in Tunarr (the schedule designer is designed in `web-schedule.md`: week grid, drag and type, a Pools panel; not built)
- [ ] Stage a date range, edit a day in staging (delete, add, resize slots, pin programs), re-plan only what changed
- [ ] Cursor adjustments with a preview of which airing they change
- [ ] Metrics dashboard: the numbers in [`metrics.md`](metrics.md) per channel and over time (the metrics
      are computed today but not stored over time)

**Release**
- [ ] A verified end-to-end run on a test copy of Tunarr, including playback and the guide check (staging commit verified; ad playback and the media server's guide still open)
- [ ] A way to run it: a container image whose own scheduler runs the worker daily (decided)

## Open decisions (the owner decides)

Settled this session and recorded under Decided in the roadmap: the exception fallback (warning and dead air), no ad overrides and no overflow or lateness in 1.0, a scheduler inside the container, shows named by id plus title label, mid-break refinement later.


- **Ad and bumper interface.** Decided: a block drawn in order, a live sample from the real library, simple first with details on request, saved as a new schedule revision. See [`web-ads.md`](web-ads.md). Open there: warning about unplayable clips, which lists to offer, where the interstitial sits in the picture.
- **Mid-break offers** need refinement, deferred by the owner until later.
- **Web pages still to design with the owner:** special days (the open part of the schedule designer), the staging editor, the cursors page and the dashboard (the ads page, the schedule designer's main view and the architecture are done).
- **Phase 4 design.** The staging build plan is in [`staging-design.md`](staging-design.md) (six slices; pins by block number, a lock applies its state effect, ranges in local dates). Storage, conflicts, revisions and the revision-versus-locks rule are decided (see
  `architecture.md`, "Phase 4 storage"). Still to settle when building: how staging is shown in the CLI, and the
  exact preview diff format.

## Known gaps

Each is one of: **build** (clear what to do), **verify** (find out), **know** (accepted, worth knowing).

- **know** Chapters are cached in the store (`chapter_cache`), keyed by program id: a cached list is used while the program's length is unchanged and it is under 30 days old, and "has none" is cached too. On the test copy a staging command took 50 s the first time and 7 s after. `daytuner chapters clear` forgets them, for example after the library is scanned again. A program whose chapters cannot be read plans with the every-N-minutes offers, with a note, and is not cached.
- **know** `channel add` shows where each ordered show stands in the channel's existing lineup, and `channel adopt-history` applies it (the last item of the pool in the lineup decides, so a trailing rerun can pull the place back; `cursor set` fixes one). Only for a channel DayTuner has not written to.
- **build** The metrics are not stored over time, which the dashboard needs.
- **verify** Playback of ad and filler clips and the media server's guide (phase 3, above).
- **know** A lineup whose end is fractional (older lineups) gets one rounded flex to the next grid
  line, so it stays up to half a millisecond off the grid from there on.
- **know** `channel resync` adopts Tunarr's real end after a refusal, but then the planner state may not match what is in the lineup; a person has to check the shows' places.

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

1. **Finish verifying phase 3.** Ad and filler clip playback (needs a test Tunarr with a configurable clip mount) and the
   media server's guide. The multi-year lineup is dropped (owner's decision).
2. **Close the remaining small build gaps** that make the worker safe to leave running: none left but the metrics history. (Done: chapters, `channel adopt-history`, `channel commits` and a note on a commit whose verification failed, `channel resync`, titles in warnings, the warning for
   an exception that matches no slot.)
3. **Settle the open decisions that shape phase 4** (ad overrides, overflow, the duplicate-title
   syntax, how it is run), then design phase 4 with the owner: revisions, staging, pins and locks.
4. **Build phase 4**, then design and build phase 5, with the metrics history for the dashboard.
