# @daytuner/store

SQLite (Node's built-in `node:sqlite`, no native build). Per channel: the planner's state at the
committed edge, the edge, a copy of the channel file, the commit log (`pending`, `done` or `abandoned`)
and the cursor-adjustment log. A commit is recorded as pending before anything is written to Tunarr
and completed afterwards, moving the state and the edge together, so a crash can always be resolved.
Times are passed in; the store never reads the clock.
