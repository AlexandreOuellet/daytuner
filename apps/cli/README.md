# @daytuner/cli

```
daytuner preview <channel.yaml> [--from ISO] [--days N] [--seed N]
daytuner channel add <channel.yaml> [--channel NAME] [--seed N] [--floor 7d] [--step 24h]
daytuner channel set-schedule <name> <channel.yaml>
daytuner channel list | status <name> | commits <name>
daytuner run <name> [--yes]
daytuner cursor <name> list | rewind <sequence> <k> | set <sequence> <episode-number>
```

Common options: `--tunarr URL` (or `TUNARR_URL`), `--db FILE` (or `DAYTUNER_DB`, default `state/daytuner.db`).
From the repository: `pnpm --filter @daytuner/cli daytuner ...`.

- `preview` plans from the library in Tunarr and prints the metrics in
  [`docs/metrics.md`](../../docs/metrics.md) and the warnings. It never writes and keeps no state.
- `channel add` imports a channel file into the store and records where the channel's lineup ends now.
- `run` is the worker: it tops the channel up to floor + one step and **appends**. Without `--yes` it
  is a dry run. It refuses, and writes nothing, if Tunarr's lineup ends somewhere other than the
  store says, or has already run out. It reads the lineup back after writing and checks it.
- `cursor` moves an ordered show's place after a missed week (rewind by k, or set an episode). It
  changes the first uncommitted airing onward; what is already in Tunarr stays.

Only point `run --yes` at a test copy of Tunarr, never the one people are watching.
