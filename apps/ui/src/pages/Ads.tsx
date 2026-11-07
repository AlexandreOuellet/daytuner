import { useEffect, useRef, useState } from 'react';
import { api, type AdSample, type AdSettings, type Edge, type FillerList, type SaveResult } from '../api';
import { BlockStrip } from '../components/BlockStrip';
import { minutes } from '../format';
import { channelLink } from '../router';
import { useLoad } from '../useLoad';

type Pos = Edge | 'mid';
const ORDER: Pos[] = ['head', 'pre', 'mid', 'post', 'tail'];
const NAME: Record<Pos, string> = { head: 'Head', pre: 'Before the show', mid: 'During the show', post: 'After the show', tail: 'Tail of the slot' };
const HELP: Record<Pos, string> = {
  head: 'The very start of a slot, before its first show.',
  pre: 'Just before each show.',
  mid: 'Breaks inside a show. They are offered at chapter marks (or every few minutes); the planner takes as many as the ad share allows.',
  post: 'Just after each show.',
  tail: 'The very end of a slot, before the next one starts.',
};

function describe(s: AdSettings, p: Pos): string {
  const bump = p !== 'mid' && s.bumpers[p] ? `bumper: ${s.bumpers[p]}` : p === 'mid' ? '' : 'no bumper';
  if (p === 'mid') return s.mid ? `${s.mid.list}, ${minutes(s.mid.min)}–${minutes(s.mid.max)} min` : 'no ads';
  const a = s.positions[p];
  const ads = a && a.max > 0 ? `${a.list}, up to ${minutes(a.max)} min` : 'no ads';
  return `${ads}; ${bump}`;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

function ListSelect({ id, label, value, lists, onChange }: { id: string; label: string; value: string | undefined; lists: FillerList[]; onChange: (v: string | undefined) => void }) {
  return (
    <label htmlFor={id}>{label}{' '}
      <select id={id} value={value ?? ''} onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value)}>
        <option value="">none</option>
        {value && !lists.some((l) => l.name === value) && <option value={value}>{value} (not in Tunarr)</option>}
        {lists.map((l) => <option key={l.id} value={l.name}>{l.name} ({l.count})</option>)}
      </select>
    </label>
  );
}

function Num({ id, label, value, step = 1, onChange }: { id: string; label: string; value: number; step?: number; onChange: (v: number) => void }) {
  return <label htmlFor={id}>{label} <input id={id} type="number" min={0} step={step} value={value} onChange={(e) => onChange(Math.max(0, Number(e.target.value) || 0))} /></label>;
}

