# DayTuner

A standalone scheduling application for [Tunarr](https://github.com/chrisbenincasa/tunarr).
DayTuner is an independent project and is not affiliated with or endorsed by Tunarr.

Tunarr stays what it is good at: it holds the media library, streams the channels, and stores
each channel's lineup. **This project owns everything about deciding what plays and when**:
the schedule definition, the planning (grid, ads, bumpers), the preview with metrics, the commit,
and the memory of "which episode plays next".

> **Status: working, not yet released.** The planner, the command line, the store, the worker, the web interface and a container
> image are built and tested against a copy of Tunarr. It is not published or tagged: see [`docs/status.md`](docs/status.md) for what is
> done and what is left, and [`docs/deploy.md`](docs/deploy.md) to run it. Rules and design: [`docs/roadmap.md`](docs/roadmap.md).

## Why

Scheduling inside Tunarr turned out to be the hard part of running a themed channel lineup:

- Changing a rule means building an image, opening a PR and redeploying.
- Saving a schedule replaces the whole lineup (60 to 75 MB for a year) and moves anyone watching.
- There is no preview, no diff, no rollback, and no way to measure what a schedule will really do.
- Small timing errors add up (a few milliseconds a block became minutes over a year).
- Ordered shows cannot skip an episode that does not fit, and iterators restart on every regeneration.

Tunarr's API already accepts a hand-built ("manual") lineup, including ad clips, bumpers and flex.
That means the scheduling brain can live outside Tunarr and write to it. See
[`docs/tunarr-api.md`](docs/tunarr-api.md) for what was verified.

## How it fits

```
        schedules (SQLite, YAML export)                Jellyfin / players
                  |                                           ^
                  v                                           |
  +-----------------------------+   read library     +------------------+
  |           DayTuner          | <------------------ |      Tunarr      |
  |  engine . preview . worker  |   write lineup      |  library . lineup |
  |  state . web interface      | ------------------> |  streaming . EPG  |
  +-----------------------------+   (append / replace)+------------------+
```

## Documentation

| Document | What it covers |
|---|---|
| [`docs/vision.md`](docs/vision.md) | The goal, principles, non-goals, and how we will know it works |
| [`docs/glossary.md`](docs/glossary.md) | What each word means: slot, planned slot, window, block, tiers, and so on |
| [`docs/architecture.md`](docs/architecture.md) | Components, data flow, state, deployment |
| [`docs/tunarr-api.md`](docs/tunarr-api.md) | What was verified against stock Tunarr, and what is still unknown |
| [`docs/planning-rules.md`](docs/planning-rules.md) | The scheduling rules the engine must implement |
| [`docs/metrics.md`](docs/metrics.md) | The measurements used to judge a schedule |
| [`docs/roadmap.md`](docs/roadmap.md) | Phases and open decisions |

## Licence and credits

Released under the [MIT licence](LICENSE).

This project is an independent work and is not affiliated with Tunarr. It talks to
[Tunarr](https://github.com/chrisbenincasa/tunarr) (copyright (c) 2020 Dan Ferguson, Victor Hugo
Soliz Kuncar, zlib licence) only through its HTTP API. If code from Tunarr is ever copied into
this repository, its notice must be kept, the file marked as altered, and the origin stated here.

## Layout

```
packages/engine         pure planning code: no network, no database
packages/tunarr-client  typed client for the parts of Tunarr's API we use
apps/cli                preview and apply from the command line
apps/web                the interface (later)
schedules/              example schedule in the YAML import/export format
tools/spike             the script that verified the Tunarr API
docs/                   the documents above
```
