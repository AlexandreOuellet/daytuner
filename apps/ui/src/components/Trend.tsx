import { useState } from 'react';

export interface TrendPoint {
  /** What the point is, for the tooltip and the table ("commit 12, 14 Nov"). */
  label: string;
  value: number;
}

interface Props {
  title: string;
  points: readonly TrendPoint[];
  format: (v: number) => string;
  /** A line to compare against (a target), drawn dashed and named in text. */
  target?: { value: number; label: string };
}

const W = 320;
const H = 110;
const PAD = 8;

/** One measure over the commits: a line with a dot per commit, the last value named, a tooltip, and a table view. */
export function Trend({ title, points, format, target }: Props) {
  const [hover, setHover] = useState<number>();
  const values = points.map((p) => p.value);
  const all = target ? [...values, target.value] : values;
  const lo = Math.min(0, ...all);
  const hi = Math.max(...all, lo + 1e-9);
  const x = (i: number): number => (points.length === 1 ? W / 2 : PAD + (i * (W - 2 * PAD)) / (points.length - 1));
  const y = (v: number): number => H - PAD - ((v - lo) / (hi - lo)) * (H - 2 * PAD);
  const last = points[points.length - 1];

  function near(clientX: number, el: SVGSVGElement): void {
    const box = el.getBoundingClientRect();
    const px = ((clientX - box.left) / box.width) * W;
    let best = 0;
    points.forEach((_, i) => { if (Math.abs(x(i) - px) < Math.abs(x(best) - px)) best = i; });
    setHover(best);
  }

  return (
    <figure className="trend">
      <figcaption>
        <span className="trend-title">{title}</span>
        {last && <span className="trend-last">{format(last.value)}</span>}
      </figcaption>
      {points.length === 0 ? (
        <p className="muted">No commit with metrics yet.</p>
      ) : (
        <div className="trend-plot">
          <svg
            viewBox={`0 0 ${W} ${H}`}
            role="img"
            aria-label={`${title}: ${points.length} commit${points.length === 1 ? '' : 's'}, latest ${last ? format(last.value) : ''}`}
            onMouseMove={(e) => near(e.clientX, e.currentTarget)}
            onMouseLeave={() => setHover(undefined)}
          >
            <line className="grid" x1={PAD} x2={W - PAD} y1={y(lo)} y2={y(lo)} />
            <line className="grid" x1={PAD} x2={W - PAD} y1={y(hi)} y2={y(hi)} />
            {target && <line className="target" x1={PAD} x2={W - PAD} y1={y(target.value)} y2={y(target.value)} />}
            {points.length > 1 && <polyline className="series" fill="none" points={points.map((p, i) => `${x(i)},${y(p.value)}`).join(' ')} />}
            {points.map((p, i) => <circle key={i} className={`dot${hover === i ? ' on' : ''}`} cx={x(i)} cy={y(p.value)} r={4} />)}
            {hover !== undefined && <line className="cross" x1={x(hover)} x2={x(hover)} y1={PAD} y2={H - PAD} />}
          </svg>
          {hover !== undefined && points[hover] && (
            <div className="tip" role="status" style={{ left: `${(x(hover) / W) * 100}%` }}>
              <strong>{format(points[hover]!.value)}</strong>
              <span>{points[hover]!.label}</span>
            </div>
          )}
        </div>
      )}
      {target && <p className="muted small">Target: {target.label}</p>}
      {points.length > 0 && (
        <details>
          <summary>Table</summary>
          <table>
            <thead><tr><th scope="col">Commit</th><th scope="col">{title}</th></tr></thead>
            <tbody>{points.map((p, i) => <tr key={i}><td>{p.label}</td><td>{format(p.value)}</td></tr>)}</tbody>
          </table>
        </details>
      )}
    </figure>
  );
}
