import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type Library, type PoolModel, type PoolStats, type SaveResult, type ScheduleModel, type SlotModel, type TemplateModel } from '../api';
import { PoolsPanel } from '../components/PoolsPanel';
import { Palette, TemplateEditor, DEFAULT_LENGTH, lengthText } from '../components/Templates';
import { WeekGrid } from '../components/WeekGrid';
import { clock } from '../format';
import { calendarLink, channelLink, specialLink } from '../router';
import { useLoad } from '../useLoad';
import { DAY_NAMES, HOUR, hasGaps, keyOf, moveTo, place, resizeTo } from '../week';

type Draft = Pick<ScheduleModel, 'week' | 'pools' | 'templates'> & { fill?: string };
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const hhmm = (ms: number): string => clock(Math.floor(ms / 60_000));
const parseTime = (t: string): number | undefined => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(t);
  return m ? Number(m[1]) * HOUR + Number(m[2]) * 60_000 : undefined;
};
const hueOf = (pools: string[]) => (pool: string): number => (Math.max(0, pools.indexOf(pool)) * 57 + 210) % 360;
const matches = (s: SlotModel, t: TemplateModel): boolean => s.pool === t.pool && s.length === t.length && s.link === t.link && s.linkMode === t.linkMode && s.run === t.run && same(s.tags, t.tags);

