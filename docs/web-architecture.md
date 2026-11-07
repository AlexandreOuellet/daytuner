# Web interface: architecture (design)

How the interface, the API and the scheduler are built and run. What each page shows is designed separately
(the first is [`web-ads.md`](web-ads.md)). `apps/web` is where this lives; it does not exist yet.

## Decided

- **TypeScript server plus a small React app.** A Node HTTP server (Fastify or Hono) serves a JSON API on top of the
  same engine, schedule, store, client and worker packages. The pages are a Vite + React single-page app, built to static
  files that the same server serves. One language end to end, and the engine's types are shared with the pages. The block
  picture and the staging timeline are the reason for React.
- **No login; the network is the protection.** Like the other *arr applications behind a reverse proxy or inside a
  cluster. DayTuner can write lineups to Tunarr, so it must only be reachable by its owner: the docs say so plainly, and
  the server **binds to localhost by default** (the container sets the address explicitly).
- **One process, one container.** A single Node process runs the HTTP server and the internal scheduler (the daily
  worker), against the SQLite file on the config volume. Long jobs (reading chapters, planning a range) run off the
  request path and report their progress.

## Proposed (confirm when building)

These follow from the decisions above and from rules already in the project. Nothing here is settled until the piece is
built and the owner has seen it.

- **The API is a thin layer over what the CLI already calls.** Every CLI command has a matching call (`stageGenerate`,
  `stageEdit`, `revisionImpact`, `topUp`, `adjustCursor`, ...), so the interface and the CLI cannot disagree. The
  pages never plan on their own; they ask the server.
- **Writing to Tunarr stays behind a switch.** The server starts read-only. The environment variable that lets it write
  to Tunarr (and so lets the scheduler and a "commit" button work) is off unless set, mirroring the client's
  `allowWrites` guard. A read-only server still plans, previews and edits staging.
- **Jobs are visible.** A plan or a commit that takes longer than a moment becomes a job with a state (running, done,
  failed) and a message, polled by the page. Only one job per channel runs at a time, which also protects the "one pending
  commit per channel" rule.
- **Configuration comes from the environment**: the Tunarr address (`TUNARR_URL`), the database path (`DAYTUNER_DB`),
  the address and port to listen on, and the write switch. Secrets are never written to the database or the logs.
- **The scheduler is a plain timer in the process**: once a day at a time of day set per channel, it runs the same top-up
  the CLI's `run` does, and records the result in the commit log. A missed run is made up at the next start.

## Open

- Fastify or Hono (a small choice, made when the server is written).
- How progress is reported to the page (polling is enough to start).
- How the container is built and published, and the first-run experience (adding a channel from a Tunarr channel).
