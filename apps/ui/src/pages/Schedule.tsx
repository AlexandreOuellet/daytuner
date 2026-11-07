import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type Library, type PoolModel, type PoolStats, type SaveResult, type ScheduleModel, type SlotModel } from '../api';
import { PoolsPanel } from '../components/PoolsPanel';
import { WeekGrid } from '../components/WeekGrid';
import { clock } from '../format';
import { channelLink } from '../router';
import { useLoad } from '../useLoad';
import { DAY_NAMES, HOUR, keyOf, slotLength } from '../week';

type Draft = Pick<ScheduleModel, 'week' | 'pools'>;
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const hhmm = (ms: number): string => clock(Math.floor(ms / 60_000));
const parseTime = (t: string): number | undefined => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(t);
  return m ? Number(m[1]) * HOUR + Number(m[2]) * 60_000 : undefined;
};

export function Schedule({ name }: { name: string }) {
  const loaded = useLoad(() => api.scheduleModel(name), `sched:${name}`);
  const library = useLoad(api.library, 'library');
  const [draft, setDraft] = useState<Draft>();
  const base = useRef<Draft | undefined>(undefined);
  const [selected, setSelected] = useState<string>();
  const [stats, setStats] = useState<Record<string, PoolStats>>({});
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<SaveResult>();
  const [error, setError] = useState<string>();
  const [add, setAdd] = useState({ day: 1, time: '20:00', pool: '' });

  useEffect(() => {
    if (loaded.data) {
      const m = { week: loaded.data.model.week, pools: loaded.data.model.pools };
      setDraft(m); base.current = m;
      setAdd((a) => ({ ...a, pool: a.pool || Object.keys(m.pools)[0] || '' }));
    }
  }, [loaded.data]);

  const grid = loaded.data?.model.grid ?? 900_000;
  const poolNames = useMemo(() => Object.keys(draft?.pools ?? {}), [draft?.pools]);
  const poolsKey = JSON.stringify(draft?.pools ?? {});

  // What each pool holds, read again a moment after the pools change.
  useEffect(() => {
    if (!draft) return;
    let live = true;
    const t = setTimeout(() => {
      api.poolStats(name, draft.pools).then((s) => { if (live) setStats(s); }, () => undefined);
    }, 500);
    return () => { live = false; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [poolsKey, name, !!draft]);

  if (loaded.error) return <section><p><a href={channelLink(name)}>← {name}</a></p><p className="error" role="alert">{loaded.error}</p></section>;
  if (!draft) return <section><p className="muted">Loading…</p></section>;

  const week = draft.week;
  const dirty = !same(draft, base.current);
  const edit = (f: (d: Draft) => Draft): void => { setDraft((d) => (d ? f(d) : d)); setResult(undefined); };
  const slot = week.find((s) => keyOf(s) === selected);

  const shortestSlot: Record<string, number> = {};
  for (const s of week) shortestSlot[s.pool] = Math.min(shortestSlot[s.pool] ?? Infinity, slotLength(week, s));
  const notes: Record<string, string> = {};
  for (const s of week) {
    const len = slotLength(week, s);
    const st = stats[s.pool];
    if (len > 12 * HOUR) notes[keyOf(s)] = `This slot lasts ${(len / HOUR).toFixed(1)} hours.`;
    else if (st && st.count > 0 && st.durations[0]! > len) notes[keyOf(s)] = `No program of ${s.pool} fits this ${Math.round(len / 60_000)}-minute slot.`;
  }

  const move = (key: string, at: number): void => {
    edit((d) => ({ ...d, week: d.week.map((s) => (keyOf(s) === key ? { ...s, at } : s)) }));
    const [day] = key.split('@');
    setSelected(`${day}@${at}`);
  };
  const update = (patch: Partial<SlotModel>): void => {
    if (!slot) return;
    const key = keyOf(slot);
    const next = { ...slot, ...patch };
    if ('link' in patch && !patch.link) { delete next.link; delete next.linkMode; }
    if (patch.at !== undefined && week.some((s) => keyOf(s) !== key && s.day === next.day && s.at === next.at)) return; // never two slots at one moment
    edit((d) => ({ ...d, week: d.week.map((s) => (keyOf(s) === key ? next : s)) }));
    setSelected(keyOf(next));
  };
  const addSlot = (): void => {
    const at = parseTime(add.time);
    if (at === undefined || at % grid !== 0 || !add.pool) { setError(`Give a time on the ${grid / 60_000}-minute grid and a pool.`); return; }
    if (week.some((s) => s.day === add.day && s.at === at)) { setError(`There is already a slot at ${add.time} on ${DAY_NAMES[add.day]}.`); return; }
    setError(undefined);
    edit((d) => ({ ...d, week: [...d.week, { day: add.day, at, pool: add.pool }] }));
    setSelected(`${add.day}@${at}`);
  };
  const remove = (): void => {
    if (!slot) return;
    if (week.length === 1) { setError('The week needs at least one slot.'); return; }
    setError(undefined);
    edit((d) => ({ ...d, week: d.week.filter((s) => keyOf(s) !== keyOf(slot)) }));
    setSelected(undefined);
  };
  const changePool = (poolName: string, pool: PoolModel | null): void =>
    edit((d) => {
      const pools = { ...d.pools };
      if (pool === null) delete pools[poolName]; else pools[poolName] = pool;
      return { ...d, pools };
    });
  async function save(force: boolean): Promise<void> {
    if (!draft) return;
    setSaving(true); setError(undefined);
    try {
      const r = await api.saveModel(name, draft, force);
      setResult(r);
      if (r.saved) loaded.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  const linkNames = [...new Set(week.map((s) => s.link).filter((x): x is string => !!x))];
  const used = new Set(week.map((s) => s.pool));

  return (
    <section>
      <p><a href={channelLink(name)}>← {name}</a></p>
      <div className="page-head"><h1>The week</h1></div>
      <p className="muted">Each slot lasts until the next one starts, and the week wraps round. Drag a slot's top edge, or select it and use the arrow keys, to change when it starts. Times snap to the {grid / 60_000}-minute grid.</p>
      {error && <p className="error" role="alert">{error}</p>}

      <WeekGrid week={week} grid={grid} pools={poolNames} selected={selected} onSelect={setSelected} onMove={move} notes={notes} />

      {slot ? (
        <div className="editor" aria-label="The selected slot">
          <h2>{DAY_NAMES[slot.day]} {hhmm(slot.at)}</h2>
          <p className="muted small">Lasts {(slotLength(week, slot) / HOUR).toFixed(2).replace(/\.?0+$/, '')} hours (until the next slot starts).{notes[keyOf(slot)] ? ` ${notes[keyOf(slot)]}` : ''}</p>
          <label>Starts at <input type="time" step={grid / 1000} value={hhmm(slot.at)} onChange={(e) => { const at = parseTime(e.target.value); if (at !== undefined && at % grid === 0) update({ at }); }} /></label>
          <label>Plays from{' '}
            <select value={slot.pool} onChange={(e) => update({ pool: e.target.value })}>{poolNames.map((p) => <option key={p} value={p}>{p}</option>)}</select>
          </label>
          <div className="row">
            <label>Linked to another slot{' '}
              <select aria-label="Link" value={slot.link ? slot.linkMode ?? 'continue' : ''} onChange={(e) => {
                if (e.target.value === '') update({ link: undefined });
                else update({ link: slot.link ?? linkNames[0] ?? `${slot.pool}`, linkMode: e.target.value as 'continue' | 'rerun' });
              }}>
                <option value="">no</option>
                <option value="continue">continues the same show (shares its place)</option>
                <option value="rerun">reruns it (replays the episodes behind)</option>
              </select>
            </label>
            {slot.link !== undefined && (
              <label>Link name <input list="linknames" aria-label="Link name" value={slot.link} onChange={(e) => update({ link: e.target.value.trim() || slot.link })} />
                <datalist id="linknames">{linkNames.map((l) => <option key={l} value={l} />)}</datalist>
              </label>
            )}
          </div>
          <button type="button" onClick={remove}>Remove this slot</button>
        </div>
      ) : (
        <p className="muted">Select a slot to change it.</p>
      )}

      <div className="editor" aria-label="Add a slot">
        <h2>Add a slot</h2>
        <div className="row">
          <label>Day <select value={add.day} onChange={(e) => setAdd({ ...add, day: Number(e.target.value) })}>{DAY_NAMES.map((d, i) => <option key={d} value={i}>{d}</option>)}</select></label>
          <label>Time <input type="time" step={grid / 1000} value={add.time} onChange={(e) => setAdd({ ...add, time: e.target.value })} /></label>
          <label>Pool <select value={add.pool} onChange={(e) => setAdd({ ...add, pool: e.target.value })}>{poolNames.map((p) => <option key={p} value={p}>{p}</option>)}</select></label>
          <button type="button" onClick={addSlot}>Add</button>
        </div>
      </div>

      <h2>Pools</h2>
      <p className="muted small">A pool is where a slot draws its programs from. A slot only picks one.</p>
      <PoolsPanel pools={draft.pools} stats={stats} library={library.data} shortestSlot={shortestSlot} used={used} onChange={changePool} />

      <div className="savebar">
        <button type="button" className="primary" disabled={!dirty || saving} onClick={() => save(false)}>{saving ? 'Saving…' : 'Save as a new revision'}</button>
        <button type="button" disabled={!dirty || saving} onClick={() => { setDraft(base.current); setResult(undefined); setSelected(undefined); }}>Discard changes</button>
        {!dirty && <span className="muted small">No changes.</span>}
      </div>
      {result?.saved && <p className="ok-note" role="status">Saved as revision {result.revision}. Days already committed to Tunarr stay as they are; the new week is used for lineup planned from now on.</p>}
      {result && !result.saved && (
        <div className="error" role="alert">
          <p><strong>Not saved.</strong> {result.impact?.conflicts.length} locked staged slot{result.impact?.conflicts.length === 1 ? '' : 's'} would no longer fit:</p>
          <ul>{result.impact?.conflicts.map((c) => <li key={c.start}>{c.message}</li>)}</ul>
          <button type="button" onClick={() => save(true)} disabled={saving}>Save anyway</button>
          <span className="small"> Those slots are planned again at commit time, and the log records why.</span>
        </div>
      )}
    </section>
  );
}
