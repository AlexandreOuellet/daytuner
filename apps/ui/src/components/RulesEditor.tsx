import { useEffect, useState } from 'react';
import type { Library, PoolModel, RuleValueField } from '../api';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A value as the text a person types: a list is written with commas. */
const textOf = (v: unknown): string => (Array.isArray(v) ? v.join(', ') : v === undefined || v === null ? '' : String(v));
/** The text back to what the file holds: nothing, one value, or a list. */
const valueOf = (t: string): string | string[] | undefined => {
  const parts = t.split(',').map((x) => x.trim()).filter((x) => x !== '');
  return parts.length === 0 ? undefined : parts.length === 1 ? parts[0]! : parts;
};

/**
 * The text of a box while it is typed. The file holds only the values, so "Comedy," and "Comedy" are the same value and a box that
 * showed what the file holds would swallow the comma. The typed text is kept, and replaced only when the file's value
 * changes from elsewhere (a suggestion, a reset).
 */
function useDraft(value: string): [string, (t: string) => void] {
  const [draft, setDraft] = useState(value);
  useEffect(() => { setDraft((d) => (JSON.stringify(valueOf(d)) === JSON.stringify(valueOf(value)) ? d : value)); }, [value]);
  return [draft, setDraft];
}

/** The shows an entry leaves out, typed as names with commas (the typed text is kept, see `useDraft`). */
function LeftOut({ label, held, onText }: { label: string; held: string; onText: (text: string) => void }) {
  const [text, setText] = useDraft(held);
  return <input aria-label={label} value={text} onChange={(ev) => { setText(ev.target.value); onText(ev.target.value); }} />;
}

const FIELDS: { key: string; label: string; hint: string; movieOnly?: boolean }[] = [
  { key: 'genre', label: 'Genre', hint: 'Comedy, Horror' },
  { key: 'year', label: 'Year', hint: '1999 or 1980-1989' },
  { key: 'rating', label: 'Rating', hint: 'PG, R' },
  { key: 'studio', label: 'Studio', hint: 'Paramount' },
  { key: 'tag', label: 'Tag', hint: 'sitcom' },
  { key: 'actor', label: 'Actor', hint: 'Peter Falk' },
  { key: 'director', label: 'Director', hint: '', movieOnly: true },
  { key: 'title', label: 'Title has', hint: 'part of a title' },
  { key: 'audio', label: 'Audio language', hint: 'French or fra' },
  { key: 'subtitles', label: 'Subtitle language', hint: 'French or fra' },
  { key: 'duration', label: 'Length', hint: '<=117m', movieOnly: true },
];

type Values = Library['values'];
const VALUE_FIELDS = new Set<string>(['genre', 'rating', 'studio', 'tag', 'actor', 'director', 'audio', 'subtitles']);
const LIST_SHOWN = 10;

/** One box of a rule. For a field the library has values for, it lists matching values while it has focus and marks a typo. */
function RuleBox({ field, label, value: held, values, onChange: report }: { field: { key: string; label: string; hint: string }; label: string; value: string; values: Values; onChange: (text: string) => void }) {
  const [focus, setFocus] = useState(false);
  const [value, setValue] = useDraft(held);
  const onChange = (text: string): void => { setValue(text); report(text); };
  const known = VALUE_FIELDS.has(field.key) ? values?.[field.key as RuleValueField] : undefined;
  const parts = value.split(',');
  const last = (parts[parts.length - 1] ?? '').trim().toLowerCase();
  const matches = (v: { value: string; label?: string }, t: string): boolean => (v.value + ' ' + (v.label ?? '')).toLowerCase().includes(t);
  const taken = new Set(parts.slice(0, -1).map((x) => x.trim().toLowerCase()));
  const offered = known && focus ? known.filter((v) => !taken.has(v.value.toLowerCase()) && matches(v, last)).slice(0, LIST_SHOWN) : [];
  const unknown = known && known.length > 0
    ? parts.map((x) => x.trim()).filter((x) => x !== '' && !known.some((v) => v.value.toLowerCase() === x.toLowerCase() || (v.label ?? '').toLowerCase().startsWith(x.toLowerCase() + ' (')))
    : [];
  return (
    <label>{field.label}{' '}
      <input aria-label={label} placeholder={field.hint} value={value} autoComplete="off"
        onFocus={() => setFocus(true)} onBlur={() => setFocus(false)} onChange={(e) => onChange(e.target.value)} />
      {offered.length > 0 && (
        <span className="suggest" role="listbox" aria-label={`${label}: suggestions`}>
          {offered.map((v) => (
            <button key={v.value} type="button" role="option" aria-selected={false}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onChange([...parts.slice(0, -1).map((x) => x.trim()), v.value].join(', '))}>{v.label ?? v.value}</button>
          ))}
        </span>
      )}
      {unknown.length > 0 && <span className="warn-note small">Not in the library: {unknown.join(', ')}</span>}
    </label>
  );
}

