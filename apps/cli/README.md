# @daytuner/cli

```
pnpm --filter @daytuner/cli daytuner preview <channel.yaml> --tunarr URL [--from ISO] [--days N] [--seed N] [--json]
pnpm --filter @daytuner/cli daytuner apply   <channel.yaml> --tunarr URL [--channel NAME] [--days N] [--seed N] [--state FILE] [--yes]
```

- `preview` reads the library from Tunarr, plans, and prints the metrics in
  [`docs/metrics.md`](../../docs/metrics.md) and the warnings. It never writes.
- `apply` plans from the end of the channel's lineup and **appends**. Without `--yes` it is a dry
  run. With it, it appends, reads the lineup back and checks that Tunarr stored exactly what was
  sent. It never replaces anything and never touches the channel's start time.

Only point `apply --yes` at a test copy of Tunarr, never the one people are watching.
`--state FILE` keeps the planner's state (cursors, bags, random numbers) between runs.
