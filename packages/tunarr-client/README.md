# @daytuner/tunarr-client

A small typed client for Tunarr. Endpoints and caveats: [`docs/tunarr-api.md`](../../docs/tunarr-api.md).

- **Reads** (`client.ts`): channels, stored lineups, filler lists and clips, movies, shows, episodes in
  viewing order. Durations are rounded to whole milliseconds once, here. Searches check the count
  against Tunarr's `totalHits`, so a dropped page cannot go unnoticed.
- **Writes** (`appendLineup`): off unless the client is created with `allowWrites`. It only appends.
- **Lineup items** (`lineup.ts`): turns the engine's planned slots into Tunarr's manual lineup items,
  and aligns an existing lineup's end to the grid.

Tests that need a server run only when `TUNARR_URL` is set, and only read.