export function Schedule({ name }: { name: string }) {
  const loaded = useLoad(() => api.scheduleModel(name), `sched:${name}`);
  const library = useLoad(api.library, 'library');
  const [draft, setDraft] = useState<Draft>();
  const base = useRef<Draft | undefined>(undefined);
  const [selected, setSelected] = useState<string>();
  const [armed, setArmed] = useState<string>();
  const [editing, setEditing] = useState<string | null>();
  const [stats, setStats] = useState<Record<string, PoolStats>>({});
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<SaveResult>();
  const [error, setError] = useState<string>();
  const [form, setForm] = useState({ day: 1, time: '20:00', template: '' });

  useEffect(() => {
    if (loaded.data) {
      const m: Draft = { week: loaded.data.model.week, pools: loaded.data.model.pools, templates: loaded.data.model.templates ?? {}, ...(loaded.data.model.fill ? { fill: loaded.data.model.fill } : {}) };
      setDraft(m); base.current = m;
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

  const { week, templates } = draft;
  const dirty = !same(draft, base.current);
  const edit = (f: (d: Draft) => Draft): void => { setDraft((d) => (d ? f(d) : d)); setResult(undefined); };
  const slot = week.find((s) => keyOf(s) === selected);
  const templateNames = Object.keys(templates);
  const uses: Record<string, number> = {};
  for (const s of week) if (s.template) uses[s.template] = (uses[s.template] ?? 0) + 1;
  const gaps = hasGaps(week);

  const shortestSlot: Record<string, number> = {};
  for (const s of week) shortestSlot[s.pool] = Math.min(shortestSlot[s.pool] ?? Infinity, s.length);
  const notes: Record<string, string> = {};
  for (const s of week) {
    const st = stats[s.pool];
    if (s.length > 12 * HOUR) notes[keyOf(s)] = `This slot lasts ${(s.length / HOUR).toFixed(1)} hours.`;
    else if (st && st.count > 0 && st.durations[0]! > s.length) notes[keyOf(s)] = `No program of ${s.pool} fits this ${Math.round(s.length / 60_000)}-minute slot.`;
  }

  // --- placing, moving and resizing ---
  const putTemplate = (tplName: string, day: number, at: number): void => {
    const t = templates[tplName];
    if (!t) return;
    const s = place(week, { ...t, name: tplName }, day, at, grid);
    if (!s) { setError(`There is no room for ${tplName} at ${DAY_NAMES[day]} ${hhmm(Math.round(at / grid) * grid)}: another slot is playing then.`); return; }
    setError(undefined);
    edit((d) => ({ ...d, week: [...d.week, s] }));
    setSelected(keyOf(s));
  };
  const move = (key: string, day: number, at: number): void => {
    const cur = week.find((s) => keyOf(s) === key);
    const next = cur && moveTo(week, cur, day, at, grid);
    if (!next) return;
    edit((d) => ({ ...d, week: d.week.map((s) => (keyOf(s) === key ? next : s)) }));
    setSelected(keyOf(next));
  };
  const resize = (key: string, length: number): void => {
    const cur = week.find((s) => keyOf(s) === key);
    if (!cur) return;
    const next = resizeTo(week, cur, length, grid);
    if (next.length !== cur.length) edit((d) => ({ ...d, week: d.week.map((s) => (keyOf(s) === key ? next : s)) }));
  };
  const update = (patch: Partial<SlotModel>): void => {
    if (!slot) return;
    const key = keyOf(slot);
    let next: SlotModel = { ...slot, ...patch };
    if ('link' in patch && !patch.link) { delete next.link; delete next.linkMode; }
    if (patch.link) delete next.run; // a run slot cannot be linked
    if ('run' in patch && !patch.run) { delete next.run; delete next.tags; }
    if (patch.run) { delete next.link; delete next.linkMode; }
    if ('tags' in patch && (!patch.tags || patch.tags.length === 0)) delete next.tags;
    if (patch.at !== undefined || patch.day !== undefined) {
      const m = moveTo(week, slot, patch.day ?? slot.day, patch.at ?? slot.at, grid);
      if (!m) return; // never two slots at one moment
      next = { ...next, day: m.day, at: m.at, length: Math.min(next.length, m.length) };
    }
    if (patch.length !== undefined) next = resizeTo(week, { ...slot, ...patch, length: slot.length }, patch.length, grid);
    edit((d) => ({ ...d, week: d.week.map((s) => (keyOf(s) === key ? next : s)) }));
    setSelected(keyOf(next));
  };
  const remove = (): void => {
    if (!slot) return;
    if (week.length === 1) { setError('The week needs at least one slot.'); return; }
    setError(undefined);
    edit((d) => ({ ...d, week: d.week.filter((s) => keyOf(s) !== keyOf(slot)) }));
    setSelected(undefined);
  };
  const placeFromForm = (): void => {
    const at = parseTime(form.time);
    const tpl = form.template || templateNames[0];
    if (at === undefined || at % grid !== 0 || !tpl) { setError(`Give a time on the ${grid / 60_000}-minute grid and a template.`); return; }
    putTemplate(tpl, form.day, at);
  };

  // --- templates ---
  const saveTemplate = (old: string | null, tplName: string, t: TemplateModel, update: boolean): void => {
    edit((d) => {
      const before = old ? d.templates[old] : undefined;
      const templates = Object.fromEntries(Object.entries(d.templates).filter(([n]) => n !== old));
      templates[tplName] = t;
      let w = d.week;
      if (old) {
        w = d.week.map((s) => (s.template === old ? { ...s, template: tplName } : s));
        if (update && before) {
          for (const s of [...w]) {
            if (s.template !== tplName || !matches(s, before)) continue;
            const { link: _l, linkMode: _m, run: _r, tags: _t, ...rest } = s;
            const merged: SlotModel = { ...rest, pool: t.pool, length: s.length, ...(t.link ? { link: t.link, linkMode: t.linkMode ?? 'continue' } : {}), ...(t.run ? { run: true as const } : {}), ...(t.tags ? { tags: t.tags } : {}) };
            const sized = resizeTo(w.filter((x) => keyOf(x) !== keyOf(s)), merged, t.length, grid);
            w = w.map((x) => (keyOf(x) === keyOf(s) ? sized : x));
          }
        }
      }
      return { ...d, templates, week: w };
    });
    setEditing(undefined);
    setArmed(tplName);
  };
  const deleteTemplate = (tplName: string): void => {
    edit((d) => {
      const { [tplName]: _gone, ...rest } = d.templates;
      return { ...d, templates: rest, week: d.week.map((s) => { const { template: _t, ...r } = s; return s.template === tplName ? r : s; }) };
    });
    if (armed === tplName) setArmed(undefined);
    setEditing(undefined);
  };
  const fromPools = (): void => edit((d) => ({ ...d, templates: Object.fromEntries(Object.keys(d.pools).map((p) => [p, { pool: p, length: DEFAULT_LENGTH }])) }));
  const saveSlotAsTemplate = (): void => {
    if (!slot) return;
    const n = window.prompt('Name for the template', `${slot.pool}, ${lengthText(slot.length)}`)?.trim();
    if (!n) return;
    if (templates[n]) { setError(`There is already a template called "${n}".`); return; }
    setError(undefined);
    edit((d) => ({ ...d, templates: { ...d.templates, [n]: { pool: slot.pool, length: slot.length, ...(slot.link ? { link: slot.link, linkMode: slot.linkMode ?? 'continue' } : {}), ...(slot.run ? { run: true as const } : {}), ...(slot.tags ? { tags: slot.tags } : {}) } }, week: d.week.map((s) => (keyOf(s) === keyOf(slot) ? { ...s, template: n } : s)) }));
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
      const r = await api.saveModel(name, { week: draft.week, pools: draft.pools, templates: draft.templates, fill: draft.fill ?? null }, force);
      setResult(r);
      if (r.saved) loaded.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  const linkNames = [...new Set([...week.map((s) => s.link), ...Object.values(templates).map((t) => t.link)].filter((x): x is string => !!x))];
  const used = new Set([...week.map((s) => s.pool), ...Object.values(templates).map((t) => t.pool), ...(draft.fill ? [draft.fill] : [])]);
  const hue = hueOf(poolNames);
  const editedTemplate = editing ? templates[editing] : undefined;

  return (
    <section>
      <p><a href={channelLink(name)}>← {name}</a></p>
      <div className="page-head"><h1>The week</h1></div>
      <p className="muted">Make a slot template (a name, what it plays and how long, 2 hours unless you say otherwise), then drag it onto the week. Drag a slot to move it, drag its bottom edge to make it longer or shorter. Times snap to the {grid / 60_000}-minute grid. Time no slot covers plays the fill pool.</p>
      {error && <p className="error" role="alert">{error}</p>}

      <h2>Slot templates</h2>
      {templateNames.length === 0 && (
        <p className="muted">No templates yet. <button type="button" onClick={fromPools}>Make one per pool</button> (2 hours each) or <button type="button" onClick={() => setEditing(null)}>make your own</button>.</p>
      )}
      <Palette templates={templates} pools={draft.pools} hueOf={hue} armed={armed} uses={uses} onArm={setArmed} onEdit={setEditing} />
      {templateNames.length > 0 && editing === undefined && <p><button type="button" onClick={() => setEditing(null)}>New template</button> {armed && <span className="muted small">“{armed}” is picked up: click a spot on the week to place it.</span>}</p>}
      {editing !== undefined && (
        <TemplateEditor key={editing ?? '(new)'} name={editing ?? undefined} template={editedTemplate} taken={templateNames} pools={draft.pools} grid={grid}
          following={editing && editedTemplate ? week.filter((s) => s.template === editing && matches(s, editedTemplate)).length : 0} linkNames={linkNames}
          onSave={(n, t, u) => saveTemplate(editing, n, t, u)} onDelete={editing ? () => deleteTemplate(editing) : undefined} onClose={() => setEditing(undefined)} />
      )}

      <WeekGrid week={week} grid={grid} pools={poolNames} fill={draft.fill} selected={selected} onSelect={setSelected} onMove={move} onResize={resize} armed={!!armed} notes={notes}
        onPlace={(day, at) => { if (armed) putTemplate(armed, day, at); }} onDropTemplate={putTemplate} />

      <div className="editor" aria-label="Where empty time goes">
        <label>Time no slot covers plays from{' '}
          <select aria-label="Fill pool" value={draft.fill ?? ''} onChange={(e) => edit((d) => { const { fill: _f, ...r } = d; return e.target.value ? { ...r, fill: e.target.value } : r; })}>
            <option value="">nothing (every minute must be in a slot)</option>
            {poolNames.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </label>
        {gaps && !draft.fill && <p className="error" role="alert">Part of the week has no slot, so choose a fill pool before saving.</p>}
      </div>

      {slot ? (
        <div className="editor" aria-label="The selected slot">
          <h2>{DAY_NAMES[slot.day]} {hhmm(slot.at)}</h2>
          <p className="muted small">{slot.template ? `Placed from the template “${slot.template}”. ` : ''}Lasts {lengthText(slot.length)}.{notes[keyOf(slot)] ? ` ${notes[keyOf(slot)]}` : ''}</p>
          <div className="row">
            <label>Day <select aria-label="Day of the slot" value={slot.day} onChange={(e) => update({ day: Number(e.target.value) })}>{DAY_NAMES.map((d, i) => <option key={d} value={i}>{d}</option>)}</select></label>
            <label>Starts at <input type="time" step={grid / 1000} value={hhmm(slot.at)} onChange={(e) => { const at = parseTime(e.target.value); if (at !== undefined && at % grid === 0) update({ at }); }} /></label>
            <label>Lasts, minutes <input type="number" aria-label="Lasts, minutes" min={grid / 60_000} step={grid / 60_000} value={slot.length / 60_000} onChange={(e) => { const m = Number(e.target.value); if (Number.isFinite(m) && m > 0) update({ length: m * 60_000 }); }} /></label>
          </div>
          <label>Plays from{' '}
            <select value={slot.pool} onChange={(e) => update({ pool: e.target.value })}>{poolNames.map((p) => <option key={p} value={p}>{p}</option>)}</select>
          </label>
          <div className="row">
            <label><input type="checkbox" aria-label="Run of short items" checked={slot.run === true} onChange={(e) => update({ run: e.target.checked ? true : undefined })} />{' '}
              A run of short items (music videos): they play back to back and only the slot starts and ends on the grid</label>
            <label>Closer genres{' '}
              <input aria-label="Closer genres" placeholder="any" value={(slot.tags ?? []).join(', ')} onChange={(e) => update({ tags: e.target.value.split(',').map((t) => t.trim()).filter(Boolean) })} />
            </label>
          </div>
          <div className="row">
            <label>Linked to another slot{' '}
              <select aria-label="Link" disabled={slot.run === true} value={slot.link ? slot.linkMode ?? 'continue' : ''} onChange={(e) => {
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
          <div className="row">
            <button type="button" onClick={remove}>Remove this slot</button>
            <button type="button" onClick={saveSlotAsTemplate}>Save as a template</button>
          </div>
        </div>
      ) : (
        <p className="muted">Select a slot to change it.</p>
      )}

      {templateNames.length > 0 && (
        <div className="editor" aria-label="Place a template">
          <h2>Place a template</h2>
          <p className="muted small">Without dragging: choose where it goes.</p>
          <div className="row">
            <label>Template <select aria-label="Template to place" value={form.template || templateNames[0]} onChange={(e) => setForm({ ...form, template: e.target.value })}>{templateNames.map((t) => <option key={t} value={t}>{t}</option>)}</select></label>
            <label>Day <select value={form.day} onChange={(e) => setForm({ ...form, day: Number(e.target.value) })}>{DAY_NAMES.map((d, i) => <option key={d} value={i}>{d}</option>)}</select></label>
            <label>Time <input type="time" step={grid / 1000} value={form.time} onChange={(e) => setForm({ ...form, time: e.target.value })} /></label>
            <button type="button" onClick={placeFromForm}>Place</button>
          </div>
        </div>
      )}

      <p><a href={calendarLink(name)}>The calendar</a>: what is committed, staged and planned on each date, with the ads and breaks.</p>
      <p><a href={specialLink(name)}>Special days</a>: a day with a different program, such as Halloween.</p>

      <h2>Pools</h2>
      <p className="muted small">A pool is where a slot draws its programs from. A template only picks one.</p>
      <PoolsPanel pools={draft.pools} stats={stats} library={library.data as Library | undefined} shortestSlot={shortestSlot} used={used} onChange={changePool} />

      <div className="savebar">
        <button type="button" className="primary" disabled={!dirty || saving || (gaps && !draft.fill)} onClick={() => save(false)}>{saving ? 'Saving…' : 'Save as a new revision'}</button>
        <button type="button" disabled={!dirty || saving} onClick={() => { setDraft(base.current); setResult(undefined); setSelected(undefined); setEditing(undefined); }}>Discard changes</button>
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
