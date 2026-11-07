// The daily run, inside the server: a plain timer that, each minute, starts the worker for every channel whose
// run has come due. It uses the same jobs as a manual run, so a channel is never run twice at once, and it records
// how each run ended. Only started when the server may write to Tunarr.

import type { Clock } from '@daytuner/engine';
import type { Store } from '@daytuner/store';
import type { TunarrClient } from '@daytuner/tunarr-client';
import { isDue, runAndRecord } from '@daytuner/worker';
import { JobBusyError, type Jobs } from './jobs.js';

export interface SchedulerDeps {
  store: Store;
  clock: Clock;
  jobs: Jobs;
  /** Must be a client that may write. */
  writeClient: TunarrClient;
  log?: (message: string) => void;
}

export class Scheduler {
  constructor(private readonly d: SchedulerDeps) {}

  /** Starts the run of every channel that is due and not busy. Returns their names. Does not wait for them. */
  tick(): string[] {
    const { store, clock, jobs, writeClient } = this.d;
    const started: string[] = [];
    for (const ch of store.channels()) {
      let due: boolean;
      try {
        due = isDue(ch, store.lastRuns(ch.id, 1)[0]?.at, clock.now());
      } catch {
        continue; // a schedule that no longer parses is shown on the dashboard, not run
      }
      if (!due) continue;
      try {
        jobs.start(ch.name, 'scheduled run', async () => {
          const r = await runAndRecord({ store, client: writeClient, clock }, ch.name);
          this.d.log?.(`${ch.name}: ${r.action === 'appended' ? `appended ${r.slots} slots` : 'nothing to do'}`);
          return { action: r.action };
        });
        started.push(ch.name);
      } catch (e) {
        if (!(e instanceof JobBusyError)) throw e; // busy: try again at the next tick
      }
    }
    return started;
  }

  /** Ticks now, then every `intervalMs`. Returns a function that stops it. */
  start(intervalMs = 60_000): () => void {
    this.tick();
    const timer = setInterval(() => this.tick(), intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }
}
