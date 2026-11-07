import { useEffect, useRef, useState } from 'react';
import { api, type ExceptionModel, type Library, type Occurrence, type SaveResult, type ScheduleModel } from '../api';
import { MONTHS, dateText, fallsOn, monthWeeks, monthsFrom, playName, weekdayOf } from '../calendar';
import { clock, inZone } from '../format';
import { channelLink } from '../router';
import { useLoad } from '../useLoad';
import { DAY_NAMES } from '../week';

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const STATE: Record<Occurrence['state'], string> = { rule: 'planned from the schedule when its time comes', staged: 'staged', committed: 'already in Tunarr' };
const MARK: Record<Occurrence['state'], string> = { rule: '★', staged: '◆', committed: '✓' };
const hm = (ms: number): string => clock(Math.floor(ms / 60_000));

export function SpecialDays({ name }: { name: string }) {
  const loaded = useLoad(() => api.scheduleModel(name), `special:${name}`);
  const library = useLoad(api.library, 'library');
  const [draft, setDraft] = useState<ExceptionModel[]>();
  const base = useRef<ExceptionModel[] | undefined>(undefined);
  const [occ, setOcc] = useState<Occurrence[]>([]);
  const [picked, setPicked] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<SaveResult>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (loaded.data) { setDraft(loaded.data.model.exceptions); base.current = loaded.data.model.exceptions; }
  }, [loaded.data]);

  const model = loaded.data?.model;
  useEffect(() => {
    if (!draft || !model) return;
    let live = true;
    api.specialDays(name, draft, model.week).then((o) => { if (live) setOcc(o); }, (e: unknown) => { if (live) setError(e instanceof Error ? e.message : String(e)); });
    return () => { live = false; };
  }, [draft, model, name]);

  if (loaded.error) return <section><p><a href={channelLink(name)}>← {name}</a></p><p className="error" role="alert">{loaded.error}</p></section>;
  if (!draft || !model) return <section><p className="muted">Loading…</p></section>;

  const today = inZone(Date.now(), model.timezone).slice(0, 10);
  const dirty = !same(draft, base.current);
  const edit = (f: (d: ExceptionModel[]) => ExceptionModel[]): void => { setDraft((d) => (d ? f(d) : d)); setResult(undefined); };
  const marks = (date: string): Occurrence[] => occ.filter((o) => o.date === date);
  const onDay = (date: string): { e: ExceptionModel; i: number; o?: Occurrence }[] =>
    draft.flatMap((e, i) => (fallsOn(e, date) ? [{ e, i, o: occ.find((x) => x.index === i && x.date === date) }] : []));

  async function save(force: boolean): Promise<void> {
    setSaving(true); setError(undefined);
    try {
      const r = await api.saveModel(name, { week: model!.week, pools: model!.pools, exceptions: draft }, force);
      setResult(r);
      if (r.saved) loaded.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section>
      <p><a href={channelLink(name)}>← {name}</a></p>
      <div className="page-head"><h1>Special days</h1></div>
      <p className="muted">A special day replaces one slot with one chosen program. Pick a day to add one. For a bigger event (several programs, a different length), plan the day in staging instead: <code>daytuner stage {name} generate</code>, then edit it there; staging never changes the schedule.</p>
      {error && <p className="error" role="alert">{error}</p>}
      <ul className="legend" aria-label="Legend">
        {(['rule', 'staged', 'committed'] as const).map((s) => <li key={s}><span aria-hidden="true">{MARK[s]}</span> {STATE[s]}</li>)}
      </ul>

      <div className="calendar">
        {monthsFrom(today).map(({ year, month }) => (
          <div key={`${year}-${month}`} className="month">
            <h2>{MONTHS[month - 1]} {year}</h2>
            <div className="dow" aria-hidden="true">{DAY_NAMES.map((d) => <span key={d}>{d[0]}</span>)}</div>
            {monthWeeks(year, month).map((week, w) => (
              <div className="weekrow" key={w}>
                {week.map((day, i) => {
                  if (day === null) return <span key={i} className="blank" />;
                  const date = dateText(year, month, day);
                  const here = marks(date);
                  const names = onDay(date).map((x) => playName(x.e));
                  const label = `${date}${names.length ? `: ${names.join('; ')}${here[0] ? `, ${STATE[here[0].state]}` : ''}` : ''}`;
                  return (
                    <button key={i} type="button" className={`daycell ${here.length ? `mark ${here[0]!.state}` : ''} ${date === today ? 'today' : ''} ${picked === date ? 'picked' : ''}`} aria-label={label} aria-pressed={picked === date} onClick={() => setPicked(date)}>
                      {day}{here.length > 0 && <span className="star" aria-hidden="true">{MARK[here[0]!.state]}</span>}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        ))}
      </div>

      {picked ? (
        <DayPanel
          date={picked} model={model} library={library.data} existing={onDay(picked)}
          onAdd={(e) => edit((d) => [...d, e])}
          onRemove={(i) => edit((d) => d.filter((_, j) => j !== i))}
          onChange={(i, e) => edit((d) => d.map((x, j) => (j === i ? e : x)))}
        />
      ) : <p className="muted">Pick a day on the calendar.</p>}

      <div className="savebar">
        <button type="button" className="primary" disabled={!dirty || saving} onClick={() => save(false)}>{saving ? 'Saving…' : 'Save as a new revision'}</button>
        <button type="button" disabled={!dirty || saving} onClick={() => { setDraft(base.current); setResult(undefined); }}>Discard changes</button>
        {!dirty && <span className="muted small">No changes.</span>}
      </div>
      {result?.saved && <p className="ok-note" role="status">Saved as revision {result.revision}.</p>}
      {result && !result.saved && (
        <div className="error" role="alert">
          <p><strong>Not saved.</strong> {result.impact?.conflicts.length} locked staged slot{result.impact?.conflicts.length === 1 ? '' : 's'} would no longer fit:</p>
          <ul>{result.impact?.conflicts.map((c) => <li key={c.start}>{c.message}</li>)}</ul>
          <button type="button" onClick={() => save(true)} disabled={saving}>Save anyway</button>
        </div>
      )}
    </section>
  );
}

function DayPanel({ date, model, library, existing, onAdd, onRemove, onChange }: {
  date: string; model: ScheduleModel; library: Library | undefined; existing: { e: ExceptionModel; i: number; o?: Occurrence }[];
  onAdd: (e: ExceptionModel) => void; onRemove: (i: number) => void; onChange: (i: number, e: ExceptionModel) => void;
}) {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const weekday = weekdayOf(y, m, d);
  const slots = model.week.filter((s) => s.day === weekday).sort((a, b) => a.at - b.at);
  const [at, setAt] = useState<number>(slots[0]?.at ?? 0);
  const [kind, setKind] = useState<'movie' | 'episode'>('movie');
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<{ id: string; title: string; duration: number }[]>([]);
  const [showId, setShowId] = useState('');
  const [eps, setEps] = useState<{ id: string; title: string; season: number; episode: number }[]>([]);
  const [pick, setPick] = useState('');
  const [once, setOnce] = useState(false);
  const [counts, setCounts] = useState(true);

  useEffect(() => { setAt(slots[0]?.at ?? 0); setPick(''); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [date]);
  useEffect(() => {
    let live = true;
    if (kind === 'movie' && query.trim().length >= 2) api.movies(query.trim()).then((r) => { if (live) setFound(r); }, () => undefined);
    else setFound([]);
    return () => { live = false; };
  }, [kind, query]);
  useEffect(() => {
    let live = true;
    if (kind === 'episode' && showId) api.episodes(showId).then((r) => { if (live) setEps(r); }, () => undefined); else setEps([]);
    return () => { live = false; };
  }, [kind, showId]);

  const chosen = kind === 'movie' ? found.find((x) => x.id === pick) : eps.find((x) => x.id === pick);
  const show = library?.shows.find((s) => s.id === showId);
  const add = (): void => {
    if (!chosen) return;
    onAdd({
      on: { month: m, day: d, ...(once ? { year: y } : {}) }, at,
      play: kind === 'movie' ? { movie: chosen.title, id: chosen.id } : { show: show!.title, id: showId, title: chosen.title },
      ...(counts ? {} : { counts: false as const }),
    });
    setPick('');
  };

  return (
    <div className="editor" aria-label={`Special days on ${date}`}>
      <h2>{DAY_NAMES[weekday]} {date}</h2>
      {existing.length === 0 && <p className="muted">Nothing special is planned on this day.</p>}
      {existing.map(({ e, i, o }) => (
        <div key={i} className="special">
          <p><strong>{playName(e)}</strong> at {hm(e.at)}, {e.on.year === undefined ? 'every year' : `${e.on.year} only`}{o ? `; ${STATE[o.state]}` : ''}</p>
          {o && !o.matchesSlot && <p className="warn-note small">No slot starts at {hm(e.at)} on a {DAY_NAMES[weekday]}, so this replaces nothing.</p>}
          {!o && e.on.year !== undefined && <p className="muted small">Outside the coming year, so it is not on the calendar.</p>}
          <div className="row">
            <label><input type="checkbox" checked={e.counts !== false} onChange={(ev) => onChange(i, { ...e, ...(ev.target.checked ? { counts: undefined } : { counts: false as const }) } as ExceptionModel)} /> counts as played (not repeated soon)</label>
            <button type="button" onClick={() => onRemove(i)}>Remove</button>
          </div>
        </div>
      ))}

      <h3>Add one</h3>
      {slots.length === 0 ? <p className="muted">The week has no slot on a {DAY_NAMES[weekday]}, so there is nothing to replace.</p> : (
        <>
          <div className="row">
            <label>Replace the slot at{' '}
              <select aria-label="Slot to replace" value={at} onChange={(e) => setAt(Number(e.target.value))}>
                {slots.map((s) => <option key={s.at} value={s.at}>{hm(s.at)} ({s.pool})</option>)}
              </select>
            </label>
            <label>with a{' '}
              <select aria-label="Kind of program" value={kind} onChange={(e) => { setKind(e.target.value as 'movie' | 'episode'); setPick(''); }}>
                <option value="movie">movie</option>
                <option value="episode">episode</option>
              </select>
            </label>
          </div>
          {kind === 'movie' ? (
            <div className="row">
              <label>Search <input aria-label="Search movies" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="at least two letters" /></label>
              <select aria-label="Movie" value={pick} onChange={(e) => setPick(e.target.value)}>
                <option value="">{found.length ? 'choose…' : 'no movie yet'}</option>
                {found.map((f) => <option key={f.id} value={f.id}>{f.title} ({Math.round(f.duration / 60_000)} min)</option>)}
              </select>
            </div>
          ) : (
            <div className="row">
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
            </div>
          )}
          <div className="row">
            <label><input type="checkbox" checked={once} onChange={(e) => setOnce(e.target.checked)} /> this year only ({y})</label>
            <label><input type="checkbox" checked={counts} onChange={(e) => setCounts(e.target.checked)} /> counts as played</label>
            <button type="button" onClick={add} disabled={!chosen}>Add the special day</button>
          </div>
          <p className="muted small">Without “this year only” it comes back every {MONTHS[m - 1]} {d}.</p>
        </>
      )}
    </div>
  );
}
