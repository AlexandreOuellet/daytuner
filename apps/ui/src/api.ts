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

export type Edge = 'head' | 'pre' | 'post' | 'tail';
export interface AdSettings {
  step: number;
  ratio: { min: number; max: number };
  positions: Partial<Record<Edge, { list?: string; min: number; max: number }>>;
  mid?: { list: string; every: number; min: number; max: number; tailBuffer: number; minGap?: number; chapterTypes?: string[] };
  bumpers: Partial<Record<Edge, string>>;
  interstitial?: string;
}
export interface FillerList { id: string; name: string; count: number }
export interface SampleSegment { type: 'content' | 'ad' | 'bumper' | 'interstitial' | 'dead-air'; position: string; ms: number; list?: string }
export interface AdSample {
  kind: 'episode' | 'movie'; title: string; programMs: number; windowMs: number; segments: SampleSegment[];
  adMs: number; adShare: number; midBreaks: number; deadAirMs: number; warnings: string[];
}
export interface SaveResult {
  saved: boolean; revision: number;
  impact?: { conflicts: { start: number; reason: string; message: string }[]; changes: unknown[]; staged: number };
}

export interface SlotModel { day: number; at: number; pool: string; link?: string; linkMode?: 'continue' | 'rerun' }
export interface PoolModel {
  shows?: { show: string; id?: string }[];
  movies?: { genre?: string; duration?: { op: '<=' | '<' | '>=' | '>' | '='; ms: number } };
  order?: 'sequential' | 'shuffle';
}
export interface ExceptionModel {
  on: { month: number; day: number; year?: number };
  at: number;
  play: { show: string; id?: string; title: string } | { movie: string; id?: string };
  counts?: string | false;
}
export interface Occurrence { index: number; date: string; start: number; matchesSlot: boolean; state: 'committed' | 'staged' | 'rule' }
export interface ScheduleModel { timezone: string; grid: number; week: SlotModel[]; pools: Record<string, PoolModel>; exceptions: ExceptionModel[] }
export interface PoolStats { count: number; durations: number[]; error?: string }
export interface Library { shows: { id: string; title: string }[]; genres: string[] }

export interface StagedSlot {
  start: number; end: number; slotId: string | null; pool: string | null;
  pins: Record<string, { id: string; title: string; duration: number }>;
  locked: boolean; edited: boolean; programs: string[];
  blocks: { programId: string; start: number; end: number; pinned?: boolean }[];
}
export interface SlotChange {
  start: number; end: number; slotId: string; kind: 'new' | 'removed' | 'changed' | 'ads-only';
  before: string[]; after: string[]; endBefore?: number; deadAirBefore: number; deadAirAfter: number;
}
export interface StageWarning { code: string; severity: 'info' | 'warning' | 'alert'; at: number; slotId: string; message: string }
export interface StageOut { staged: number; planned: number; warnings: StageWarning[]; changes: SlotChange[]; titles: Record<string, string> }
export interface StageCheck { conflicts: { start: number; slotId: string; reason: string; message: string }[]; pinProblems: StageWarning[]; titles: Record<string, string> }

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
  ads: (name: string) => get<{ revision: number; settings: AdSettings; lists: FillerList[] }>(`/api/channels/${encodeURIComponent(name)}/ads`),
  sampleAds: (name: string, settings: AdSettings) => runJob<{ samples: AdSample[] }>(`/api/channels/${encodeURIComponent(name)}/ads/sample`, { settings }),
  saveAds: (name: string, settings: AdSettings, force = false) => runJob<SaveResult>(`/api/channels/${encodeURIComponent(name)}/ads`, { settings, force }),
  scheduleModel: (name: string) => get<{ revision: number; model: ScheduleModel }>(`/api/channels/${encodeURIComponent(name)}/schedule/model`),
  library: () => get<Library>('/api/library'),
  poolStats: (name: string, pools: Record<string, PoolModel>) => runJob<Record<string, PoolStats>>(`/api/channels/${encodeURIComponent(name)}/pools/stats`, { pools }),
  saveModel: (name: string, model: Pick<ScheduleModel, 'week' | 'pools'> & { exceptions?: ExceptionModel[] }, force = false) =>
    runJob<SaveResult>(`/api/channels/${encodeURIComponent(name)}/schedule/model`, { week: model.week, pools: model.pools, ...(model.exceptions ? { exceptions: model.exceptions } : {}), force }),
  specialDays: (name: string, exceptions: ExceptionModel[], week: SlotModel[]) => post<Occurrence[]>(`/api/channels/${encodeURIComponent(name)}/special-days`, { exceptions, week }),
  movies: (q: string) => get<{ id: string; title: string; duration: number }[]>(`/api/library/movies?q=${encodeURIComponent(q)}`),
  episodes: (showId: string) => get<{ id: string; title: string; season: number; episode: number; duration: number }[]>(`/api/library/shows/${encodeURIComponent(showId)}/episodes`),
  staged: (name: string) => get<StagedSlot[]>(`/api/channels/${encodeURIComponent(name)}/staged`),
  stageCheck: (name: string) => runJob<StageCheck>(`/api/channels/${encodeURIComponent(name)}/stage/check`, {}),
  stageGenerate: (name: string, to: number | string, keepFrom?: number | string, keepTo?: number | string) =>
    runJob<StageOut>(`/api/channels/${encodeURIComponent(name)}/stage/generate`, { to, ...(keepFrom !== undefined ? { keepFrom } : {}), ...(keepTo !== undefined ? { keepTo } : {}) }),
  lockSlot: (name: string, start: number, locked: boolean) => post<{ ok: boolean }>(`/api/channels/${encodeURIComponent(name)}/stage/lock`, { start, locked }),
  /** Times are epoch milliseconds or a local date-time of the channel ("2026-10-31T20:00"). */
  stageEdit: (name: string, body: { kind: 'delete' | 'resize' | 'add'; start: number | string; end?: number | string; program?: string | { id: string; title: string; duration: number } }) =>
    runJob<StageOut>(`/api/channels/${encodeURIComponent(name)}/stage/edit`, body),
  pin: (name: string, start: number, block: number, program: string | { id: string; title: string; duration: number }) =>
    runJob<StageOut>(`/api/channels/${encodeURIComponent(name)}/stage/pin`, { start, block, program }),
  unpin: (name: string, start: number, block: number) => runJob<StageOut>(`/api/channels/${encodeURIComponent(name)}/stage/unpin`, { start, block }),
  resetStage: (name: string, from: number, to: number) => runJob<StageOut>(`/api/channels/${encodeURIComponent(name)}/stage/reset`, { from, to }),
  runs: (name: string) => get<Run[]>(`/api/channels/${encodeURIComponent(name)}/runs`),
};