export function Ads({ name }: { name: string }) {
  const loaded = useLoad(() => api.ads(name), `ads:${name}`);
  const [draft, setDraft] = useState<AdSettings>();
  const [picked, setPicked] = useState<Pos>('mid');
  const [samples, setSamples] = useState<{ for: AdSettings; list: AdSample[] }>();
  const [sampling, setSampling] = useState(false);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<SaveResult>();
  const [error, setError] = useState<string>();
  const base = useRef<AdSettings | undefined>(undefined);

  useEffect(() => {
    if (loaded.data) { setDraft(loaded.data.settings); base.current = loaded.data.settings; }
  }, [loaded.data]);

  const lists = loaded.data?.lists ?? [];
  const dirty = draft !== undefined && !same(draft, base.current);
  const step = draft?.step ?? 15_000;
  const ms = (min: number): number => Math.round((min * 60_000) / step) * step;
  const edit = (f: (s: AdSettings) => AdSettings): void => { setDraft((d) => (d ? f(d) : d)); setResult(undefined); };

  async function sample(): Promise<void> {
    if (!draft) return;
    setSampling(true); setError(undefined);
    try {
      const r = await api.sampleAds(name, draft);
      setSamples({ for: draft, list: r.samples });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSampling(false);
    }
  }
  async function save(force: boolean): Promise<void> {
    if (!draft) return;
    setSaving(true); setError(undefined);
    try {
      const r = await api.saveAds(name, draft, force);
      setResult(r);
      if (r.saved) loaded.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  if (loaded.error) return <section><p><a href={channelLink(name)}>← {name}</a></p><p className="error" role="alert">{loaded.error}</p></section>;
  if (!draft) return <section><p className="muted">Loading…</p></section>;

  const edge = picked === 'mid' ? undefined : picked;
  const pos = edge ? draft.positions[edge] : undefined;
  const setPos = (e: Edge, patch: Partial<{ list: string | undefined; min: number; max: number }>): void =>
    edit((s) => {
      const cur = s.positions[e] ?? { min: 0, max: 0 };
      const next = { ...cur, ...patch };
      const { list, ...rest } = next;
      const out = { ...rest, ...(list ? { list } : {}) };
      const positions = { ...s.positions };
      if (!out.list || out.max === 0) delete positions[e]; else positions[e] = out;
      return { ...s, positions };
    });
  const setMid = (patch: Partial<NonNullable<AdSettings['mid']>> | null): void =>
    edit((s) => {
      if (patch === null) { const { mid: _gone, ...rest } = s; return rest; }
      const cur = s.mid ?? { list: lists[0]?.name ?? '', every: 8 * 60_000, min: 2 * 60_000, max: 3 * 60_000, tailBuffer: 60_000 };
      return { ...s, mid: { ...cur, ...patch } };
    });
  const stale = samples !== undefined && !same(samples.for, draft);

  return (
    <section>
      <p><a href={channelLink(name)}>← {name}</a></p>
      <div className="page-head"><h1>Ads, bumpers and filler</h1></div>
      <p className="muted">Where breaks go, what fills them and how much of the show they take. Changes are saved as a new schedule revision; nothing is written to Tunarr.</p>
      {error && <p className="error" role="alert">{error}</p>}

      <div className="block" role="group" aria-label="A block, from the start of the slot to its end">
        {ORDER.map((p) => (
          <button key={p} type="button" className={`pos ${p === 'mid' ? 'mid' : ''} ${picked === p ? 'picked' : ''}`} aria-pressed={picked === p} onClick={() => setPicked(p)}>
            <strong>{NAME[p]}</strong>
            <span>{describe(draft, p)}</span>
          </button>
        ))}
      </div>

      <div className="editor" aria-label={`Settings for ${NAME[picked]}`}>
        <h2>{NAME[picked]}</h2>
        <p className="muted small">{HELP[picked]}</p>
        {edge ? (
          <>
            <ListSelect id="ads-list" label="Ads from" value={pos?.list} lists={lists} onChange={(v) => setPos(edge, v ? { list: v, ...(pos && pos.max > 0 ? {} : { max: ms(2) }) } : { list: undefined })} />
            {pos && pos.max > 0 && <Num id="ads-max" label="up to (minutes)" step={0.25} value={Number(minutes(pos.max))} onChange={(v) => setPos(edge, { max: ms(v) })} />}
            <ListSelect id="bumper-list" label="Bumper from" value={draft.bumpers[edge]} lists={lists} onChange={(v) => edit((s) => { const b = { ...s.bumpers }; if (v) b[edge] = v; else delete b[edge]; return { ...s, bumpers: b }; })} />
            {pos && pos.max > 0 && (
              <details><summary>More</summary>
                <Num id="ads-min" label="At least (minutes)" step={0.25} value={Number(minutes(pos.min))} onChange={(v) => setPos(edge, { min: Math.min(ms(v), pos.max) })} />
              </details>
            )}
          </>
        ) : (
          <>
            <ListSelect id="mid-list" label="Ads from" value={draft.mid?.list} lists={lists} onChange={(v) => setMid(v ? { list: v } : null)} />
            {draft.mid && (
              <>
                <Num id="mid-min" label="Each break lasts (minutes) from" step={0.25} value={Number(minutes(draft.mid.min))} onChange={(v) => setMid({ min: Math.min(ms(v), draft.mid!.max) })} />
                <Num id="mid-max" label="to" step={0.25} value={Number(minutes(draft.mid.max))} onChange={(v) => setMid({ max: Math.max(ms(v), draft.mid!.min) })} />
                <details><summary>More</summary>
                  <Num id="mid-every" label="When a show has no chapters, offer a break every (minutes)" step={0.5} value={Number(minutes(draft.mid.every))} onChange={(v) => setMid({ every: Math.max(step, ms(v)) })} />
                  <Num id="mid-tail" label="Keep the last (minutes) free of breaks" step={0.5} value={Number(minutes(draft.mid.tailBuffer))} onChange={(v) => setMid({ tailBuffer: ms(v) })} />
                  <Num id="mid-gap" label="At least (minutes) between breaks" step={0.5} value={Number(minutes(draft.mid.minGap ?? 0))} onChange={(v) => setMid({ minGap: v === 0 ? undefined : ms(v) })} />
                </details>
              </>
            )}
          </>
        )}
      </div>

      <div className="editor">
        <h2>How much of a show ads may take</h2>
        <Num id="ratio-min" label="At least (% of the show's length)" step={1} value={Number((draft.ratio.min * 100).toFixed(2))} onChange={(v) => edit((s) => ({ ...s, ratio: { min: Math.min(v / 100, s.ratio.max), max: s.ratio.max } }))} />
        <Num id="ratio-max" label="at most (%)" step={1} value={Number((draft.ratio.max * 100).toFixed(2))} onChange={(v) => edit((s) => ({ ...s, ratio: { min: s.ratio.min, max: Math.max(v / 100, s.ratio.min) } }))} />
        <p className="muted small">Bumpers are not counted. Mid breaks are offers, not promises: the planner takes only as many as this share allows.</p>
        <details><summary>More</summary>
          <Num id="step" label="Ad lengths are multiples of (seconds)" step={5} value={draft.step / 1000} onChange={(v) => edit((s) => ({ ...s, step: Math.max(1, Math.round(v)) * 1000 }))} />
        </details>
      </div>

      <div className="editor">
        <h2>Whatever nothing else fills</h2>
        <p className="muted small">Clips (music videos, public service messages…) that fill a gap no ad can. What they cannot fill is dead air.</p>
        <ListSelect id="interstitial" label="Fill gaps from" value={draft.interstitial} lists={lists} onChange={(v) => edit((s) => { const { interstitial: _gone, ...rest } = s; return v ? { ...rest, interstitial: v } : rest; })} />
      </div>

      <div className="editor">
        <div className="page-head"><h2>A sample</h2><button type="button" onClick={sample} disabled={sampling}>{sampling ? 'Planning…' : samples ? 'Update the sample' : 'Show a sample'}</button></div>
        {!samples && <p className="muted">Plans a real episode and a real movie from this channel's library with the settings above, so you see what would air.</p>}
        {stale && <p className="warn-note">The settings changed since this sample. Update it to see the effect.</p>}
        {samples?.list.length === 0 && <p className="muted">The library has no program of a suitable length to sample.</p>}
        {samples?.list.map((s) => <BlockStrip key={s.kind} sample={s} />)}
      </div>

      <div className="savebar">
        <button type="button" className="primary" disabled={!dirty || saving} onClick={() => save(false)}>{saving ? 'Saving…' : 'Save as a new revision'}</button>
        <button type="button" disabled={!dirty || saving} onClick={() => { setDraft(base.current); setResult(undefined); }}>Discard changes</button>
        {!dirty && <span className="muted small">No changes.</span>}
      </div>
      {result?.saved && <p className="ok-note" role="status">Saved as revision {result.revision}. It takes effect for lineup planned from now on; what is already in Tunarr stays as it is.</p>}
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
