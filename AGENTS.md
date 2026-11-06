# DayTuner: notes for contributors and coding agents

- Read `docs/vision.md`, `docs/glossary.md`, `docs/planning-rules.md` and `docs/architecture.md`
  first. The rules come from measurements, and the glossary fixes what slot, planned slot and block
  mean. `docs/roadmap.md` lists what is decided and what is still open (see "Open decisions").
- Design before code: settle an open decision with the owner and record it in the docs before
  building it. DayTuner is pushed publicly only as a good working 1.0 (see the roadmap).
- `packages/engine` stays pure: no network, no database, no `Date.now()`. Inject the clock.
- Never write to a Tunarr that people are watching while testing. Use a copy of its data.
- Never change a channel's `startTime`. See `docs/tunarr-api.md`.
- Every duration written to a lineup is an integer number of milliseconds.
- Do not commit secrets, library dumps or lineup files.
