import { useState } from 'react';
import type { Library, PoolModel, PoolStats } from '../api';
import { minutes } from '../format';

interface Props {
  pools: Record<string, PoolModel>;
  stats: Record<string, PoolStats>;
  library: Library | undefined;
  /** The shortest slot (ms) each pool is used in, to say how many of its programs fit. */
  shortestSlot: Record<string, number>;
  used: Set<string>;
  onChange: (name: string, pool: PoolModel | null) => void;
}

const kindOf = (p: PoolModel): string => (p.shows ? 'shows' : 'movies');

function Summary({ name, stats, shortest }: { name: string; stats: PoolStats | undefined; shortest: number | undefined }) {
  if (!stats) return <p className="muted small">Counting…</p>;
  if (stats.error) return <p className="error small">{stats.error}</p>;
  if (stats.count === 0) return <p className="warn-note small">Nothing in the library matches {name}.</p>;
  const fit = shortest === undefined ? undefined : stats.durations.filter((d) => d <= shortest).length;
  return (
    <p className="muted small">
      {stats.count} program{stats.count === 1 ? '' : 's'}, {minutes(stats.durations[0]!)} to {minutes(stats.durations[stats.durations.length - 1]!)} min
      {fit !== undefined && <>; {fit} fit{fit === 1 ? 's' : ''} the shortest slot that uses {name} ({Math.round(shortest! / 60_000)} min)</>}.
    </p>
  );
}

export function PoolsPanel({ pools, stats, library, shortestSlot, used, onChange }: Props) {
  const [newName, setNewName] = useState('');
  const [newKind, setNewKind] = useState<'shows' | 'movies'>('shows');
  const names = Object.keys(pools);
  const add = (): void => {
    const name = newName.trim();
    if (!name || name in pools) return;
    onChange(name, newKind === 'shows' ? { shows: [{ show: library?.shows[0]?.title ?? '' }], order: 'sequential' } : { movies: {}, order: 'shuffle' });
    setNewName('');
  };

  return (
    <div className="pools">
      {names.map((name) => {
        const p = pools[name]!;
        return (
          <article key={name} className="card poolcard">
            <header><h3>{name}</h3><span className="chip">{kindOf(p)}</span></header>
            <Summary name={name} stats={stats[name]} shortest={shortestSlot[name]} />
            {p.shows && (
              <>
                <ul className="chips">
                  {p.shows.map((r, i) => (
                    <li key={`${r.show}:${i}`} className="chip">
                      {r.show}
                      <button type="button" aria-label={`Remove ${r.show} from ${name}`} onClick={() => onChange(name, { ...p, shows: p.shows!.filter((_, j) => j !== i) })} disabled={p.shows!.length === 1}>×</button>
                    </li>
                  ))}
                </ul>
                <label>Add a show{' '}
                  <select aria-label={`Add a show to ${name}`} value="" onChange={(e) => {
                    const show = library?.shows.find((x) => x.id === e.target.value);
                    if (show) onChange(name, { ...p, shows: [...p.shows!, { show: show.title, id: show.id }] });
                  }}>
                    <option value="">choose…</option>
                    {library?.shows.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}
                  </select>
                </label>
              </>
            )}
            {p.movies && (
              <div className="row">
                <label>Genre{' '}
                  <select aria-label={`Genre for ${name}`} value={p.movies.genre ?? ''} onChange={(e) => onChange(name, { ...p, movies: { ...p.movies, ...(e.target.value ? { genre: e.target.value } : {}), ...(e.target.value ? {} : { genre: undefined }) } })}>
                    <option value="">any</option>
                    {library?.genres.map((g) => <option key={g} value={g}>{g}</option>)}
                  </select>
                </label>
                <label>No longer than (min){' '}
                  <input type="number" min={0} aria-label={`Longest movie in ${name}, minutes`} value={p.movies.duration ? Math.round(p.movies.duration.ms / 60_000) : ''} placeholder="any"
                    onChange={(e) => onChange(name, { ...p, movies: { ...(p.movies?.genre ? { genre: p.movies.genre } : {}), ...(e.target.value === '' || Number(e.target.value) <= 0 ? {} : { duration: { op: '<=' as const, ms: Math.round(Number(e.target.value)) * 60_000 } }) } })} />
                </label>
              </div>
            )}
            <fieldset className="row">
              <legend className="small muted">Order</legend>
              {p.shows ? (
                <>
                  <label><input type="radio" name={`order-${name}`} checked={p.order !== 'shuffle'} onChange={() => onChange(name, { ...p, order: 'sequential' })} /> in order, never skipping</label>
                  <label><input type="radio" name={`order-${name}`} checked={p.order === 'shuffle'} onChange={() => onChange(name, { ...p, order: 'shuffle' })} /> shuffled</label>
                </>
              ) : (
                <>
                  <label><input type="radio" name={`order-${name}`} checked={p.order !== 'sequential'} onChange={() => onChange(name, { ...p, order: 'shuffle' })} /> shuffled, each once before any repeats</label>
                  <label><input type="radio" name={`order-${name}`} checked={p.order === 'sequential'} onChange={() => onChange(name, { ...p, order: 'sequential' })} /> in order</label>
                </>
              )}
            </fieldset>
            <button type="button" onClick={() => onChange(name, null)} disabled={used.has(name)} title={used.has(name) ? 'Some slot uses this pool' : undefined}>Remove pool</button>
          </article>
        );
      })}
      <div className="card poolcard">
        <h3>New pool</h3>
        <label>Name <input value={newName} onChange={(e) => setNewName(e.target.value)} aria-label="Name of the new pool" /></label>
        <label>Of{' '}
          <select value={newKind} onChange={(e) => setNewKind(e.target.value as 'shows' | 'movies')} aria-label="Kind of the new pool">
            <option value="shows">shows</option>
            <option value="movies">movies</option>
          </select>
        </label>
        <button type="button" onClick={add} disabled={!newName.trim() || newName.trim() in pools}>Add the pool</button>
      </div>
    </div>
  );
}