/** The conditions of one rule, one input each. Everything filled in must hold; commas mean any of. */
function RuleFields({ rule, movies, label, values, onChange }: { rule: Obj; movies: boolean; label: string; values: Values; onChange: (r: Obj) => void }) {
  return (
    <div className="rulefields">
      {FIELDS.filter((f) => movies || !f.movieOnly).map((f) => (
        <RuleBox key={f.key} field={f} label={`${label}: ${f.label}`} value={textOf(rule[f.key])} values={values}
          onChange={(text) => {
            const v = valueOf(text);
            const next: Obj = { ...rule };
            if (v === undefined) delete next[f.key]; else next[f.key] = f.key === 'duration' ? String(v) : v;
            onChange(next);
          }} />
      ))}
    </div>
  );
}

const ruleList = (v: unknown): Obj[] => (Array.isArray(v) ? v.filter(isObj) : isObj(v) ? [v] : []);

function RuleList({ title, rules, movies, label, values, onChange, empty }: { title: string; rules: Obj[]; movies: boolean; label: string; values: Values; onChange: (r: Obj[]) => void; empty?: string }) {
  return (
    <div className="rulelist">
      <h4>{title}</h4>
      {rules.length === 0 && empty && <p className="muted small">{empty}</p>}
      {rules.map((r, i) => (
        <div key={i} className="rule">
          <RuleFields rule={r} movies={movies} label={`${label} ${i + 1}`} values={values} onChange={(n) => onChange(rules.map((x, j) => (j === i ? n : x)))} />
          <button type="button" aria-label={`Remove ${label} ${i + 1}`} onClick={() => onChange(rules.filter((_, j) => j !== i))}>Remove</button>
        </div>
      ))}
      <button type="button" onClick={() => onChange([...rules, {}])}>Add a rule</button>
    </div>
  );
}

/** The `raw` of a pool of movies, set so that empty parts are left out of the file. */
function moviesWith(movies: Obj, key: 'match' | 'except', list: Obj[]): Obj {
  const next = { ...movies };
  if (list.length === 0) delete next[key]; else next[key] = key === 'match' && list.length === 1 ? list[0] : list;
  return next;
}

export function MovieRules({ name, raw, library, onChange }: { name: string; raw: Obj; library?: Library | undefined; onChange: (raw: Obj) => void }) {
  const movies = isObj(raw['movies']) ? raw['movies'] : {};
  const { match, except, ...beside } = movies;
  const set = (m: Obj): void => onChange({ ...raw, movies: m });
  return (
    <div className="rules" aria-label={`Rules of ${name}`}>
      <div className="rulelist">
        <h4>Always</h4>
        <p className="muted small">Holds for every movie of the pool. Several values separated by commas mean any of them.</p>
        <RuleFields rule={beside} movies label={`${name} always`} values={library?.values} onChange={(b) => set({ ...b, ...(match !== undefined ? { match } : {}), ...(except !== undefined ? { except } : {}) })} />
      </div>
      <RuleList title="Any of these" rules={ruleList(match)} movies label={`${name} rule`} values={library?.values} empty="No rules: every movie that meets the conditions above is in."
        onChange={(l) => set(moviesWith(movies, 'match', l))} />
      <RuleList title="Except" rules={ruleList(except)} movies label={`${name} except`} values={library?.values} onChange={(l) => set(moviesWith(movies, 'except', l))} />
    </div>
  );
}

type Entry = string | Obj;
const entryName = (e: Entry): string | undefined => (typeof e === 'string' ? e : typeof e['show'] === 'string' ? e['show'] : undefined);

