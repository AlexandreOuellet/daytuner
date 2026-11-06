# @daytuner/worker

`topUp(deps, channel, { dryRun })` keeps a channel's committed lineup at least floor + one step ahead
of now. It checks that the store and Tunarr agree about where the lineup ends, plans from there with
the stored state, records a pending commit, appends and verifies, then completes the commit. A crash
between those steps is settled by the next run from where Tunarr's lineup really ends. It only appends.

`adjustCursor` rewinds an ordered show or sets its episode. Rules: [`docs/architecture.md`](../../docs/architecture.md), "Worker".
