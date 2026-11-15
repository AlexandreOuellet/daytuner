import { useMemo, type ReactNode } from 'react';
import FullCalendar from '@fullcalendar/react';
import timeGridPlugin from '@fullcalendar/timegrid';
import interactionPlugin from '@fullcalendar/interaction';
import type { EventClickArg, EventDropArg, EventInput } from '@fullcalendar/core';
import type { EventResizeDoneArg } from '@fullcalendar/interaction';
import { NOTICED_DEAD_AIR_MS, hueOf, programName, segsOfBlock, timelineOf, type Entry } from '../calview';
import { addDays, dayStart, localDate, msOf, wallOf } from '../staging';

export interface DaySelection { key: string; block?: number }

const PLACE_WORD = { committed: 'Committed', staged: 'Staged', planned: 'Planned' } as const;
const wallIso = (zone: string, ms: number): string => new Date(wallOf(zone, ms)).toISOString();
const absOf = (zone: string, d: Date, near: number): number => msOf(zone, d.getTime(), near);

interface Props {
  entries: Entry[];
  zone: string;
  /** The first date shown, "2026-12-02", and how many days from it. */
  from: string;
  days: number;
  titles: Record<string, string>;
  clips: Record<string, string>;
  selected: DaySelection | undefined;
  onSelect: (key: string, block?: number) => void;
  grid: number;
  /** A whole slot was dragged to start at `to` (already on the grid). */
  onMove: (entry: Entry, to: number) => void;
  /** One edge of a slot was dragged to `to`. */
  onEdge: (entry: Entry, edge: 'start' | 'end', to: number) => void;
  timeOf: (zone: string, ms: number) => string;
  busy: boolean;
}