export function ShowRules({ name, raw, library, onChange }: { name: string; raw: Obj; library: Library | undefined; onChange: (raw: Obj) => void }) {
  const entries: Entry[] = Array.isArray(raw['shows']) ? (raw['shows'] as Entry[]) : [];
  const episodes = isObj(raw['episodes']) ? raw['episodes'] : {};
  const setEntries = (shows: Entry[]): void => onChange({ ...raw, shows });
  const setEpisodes = (key: string, value: string): void => {
    const next: Obj = { ...episodes };
    if (value === '') delete next[key]; else next[key] = value;
    const out = { ...raw };
    if (Object.keys(next).length === 0) delete out['episodes']; else out['episodes'] = next;
    onChange(out);
  };
  const setEntry = (i: number, e: Entry): void => setEntries(entries.map((x, j) => (j === i ? e : x)));
  return (
    <div className="rules" aria-label={`Rules of ${name}`}>
      <p className="muted small">Shows take turns in this order. A show found by a rule that is also named plays once, where it is named.</p>
      {entries.map((e, i) => {
        const named = entryName(e);
        if (named !== undefined) {
          return (
            <div key={i} className="rule">
              <strong>{named}</strong>
              <button type="button" aria-label={`Remove ${named} from ${name}`} onClick={() => setEntries(entries.filter((_, j) => j !== i))}>Remove</button>
            </div>
          );
        }
        const o = e as Obj;
        return (
          <div key={i} className="rule showrule">
            <RuleList title="Shows that match any of" rules={ruleList(o['match'])} movies={false} label={`${name} entry ${i + 1} rule`} values={library?.values}
              onChange={(l) => setEntry(i, { ...o, match: l.length === 1 ? l[0]! : l })} />
            <RuleList title="Except shows that match" rules={ruleList(o['except'])} movies={false} label={`${name} entry ${i + 1} except`} values={library?.values}
              onChange={(l) => { const next = { ...o }; if (l.length === 0) delete next['except']; else next['except'] = l; setEntry(i, next); }} />
            <label className="small">Except these shows (names, commas){' '}
              <LeftOut label={`${name} entry ${i + 1}: shows left out`} held={ruleList(o['except']).flatMap((x) => (typeof x['show'] === 'string' ? [x['show']] : [])).join(', ')}
                onText={(text) => {
                  const named2 = text.split(',').map((s) => s.trim()).filter(Boolean).map((s) => ({ show: s }));
                  const rest = ruleList(o['except']).filter((x) => typeof x['show'] !== 'string');
                  const all = [...rest, ...named2];
                  const next = { ...o }; if (all.length === 0) delete next['except']; else next['except'] = all; setEntry(i, next);
                }} />
            </label>
            <button type="button" aria-label={`Remove rule entry ${i + 1} from ${name}`} onClick={() => setEntries(entries.filter((_, j) => j !== i))}>Remove this entry</button>
          </div>
        );
      })}
      <div className="row">
        <select aria-label={`Add a show to ${name}`} value="" onChange={(ev) => {
          const show = library?.shows.find((x) => x.id === ev.target.value);
          if (show) setEntries([...entries, { show: show.title, id: show.id }]);
        }}>
          <option value="">Add a show…</option>
          {library?.shows.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}
        </select>
        <button type="button" onClick={() => setEntries([...entries, { match: [{}] }])}>Add shows by rule</button>
      </div>
      <div className="rulelist">
        <h4>Episodes</h4>
        <div className="rulefields">
          <label>Seasons <input aria-label={`${name} episodes: seasons`} placeholder="1-3" value={textOf(episodes['seasons'])} onChange={(e) => setEpisodes('seasons', e.target.value.trim())} /></label>
          <label>Specials{' '}
            <select aria-label={`${name} episodes: specials`} value={textOf(episodes['specials'])} onChange={(e) => setEpisodes('specials', e.target.value)}>
              <option value="">include</option><option value="skip">skip</option>
            </select>
          </label>
          <label>Length <input aria-label={`${name} episodes: length`} placeholder=">=15m" value={textOf(episodes['duration'])} onChange={(e) => setEpisodes('duration', e.target.value.trim())} /></label>
          <label>Order{' '}
            <select aria-label={`${name} episodes: order`} value={textOf(episodes['order'])} onChange={(e) => setEpisodes('order', e.target.value)}>
              <option value="">season, then episode</option><option value="airdate">air date</option>
            </select>
          </label>
        </div>
      </div>
    </div>
  );
}

/** A length as the file writes it: whole minutes as "117m", and a part of a minute kept ("1m30s"), not rounded to the minute. */
export function lengthText(ms: number): string {
  const seconds = Math.round(ms / 1000);
  const m = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${m}m` : `${m > 0 ? `${m}m` : ''}${rest}s`;
}

/** A pool of the page's plain kind, written as rules so that it can be given more conditions. */
export function toRules(p: PoolModel): PoolModel {
  const order = p.order;
  if (p.shows) return { raw: { shows: p.shows.map((r) => (r.id ? { show: r.show, id: r.id } : r.show)) }, ...(order ? { order } : {}) };
  const m = p.movies ?? {};
  return { raw: { movies: { ...(m.genre ? { genre: m.genre } : {}), ...(m.duration ? { duration: `${m.duration.op}${lengthText(m.duration.ms)}` } : {}) } }, ...(order ? { order } : {}) };
}
