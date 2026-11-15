import { useState } from 'react';
import { api } from '../api';
import { scheduleLink } from '../router';
import { useLoad } from '../useLoad';

type Mode = 'create' | 'attach';

/** Adds a channel: creates an empty one in Tunarr, or attaches one that exists. Both start with an empty week (docs/web-channels.md). */
export function AddChannel() {
  const info = useLoad(api.addChannelInfo, 'add-channel');
  const [mode, setMode] = useState<Mode>('create');
  const [name, setName] = useState('');
  const [number, setNumber] = useState<string>('');
  const [hidden, setHidden] = useState(true);
  const [attachId, setAttachId] = useState('');
  const [adList, setAdList] = useState('');
  const [fillerList, setFillerList] = useState('');
  const [grid, setGrid] = useState(15);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [done, setDone] = useState<string | undefined>();
  const d = info.data;
  const canCreate = d?.canCreate === true;
  const chosen = mode === 'create' && !canCreate && d ? 'attach' : mode;
  const numberValue = number === '' ? (d?.nextNumber ?? 0) : Number(number);
  const lists = { gridMinutes: grid, ...(adList ? { adList } : {}), ...(fillerList ? { fillerList } : {}) };
  const ready = chosen === 'create' ? name.trim() !== '' && Number.isInteger(numberValue) && numberValue >= 1 : attachId !== '';

  const submit = async (): Promise<void> => {
    setBusy(true); setError(undefined);
    try {
      const r = chosen === 'create'
        ? await api.createChannel({ name: name.trim(), number: numberValue, hidden, ...lists })
        : await api.attachChannel({ tunarrChannel: attachId, ...lists });
      setDone(r.name);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <section>
        <h1>Channel added</h1>
        <p role="status">{done} is added with an empty week. Nothing is planned until you design a schedule for it.</p>
        <p><a className="button" href={scheduleLink(done)}>Design its schedule</a></p>
      </section>
    );
  }
  return (
    <section>
      <div className="page-head"><h1>Add a channel</h1></div>
      {info.error && <p className="error" role="alert">{info.error}</p>}
      {d && (
        <form onSubmit={(e) => { e.preventDefault(); if (ready && !busy) void submit(); }} className="addchannel">
          <fieldset>
            <legend>Which channel</legend>
            <label><input type="radio" name="mode" checked={chosen === 'create'} disabled={!canCreate} onChange={() => setMode('create')} /> Create a new channel in Tunarr</label>
            {!canCreate && <p className="muted small">This server is read only, so it cannot create a channel in Tunarr. Switch writing on (<code>DAYTUNER_ALLOW_WRITES=1</code>) to create one.</p>}
            <label><input type="radio" name="mode" checked={chosen === 'attach'} onChange={() => setMode('attach')} /> Attach a Tunarr channel that exists</label>
          </fieldset>

          {chosen === 'create' ? (
            <fieldset>
              <legend>The new channel</legend>
              <label>Name <input value={name} onChange={(e) => setName(e.target.value)} /></label>
              <label>Number <input type="number" min={1} step={1} value={number === '' ? d.nextNumber : number} onChange={(e) => setNumber(e.target.value)} /></label>
              <label><input type="checkbox" checked={hidden} onChange={(e) => setHidden(e.target.checked)} /> Hidden (kept out of guides and clients until you turn it off in Tunarr)</label>
            </fieldset>
          ) : (
            <fieldset>
              <legend>The Tunarr channel</legend>
              {d.channels.length === 0
                ? <p className="muted">Every Tunarr channel is already managed by DayTuner.</p>
                : (
                  <label>Channel{' '}
                    <select aria-label="Tunarr channel" value={attachId} onChange={(e) => setAttachId(e.target.value)}>
                      <option value="">Choose…</option>
                      {d.channels.map((c) => <option key={c.id} value={c.id}>{c.number} · {c.name}</option>)}
                    </select>
                  </label>
                )}
              <p className="muted small">DayTuner starts after what the channel already holds. Its schedule starts empty.</p>
            </fieldset>
          )}

          <fieldset>
            <legend>Ads and filler</legend>
            <label>Ad list{' '}
              <select aria-label="Ad list" value={adList} onChange={(e) => setAdList(e.target.value)}>
                <option value="">No ads</option>
                {d.lists.map((l) => <option key={l.name} value={l.name}>{l.name} ({l.count})</option>)}
              </select>
            </label>
            <label>Filler list{' '}
              <select aria-label="Filler list" value={fillerList} onChange={(e) => setFillerList(e.target.value)}>
                <option value="">No filler</option>
                {d.lists.map((l) => <option key={l.name} value={l.name}>{l.name} ({l.count})</option>)}
              </select>
            </label>
            <p className="muted small">The ads page sets how many and where.</p>
          </fieldset>

          <fieldset>
            <legend>Schedule</legend>
            <label>Grid{' '}
              <select aria-label="Grid" value={grid} onChange={(e) => setGrid(Number(e.target.value))}>
                {(d.grids ?? [15]).map((g) => <option key={g} value={g}>{g} minutes</option>)}
              </select>
            </label>
            <p className="muted small">Slots and blocks start and end on a multiple of the grid. Time zone: {d.timezone} (the server's).</p>
          </fieldset>
          {error && <p className="error" role="alert">{error}</p>}
          <button type="submit" disabled={!ready || busy}>{busy ? 'Adding…' : chosen === 'create' ? 'Create the channel' : 'Attach the channel'}</button>
        </form>
      )}
    </section>
  );
}
