# Web interface: the metrics dashboard (design)

The page that shows how the channels are doing, from the numbers in [`metrics.md`](metrics.md). It also decides how
metrics are stored over time, which the engine computes today but nothing keeps. Architecture is in
[`web-architecture.md`](web-architecture.md).

## Decided

- **A health card per channel, then trends.** Each channel is a card with a few headline numbers (ad share, dead air,
  how far ahead it is committed, repeats, warnings in the last commit), marked ok or needs attention against its targets.
  Click a card for the full metrics, trend lines and the last commits. You see at a glance whether anything needs you.

  ```
  The Funny Bone      committed 8.1 days ahead      [ok]
    ad share 22.4%   dead air 0.21%   repeats 0   last commit: 0 alerts

  Betamax Boulevard   committed 2.3 days ahead      [needs attention]
    floor is 7 days   last run failed: lineup ran out

    [ open ]  full metrics, trends, last commits
  ```

- **Trends have one point per commit.** Each time the worker (or the owner) commits, DayTuner stores the metrics of
  what it wrote. A change of schedule or ad settings then shows exactly where it took effect, no point needs a replan,
  and a point can be opened to see that commit's slots.
- **Targets the owner sets, with sensible defaults.** Per channel, a few thresholds start from defaults and can be
  changed. The cards mark ok or needs attention against them, and the commit log says which target tripped.

## Storage

- A `commit_metrics` table: one row per commit, with the commit id and the computed metrics as JSON (the same
  `Metrics` the engine returns). It is written in the same step that completes the commit, from the slots that were
  appended. The channel's grid and time zone, which the metrics need, come from the schedule in force at that commit.
- A per-channel `targets` row (JSON), created with the defaults when the channel is added.
- Commits made before this exists have no stored metrics (the log keeps only each slot's programs, not its items), so
  their points are missing and the trend starts at the first commit made after the change.

## Proposed targets (confirm when building)

| Target | Default | Marks needs attention when |
|---|---|---|
| Committed ahead | the channel's floor | the lineup reaches less than the floor |
| Dead air | under 0.5% of air time | above |
| Ad share | inside the schedule's ratio | outside it |
| Longest wait at the end of a slot | p90 under 30 minutes | above |
| Alerts in the last commit | none | any |
| Repeats of an ordered show's cycle | none | any |
| Last run | succeeded | failed or refused (for example "lineup ran out") |

## Open

- Whether the dashboard also shows the **staged range's** metrics (what would air if committed now), beside the
  committed ones. It can be planned on demand, like the diff.
- **Retention:** one row per commit is small, so it is kept; whether old rows are ever thinned.
- **Notifications** when a card turns to needs attention: not decided, not needed for 1.0.
- **Small screens:** cards stack; the trend charts need a narrower layout.
