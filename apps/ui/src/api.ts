// The calls the pages make. Types mirror what apps/web answers (see apps/web/README.md).

export interface HealthCheck { name: string; ok: boolean; detail: string }
export interface Health {
  status: 'ok' | 'needs-attention';
  checks: HealthCheck[];
  headline: { aheadMs: number; adLoad?: number; deadAirShare?: number; repeats?: number; alerts?: number };
}
export interface ChannelSummary {
  name: string; tunarrId: string; timezone: string; floorMs: number; stepMs: number; revision: number;
  edge: number; aheadMs: number; pendingCommit: boolean; staged: number; runAtMinutes: number;
}
export interface Card extends ChannelSummary { health: Health }
export interface Distribution { count: number; median: number; p90: number; p99: number; max: number }
export interface MetricsPoint {
  commitId: number; at: number; fromEdge: number; toEdge: number; alerts: number; warnings: number;
  metrics: { slots: number; adLoadRatio: Distribution; deadAirShare: number; endOfSlotMinutes: Distribution; repeatedProgramAirings: number };
}
export interface Commit { id: number; status: string; items: number; totalMs: number; fromEdge: number; toEdge: number; startedAt: number; finishedAt: number | null; note: string | null }
export interface ChannelDetail extends ChannelSummary { commits: Commit[] }
export interface Run { id: number; at: number; outcome: string; message: string }
export interface Targets { deadAirMaxShare: number; adLoadRange: { min: number; max: number } | null; endOfSlotP90MaxMinutes: number; maxAlerts: number; maxRepeats: number }
export interface ServerHealth { ok: boolean; version: string; writes: boolean }

export interface CursorCard {
  key: string; pool: string; length: number; slots: string[]; slotInfo: { id: string; mode: 'continue' | 'rerun' }[];
  /** Episodes the show plays in a week: what "missed a week" rewinds by. */
  perWeek: number; position: number; history: number; next: { programId: string; title: string } | null;
}
export interface CursorAiring { start: number; slotId: string; kind: 'continue' | 'rerun'; before: string[]; after: string[]; staged: boolean; locked: boolean }
export interface CursorPreview {
  key: string; pool: string; length: number; before: { position: number; history: number }; after: { position: number; history: number };
  committedUntil: number; next: { before?: string; after?: string }; airings: CursorAiring[]; titles: Record<string, string>;
}
export interface JobInfo<T = unknown> { id: string; channel: string; kind: string; state: 'running' | 'done' | 'failed'; message: string; result?: T }

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

async function get<T>(path: string): Promise<T> {
  const r = await fetch(path);
  const body = (await r.json().catch(() => ({}))) as { error?: string };
  if (!r.ok) throw new ApiError(r.status, body.error ?? `the server answered ${r.status}`);
  return body as T;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const out = (await r.json().catch(() => ({}))) as { error?: string };
  if (!r.ok) throw new ApiError(r.status, out.error ?? `the server answered ${r.status}`);
  return out as T;
}

/** How often a running job is asked about. Tests set it to 0. */
export const polling = { intervalMs: 400 };

/** Starts a job and waits for it. A failed job throws with its message. */
export async function runJob<T>(path: string, body: unknown): Promise<T> {
  let job = (await post<{ job: JobInfo<T> }>(path, body)).job;
  while (job.state === 'running') {
    await new Promise((r) => setTimeout(r, polling.intervalMs));
    job = await get<JobInfo<T>>(`/api/jobs/${job.id}`);
  }
  if (job.state === 'failed') throw new ApiError(500, job.message);
  return job.result as T;
}

export const api = {
  health: () => get<ServerHealth>('/api/health'),
  dashboard: () => get<Card[]>('/api/dashboard'),
  channel: (name: string) => get<ChannelDetail>(`/api/channels/${encodeURIComponent(name)}`),
  channelHealth: (name: string) => get<Health>(`/api/channels/${encodeURIComponent(name)}/health`),
  metrics: (name: string) => get<MetricsPoint[]>(`/api/channels/${encodeURIComponent(name)}/metrics`),
  targets: (name: string) => get<Targets>(`/api/channels/${encodeURIComponent(name)}/targets`),
  cursors: (name: string) => get<CursorCard[]>(`/api/channels/${encodeURIComponent(name)}/cursors`),
  previewCursor: (name: string, key: string, kind: 'rewind' | 'set', amount: number) =>
    runJob<CursorPreview>(`/api/channels/${encodeURIComponent(name)}/cursors/preview`, { key, kind, amount }),
  adjustCursor: (name: string, key: string, kind: 'rewind' | 'set', amount: number) =>
    runJob<{ before: { position: number }; after: { position: number } }>(`/api/channels/${encodeURIComponent(name)}/cursors/adjust`, { key, kind, amount }),
  runs: (name: string) => get<Run[]>(`/api/channels/${encodeURIComponent(name)}/runs`),
};
