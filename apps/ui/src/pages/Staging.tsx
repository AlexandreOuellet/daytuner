import { useCallback, useEffect, useState } from 'react';
import { api, type StageOut, type StagedSlot } from '../api';
import { ChangesPanel } from '../components/ChangesPanel';
import { DayTimeline } from '../components/DayTimeline';
import { ProgramPicker, type Program } from '../components/ProgramPicker';
import { channelLink } from '../router';
import { addDays, dayStart, localDate, stagedDays, timeOf } from '../staging';
import { useLoad } from '../useLoad';

export function Staging({ name, date: wanted }: { name: string; date?: string }) {
  const channel = useLoad(() => api.channel(name), `ch:${name}`);
  const model = useLoad(() => api.scheduleModel(name), `m:${name}`);
  const staged = useLoad(() => api.staged(name), `st:${name}`);
  const library = useLoad(api.library, 'library');
  const [titles, setTitles] = useState<Record<string, string>>({});
  const [problems, setProblems] = useState<Record<number, string>>({});
  const [date, setDate] = useState<string>();
  const [selected, setSelected] = useState<number>();
  const [block, setBlock] = useState<number>();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [last, setLast] = useState<{ out: StageOut; heading: string }>();
  const [replacing, setReplacing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ start: '', end: '', to: '' });

  const zone = channel.data?.timezone ?? 'UTC';
  const grid = model.data?.model.grid ?? 900_000;
  const slots = staged.data ?? [];
  const days = channel.data ? stagedDays(zone, slots) : [];
  const shown = date ?? (wanted && channel.data ? wanted : days[0]);

  // Names for the programs, and what the next commit would find wrong; read again after each change.
  const refreshChecks = useCallback(async () => {
    try {
      const c = await api.stageCheck(name);
      setTitles((t) => ({ ...t, ...c.titles }));
      const p: Record<number, string> = {};
      for (const x of c.conflicts) p[x.start] = `Conflict (${x.reason}): ${x.message}`;
      for (const w of c.pinProblems) {
        const row = slots.find((s) => w.at >= s.start && w.at < s.end);
        if (row) p[row.start] = `${w.severity === 'alert' ? 'Alert' : 'Note'}: ${w.message}`;
      }
      setProblems(p);
    } catch {
      /* the timeline still works without names */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, staged.data]);
  useEffect(() => { if (staged.data && staged.data.length > 0) void refreshChecks(); }, [staged.data, refreshChecks]);

  async function act(label: string, run: () => Promise<StageOut>): Promise<void> {
    setBusy(label); setError(undefined);
    try {
      const out = await run();
      setTitles((t) => ({ ...t, ...out.titles }));
      setLast({ out, heading: `Changed by ${label}` });
      staged.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(undefined);
    }
  }

  async function lock(start: number, locked: boolean): Promise<void> {
    setError(undefined);
    try {
      await api.lockSlot(name, start, locked);
      staged.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  if (channel.error || staged.error) return <section><p><a href={channelLink(name)}>← {name}</a></p><p className="error" role="alert">{channel.error ?? staged.error}</p></section>;
  if (!channel.data || !staged.data) return <section><p className="muted">Loading…</p></section>;

  const slot: StagedSlot | undefined = slots.find((s) => s.start === selected);
  const start = shown ? dayStart(zone, shown) : 0;
  const end = shown ? dayStart(zone, addDays(shown, 1)) : 0;
  const idx = shown ? days.indexOf(shown) : -1;
  const edge = channel.data.edge;
  const aBlock = slot && block !== undefined ? slot.blocks[block] : undefined;
  const pinNumber = block !== undefined ? block + 1 : undefined;
  const pinned = slot && pinNumber !== undefined ? slot.pins[String(pinNumber)] : undefined;

  const pick = (s: number, b?: number): void => { setSelected(s); setBlock(b); setReplacing(false); };

  return (
    <section>
      <p><a href={channelLink(name)}>← {name}</a></p>
      <div className="page-head"><h1>Staging</h1></div>
      <p className="muted">Planned days that are not in Tunarr yet. Change them here; nothing changes the schedule or writes to Tunarr until they are committed. The lineup is committed until {timeOf(zone, edge)} on {localDate(zone, edge)}.</p>
      {error && <p className="error" role="alert">{error}</p>}
      {busy && <p role="status" className="muted">Working: {busy}…</p>}

      <div className="stage-range">
        <label>Stage the days until <input type="date" aria-label="Stage until" value={form.to} onChange={(e) => setForm({ ...form, to: e.target.value })} /></label>
        <button type="button" disabled={!form.to || busy !== undefined} onClick={() => act('staging a range', () => api.stageGenerate(name, form.to))}>Stage them</button>
        <span className="muted small">Plans from the end of the committed lineup. Locked slots, pins and shapes are kept.</span>
      </div>

      {days.length === 0 ? (
        <p className="muted">Nothing is staged. Choose a date above to plan the days up to it.</p>
      ) : (
        <>
          <div className="daystrip" role="tablist" aria-label="Staged days">
            {days.map((d) => <button key={d} type="button" role="tab" aria-selected={d === shown} className={d === shown ? 'on' : ''} onClick={() => setDate(d)}>{d.slice(5)}</button>)}
          </div>
          <div className="page-head">
            <button type="button" disabled={idx <= 0} onClick={() => setDate(days[idx - 1])}>← Previous day</button>
            <h2>{shown}</h2>
            <button type="button" disabled={idx < 0 || idx >= days.length - 1} onClick={() => setDate(days[idx + 1])}>Next day →</button>
          </div>
          {shown && !days.includes(shown) && <p className="muted">Nothing is staged on {shown}.</p>}
          {shown && (
            <DayTimeline slots={slots} zone={zone} dayStart={start} dayEnd={end} grid={grid} titles={titles} selected={selected} selectedBlock={block} problems={problems}
              onSelect={pick} onLock={lock} busy={busy !== undefined}
              onResize={(s, e) => act('resizing a slot', () => api.stageEdit(name, { kind: 'resize', start: s, end: e }))} />
          )}
        </>
      )}

      {slot && (
        <div className="editor" aria-label="The selected slot">
          <h2>{timeOf(zone, slot.start)}–{timeOf(zone, slot.end)} · {slot.slotId?.startsWith('added@') ? 'an added slot' : slot.pool}</h2>
          {problems[slot.start] && <p className="warn-note small">{problems[slot.start]}</p>}
          <div className="row">
            <button type="button" onClick={() => lock(slot.start, !slot.locked)} disabled={busy !== undefined}>{slot.locked ? 'Unlock' : 'Lock'}</button>
            <button type="button" disabled={slot.locked || busy !== undefined} title={slot.locked ? 'Unlock it first' : 'The slot before it grows to take its time'} onClick={() => act('deleting a slot', () => api.stageEdit(name, { kind: 'delete', start: slot.start }))}>Delete this slot</button>
            <button type="button" disabled={slot.locked || busy !== undefined} onClick={() => act('resetting a slot', () => api.resetStage(name, slot.start, slot.end))}>Reset this slot to the plan</button>
          </div>
          <label>Ends at{' '}
            <input type="datetime-local" step={grid / 1000} aria-label="New end" disabled={slot.locked || busy !== undefined} defaultValue={`${localDate(zone, slot.end)}T${timeOf(zone, slot.end)}`} key={`${slot.start}:${slot.end}`}
              onBlur={(e) => { if (e.target.value && e.target.value !== `${localDate(zone, slot.end)}T${timeOf(zone, slot.end)}`) void act('resizing a slot', () => api.stageEdit(name, { kind: 'resize', start: slot.start, end: e.target.value })); }} />
          </label>
          {aBlock && pinNumber !== undefined && (
            <div className="blockpanel">
              <h3>Block {pinNumber}: {titles[aBlock.programId] ?? aBlock.programId}</h3>
              <div className="row">
                {pinned && <button type="button" disabled={busy !== undefined || slot.locked} onClick={() => act('removing a pin', () => api.unpin(name, slot.start, pinNumber))}>Unpin ({pinned.title})</button>}
                <button type="button" disabled={slot.locked || busy !== undefined} onClick={() => setReplacing((r) => !r)} aria-expanded={replacing}>Replace with…</button>
              </div>
              {slot.locked && <p className="muted small">The slot is locked. Unlock it to change its programs.</p>}
              {replacing && !slot.locked && <ProgramPicker library={library.data} label="Pin it here" onPick={(p) => { setReplacing(false); void act('pinning a program', () => api.pin(name, slot.start, pinNumber, p)); }} />}
            </div>
          )}
        </div>
      )}

      <div className="editor" aria-label="Add a special slot">
        <div className="page-head"><h2>Add a special slot</h2><button type="button" onClick={() => setAdding((a) => !a)} aria-expanded={adding}>{adding ? 'Close' : 'Add…'}</button></div>
        {adding && (
          <>
            <div className="row">
              <label>From <input type="datetime-local" step={grid / 1000} aria-label="Slot start" value={form.start} onChange={(e) => setForm({ ...form, start: e.target.value })} /></label>
              <label>to <input type="datetime-local" step={grid / 1000} aria-label="Slot end" value={form.end} onChange={(e) => setForm({ ...form, end: e.target.value })} /></label>
            </div>
            <p className="muted small">The slots it overlaps are cut around it. Its content is the program you pin to it.</p>
            <ProgramPicker library={library.data} label="Add the slot with it" onPick={(p: Program) => {
              if (!form.start || !form.end) { setError('Give the start and the end of the new slot.'); return; }
              setAdding(false);
              void act('adding a slot', () => api.stageEdit(name, { kind: 'add', start: form.start, end: form.end, program: p }));
            }} />
          </>
        )}
      </div>

      {shown && days.includes(shown) && (
        <div className="row">
          <button type="button" disabled={busy !== undefined} onClick={() => act('resetting the day', () => api.resetStage(name, start, end))}>Reset this day to the plan</button>
          <span className="muted small">Drops the shapes and pins of the unlocked slots that start on {shown}; locked slots stay.</span>
        </div>
      )}

      {last && <ChangesPanel out={last.out} zone={zone} heading={last.heading} />}
    </section>
  );
}
