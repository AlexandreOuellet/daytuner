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

export const api = {
  health: () => get<ServerHealth>('/api/health'),
  dashboard: () => get<Card[]>('/api/dashboard'),
  channel: (name: string) => get<ChannelDetail>(`/api/channels/${encodeURIComponent(name)}`),
  channelHealth: (name: string) => get<Health>(`/api/channels/${encodeURIComponent(name)}/health`),
  metrics: (name: string) => get<MetricsPoint[]>(`/api/channels/${encodeURIComponent(name)}/metrics`),
  targets: (name: string) => get<Targets>(`/api/channels/${encodeURIComponent(name)}/targets`),
  runs: (name: string) => get<Run[]>(`/api/channels/${encodeURIComponent(name)}/runs`),
};
