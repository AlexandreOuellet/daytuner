# Tunarr API: what was verified

Everything here was tested on **stock Tunarr** (upstream `main` at commit `86cf43e3`, no
modifications), running on a copy of a real database, using only the HTTP API. The script is in
[`tools/spike/run.py`](../tools/spike/run.py).

## The write path

`POST /api/channels/{id}/programming` accepts a **manual** lineup:

```json
{ "type": "manual", "lineup": [ ...items... ], "append": false }
```

Item types: `content` (with `startOffsetMs`, which is how a program is split at its ad breaks),
`filler` (`fillerListId`, `fillerType`), `flex` (optionally with a `fillerConfig`), `custom`,
`redirect`. These are the same shapes the stock scheduler writes.

## Verified

| Check | Result |
|---|---|
| Save a day: 874 items (content, ad clips for mid/post/tail, flex) | Stored lineup is identical to what was sent |
| Expand with `append: true` | Stored lineup is identical to day 1 + day 2; duration is the exact sum |
| Rewrite the future (`append: false`, same past, new future) | Stored identical; `now_playing` unchanged |
| Filler types `head`, `pre`, `mid`, `post`, `tail`, `fallback` | All accepted and stored as sent |
| Flex with and without a `fillerConfig` | Both accepted and stored as sent |
| Program ids the channel does not already contain | Accepted. They only have to exist in the library |
| Channel `startTime` through manual saves | Never changes |
| `GET /api/channels/{id}/now_playing` | Reports the right program after each step |
| Channel duration | Always equals the sum of the lineup (to the millisecond) |

Ad clips and bumpers are ordinary `filler` items pointing at a clip (a program id) in a filler
list, with that clip's duration. Choosing the clips is the engine's job ("eager" scheduling).

## A DayTuner lineup appended to the test copy

`daytuner apply` appended a planned 3-day lineup (2520 items: content split at mid breaks, mid,
post and tail ads, `fallback` interstitials and flex) to the channel "Test Channel" of the test
copy, on top of a lineup whose end carried a fraction of a millisecond. Checked afterwards:

- The stored items were exactly the items sent (count, types and durations); the lineup grew by
  exactly the sum sent; the channel's `startTime` did not change.
- Split programs are continuous: each piece starts at the previous piece's `startOffsetMs` plus its duration.
- The guide (`GET /api/channels/{id}/lineup?from=&to=`) lists the new programs starting exactly on
  the 15-minute grid, to the second. `now_playing` still answers.
- An existing lineup whose end is fractional is handled by one flex (rounded to whole milliseconds)
  up to the next grid line. After it, everything written is whole milliseconds.

## The read path (verified on the test copy)

| What | Call | Notes |
|---|---|---|
| Channels | `GET /api/channels` | `duration` is fractional, so round it |
| Stored lineup | `GET /api/channels/{id}/programming` | `lineup` holds the items as written |
| Filler lists | `GET /api/filler-lists`, then `GET /api/filler-lists/{id}/programs` | one entry per clip; its `duration` is fractional (for example `135732.245`) |
| Movies, shows | `POST /api/programs/search` with a `type` filter, `page` and `limit` | movies carry `duration` and `genres`. **Pages count from 0**: page 1 skips the first `limit` results, and a `limit` at or above the total with page 1 returns nothing. Check the count against `totalHits` |
| Episodes of a show | `GET /api/programs/{showId}/descendants` | each has `season.index` and `episodeNumber`; sort by those for the viewing order |
| Chapters | `GET /api/programs/{id}/stream_details` | not on the other program endpoints, so one call per program |

Item shapes in a stored lineup: `content` has `id`, `startOffsetMs` and `duration` (the length of
that piece); `filler` has `id` (the clip), `fillerListId`, `fillerType` and `duration`; `flex` has
`duration`. Library and clip durations are fractional, so DayTuner rounds each once, when it reads
them, and plans in whole milliseconds from there.

## The test copy

Never write to the Tunarr that people watch.
Writes go to a stock Tunarr running on a copy of the data: the temporary `tunarr-stock-test` pod in
the `tunarr-test` namespace, reached with `kubectl -n tunarr-test port-forward pod/tunarr-stock-test
18000:8000`. Its channel "Test Channel" is the one to write to. Client tests that need a server run
only when `TUNARR_URL` is set, and the integration tests in the client package only read.

## Do not do

- **Do not change a channel's `startTime`** (`PUT /api/channels/{id}`). It is stored to the whole
  minute, and changing it on a channel with a lineup changed the stored lineup in ways that were
  not understood (the duration shrank and a long flex appeared at the start). The lineup can
  only grow; plan for a year or so of lineup (about 60 to 75 MB) as Tunarr does today.
- Do not let the channel be saved from Tunarr's own interface while managed here.

## Not verified yet

- Real playback through ffmpeg and the media server for a manually written lineup.
- The XMLTV guide and the media server's guide after an append (caching was a problem before). Only
  Tunarr's own guide endpoint is checked, above.
- How a very long lineup (several years) behaves.
- Behaviour of `append: true` exactly at the moment a viewer crosses the join.

## Useful endpoints

`GET /openapi.json` (the schema), `GET /api/channels`, `GET /api/channels/{id}`,
`GET /api/channels/{id}/programming` (the stored lineup), `GET /api/channels/{id}/now_playing`,
`GET /api/channels/{id}/lineup?from=&to=` (the guide, which hides ad filler),
`GET /api/smart_collections`, `POST /api/programs/search`.
