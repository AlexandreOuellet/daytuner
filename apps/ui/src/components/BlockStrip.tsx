import type { AdSample, SampleSegment } from '../api';
import { mmss } from '../format';

const LABEL: Record<SampleSegment['type'], string> = { content: 'program', ad: 'ads', bumper: 'bumper', interstitial: 'filler', 'dead-air': 'dead air' };

/** A block drawn to scale, one box per piece, with the kind in words (never colour alone) and a table below. */
export function BlockStrip({ sample }: { sample: AdSample }) {
  return (
    <figure className="sample">
      <figcaption>
        <strong>{sample.kind === 'episode' ? 'An episode' : 'A movie'}:</strong> {sample.title} <span className="muted">({mmss(sample.programMs)})</span>
      </figcaption>
      <div className="strip" role="img" aria-label={`${sample.kind} block of ${mmss(sample.windowMs)}: ${sample.segments.map((s) => `${LABEL[s.type]} ${s.position} ${mmss(s.ms)}`).join(', ')}`}>
        {sample.segments.map((s, i) => (
          <span key={i} className={`seg ${s.type}`} style={{ flexGrow: s.ms }} title={`${LABEL[s.type]}${s.position ? ` (${s.position})` : ''}${s.list ? `, ${s.list}` : ''}: ${mmss(s.ms)}`}>
            {s.ms / sample.windowMs > 0.04 ? LABEL[s.type] : ''}
          </span>
        ))}
      </div>
      <ul className="legend" aria-label="Legend">
        {(['content', 'ad', 'bumper', 'interstitial', 'dead-air'] as const).filter((t) => sample.segments.some((s) => s.type === t)).map((t) => <li key={t}><span className={`swatch ${t}`} aria-hidden="true" />{LABEL[t]}</li>)}
      </ul>
      <p className="muted small">
        Ads are {(sample.adShare * 100).toFixed(1)}% of the program, in {sample.midBreaks} mid break{sample.midBreaks === 1 ? '' : 's'} and the edges; dead air {mmss(sample.deadAirMs)}; the slot is {mmss(sample.windowMs)}.
      </p>
      {sample.warnings.map((w, i) => <p key={i} className="warn-note small">{w}</p>)}
      <details>
        <summary>Table</summary>
        <table>
          <thead><tr><th scope="col">Piece</th><th scope="col">Where</th><th scope="col">List</th><th scope="col">Length</th></tr></thead>
          <tbody>{sample.segments.map((s, i) => <tr key={i}><td>{LABEL[s.type]}</td><td>{s.position || '–'}</td><td>{s.list ?? '–'}</td><td>{mmss(s.ms)}</td></tr>)}</tbody>
        </table>
      </details>
    </figure>
  );
}
