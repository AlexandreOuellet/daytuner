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

## Guide and playback checks (test copy)

- **XMLTV** (`POST /api/xmltv/refresh`, then `GET /api/xmltv.xml`): verified. All 19 programmes
  from DayTuner's first append (from 08:00:00Z) start exactly on a 15-minute line, are contiguous with
  no gap or overlap, and carry the right titles. Ads are folded into the programme they belong to.
  The guide only covers `programmingHours` (72) ahead, so it cannot show a lineup written further out.
  The media server's own guide (Jellyfin reading Tunarr's XMLTV) was not checked.
- **`GET /stream/channels/{id}/item-stream.ts?t=`** does **not** play the item that started at `t`.
  It streams whatever is on air at the wall-clock moment of the request and only logs a mismatch.
  A future part of a lineup therefore cannot be played through it, and a request for one returns the
  item airing now. (Earlier readings in this project that treated it otherwise were wrong.)
- **Split programs.** A `content` item's `startOffsetMs` is the offset into the source media where
  that piece begins. Tunarr's own test (`StreamProgramCalculator.test.ts`, "mid-roll break") covers
  exactly this: 8 minutes at offset 0, a break, then 14 minutes at offset 8 minutes. The stock
  scheduler writes `baseOffset + segmentStart`, the same shape DayTuner writes. Also observed (next
  section).
- **Ad clips cannot be played from the `tunarr-stock-test` pod.** The "ads" source is local files under
  `/ads`, which that pod does not mount (a Tunarr with that folder mounted does). Tunarr's log shows `Error opening input: No such file or directory`.
- Playing a DayTuner-written region needs the wall clock to be inside it: a throwaway channel in the
  test copy whose start is in the past, with the plan appended from its start.

### Observed playback of a DayTuner-written lineup

On a throwaway channel in the test copy (created with `POST /api/channels`, body
`{"type": "new", "channel": {...}}` with a client-supplied `id`, `duration: 0` and a `startTime` on the
grid in the past; deleted afterwards), a 4-hour plan was appended from the channel's very first
moment. While the wall clock ran through it, 15 samples asked the pod to stream and read its real
ffmpeg command line:

- **Every content piece (8 samples, across pieces 3 and 4 of one episode, either side of a break)
  played the right Jellyfin media, seeking to `startOffsetMs` plus the time elapsed in the piece, with
  the right time remaining, to within 44 ms.** The piece after a break resumed at exactly its
  `startOffsetMs`. So a program split at its mid breaks is played continuously.
- **Filler items (7 samples) were not playable in that pod, for reasons of the pod and the library:**
  the clips used (the "Funny Filler" list) are audio-only music tracks, and the stock remux path fails
  with `Stream map '' matches no streams`, after which Tunarr falls back to an error screen that wants a
  GPU the pod lacks. The "Old Ads" clips are video files under `/ads`, which the pod does not mount.
  The timeline itself was unaffected: the next content piece started on time.

## The read path (verified on the test copy)

| What | Call | Notes |
|---|---|---|
| Channels | `GET /api/channels` | `duration` is fractional, so round it |
| Stored lineup | `GET /api/channels/{id}/programming` | `lineup` holds the items as written |
| Filler lists | `GET /api/filler-lists`, then `GET /api/filler-lists/{id}/programs` | one entry per clip; its `duration` is fractional (for example `135732.245`) |
| Movies, shows | `POST /api/programs/search` with a `type` filter, `page` and `limit` | movies carry `duration` and `genres`. **Pages count from 0**: page 1 skips the first `limit` results, and a `limit` at or above the total with page 1 returns nothing. Check the count against `totalHits` |
| Episodes of a show | `GET /api/programs/{showId}/descendants` | each has `season.index` and `episodeNumber`; sort by those for the viewing order |
| Chapters | `GET /api/programs/{id}/stream_details` | not on the other program endpoints, so one call per program (about 0.4 s). They are at `details.streamDetails.chapters`: `startTime` and `endTime` in milliseconds from the start of the program, and a `chapterType`. On the test copy about half the movies had none, the rest 5 to 34, all of type `chapter` and titled "Chapter N"; the last one ends at the program's duration. Episodes: about a third of the 175 shows have none (for example Futurama, Brooklyn Nine-Nine, 30 Rock); sitcoms that have them usually carry 4 to 9 per episode, one-hour dramas 7 to 14, some mixed within one show |

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

- Real playback of a lineup DayTuner wrote, watched while the wall clock is inside it (see above for what was checked in the code).
- The XMLTV guide and the media server's guide after an append (caching was a problem before). Only
  Tunarr's own guide endpoint is checked, above.
- How a very long lineup (several years) behaves.
- Behaviour of `append: true` exactly at the moment a viewer crosses the join.

## Useful endpoints

`GET /openapi.json` (the schema), `GET /api/channels`, `GET /api/channels/{id}`,
`GET /api/channels/{id}/programming` (the stored lineup), `GET /api/channels/{id}/now_playing`,
`GET /api/channels/{id}/lineup?from=&to=` (the guide, which hides ad filler),
`GET /api/smart_collections`, `POST /api/programs/search`.

### Chapters on real episodes

A 3-day plan of four shows on the test copy (Bob's Burgers, Community, Archer, Brooklyn Nine-Nine, 30-minute
grid) used 72 episodes, 54 of them with chapters. It made 205 mid breaks. Every break inside an episode
that has chapters (169 of them) sits exactly at a chapter end; the other 36 are in episodes with none (all
of Brooklyn Nine-Nine and some others), and use the every-N-minutes offers.