const durationText = (ms: number): string => { const m = Math.round(ms / 60_000); return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:00`; };

/**
 * The calendar's days as a time grid (the same FullCalendar grid as the week on the schedule page), vertical, one to seven days of
 * real dates. Each slot is an event with its blocks inside it, and each block shows how it is divided (program, ads, bumpers, filler,
 * dead air). The grid draws and reports what was dragged; the page decides what that means (it stages a change). The channel's own
 * hours are drawn by giving the grid each instant as its wall clock in the channel's time zone.
 */
export function CalGrid({ entries, zone, from, days, titles, clips, selected, onSelect, grid, onMove, onEdge, timeOf, busy }: Props) {
  const lo = dayStart(zone, from);
  const hi = dayStart(zone, addDays(from, days));
  const shown = useMemo(() => entries.filter((e) => e.end > lo && e.start < hi), [entries, lo, hi]);

  const events = useMemo<EventInput[]>(() => shown.map((e) => {
    const chosen = selected?.key === e.key;
    const canEdit = e.editable && !e.locked && !busy;
    const sig = `${e.key}:${e.start}:${e.end}:${e.locked}:${e.marks.join(',')}:${chosen ? selected?.block ?? 'slot' : ''}:${e.view.blocks.length}:${canEdit}`;
    return {
      id: sig, start: wallIso(zone, e.start), end: wallIso(zone, e.end), title: e.label, editable: canEdit,
      classNames: ['calev', `place-${e.place}`, ...(chosen ? ['picked'] : [])],
      extendedProps: { key: e.key },
    };
  }), [shown, selected, busy, zone]);

  const byKey = useMemo(() => new Map(entries.map((e) => [e.key, e])), [entries]);
  const first = shown[0];
  const scrollTime = first ? new Date(Math.max(wallOf(zone, first.start), wallOf(zone, lo)) - 30 * 60_000).toISOString().slice(11, 19) : '08:00:00';

  const content = (key: string, isStart: boolean): ReactNode => {
    const e = byKey.get(key);
    if (!e) return null;
    const chosen = selected?.key === e.key;
    const label = `${PLACE_WORD[e.place]}: ${e.label}, ${timeOf(zone, e.start)} to ${timeOf(zone, e.end)}${e.marks.length ? `, ${e.marks.join(', ')}` : ''}`;
    if (!isStart) return <section className={`cslot cont place-${e.place}`} aria-label={`Continues: ${label}`}><div className="chead"><span>↳ {e.label}</span></div></section>;
    // A slot over midnight is drawn on each day; the blocks are drawn on the day the slot begins, up to its end.
    const cut = dayStart(zone, addDays(localDate(zone, e.start), 1));
    const segs = timelineOf(e.view.items, titles, clips);
    return (
      <section className={`cslot place-${e.place} ${e.locked ? 'locked' : ''}`} aria-label={label} style={{ ['--h' as string]: hueOf(e.label) }}>
        <div className="chead">
          <strong>{e.label}</strong>
          <span className={`badge place-${e.place}`}>{PLACE_WORD[e.place]}</span>
          {e.marks.map((m) => <span key={m} className="badge hand">{m}</span>)}
          <span className="small muted">{timeOf(zone, e.start)}–{timeOf(zone, e.end)}</span>
        </div>
        <div className="cblocks">
          {e.view.blocks.map((b, i) => {
            if (b.start >= cut) return null;
            const len = Math.max(1, Math.min(b.end, cut) - b.start);
            const bseg = segsOfBlock(segs, e.start, b);
            const blen = b.end - b.start;
            const dead = bseg.filter((s) => s.cls === 'dead-air').reduce((a, s) => a + s.ms, 0);
            const name = programName(titles, b.programId);
            const here = chosen && selected?.block === i;
            return (
              <button key={i} type="button" className={`cblk ${dead >= NOTICED_DEAD_AIR_MS ? 'hasdead' : ''} ${b.pinned ? 'pinned' : ''}`} aria-pressed={here}
                style={{ flex: `${len} 1 0` }} title={`${name}, ${timeOf(zone, b.start)}${b.pinned ? ', pinned' : ''}`} aria-label={`${name}, ${timeOf(zone, b.start)}${b.pinned ? ', pinned' : ''}`}
                onClick={(ev) => { ev.stopPropagation(); onSelect(e.key, i); }}>
                <span className="cname">{b.pinned ? '📌 ' : ''}{name}</span>
                <span className="cbar" aria-hidden="true">{bseg.map((s, j) => <i key={j} className={`seg ${s.cls}`} style={{ width: `${(s.ms / blen) * 100}%` }} />)}</span>
                <span className="ctime small">{timeOf(zone, b.start)}</span>
              </button>
            );
          })}
        </div>
      </section>
    );
  };

  return (
    <div className="calday-wrap">
      <div className="calgrid" role="group" aria-label={days === 1 ? 'The day' : 'The days'}>
        <FullCalendar
          plugins={[timeGridPlugin, interactionPlugin]}
          initialView="timeGrid"
          initialDate={`${from}T00:00:00Z`}
          visibleRange={{ start: `${from}T00:00:00Z`, end: `${addDays(from, days)}T00:00:00Z` }}
          timeZone="UTC"
          headerToolbar={false}
          allDaySlot={false}
          dayHeaderFormat={{ weekday: 'short', month: 'short', day: 'numeric' }}
          slotMinTime="00:00:00"
          slotMaxTime="24:00:00"
          slotDuration="01:00:00"
          snapDuration={durationText(grid)}
          scrollTime={scrollTime}
          slotLabelFormat={{ hour: '2-digit', minute: '2-digit', hour12: false }}
          height={460}
          expandRows={false}
          nowIndicator={false}
          editable
          eventResizableFromStart
          eventOverlap={false}
          slotEventOverlap={false}
          eventInteractive
          events={events}
          eventContent={(arg) => content(arg.event.extendedProps['key'] as string, arg.isStart)}
          eventClick={(arg: EventClickArg) => {
            arg.jsEvent.preventDefault();
            if ((arg.jsEvent.target as HTMLElement | null)?.closest?.('.cblk')) return; // a block picks itself
            onSelect(arg.event.extendedProps['key'] as string);
          }}
          eventDrop={(arg: EventDropArg) => {
            const e = byKey.get(arg.event.extendedProps['key'] as string);
            const start = arg.event.start;
            arg.revert(); // the page redraws from its own state, which is the one source of truth
            if (e && start) onMove(e, absOf(zone, start, e.start));
          }}
          eventResize={(arg: EventResizeDoneArg) => {
            const e = byKey.get(arg.event.extendedProps['key'] as string);
            const { start, end } = arg.event;
            arg.revert();
            if (!e || !start || !end) return;
            // An edge that was not touched is told by its place on the grid, not by converting it back (on the day the clocks go back
            // that place is two instants, and the wrong one would read as a change).
            if (end.getTime() !== wallOf(zone, e.end)) onEdge(e, 'end', absOf(zone, end, e.end));
            else if (start.getTime() !== wallOf(zone, e.start)) onEdge(e, 'start', absOf(zone, start, e.start));
          }}
        />
      </div>
      <ul className="legend small" aria-label="What the colours mean">
        <li><span className="seg content" aria-hidden="true" />Program</li>
        <li><span className="seg ad" aria-hidden="true" />Ads</li>
        <li><span className="seg bumper" aria-hidden="true" />Bumpers</li>
        <li><span className="seg interstitial" aria-hidden="true" />Filler</li>
        <li><span className="seg dead-air" aria-hidden="true" />Dead air</li>
      </ul>
    </div>
  );
}
