import { api, type MetricsPoint } from '../api';
import { StatusBadge } from '../components/Status';
import { Trend, type TrendPoint } from '../components/Trend';
import { clock, days, inZone, pct } from '../format';
import { useLoad } from '../useLoad';

const point = (zone: string, p: MetricsPoint, value: number): TrendPoint => ({ label: `commit ${p.commitId}, ${inZone(p.at, zone)}`, value });

export function Channel({ name }: { name: string }) {
  const detail = useLoad(() => api.channel(name), `d:${name}`);
  const health = useLoad(() => api.channelHealth(name), `h:${name}`);
  const metrics = useLoad(() => api.metrics(name), `m:${name}`);
  const targets = useLoad(() => api.targets(name), `t:${name}`);
  const runs = useLoad(() => api.runs(name), `r:${name}`);
  const zone = detail.data?.timezone ?? 'UTC';
  const pts = metrics.data ?? [];
  const err = detail.error ?? health.error ?? metrics.error;

  return (
    <section>
      <p><a href="#/">← Channels</a></p>
      <div className="page-head">
        <h1>{name}</h1>
        {health.data && <StatusBadge status={health.data.status} />}
      </div>
      {err && <p className="error" role="alert">{err}</p>}

      {detail.data && (
        <p className="muted">
          Schedule revision {detail.data.revision}. The lineup ends {inZone(detail.data.edge, zone)} ({zone}); floor {days(detail.data.floorMs)}, step {days(detail.data.stepMs)}, daily run at {clock(detail.data.runAtMinutes)}.
        </p>
      )}

      {health.data && (
        <>
          <h2>Checks</h2>
          <ul className="checks">
            {health.data.checks.map((c) => (
              <li key={c.name} className={c.ok ? 'ok' : 'bad'}>
                <span className="mark" aria-hidden="true">{c.ok ? '✓' : '!'}</span>
                <span><strong>{c.name}.</strong> {c.detail}</span>
              </li>
            ))}
          </ul>
        </>
      )}

      <h2>Over the commits</h2>
      <div className="trends">
        <Trend title="Dead air" points={pts.map((p) => point(zone, p, p.metrics.deadAirShare))} format={(v) => pct(v, 2)} target={targets.data ? { value: targets.data.deadAirMaxShare, label: `at most ${pct(targets.data.deadAirMaxShare, 2)} of air time` } : undefined} />
        <Trend title="Ad load (median)" points={pts.map((p) => point(zone, p, p.metrics.adLoadRatio.median))} format={(v) => pct(v)} />
        <Trend title="End of a slot, 90th percentile (min)" points={pts.map((p) => point(zone, p, p.metrics.endOfSlotMinutes.p90))} format={(v) => `${v.toFixed(1)} min`} target={targets.data ? { value: targets.data.endOfSlotP90MaxMinutes, label: `at most ${targets.data.endOfSlotP90MaxMinutes} min` } : undefined} />
        <Trend title="Alerts" points={pts.map((p) => point(zone, p, p.alerts))} format={(v) => String(v)} target={targets.data ? { value: targets.data.maxAlerts, label: `at most ${targets.data.maxAlerts}` } : undefined} />
      </div>

      <h2>Last commits</h2>
      {detail.data && detail.data.commits.length === 0 && <p className="muted">None yet.</p>}
      <ul className="log">
        {detail.data?.commits.map((c) => (
          <li key={c.id}>
            <strong>commit {c.id}</strong> {c.status}: {c.items} items, {days(c.totalMs)}, {inZone(c.fromEdge, zone)} to {inZone(c.toEdge, zone)}
            {c.note && <div className="muted small">{c.note}</div>}
          </li>
        ))}
      </ul>

      <h2>Last runs</h2>
      {runs.data && runs.data.length === 0 && <p className="muted">No run recorded yet.</p>}
      <ul className="log">
        {runs.data?.map((r) => <li key={r.id}><strong>{r.outcome}</strong> {inZone(r.at, zone)}: {r.message}</li>)}
      </ul>
    </section>
  );
}
