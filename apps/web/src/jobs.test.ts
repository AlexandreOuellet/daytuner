import { describe, expect, it } from 'vitest';
import { JobBusyError, Jobs } from './jobs.js';

const clock = { t: 1000, now() { return this.t; } };

describe('jobs', () => {
  it('runs a job to the end and keeps what it produced', async () => {
    const jobs = new Jobs(clock);
    const j = jobs.start('A', 'plan', async (say) => { say('halfway'); return { slots: 3 }; });
    expect(j).toMatchObject({ state: 'running', channel: 'A', kind: 'plan', startedAt: 1000 });
    clock.t = 2000;
    const done = await jobs.settled(j.id);
    expect(done).toMatchObject({ state: 'done', message: 'done', result: { slots: 3 }, finishedAt: 2000 });
  });

  it('records a failure with its message', async () => {
    const jobs = new Jobs(clock);
    const j = jobs.start('A', 'commit', async () => { throw new Error('Tunarr said no'); });
    expect(await jobs.settled(j.id)).toMatchObject({ state: 'failed', message: 'Tunarr said no' });
  });

  it('allows one running job per channel, and others in parallel', async () => {
    const jobs = new Jobs(clock);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const first = jobs.start('A', 'plan', () => gate);
    expect(() => jobs.start('A', 'commit', async () => 1)).toThrow(JobBusyError);
    const other = jobs.start('B', 'plan', async () => 1);
    expect((await jobs.settled(other.id))!.state).toBe('done');
    release();
    await jobs.settled(first.id);
    const again = jobs.start('A', 'commit', async () => 1); // free again
    expect((await jobs.settled(again.id))!.state).toBe('done');
  });

  it('lists newest first and forgets the oldest finished ones', async () => {
    const jobs = new Jobs(clock);
    const ids: string[] = [];
    for (let i = 0; i < 55; i++) {
      const j = jobs.start('A', `k${i}`, async () => i);
      await jobs.settled(j.id);
      ids.push(j.id);
    }
    expect(jobs.list()).toHaveLength(50);
    expect(jobs.list()[0]!.id).toBe(ids[54]);
    expect(jobs.get(ids[0]!)).toBeUndefined();
  });
});
