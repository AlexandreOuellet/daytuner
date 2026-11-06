# @daytuner/schedule

Reads a channel file (YAML, see [`schedules/example.yaml`](../../schedules/example.yaml)) and turns it
into what the engine takes.

- `parseScheduleFile`: strict parsing (unknown keys and bad values are errors that say where).
- `resolveSchedule`: finds the shows, movies and filler lists in a library (anything shaped like the
  Tunarr client) and builds the engine's `Schedule` and `Library`. Several shows in one ordered pool
  take turns. Titles match ignoring case and curly quotes.
