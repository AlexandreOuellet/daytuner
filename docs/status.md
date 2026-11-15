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
| 3 State and worker | built, verified except ad and filler playback | SQLite store, safe top-up worker, `channel`, `run`, `cursor` commands. Run end to end on the test copy. Ad and filler playback is Tunarr's to mount (see Known gaps); the media server's guide follows Tunarr's, which the owner reports works |
| 4 Schedules and staging | built, verified on the test copy | Design settled (architecture.md, "Phase 4 storage"). Revisions and all six slices of staging (store, `stage generate|show|clear|lock|unlock|pin|unpin`, locked slots committed as stored, lock conflicts, pins, conflicts shown by `stage show`, `stage delete|resize|add`) built), the preview diff and the revision dry-run against locked slots built; staging was run on the test copy and a locked, a pinned and an added slot were committed and read back identical (see `tunarr-api.md`) |
| 5 Web interface | built, being tried | The dashboard, channel and add-a-channel pages, cursors, ads, the schedule designer with pool rules, the calendar (one to seven days as a time grid), and the staging editor. Tried on the test copy; not yet on a real channel |

Tests: all pass across the engine (176), client (27), store (32), schedule (74), worker (88), web (37), UI (101) and CLI (22),
plus 3 client integration tests that run only against a real Tunarr (`TUNARR_URL`).

## Needed for 1.0

Nothing is pushed publicly until all of this is done (see the roadmap).

**Phase 3, to finish**
- [x] Playback of programs in a lineup DayTuner wrote: right media, seek and remaining time to within
      44 ms across a split program (see `tunarr-api.md`)
- [-] Playback of the ad and filler clips: the owner's call is that mounting the clips is Tunarr's job, not DayTuner's (`deploy.md`). Moved to Known gaps (know)
- [x] Tunarr's XMLTV guide after an append: programme starts exactly on the grid, contiguous
- [x] The media server's guide (Jellyfin reading Tunarr's XMLTV) after an append: the owner reports it follows Tunarr and works
- [-] Synthetic multi-year lineup: the owner decided not to run it

