# @daytuner/ui

The pages of the web interface: a Vite + React app. The design of each page is in `docs/web-*.md`; the server and API it
talks to are in [`apps/web`](../web/README.md).

```
pnpm --filter @daytuner/ui build     # builds apps/ui/dist, which the server serves
pnpm --filter @daytuner/ui dev       # a dev server that forwards /api to a running DayTuner server (DAYTUNER_API, default :8420)
pnpm --filter @daytuner/ui test
```

Built so far: the dashboard (a card per channel with its health), a channel page (checks, trends over the commits, the
last commits and runs) and the cursors page (a card per ordered show: its next episode and airings, "missed a week", rewind by
N and set to an episode, each previewed before it is applied). No login, no charting library: the trends are small SVG lines with a table view.

The ads page is built too (the block drawn in order, simple settings with a "More" on each, a real sample, and saving as a new revision).

To build: the schedule designer, the staging editor (see `docs/status.md`).
