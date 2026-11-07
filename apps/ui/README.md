# @daytuner/ui

The pages of the web interface: a Vite + React app. The design of each page is in `docs/web-*.md`; the server and API it
talks to are in [`apps/web`](../web/README.md).

```
pnpm --filter @daytuner/ui build     # builds apps/ui/dist, which the server serves
pnpm --filter @daytuner/ui dev       # a dev server that forwards /api to a running DayTuner server (DAYTUNER_API, default :8420)
pnpm --filter @daytuner/ui test
```

Built so far: the dashboard (a card per channel with its health) and a channel page (checks, trends over the commits, the
last commits and runs). No login, no charting library: the trends are small SVG lines with a table view.

To build: the cursors page, the ads page, the schedule designer, the staging editor (see `docs/status.md`).
