// Jobs: work that takes longer than a request (planning a range, committing). One job per channel at a time,
// which also protects the "one pending commit per channel" rule. Jobs live in memory: a restart forgets them,
// and the commit log in the store is the record that matters.

import type { Clock } from '@daytuner/engine';

export type JobState = 'running' | 'done' | 'failed';

export interface Job {
  id: string;
  channel: string;
  kind: string;
  state: JobState;
  /** What it is doing, or why it failed. */
  message: string;
  startedAt: number;
  finishedAt: number | null;
  /** What it produced, for a job that finished. */
  result?: unknown;
}

export class JobBusyError extends Error {
  constructor(readonly channel: string, readonly running: Job) {
    super(`"${channel}" is busy: ${running.kind} is still running`);
    this.name = 'JobBusyError';
  }
}

const KEEP = 50;

export class Jobs {
  private readonly all = new Map<string, Job>();
  private readonly pending = new Map<string, Promise<void>>();
  private counter = 0;

  constructor(private readonly clock: Clock) {}

  /** Starts a job and returns at once. Throws JobBusyError when the channel already has one running. */
  start(channel: string, kind: string, run: (say: (message: string) => void) => Promise<unknown>): Job {
    const running = [...this.all.values()].find((j) => j.channel === channel && j.state === 'running');
    if (running) throw new JobBusyError(channel, running);
    const job: Job = { id: `job-${++this.counter}`, channel, kind, state: 'running', message: 'started', startedAt: this.clock.now(), finishedAt: null };
    this.all.set(job.id, job);
    this.pending.set(
      job.id,
      (async () => {
        try {
          job.result = await run((m) => { job.message = m; });
          job.state = 'done';
          job.message = 'done';
        } catch (e) {
          job.state = 'failed';
          job.message = e instanceof Error ? e.message : String(e);
        } finally {
          job.finishedAt = this.clock.now();
          this.trim();
        }
      })(),
    );
    return { ...job };
  }

  get(id: string): Job | undefined {
    const j = this.all.get(id);
    return j ? { ...j } : undefined;
  }

  /** Newest first. */
  list(): Job[] {
    return [...this.all.values()].reverse().map((j) => ({ ...j }));
  }

  /** Resolves when the job has finished (for tests and for a caller that wants to wait). */
  async settled(id: string): Promise<Job | undefined> {
    await this.pending.get(id);
    return this.get(id);
  }

  private trim(): void {
    const finished = [...this.all.values()].filter((j) => j.state !== 'running');
    for (const j of finished.slice(0, Math.max(0, finished.length - KEEP))) {
      this.all.delete(j.id);
      this.pending.delete(j.id);
    }
  }
}
