import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { api, type CalendarOut } from '../api';
import { CalGrid, type DaySelection } from '../components/CalGrid';
import { ProgramPicker, type Program } from '../components/ProgramPicker';
import { breakCounts, clockSec, dayBounds, entriesOf, hueOf, moveSlotPlan, programName, rowsOf, segsOfBlock, snapSecond, timelineOf, weekStartOf, withTitles, type Entry } from '../calview';
import { inZone as rawInZone, mmss, pct } from '../format';
import { channelLink, scheduleLink, stagingLink } from '../router';
import { addDays, localDate, timeOf as rawTimeOf } from '../staging';
import { useLoad } from '../useLoad';

/** A time of day to the minute, from the nearest whole second (see `snapSecond`). */
const timeOf = (zone: string, ms: number): string => rawTimeOf(zone, snapSecond(ms));
const inZone = (ms: number, zone: string): string => rawInZone(snapSecond(ms), zone);
const PLACE_WORD = { committed: 'Committed', staged: 'Staged', planned: 'Planned' } as const;
const EIGHT_WEEKS = 56 * 86_400_000;
const WEEK = 7;
const SPANS = [1, 3, 7] as const;

/**
 * What will air, date by date: committed (already in Tunarr), staged (stored here, waiting) and planned (stored nowhere).
 * Top: one to seven days as a time grid, with each slot's blocks inside it; a slot is dragged to move it, or by an edge to resize it. Below: one continuous list of what plays, that grows a week
 * at a time as it is scrolled; picking a slot or block anywhere brings the list to it. A staged or planned slot can be changed
 * from the bar between them; every change is a staging change, and nothing is written to Tunarr.
 */
