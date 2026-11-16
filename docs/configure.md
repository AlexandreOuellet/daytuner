# Configuring DayTuner

## The server

All settings are environment variables.

| Variable | Meaning | Default |
|---|---|---|
| `TUNARR_URL` | Where Tunarr is, for example `http://tunarr:8000`. Required. | |
| `DAYTUNER_ALLOW_WRITES` | `1` lets DayTuner write lineups to Tunarr, create channels from the page, and run the daily scheduler. Without it, it only reads and plans. | off |
| `TZ` | The server's time zone. A channel created from the page gets it. A container is UTC unless this is set. | the system's |
| `DAYTUNER_DB` | The SQLite file | `/config/daytuner.db` in the image |
| `DAYTUNER_HOST`, `DAYTUNER_PORT` | Where it listens | `0.0.0.0`, `8420` in the image; `127.0.0.1` from source |
| `DAYTUNER_UI_DIR` | The built pages | `/app/apps/ui/dist` in the image |

The command line takes `--tunarr URL` and `--db FILE` in place of the first and fourth.

## A channel

A channel is a Tunarr channel plus a **schedule** kept in DayTuner. Add one from the page ("Add a channel"), or from a channel
file with `daytuner channel add file.yaml`. The page can create a new, empty channel in Tunarr (needs writing on; **hidden** by
default, so it is not shown in guides until you say so) or attach one that exists.

Per channel (the page's channel settings, or `POST /api/channels/:name/settings`):

- **Run time:** when the daily run happens, in the schedule's time zone. Default 03:00.
- **Floor and step:** how far ahead the lineup is kept written (default 3 days) and how much is added at a run (default 24 hours).
- **Ad and filler lists:** chosen from the lists Tunarr has.

### The grid and the time zone

A channel has a **grid** (5, 10, 15, 20, 30 or 60 minutes; 15 by default): every slot and program starts on a multiple of it. The
grid must divide the time zone's offset from UTC, so the page offers only the grids that fit your zone. The time zone is the
server's (`TZ`) and is not a per-channel choice on the page.

### The channel file

The schedule is a YAML file, also what *Export* gives back. [`schedules/example.yaml`](../schedules/example.yaml) is a complete,
commented example. In short:

- `pools`: named sets of shows or movies. Movies and shows can be picked by title or by rules (genre, year, rating, studio, tag,
  actor, director, title, audio and subtitle language, duration), with `match` and `except`. See [`pool-rules.md`](pool-rules.md).
  A pool is `sequential` (an ordered show, never skipping an episode) or `shuffle` (a bag: each item once before any repeats).
- `week`: for each day, the slots, each with a start time and a pool. A slot lasts until the next one starts, or for its
  `length`. A slot can be *linked* to another to continue its show or rerun it.
- `ads` and `bumpers`: what plays in each break position (head, mid, post, tail), and its length. See
  [`planning-rules.md`](planning-rules.md) and [`web-ads.md`](web-ads.md).
- `exceptions`: special days (a date and time, and what plays), which win over the week.

The rules the planner follows are in [`planning-rules.md`](planning-rules.md); the words (slot, block, window) in
[`glossary.md`](glossary.md).
