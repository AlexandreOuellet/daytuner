import type { SlotChange, StageOut } from '../api';
import { inZone } from '../format';

const names = (ids: string[], titles: Record<string, string>): string =>
  ids.length === 0 ? 'nothing' : ids.slice(0, 2).map((id) => titles[id] ?? id).join(', ') + (ids.length > 2 ? ` (+${ids.length - 2})` : '');
const mmss = (ms: number): string => `${Math.floor(ms / 60_000)}:${String(Math.round((ms % 60_000) / 1000)).padStart(2, '0')}`;

function Row({ c, titles, zone }: { c: SlotChange; titles: Record<string, string>; zone: string }) {
  const tag = c.kind === 'new' ? 'new' : c.kind === 'removed' ? 'removed' : 'changed';
  const dead = Math.abs(c.deadAirAfter - c.deadAirBefore) >= 15_000;
  return (
    <li>
      <strong>{inZone(c.start, zone)} to {inZone(c.end, zone)}</strong> <span className="chip">{tag}</span>
      {c.endBefore !== undefined && <div className="small muted">ends {inZone(c.endBefore, zone)} → {inZone(c.end, zone)}</div>}
      {c.kind !== 'new' && <div className="small">before: {names(c.before, titles)}</div>}
      {c.kind !== 'removed' && <div className="small">after: <strong>{names(c.after, titles)}</strong>{dead && <span className="muted"> (dead air {mmss(c.deadAirBefore)} → {mmss(c.deadAirAfter)})</span>}</div>}
    </li>
  );
}

/** What the last edit did to the staged slots, before anything is committed. */
export function ChangesPanel({ out, zone, heading }: { out: StageOut; zone: string; heading: string }) {
  const listed = out.changes.filter((c) => c.kind !== 'ads-only');
  const adsOnly = out.changes.length - listed.length;
  const alerts = out.warnings.filter((w) => w.severity === 'alert' || w.code.startsWith('pin-') || w.code === 'locked-slot-conflict');
  return (
    <div className="changes" aria-label="What the last change did">
      <h3>{heading}</h3>
      {listed.length === 0 && adsOnly === 0 && <p className="muted">No slot changed.</p>}
      {listed.length > 0 && <ul>{listed.map((c) => <Row key={`${c.start}:${c.kind}`} c={c} titles={out.titles} zone={zone} />)}</ul>}
      {adsOnly > 0 && <p className="muted small">{adsOnly} other slot{adsOnly === 1 ? '' : 's'} keep their programs; only their ads were reshuffled.</p>}
      {alerts.map((w, i) => <p key={i} className="warn-note small"><strong>{w.severity === 'alert' ? 'Alert' : 'Note'}:</strong> {w.message}</p>)}
    </div>
  );
}
