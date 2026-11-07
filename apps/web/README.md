# @daytuner/web

The interface: the server and its JSON API (the pages come later). Design: [`docs/web-architecture.md`](../../docs/web-architecture.md)
and the page designs it links to. A Hono server on the same engine, schedule, store and worker code as the command line.

```
pnpm --filter @daytuner/web start
```

The server also serves the pages (`apps/ui`, built with `pnpm --filter @daytuner/ui build`) from `DAYTUNER_UI_DIR`
(default `apps/ui/dist`); without a build it serves only the API.

Configuration is from the environment: `DAYTUNER_DB` (default `state/daytuner.db`), `DAYTUNER_HOST` (default `127.0.0.1`, so
only this machine can reach it), `DAYTUNER_PORT` (default 8420), `DAYTUNER_ALLOW_WRITES=1` (default off: read only) and
`TUNARR_URL`. There is no login: only expose it to people who may change your lineups.

## API

| Call | Gives |
|---|---|
| `GET /api/health` | `{ ok, version, writes }` |
| `GET /api/channels` | each channel: name, timezone, floor, step, revision, edge, `aheadMs`, `pendingCommit`, `staged` |
| `GET /api/channels/:name` | the same, with its last commits |
| `GET /api/channels/:name/schedule` | the current revision and its YAML |
| `GET /api/channels/:name/revisions`, `/revisions/:n` | the revisions, or one |
| `GET /api/channels/:name/diff?from=&to=` | a line diff of two revisions (default: previous to current) |
| `GET /api/channels/:name/staged?from=&to=&items=1` | staged slots, with locks, pins and blocks (items on request) |
| `GET /api/channels/:name/commits?limit=` | the commit log |
| `GET /api/dashboard` | a card per channel: the summary plus its health (checks against its targets) |
| `GET /api/channels/:name/health`, `/metrics?limit=`, `/runs?limit=` | the checks; one metrics point per commit (oldest first); how the last runs ended |
| `GET /api/channels/:name/targets`, `POST` | what good looks like (dead air, ad load, end-of-slot wait, alerts, repeats); `POST` changes some |
| `POST /api/channels/:name/settings` | `{ floorMs?, stepMs?, runAt? }`: `runAt` is `"HH:MM"` in the schedule's own zone |
| `GET /api/jobs`, `/api/jobs/:id` | jobs: one running per channel at a time |

### The daily run

When the server is started with `DAYTUNER_ALLOW_WRITES=1` it also runs a timer: every minute it starts the worker for each
channel whose daily run has come due (at its `runAt`, default 03:00, in the schedule's zone) and has not been tried since. It
uses the same jobs as a manual run, so a channel is never run twice at once, and records how each run ended (shown by
`/runs` and on the dashboard). A run that failed or was refused is not tried again until the next day. After a restart a
missed run is made up. With writing off there is no timer.

### Calls that change things

A call that reads the library or plans answers `202 { job }` at once (poll `GET /api/jobs/:id`; the job's `result` holds
the outcome); a quick store change answers directly. Times are epoch milliseconds or a local date or date-time in the
channel's zone (`"2026-10-31"`, `"2026-10-31T20:00"`). Nothing writes to Tunarr except `run` with `dryRun: false`, which
needs the server started with `DAYTUNER_ALLOW_WRITES=1`.

| Call | Body | Does |
|---|---|---|
| `POST /api/channels` | `{ yaml, tunarrChannel?, floorMs?, stepMs?, seed? }` | job: add a channel from a channel file; reports where each show stands |
| `POST /api/channels/:name/stage/generate` | `{ to, keepFrom?, keepTo? }` | job: plan a range and stage the kept part |
| `POST .../stage/lock` | `{ start, locked }` | lock or unlock a staged slot |
| `POST .../stage/pin`, `/unpin` | `{ start, block, program }` / `{ start, block }` | job: pin a program (`movie:Title`, `episode:Show/Title` or `{id,title,duration}`) to a block, or remove it |
| `POST .../stage/edit` | `{ kind: delete\|resize\|add, start, end?, program? }` | job: reshape staged slots |
| `POST .../stage/reset` | `{ from, to }` | job: put staged slots in a range back to what the schedule plans (locked slots stay) |
| `POST .../stage/check`, `/diff` | | job: the conflicts the next commit would find; what staging changes compared with the plan |
| `POST .../stage/clear` | `{ from?, to? }` | remove staged slots |
| `POST .../schedule/check` | `{ yaml }` | job: dry-run a new schedule against locked staged slots |
| `POST .../schedule` | `{ yaml, force? }` | job: save a new revision; refused (`saved: false`) when locked slots would not fit, unless `force` |
| `POST .../schedule/rollback` | `{ revision }` | make an earlier revision current |
| `GET .../cursors`, `POST .../cursors/preview`, `POST .../cursors/adjust` | `{ key, kind: rewind\|set, amount }` | the shows' places; job: what an adjustment would change (the next airings now and after, which are committed, staged or locked); job: move one and plan the staged slots again |
| `POST .../run` | `{ dryRun? }` | job: plan, or commit when `dryRun` is `false` and writing is on |
| `POST .../resync`, `/adopt-history` | `{ apply? }` | settle a pending commit or adopt Tunarr's end; set shows' places from the lineup (dry run unless `apply`) |
| `GET .../ads`, `POST .../ads/sample`, `POST .../ads` | `{ settings }` / `{ settings, force? }` | the ad, bumper and filler settings as plain numbers with Tunarr's filler lists; job: plan a sample episode and movie with settings applied (saves nothing); job: save them as a new revision (refused over locked slots unless `force`) |
| `GET .../schedule/model`, `POST .../schedule/model` | `{ week, pools, exceptions?, check?, force? }` | the week's slots, the pools and the special days as data; job: save a changed week and pools as a new revision (`check` only reports what it would do to locked slots) |
| `POST .../special-days` | `{ exceptions?, week? }` | where the special days fall in the coming year, and each one's state (`committed`, `staged`, `rule`) and whether a slot starts then |
| `GET /api/library/movies?q=`, `GET /api/library/shows/:id/episodes` | | movies by title (two letters or more), and a show's episodes, for choosing what a special day plays |
| `POST .../pools/stats` | `{ pools }` | job: how many programs each pool (saved or not) holds, and how long each is |
| `GET /api/library` | | the library's shows and movie genres, for pickers |
| `GET .../export` | | the schedule with the library's ids beside every title |

Errors are `{ "error": message }` with 400 (bad input), 403 (writing is off), 404 or 409 (the channel is busy: the running job is in the body).
