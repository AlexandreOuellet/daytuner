# @daytuner/web

The interface: the server and its JSON API (the pages come later). Design: [`docs/web-architecture.md`](../../docs/web-architecture.md)
and the page designs it links to. A Hono server on the same engine, schedule, store and worker code as the command line.

```
pnpm --filter @daytuner/web start
```

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
| `GET /api/jobs`, `/api/jobs/:id` | jobs: one running per channel at a time |

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
| `GET .../cursors`, `POST .../cursors/adjust` | `{ key, kind: rewind\|set, amount }` | the shows' places; move one (and plan the staged slots again) |
| `POST .../run` | `{ dryRun? }` | job: plan, or commit when `dryRun` is `false` and writing is on |
| `POST .../resync`, `/adopt-history` | `{ apply? }` | settle a pending commit or adopt Tunarr's end; set shows' places from the lineup (dry run unless `apply`) |
| `GET .../export` | | the schedule with the library's ids beside every title |

Errors are `{ "error": message }` with 400 (bad input), 403 (writing is off), 404 or 409 (the channel is busy: the running job is in the body).