export function Calendar({ name, date: wanted }: { name: string; date?: string }) {
  const channel = useLoad(() => api.channel(name), `ch:${name}`);
  const model = useLoad(() => api.scheduleModel(name), `m:${name}`);
  const library = useLoad(api.library, 'library');
  const zone = channel.data?.timezone;
  const grid = model.data?.model?.grid ?? 900_000;
  const [picked, setPicked] = useState<string>();
  const [selected, setSelected] = useState<DaySelection>();
  /** The weeks read so far, by their Sunday. */
  const [weeks, setWeeks] = useState<Record<string, CalendarOut>>({});
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);
  const [span, setSpan] = useState<(typeof SPANS)[number]>(1);
  const asked = useRef(new Set<string>());
  /** Set when a change failed and the page is read again, so the reading does not clear the message that says why. */
  const keepError = useRef(false);
  const side = useRef<HTMLElement>(null);
  const keepFrom = useRef<number | undefined>(undefined);
  const goTo = useRef<string | undefined>(undefined);

  const date = picked ?? wanted ?? (zone ? localDate(zone, Date.now()) : undefined);
  const first = date ? weekStartOf(date) : undefined;
  const lastDate = date ? addDays(date, span - 1) : undefined;

  // A different channel starts over.
  useEffect(() => { setWeeks({}); asked.current = new Set(); setSelected(undefined); setNotice(undefined); }, [name]);

  /** Reads one week (once). */
  const ensure = useCallback(async (sunday: string): Promise<void> => {
    if (!zone || asked.current.has(sunday)) return;
    asked.current.add(sunday);
    try {
      const out = await api.calendar(name, dayBounds(zone, sunday).start, dayBounds(zone, addDays(sunday, 6)).end);
      setWeeks((w) => ({ ...w, [sunday]: out }));
    } catch (e) {
      asked.current.delete(sunday);
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [name, zone]);

  useEffect(() => {
    if (!first || !lastDate) return;
    if (keepError.current) keepError.current = false; else setError(undefined);
    void ensure(first);
    const end = weekStartOf(lastDate);
    if (end !== first) void ensure(end);
  }, [first, lastDate, ensure, version]);

  // Everything read so far, as one list.
  const loaded = useMemo(() => {
    const keys = Object.keys(weeks).sort();
    const committed = new Map<number, CalendarOut['committed'][number]>();
    const slots = new Map<string, CalendarOut['slots'][number]>();
    const titles: Record<string, string> = {};
    const clips: Record<string, string> = {};
    const rerunnable = new Set<string>();
    for (const k of keys) {
      const w = weeks[k]!;
      for (const c of w.committed) committed.set(c.start, c);
      for (const x of w.slots) slots.set(`${x.source}:${x.slot.start}`, x);
      Object.assign(titles, w.titles);
      Object.assign(clips, w.clips);
      for (const id of w.rerunnable ?? []) rerunnable.add(id);
    }
    const any = keys.length ? weeks[keys[0]!]! : undefined;
    return { keys, entries: entriesOf([...committed.values()], [...slots.values()], titles), titles, clips, rerunnable, committedUntil: any?.committedUntil };
  }, [weeks]);

  const here = first ? weeks[first] : undefined;
  const lastKey = loaded.keys[loaded.keys.length - 1];
  const firstKey = loaded.keys[0];

  // Scrolling: more weeks below and above, and the place kept when weeks are added above.
  function onScroll(): void {
    const box = side.current;
    if (!box || !zone) return;
    if (box.scrollTop + box.clientHeight > box.scrollHeight - 900 && lastKey) {
      const next = addDays(lastKey, WEEK);
      if (loaded.committedUntil === undefined || dayBounds(zone, next).start < loaded.committedUntil + EIGHT_WEEKS) void ensure(next);
    }
    if (box.scrollTop < 300 && firstKey && !(weeks[firstKey]!.committed.length === 0 && weeks[firstKey]!.slots.length === 0)) {
      const before = addDays(firstKey, -WEEK);
      if (!asked.current.has(before)) { keepFrom.current = box.scrollHeight; void ensure(before); }
    }
  }
  useLayoutEffect(() => {
    const box = side.current;
    if (box && keepFrom.current !== undefined) { box.scrollTop += box.scrollHeight - keepFrom.current; keepFrom.current = undefined; }
  }, [loaded.keys.length]);

  /** Brings the list to a slot, or to one of its blocks. Rows above it that are drawn lazily change its position, so it settles with a second and third try. */
  function scrollTo(key: string, block?: number): void {
    const id = block === undefined ? `tl-${key}` : `tl-${key}-b${block}`;
    const go = (): void => {
      const box = side.current;
      // A block's rows are drawn only when the slot comes near, so until then the slot itself is the nearest place to go.
      const el = box?.querySelector<HTMLElement>(`[id="${id}"]`) ?? box?.querySelector<HTMLElement>(`[id="tl-${key}"]`);
      // Keep the day and slot headings that stick to the top clear of what is brought into view.
      if (box && el) box.scrollTo?.({ top: el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop - (el.id === id && block !== undefined ? 72 : 30), behavior: 'auto' });
    };
    go();
    setTimeout(go, 120);
    setTimeout(go, 500);
  }
  const pick = (key: string, block?: number): void => {
    const e = loaded.entries.find((x) => x.key === key);
    setSelected(block === undefined ? { key } : { key, block });
    // The day follows a pick made in the list, unless the slot is already (partly) on the day shown.
    if (e && zone && date) { const b = dayBounds(zone, date); const z = dayBounds(zone, addDays(date, span - 1)); if (e.end <= b.start || e.start >= z.end) setPicked(localDate(zone, e.start)); }
    setNotice(undefined);
    scrollTo(key, block);
  };

  // After a jump to another date, the list goes to the first slot of that day once it is read.
  useEffect(() => {
    if (!zone || !date || !here || goTo.current !== date) return;
    goTo.current = undefined;
    const lo = dayBounds(zone, date).start;
    const e = loaded.entries.find((x) => x.end > lo);
    if (e) scrollTo(e.key);
    else if (side.current) side.current.scrollTop = 0;
  });
  const jump = (to: string): void => { goTo.current = to; setPicked(to); };

  const entry = selected ? loaded.entries.find((x) => x.key === selected.key) : undefined;

  /** Runs one change. A planned slot is staged first (everything from the committed lineup to its end), then the change is made. */
  async function act(label: string, e: Entry, run: () => Promise<unknown>): Promise<void> {
    setBusy(true); setError(undefined); setNotice(undefined);
    try {
      if (e.place === 'planned') await api.stageGenerate(name, e.end);
      await run();
      setNotice(`Done: ${label}. It is staged, not committed.`);
      setWeeks({}); asked.current = new Set(); setSelected(undefined);
      setVersion((v) => v + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      // A change of several steps (a move is two) may have gone half way: read what the server holds, not what the page remembers.
      keepError.current = true;
      setWeeks({}); asked.current = new Set(); setSelected(undefined);
      setVersion((v) => v + 1);
    } finally {
      setBusy(false);
    }
  }

  if (channel.error) return <section><p><a href={channelLink(name)}>← {name}</a></p><p className="error" role="alert">{channel.error}</p></section>;
  const dayRange = zone && date ? dayBounds(zone, date) : undefined;

  const moveEdge = (e: Entry, edge: 'start' | 'end', to: number): void => {
    if (edge === 'end') { void act('changing when the slot ends', e, () => api.stageEdit(name, { kind: 'resize', start: e.start, end: to })); return; }
    const prev = loaded.entries.filter((x) => x.end === e.start)[0];
    if (!prev || !prev.editable) { setError('The slot before this one is already in Tunarr, so this one cannot start earlier or later.'); return; }
    void act('changing when the slot starts', e, () => api.stageEdit(name, { kind: 'resize', start: prev.start, end: to }));
  };

  /** Moves a whole slot: its neighbours give and take the time (see `moveSlotPlan`). Both edge changes are staged together. */
  const moveSlot = (e: Entry, to: number): void => {
    const plan = moveSlotPlan(loaded.entries, e, to, grid);
    if ('error' in plan) { setError(plan.error); return; }
    if (plan.steps.length === 0) return;
    const reach = { ...e, end: plan.reach, place: plan.planned ? ('planned' as const) : ('staged' as const) };
    void act('moving the slot', reach, async () => { for (const st of plan.steps) await api.stageEdit(name, { kind: 'resize', start: st.start, end: st.end }); });
  };

  return (
    <section className="calpage">
      <p><a href={channelLink(name)}>← {name}</a></p>
      <div className="page-head"><h1>Calendar</h1></div>
      <details className="calhelp">
        <summary className="muted small">What committed, staged and planned mean</summary>
        <p className="muted small">
          <strong>Committed</strong>: already in Tunarr. <strong>Staged</strong>: stored here, waiting to be committed (maybe edited by hand). <strong>Planned</strong>: stored nowhere; what happens if nothing changes.
          Changes made here are staged and written to Tunarr only when you commit. More in <a href={stagingLink(name, date)}>staging</a> and <a href={scheduleLink(name)}>the weekly pattern</a>.
        </p>
      </details>
      <div className="calnav">
        <button type="button" onClick={() => date && jump(addDays(date, -span))}>← {span === 1 ? 'Day' : `${span} days`} before</button>
        <label>Go to <input type="date" aria-label="Go to a date" value={date ?? ''} onChange={(e) => e.target.value && jump(e.target.value)} /></label>
        <button type="button" onClick={() => date && jump(addDays(date, span))}>{span === 1 ? 'Day' : `${span} days`} after →</button>
        {zone && <button type="button" onClick={() => jump(localDate(zone, Date.now()))}>Today</button>}
        <span className="group" role="group" aria-label="Days shown">
          {SPANS.map((n) => <button key={n} type="button" aria-pressed={span === n} onClick={() => setSpan(n)}>{n === 1 ? '1 day' : `${n} days`}</button>)}
        </span>
        <span className="muted small">{zone}</span>
      </div>
      {!here && !error && <p className="muted" role="status">Planning this week…</p>}
      {error && <p className="error" role="alert">{error}</p>}
      {notice && <p className="muted" role="status">{notice}</p>}
      {busy && <p className="muted" role="status">Working…</p>}
      {here && zone && <p className="muted small">Committed until {inZone(here.committedUntil, zone)}. Planning stops eight weeks after that.</p>}
      {zone && here && dayRange && (
        <CalGrid entries={loaded.entries} zone={zone} from={date!} days={span} titles={loaded.titles} clips={loaded.clips}
          selected={selected} onSelect={pick} grid={grid} onMove={moveSlot} onEdge={moveEdge} timeOf={timeOf} busy={busy} />
      )}
      <EditBar name={name} entry={entry} block={selected?.block} zone={zone} grid={grid} busy={busy} entries={loaded.entries} titles={loaded.titles}
        rerunnable={loaded.rerunnable} library={library.data} act={act} onMove={moveSlot} onError={setError} />
      <aside className="calside" aria-label="What plays" ref={side} onScroll={onScroll}>
        {zone && loaded.entries.length > 0
          ? <Timeline entries={loaded.entries} zone={zone} titles={loaded.titles} clips={loaded.clips} selected={selected} onSelect={pick} name={name} boxRef={side} />
          : <p className="muted card">{here ? 'Nothing is committed, staged or planned here.' : ''}</p>}
      </aside>
    </section>
  );
}

interface EditProps {
  name: string;
  entry: Entry | undefined;
  block: number | undefined;
  zone: string | undefined;
  grid: number;
  busy: boolean;
  entries: Entry[];
  titles: Record<string, string>;
  rerunnable: ReadonlySet<string>;
  library: import('../api').Library | undefined;
  act: (label: string, e: Entry, run: () => Promise<unknown>) => Promise<void>;
  onMove: (e: Entry, to: number) => void;
  onError: (m: string) => void;
}

/** What can be done to the picked slot or block. A slot that is already in Tunarr can only be looked at. */
function EditBar({ name, entry, block, zone, grid, busy, entries, titles, rerunnable, library, act, onMove, onError }: EditProps) {
  const [replacing, setReplacing] = useState(false);
  useEffect(() => { setReplacing(false); }, [entry?.key, block]);
  if (!entry || !zone) return <p className="muted small editbar-hint">Pick a slot or a block to see what can be changed.</p>;
  const b = block !== undefined ? entry.view.blocks[block] : undefined;
  const n = block !== undefined ? block + 1 : undefined;
  const head = `${entry.label}, ${timeOf(zone, entry.start)}–${timeOf(zone, entry.end)}`;
  if (!entry.editable) {
    return <div className="editbar" aria-label="The picked slot"><p><strong>{head}</strong> <span className={`badge place-${entry.place}`}>Committed</span> Already in Tunarr, so it cannot be changed here.</p></div>;
  }
  const off = busy || entry.locked;
  const prev = entries.find((x) => x.end === entry.start);
  const canMoveStart = !!prev && prev.editable && !prev.locked;
  const grow = (edge: 'start' | 'end', by: number): Promise<void> =>
    edge === 'end'
      ? act('changing when the slot ends', entry, () => api.stageEdit(name, { kind: 'resize', start: entry.start, end: entry.end + by }))
      : act('changing when the slot starts', entry, () => api.stageEdit(name, { kind: 'resize', start: prev!.start, end: entry.start + by }));
  const staged = entry.place === 'staged';
  const move = (by: number): void => onMove(entry, entry.start + by);
  return (
    <div className="editbar" aria-label="The picked slot">
      <p>
        <strong>{head}</strong> <span className={`badge place-${entry.place}`}>{PLACE_WORD[entry.place]}</span>
        {entry.marks.map((m) => <span key={m} className="badge hand">{m}</span>)}
        {entry.place === 'planned' && <span className="muted small"> Changing it stages everything up to its end first.</span>}
      </p>
      <div className="row">
        <span className="group" role="group" aria-label="Move">
          <button type="button" disabled={off} onClick={() => move(-grid)} title="The whole slot, a step earlier. The slot before it ends sooner and the one after it starts sooner.">Move earlier</button>
          <button type="button" disabled={off} onClick={() => move(grid)}>Move later</button>
        </span>
        <span className="group" role="group" aria-label="Start">
          <button type="button" disabled={off || !canMoveStart} onClick={() => void grow('start', -grid)} title={canMoveStart ? 'The slot before it ends earlier' : 'The slot before it cannot be changed'}>Start earlier</button>
          <button type="button" disabled={off || !canMoveStart} onClick={() => void grow('start', grid)}>Start later</button>
        </span>
        <span className="group" role="group" aria-label="End">
          <button type="button" disabled={off} onClick={() => void grow('end', -grid)}>End earlier</button>
          <button type="button" disabled={off} onClick={() => void grow('end', grid)}>End later</button>
        </span>
        <button type="button" disabled={busy} onClick={() => staged ? api.lockSlot(name, entry.start, !entry.locked).then(() => act(entry.locked ? 'unlocking the slot' : 'locking the slot', entry, async () => undefined), (e: unknown) => onError(e instanceof Error ? e.message : String(e))) : act('locking the slot', entry, () => api.lockSlot(name, entry.start, true))}>{entry.locked ? 'Unlock' : 'Lock'}</button>
        <button type="button" disabled={off} onClick={() => void act('deleting the slot', entry, () => api.stageEdit(name, { kind: 'delete', start: entry.start }))}>Delete slot</button>
        {staged && <button type="button" disabled={off} onClick={() => void act('putting the slot back to the plan', entry, () => api.resetStage(name, entry.start, entry.end))}>Back to the plan</button>}
      </div>
      {entry.locked && <p className="muted small">The slot is locked. Unlock it to change it.</p>}
      {b && n !== undefined && (
        <div className="blockpanel">
          <h3>Block {n}: {programName(titles, b.programId)}</h3>
          <div className="row">
            {b.pinned && <button type="button" disabled={off} onClick={() => void act('removing the pin', entry, () => api.unpin(name, entry.start, n))}>Unpin (back to what the plan chooses)</button>}
            {!b.pinned && rerunnable.has(b.programId) && entry.pool && (
              <button type="button" disabled={off} title="Plays the episode before this one. The show's next new episode is not used up, so the week after plays the one this block would have." onClick={() => void act('playing a rerun here', entry, () => api.rerun(name, { start: entry.start, block: n, pool: entry.pool!, programId: b.programId }))}>↺ Play a rerun instead</button>
            )}
            <button type="button" disabled={off} aria-expanded={replacing} onClick={() => setReplacing((r) => !r)}>Replace with…</button>
          </div>
          {replacing && <ProgramPicker library={library} label="Pin it here" onPick={(p: Program) => { setReplacing(false); void act('pinning a program', entry, () => api.pin(name, entry.start, n, p)); }} />}
        </div>
      )}
    </div>
  );
}

/** Everything read so far, one slot after another, as what plays: each slot, each block of it, and the titles and ads by name. */
function Timeline({ entries, zone, titles, clips, selected, onSelect, name, boxRef }: { entries: Entry[]; zone: string; titles: Record<string, string>; clips: Record<string, string>; selected: DaySelection | undefined; onSelect: (key: string, block?: number) => void; name: string; boxRef: RefObject<HTMLElement | null> }) {
  let lastDay = '';
  return (
    <div className="timeline">
      {entries.map((e) => {
        const day = localDate(zone, e.start);
        const heading = day !== lastDay;
        lastDay = day;
        const chosen = selected?.key === e.key;
        return (
          <section key={e.key} id={`tl-${e.key}`} style={{ ['--h' as string]: hueOf(e.label) }} className={`tlslot place-${e.place} ${chosen && selected?.block === undefined ? 'current' : ''}`} aria-label={`${PLACE_WORD[e.place]}: ${e.label}, ${timeOf(zone, e.start)}`}>
            {heading && <h4 className="tlday">{new Date(`${day}T12:00:00Z`).toLocaleDateString('en-CA', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' })}</h4>}
            <button type="button" className="tlhead" aria-current={chosen && selected?.block === undefined ? 'true' : undefined} onClick={() => onSelect(e.key)}>
              <span className={`badge place-${e.place}`}>{PLACE_WORD[e.place]}</span> <strong>{e.label}</strong> {timeOf(zone, e.start)}–{timeOf(zone, e.end)}
              {e.marks.map((m) => <span key={m} className="badge hand">{m}</span>)}
            </button>
            <Lazy root={boxRef} height={e.view.items.length * 27 + 60}><SlotRows entry={e} zone={zone} titles={titles} clips={clips} name={name} selectedBlock={chosen ? selected?.block : undefined} onSelect={onSelect} /></Lazy>
          </section>
        );
      })}
    </div>
  );
}

function SlotRows({ entry, zone, titles, clips, name, selectedBlock, onSelect }: { entry: Entry; zone: string; titles: Record<string, string>; clips: Record<string, string>; name: string; selectedBlock: number | undefined; onSelect: (key: string, block?: number) => void }) {
  const v = entry.view;
  const segs = timelineOf(v.items, titles, clips);
  const t = v.totals;
  const blocks = v.blocks.length > 0 ? v.blocks : [{ programId: v.programs[0] ?? '', start: entry.start, end: entry.end }];
  return (
    <>
      <p className="tltotals muted small">
        Program {mmss(t.programMs)} · ads {mmss(t.adMs)} ({pct(t.adShare)}) · bumpers {mmss(t.bumperMs)} · filler {mmss(t.interstitialMs)} · dead air {mmss(t.deadAirMs)}
        {' · '}<a href={stagingLink(name, localDate(zone, entry.start))}>{entry.place === 'planned' ? 'Plan in staging' : 'Staging'}</a>
      </p>
      {v.warnings.length > 0 && (
        <details className="tlwarn">
          <summary className={`small ${v.warnings.some((w) => w.severity === 'alert') ? 'alert' : ''}`}>{v.warnings.length} {v.warnings.length === 1 ? 'note' : 'notes'}{v.warnings.some((w) => w.severity === 'alert') ? ', with an alert' : ''}</summary>
          {v.warnings.map((w, i) => <p key={i} className="warn-note small">{w.severity === 'alert' ? 'Alert' : 'Note'}: {withTitles(w.message, titles)}</p>)}
        </details>
      )}
      <table className="tltable">
        <thead className="sr-only"><tr><th scope="col">Starts</th><th scope="col">What plays</th><th scope="col">Length</th></tr></thead>
        {blocks.map((b, bi) => {
          const rows = rowsOf(segsOfBlock(segs, entry.start, b));
          return (
            <tbody key={bi} id={`tl-${entry.key}-b${bi}`} className={`tlblock ${selectedBlock === bi ? 'current' : ''}`}>
              <tr className="tlblockhead">
                <td className="tltime">{clockSec(zone, b.start)}</td>
                <td className="tlwhat"><button type="button" className="tlbtn" aria-current={selectedBlock === bi ? 'true' : undefined} onClick={() => onSelect(entry.key, bi)}><strong>{programName(titles, b.programId)}</strong>{(b as { pinned?: boolean }).pinned ? <span className="badge hand">pinned</span> : null}</button></td>
                <td className="tllen">{mmss(b.end - b.start)}</td>
              </tr>
              {rows.map((r, i) => r.kind === 'piece' ? (
                <tr key={i} className={`tlrow ${r.seg.cls}`}>
                  <td className="tltime">{clockSec(zone, b.start + r.seg.at)}</td>
                  <td className="tlwhat">{r.seg.what}{r.seg.cls === 'dead-air' ? null : <span className="tlkind"> · program</span>}</td>
                  <td className="tllen">{mmss(r.seg.ms)}</td>
                </tr>
              ) : (
                <BreakRows key={i} brk={r} zone={zone} start={b.start} />
              ))}
            </tbody>
          );
        })}
      </table>
      {v.plan.length > 0 && (
        <div className="compare">
          <h5>Compared with the plan</h5>
          <div className="cmp">
            <div><p className="muted small">Planned</p><ul>{v.plan.map((p) => <li key={p.start}><strong>{p.pool}</strong> {mmss(p.end - p.start)} · {p.programs.map((x) => programName(titles, x)).slice(0, 3).join(', ')} · ads {pct(p.totals.adShare)}, dead air {mmss(p.totals.deadAirMs)}</li>)}</ul></div>
            <div><p className="muted small">Now</p><ul><li><strong>{entry.label}</strong> {mmss(entry.end - entry.start)} · {v.programs.map((x) => programName(titles, x)).slice(0, 3).join(', ')} · ads {pct(t.adShare)}, dead air {mmss(t.deadAirMs)}</li></ul></div>
          </div>
        </div>
      )}
    </>
  );
}

/** Draws its children once it comes within reach of the scrolled box; until then a blank of about the right height holds its place. */
function Lazy({ root, height, children }: { root: RefObject<HTMLElement | null>; height: number; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    const el = ref.current;
    if (shown || !el) return;
    const io = new IntersectionObserver((hits) => { if (hits.some((h) => h.isIntersecting)) { setShown(true); io.disconnect(); } }, { root: root.current, rootMargin: '800px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [shown, root]);
  return shown ? <>{children}</> : <div ref={ref} style={{ height }} aria-hidden="true" />;
}

/** A break as one line (what is in it and how long), opened to see each clip. */
function BreakRows({ brk, zone, start }: { brk: Extract<ReturnType<typeof rowsOf>[number], { kind: 'break' }>; zone: string; start: number }) {
  const [open, setOpen] = useState(false);
  const names = brk.segs.map((s) => s.what).join(', ');
  return (
    <>
      <tr className="tlrow tlbreak">
        <td className="tltime">{clockSec(zone, start + brk.at)}</td>
        <td className="tlwhat">
          <button type="button" className="tlbtn" aria-expanded={open} onClick={() => setOpen(!open)}>
            <span aria-hidden="true">{open ? '▾' : '▸'}</span> {brk.group} break · {breakCounts(brk.segs)}
          </button>
          {!open && <span className="tlnames muted" title={names}>{names}</span>}
        </td>
        <td className="tllen">{mmss(brk.ms)}</td>
      </tr>
      {open && brk.segs.map((s, i) => (
        <tr key={i} className={`tlrow tlclip ${s.cls}`}>
          <td className="tltime">{clockSec(zone, start + s.at)}</td>
          <td className="tlwhat">{s.what}<span className="tlkind"> · {s.cls === 'ad' ? 'ad' : s.cls === 'bumper' ? 'bumper' : 'filler'}{s.list ? `, ${s.list}` : ''}</span></td>
          <td className="tllen">{mmss(s.ms)}</td>
        </tr>
      ))}
    </>
  );
}
