import { useEffect, useState } from 'react';
import { api, type Library } from '../api';

export interface Program { id: string; title: string; duration: number }

/** Finds one movie (by title) or one episode (a show, then an episode). */
export function ProgramPicker({ library, onPick, label = 'Use this' }: { library: Library | undefined; onPick: (p: Program) => void; label?: string }) {
  const [kind, setKind] = useState<'movie' | 'episode'>('movie');
  const [query, setQuery] = useState('');
  const [movies, setMovies] = useState<Program[]>([]);
  const [showId, setShowId] = useState('');
  const [eps, setEps] = useState<{ id: string; title: string; season: number; episode: number; duration: number }[]>([]);
  const [pick, setPick] = useState('');

  useEffect(() => {
    let live = true;
    if (kind === 'movie' && query.trim().length >= 2) api.movies(query.trim()).then((r) => { if (live) setMovies(r); }, () => undefined);
    else setMovies([]);
    return () => { live = false; };
  }, [kind, query]);
  useEffect(() => {
    let live = true;
    if (kind === 'episode' && showId) api.episodes(showId).then((r) => { if (live) setEps(r); }, () => undefined); else setEps([]);
    return () => { live = false; };
  }, [kind, showId]);

  const show = library?.shows.find((s) => s.id === showId);
  const chosen: Program | undefined = kind === 'movie'
    ? movies.find((m) => m.id === pick)
    : (() => { const e = eps.find((x) => x.id === pick); return e && show ? { id: e.id, title: `${show.title} "${e.title}"`, duration: e.duration } : undefined; })();

  return (
    <div className="picker">
      <div className="row">
        <label>A{' '}
          <select aria-label="Kind of program" value={kind} onChange={(e) => { setKind(e.target.value as 'movie' | 'episode'); setPick(''); }}>
            <option value="movie">movie</option>
            <option value="episode">episode</option>
          </select>
        </label>
        {kind === 'movie' ? (
          <>
            <label>Search <input aria-label="Search movies" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="at least two letters" /></label>
            <select aria-label="Movie" value={pick} onChange={(e) => setPick(e.target.value)}>
              <option value="">{movies.length ? 'choose…' : 'no movie yet'}</option>
              {movies.map((f) => <option key={f.id} value={f.id}>{f.title} ({Math.round(f.duration / 60_000)} min)</option>)}
            </select>
          </>
        ) : (
          <>
            <label>Show{' '}
              <select aria-label="Show" value={showId} onChange={(e) => { setShowId(e.target.value); setPick(''); }}>
                <option value="">choose…</option>
                {library?.shows.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}
              </select>
            </label>
            <select aria-label="Episode" value={pick} onChange={(e) => setPick(e.target.value)}>
              <option value="">{eps.length ? 'choose…' : 'choose a show'}</option>
              {eps.map((x) => <option key={x.id} value={x.id}>S{x.season}E{x.episode} {x.title}</option>)}
            </select>
          </>
        )}
        <button type="button" disabled={!chosen} onClick={() => chosen && onPick(chosen)}>{label}</button>
      </div>
    </div>
  );
}
