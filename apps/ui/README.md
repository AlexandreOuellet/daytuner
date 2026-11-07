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

The schedule designer is built for the week and the pools (a week grid with drag, arrow keys and typing, a Pools panel with live counts, saved as a revision).

The special days page is built (a calendar of the coming year, with each day's state, adding a movie or an episode, every year or this year only).

The staging editor is built too (a day timeline with the slots and their programs, drag or type to resize, locks, pins through a search, add and delete, reset, and a panel of what each change did).

All five pages designed in `docs/web-*.md` are built. What is left is in `docs/status.md`.