**Phase 4: schedules and staging**
- [x] Schedules in the store with revisions, a diff and rollback (`channel set-schedule`, `revisions`, `diff`, `rollback`)
- [x] Saving a revision dry-runs it against the locked staged slots and lists those that no longer fit
- [x] Staging: generate into staging (done), edit (done), preview the difference (done), commit (the worker commits staged slots first)
- [x] Pins, locks and lock conflicts in the engine (anchored planning too)
- [x] YAML export (`channel export <name> [--out FILE]`: the current schedule with the library's id beside every show and movie title; import is `channel add` and `channel set-schedule`)

**Phase 5: web interface**
- [ ] The server and its architecture (`web-architecture.md`): TypeScript server plus React app, no login, one process and container. Built so far (`apps/web`): the Hono server, the read-only API, the job runner, and the write API (add channel, stage generate / lock / pin / edit / reset / check / diff, schedule check and save, rollback, cursors, run, resync, adopt-history, export), with writing to Tunarr off unless switched on. Also built: the daily scheduler (a timer in the process, only when writing is on), metrics stored per commit, targets and health, the dashboard's API. The cursor preview call is built too (`cursorPreview`). The pages are a Vite + React app (`apps/ui`): the dashboard, a channel page, the cursors page, the ads page, the schedule designer's week, pools and special days, and the staging editor are built (a card per channel with its health; checks, trends over the commits, commits and runs; a card per ordered show with a before-and-after preview), served by the same server. To build: nothing from the page designs
- [x] Plain configuration of ads, bumpers and filler: the main complaint about Tunarr (`web-ads.md`; the ads page in `apps/ui`)
- [x] Edit schedules, preview, see what is scheduled, link to the channel in Tunarr (`web-schedule.md`: the week grid, the Pools panel and the calendar of special days are built; the Calendar page is built: one to seven days as the same time grid as the week, with each slot's blocks inside it and a slot dragged to move or resize, one continuous list of what plays, and changes staged from it, including a rerun in place of the next episode. A month view, skipping a block and changing a break's ads are left for after 1.0)
- [x] Add a channel from the page, creating it in Tunarr or attaching one that exists, with an empty week (`web-channels.md`; the page, the create call, and the first run of a channel that sat empty)
- [x] Stage a date range, edit a day in staging (delete, add, resize slots, pin programs), re-plan only what changed (`web-staging.md`; the staging editor in `apps/ui`)
- [x] Cursor adjustments with a preview of which airing they change (`web-cursors.md`; the cursors page in `apps/ui`)
- [ ] Metrics dashboard (check the page against its design): the numbers in [`metrics.md`](metrics.md) per channel and over time (designed in `web-dashboard.md`: a health card per channel, one point per commit, targets with defaults; the metrics
      are computed today but not stored over time)

**Release**
- [ ] A first real channel made through the page (hidden, one slot, then a saved schedule and a run) and watched
- [ ] A code review of the whole diff, and the calendar grid looked at in a browser (drag, resize, move)
- [x] A verified end-to-end run on a test copy of Tunarr: staging commit, program playback and the guide
- [x] A way to run it: a container image whose own scheduler runs the worker daily (`Dockerfile`, `docs/deploy.md`). Built with buildkit in the test cluster and deployed there (`daytuner-test` in `tunarr-test`, behind basic auth, reading the test Tunarr copy, read only)

## Open decisions (the owner decides)

Settled this session and recorded under Decided in the roadmap: the exception fallback (warning and dead air), no ad overrides and no overflow or lateness in 1.0, a scheduler inside the container, shows named by id plus title label, mid-break refinement later.


- **Ad and bumper interface.** Decided: a block drawn in order, a live sample from the real library, simple first with details on request, saved as a new schedule revision. See [`web-ads.md`](web-ads.md). Open there: warning about unplayable clips, which lists to offer, where the interstitial sits in the picture.
- **Mid-break offers** need refinement, deferred by the owner until later.
- **Web pages designed:** all five (the ads page, the cursors page, the staging editor, the schedule designer's main view and the architecture are done).
- **Phase 4 design.** The staging build plan is in [`staging-design.md`](staging-design.md) (six slices; pins by block number, a lock applies its state effect, ranges in local dates). Storage, conflicts, revisions and the revision-versus-locks rule are decided (see
  `architecture.md`, "Phase 4 storage"). Still to settle when building: how staging is shown in the CLI, and the
  exact preview diff format.

## Known gaps

Each is one of: **build** (clear what to do), **verify** (find out), **know** (accepted, worth knowing).

- **know** Chapters are cached in the store (`chapter_cache`), keyed by program id: a cached list is used while the program's length is unchanged and it is under 30 days old, and "has none" is cached too. On the test copy a staging command took 50 s the first time and 7 s after. `daytuner chapters clear` forgets them, for example after the library is scanned again. A program whose chapters cannot be read plans with the every-N-minutes offers, with a note, and is not cached.
- **know** Pool rules are built (`pool-rules.md`): movies and shows by genre, year, rating, studio, tag, actor, director, title, audio and subtitle language, with `match` / `except`, episode filters, `daytuner pool` to list what a rule holds, and a `pool-changed` warning at each plan. Rules are written in the channel file or edited on the schedule page ("Edit as rules"). Run for real on a hidden channel of the live server with a French slot: every movie in the French slots had French audio or subtitles. A show rule on genre or language is one facet call (1.3 s for Comedy on the test copy, was 9.4 s). The rules editor suggests the values the library has, finishes the last value of a comma list, and marks a value the library lacks (hard requirement, built).
- **know** `channel add` shows where each ordered show stands in the channel's existing lineup, and `channel adopt-history` applies it (the last item of the pool in the lineup decides, so a trailing rerun can pull the place back; `cursor set` fixes one). Only for a channel DayTuner has not written to.
- **know** Metrics are stored per commit (`commit_metrics`), with the alerts and warnings of what was written; commits made before this, and commits settled by a recovery, have none.
- **know** Ad and filler clip playback depends on Tunarr having the clip folder mounted; DayTuner does not read it. Without it each break fails to play (see `deploy.md`).
- **build** Saving a week takes about 14 s (a check, then a save, each planning); the save could reuse the check's plan.
- **build** The schedule page cannot save a week with no slots, so a new channel needs one slot before its first save; an empty channel's page says "needs attention" until then.
- **know** A grid must divide the time zone's offset from UTC (see `web-channels.md`); the page offers only those, and a hand-written channel file that breaks it is refused at the run with the reason.
- **know** The calendar grid draws each instant as its wall clock, so on the day the clocks change the hours after the change are drawn an hour off.
- **build** On the calendar: skipping a block, changing a break's ads, a specific place-moved note, and a warning for unlinked slots of one pool; slot display names.
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

1. **Try a real channel** made through the page (hidden, one slot), and fix what it shows.
2. **Review the diff** (it is large) and look at the calendar grid in a browser.
3. **Check the metrics dashboard** against `web-dashboard.md`.
4. **Then 1.0**: tag and push publicly (not before the owner says so).
