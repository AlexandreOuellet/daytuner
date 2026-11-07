# @daytuner/web

The interface: the server and its JSON API (the pages come later). Design: [`docs/web-architecture.md`](../../docs/web-architecture.md)
and the page designs it links to. A Hono server on the same engine, schedule, store and worker code as the command line.

```
pnpm --filter @daytuner/web start
```

Configuration is from the environment: `DAYTUNER_DB` (default `state/daytuner.db`), `DAYTUNER_HOST` (default `127.0.0.1`, so
only this machine can reach it), `DAYTUNER_PORT` (default 8420), `DAYTUNER_ALLOW_WRITES=1` (default off: read only) and
`TUNARR_URL`. There is no login: only expose it to people who may change your lineups.

## API (read only so far)

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

Errors are `{ "error": message }` with 400 (bad input), 404 or 409 (the channel is busy).
