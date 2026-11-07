import { useEffect, useState } from 'react';
import { api, type CursorAiring, type CursorCard, type CursorPreview } from '../api';
import { inZone, nameList, slotLabel } from '../format';
import { channelLink } from '../router';
import { useLoad } from '../useLoad';

type Change = { kind: 'rewind' | 'set'; amount: number; what: string };

function Airings({ list, titles, zone, compare }: { list: CursorAiring[]; titles: Record<string, string>; zone: string; compare: boolean }) {
  if (list.length === 0) return <p className="muted">No airing in the next two weeks.</p>;
  return (
    <ul className="airings">
      {list.map((a) => {
        const same = a.before.join() === a.after.join();
        return (
          <li key={a.start}>
            <span className="when">{inZone(a.start, zone)}</span>{' '}
            <span>{a.kind === 'rerun' ? 'rerun: ' : ''}{compare && !same ? <>{nameList(a.before, titles)} <span aria-label="becomes">→</span> <strong>{nameList(a.after, titles)}</strong></> : nameList(a.after, titles)}</span>
            {a.locked ? <span className="chip">locked: keeps its episodes</span> : a.staged ? <span className="chip">staged</span> : null}
          </li>
        );
      })}
    </ul>
  );
}

function Card({ name, card, zone, airings, reload }: { name: string; card: CursorCard; zone: string; airings: CursorPreview | undefined; reload: () => void }) {
  const [rewind, setRewind] = useState(1);
  const [episode, setEpisode] = useState(card.position + 1);
  const [pending, setPending] = useState<Change>();
  const [preview, setPreview] = useState<CursorPreview>();
  const [busy, setBusy] = useState<'previewing' | 'applying'>();
  const [error, setError] = useState<string>();
  const [done, setDone] = useState<string>();

  async function ask(c: Change): Promise<void> {
    setError(undefined); setDone(undefined); setPending(c); setPreview(undefined); setBusy('previewing');
    try {
      setPreview(await api.previewCursor(name, card.key, c.kind, c.amount));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPending(undefined);
    } finally {
      setBusy(undefined);
    }
  }
  async function apply(): Promise<void> {
    if (!pending) return;
    setBusy('applying'); setError(undefined);
    try {
      await api.adjustCursor(name, card.key, pending.kind, pending.amount);
      setDone(`Done: ${pending.what}.`);
      setPending(undefined); setPreview(undefined);
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(undefined);
    }
  }
  const cancel = (): void => { setPending(undefined); setPreview(undefined); setError(undefined); };
  const week = Math.max(1, card.perWeek);
  const titles = preview?.titles ?? airings?.titles ?? {};

  return (
    <article className="card cursor">
      <header><h2>{card.pool}</h2><span className="chip">{card.key}</span></header>
      <p className="next">Next up: <strong>{card.next?.title ?? 'nothing'}</strong> <span className="muted">({card.position + 1} of {card.length})</span></p>
      <p className="muted small">Read by {card.slotInfo.map((s) => `${slotLabel(s.id)} (${s.mode === 'rerun' ? 'rerun' : 'continues'})`).join(', ')}</p>

      <h3>Next airings</h3>
      {airings ? <Airings list={airings.airings} titles={airings.titles} zone={zone} compare={false} /> : <p className="muted">Loading…</p>}

      <div className="controls">
        <button type="button" disabled={busy !== undefined} onClick={() => ask({ kind: 'rewind', amount: week, what: `rewound ${week} episode${week === 1 ? '' : 's'}` })}>Missed a week</button>
        <label>Rewind by <input type="number" min={1} value={rewind} onChange={(e) => setRewind(Math.max(1, Number(e.target.value) || 1))} /></label>
        <button type="button" disabled={busy !== undefined} onClick={() => ask({ kind: 'rewind', amount: rewind, what: `rewound ${rewind} episode${rewind === 1 ? '' : 's'}` })}>Preview</button>
        <label>Set to episode <input type="number" min={1} max={card.length} value={episode} onChange={(e) => setEpisode(Math.min(card.length, Math.max(1, Number(e.target.value) || 1)))} /> of {card.length}</label>
        <button type="button" disabled={busy !== undefined} onClick={() => ask({ kind: 'set', amount: episode - 1, what: `set to episode ${episode}` })}>Preview</button>
      </div>
      <p className="muted small">“Missed a week” rewinds by {week} (the episodes this show plays in a week).</p>

      {busy === 'previewing' && <p role="status">Working out what it would change…</p>}
      {error && <p className="error" role="alert">{error}</p>}
      {done && <p className="ok-note" role="status">{done}</p>}
      {preview && pending && (
        <div className="preview" aria-label="What this would change">
          <p>
            Next up becomes <strong>{preview.next.after ? preview.titles[preview.next.after] ?? preview.next.after : 'nothing'}</strong>{' '}
            <span className="muted">(was {preview.next.before ? preview.titles[preview.next.before] ?? preview.next.before : 'nothing'})</span>.
          </p>
          <p className="muted small">Already in Tunarr until {inZone(preview.committedUntil, zone)}: that stays as it is.</p>
          <Airings list={preview.airings} titles={titles} zone={zone} compare />
          {preview.airings.some((a) => a.locked) && <p className="muted small">A locked slot keeps its episodes. Unlock it in staging to change it.</p>}
          <div className="controls">
            <button type="button" className="primary" disabled={busy !== undefined} onClick={apply}>{busy === 'applying' ? 'Applying…' : 'Apply'}</button>
            <button type="button" disabled={busy === 'applying'} onClick={cancel}>Cancel</button>
          </div>
        </div>
      )}
    </article>
  );
}

export function Cursors({ name }: { name: string }) {
  const detail = useLoad(() => api.channel(name), `d:${name}`);
  const list = useLoad(() => api.cursors(name), `c:${name}`);
  const [airings, setAirings] = useState<Record<string, CursorPreview>>({});
  const zone = detail.data?.timezone ?? 'UTC';

  // The next airings of each show, one after another: a channel runs one job at a time.
  useEffect(() => {
    let live = true;
    (async () => {
      for (const c of list.data ?? []) {
        try {
          const p = await api.previewCursor(name, c.key, 'rewind', 0);
          if (live) setAirings((a) => ({ ...a, [c.key]: p }));
        } catch {
          break; // busy or failed: the cards still work without the listing
        }
      }
    })();
    return () => { live = false; };
  }, [list.data, name]);

  return (
    <section>
      <p><a href={channelLink(name)}>← {name}</a></p>
      <div className="page-head"><h1>Where the shows are</h1></div>
      <p className="muted">Move a show's place after a missed week, or jump to an episode. Only what is not yet in Tunarr changes.</p>
      {list.error && <p className="error" role="alert">{list.error}</p>}
      {list.data && list.data.length === 0 && <p className="muted">This channel has no ordered shows.</p>}
      <div className="cards">
        {list.data?.map((c) => <Card key={c.key} name={name} card={c} zone={zone} airings={airings[c.key]} reload={() => { setAirings({}); list.reload(); }} />)}
      </div>
    </section>
  );
}
