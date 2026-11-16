# Building DayTuner

DayTuner is a TypeScript workspace (pnpm) with a React front end. It needs Node 22 or later and pnpm 10.

## From source

```
corepack enable
pnpm install
pnpm test            # every package's tests
pnpm typecheck
pnpm --filter @daytuner/ui build      # the pages, into apps/ui/dist
```

Run the server from source (it serves the built pages):

```
cd apps/web
TUNARR_URL=http://localhost:8000 DAYTUNER_DB=./daytuner.db DAYTUNER_UI_DIR=../ui/dist \
  node --import tsx src/main.ts
```

Then open <http://127.0.0.1:8420>. For work on the pages, `pnpm --filter @daytuner/ui dev` starts the Vite dev server.

The command line runs the same way: `cd apps/cli && node --import tsx src/main.ts` prints every command.

## The container image

```
docker build -t daytuner .
```

The image holds the server, the command line (as `daytuner` inside the container) and the built pages; it holds no state. It
needs no special build host: any Docker or BuildKit builder works.

## Layout

```
packages/engine         pure planning code: no network, no database
packages/schedule       the channel file (YAML) and the pool rules
packages/tunarr-client  typed client for the parts of Tunarr's API DayTuner uses
packages/store          the SQLite store
packages/worker         the run: plan, check, append, the daily scheduler
apps/cli                the command line
apps/web                the HTTP server and its API
apps/ui                 the React pages
schedules/              an example channel file
```

Contributors: see [`AGENTS.md`](../AGENTS.md) and [`status.md`](status.md).
