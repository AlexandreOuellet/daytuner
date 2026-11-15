import { useMemo } from 'react';
import FullCalendar from '@fullcalendar/react';
import timeGridPlugin from '@fullcalendar/timegrid';
import interactionPlugin from '@fullcalendar/interaction';
import type { EventClickArg, EventDropArg, EventInput, EventMountArg } from '@fullcalendar/core';
import type { EventReceiveArg, EventResizeDoneArg } from '@fullcalendar/interaction';
import type { SlotModel } from '../api';
import { clock } from '../format';
import { DAY, DAY_NAMES, HOUR, WEEK, absolute, gapSegments, keyOf } from '../week';

export const HOUR_PX = 30;

/** The week is shown as these seven dates (a Sunday to a Saturday); only the weekday and time of day mean anything. */
const REF = Date.UTC(2023, 0, 1);
const iso = (abs: number): string => new Date(REF + abs).toISOString();
const absOf = (d: Date): number => d.getTime() - REF;
const split = (abs: number): { day: number; at: number } => ({ day: Math.floor(abs / DAY), at: abs % DAY });

interface Props {
  week: SlotModel[];
  grid: number;
  /** The pool names, in a fixed order, so each keeps its colour. */
  pools: string[];
  /** The pool that plays where no slot does, named in the gaps. */
  fill: string | undefined;
  selected: string | undefined;
  onSelect: (key: string) => void;
  /** A slot was dragged to a new start. `key` is the slot's key before the move. */
  onMove: (key: string, day: number, at: number) => void;
  /** A slot's length changed by dragging its bottom edge. */
  onResize: (key: string, length: number) => void;
  /** An empty spot was clicked while a template is picked up. */
  onPlace?: (day: number, at: number) => void;
  /** A template card was dropped on the week. */
  onDropTemplate?: (name: string, day: number, at: number) => void;
  /** True while a template is picked up, so the week says where it would go. */
  armed?: boolean;
  /** Something worth knowing about a slot, by key (too long, nothing fits). */
  notes: Record<string, string>;
}

const hue = (pools: string[], pool: string): number => (Math.max(0, pools.indexOf(pool)) * 57 + 210) % 360;
const hm = (ms: number): string => clock(Math.floor(ms / 60_000));
const hours = (ms: number): string => (ms / HOUR).toFixed(2).replace(/\.?0+$/, '');
const durationText = (ms: number): string => { const m = Math.round(ms / 60_000); return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:00`; };

/** The calendar's events for a week: a slot each (and a second, fixed piece for one that runs past Saturday into Sunday), and the gaps. */
export function eventsOf(week: readonly SlotModel[], fill: string | undefined, pools: string[], selected: string | undefined, notes: Record<string, string>): EventInput[] {
  const out: EventInput[] = [];
  for (const s of week) {
    const key = keyOf(s);
    const a = absolute(s);
    const base = {
      title: s.pool,
      backgroundColor: `hsl(${hue(pools, s.pool)} 65% 50% / .28)`,
      borderColor: `hsl(${hue(pools, s.pool)} 60% 45%)`,
      classNames: selected === key ? ['slotev', 'picked'] : ['slotev'],
    };
    const label = `${DAY_NAMES[s.day]} ${hm(s.at)}, ${s.pool}${s.link ? `, ${s.linkMode === 'rerun' ? 'rerun of' : 'continues'} ${s.link}` : ''}, lasts ${hours(s.length)} h${notes[key] ? `. ${notes[key]}` : ''}`;
    // The id carries what the page shows of the slot, so a change to it draws the slot again (its label is set when it is drawn).
    const sig = `${key}:${s.length}:${s.pool}:${s.link ?? ''}:${s.linkMode ?? ''}:${selected === key}:${notes[key] ?? ''}`;
    out.push({ ...base, id: sig, start: iso(a), end: iso(a + s.length), extendedProps: { kind: 'slot', key, slot: s, label, note: notes[key] } });
    if (a + s.length > WEEK) {
      out.push({ ...base, id: `${sig}:carry`, start: iso(a - WEEK), end: iso(a + s.length - WEEK), editable: false, classNames: ['slotev', 'carry'], extendedProps: { kind: 'carry', key, slot: s, label: `Continues: ${label}` } });
    }
  }
  for (let day = 0; day < 7; day++) {
    for (const g of gapSegments(week, day)) {
      out.push({
        id: `gap:${day}:${g.from}`, overlap: true, start: iso(day * DAY + g.from), end: iso(day * DAY + g.to), display: 'background', classNames: ['gapev'],
        backgroundColor: fill ? `hsl(${hue(pools, fill)} 40% 50% / .14)` : 'rgba(128,128,128,.12)',
        extendedProps: { kind: 'gap', label: `${DAY_NAMES[day]} ${hm(g.from)} to ${g.to >= DAY ? '24:00' : hm(g.to)}: ${fill ? `plays ${fill}` : 'no slot, and no fill pool chosen'}` },
      });
    }
  }
  return out;
}

/** The week as a calendar (FullCalendar): slots are events that move, resize, and cannot overlap; template cards can be dropped on it. */
export function WeekGrid({ week, grid, pools, fill, selected, onSelect, onMove, onResize, onPlace, onDropTemplate, armed, notes }: Props) {
  const events = useMemo(() => eventsOf(week, fill, pools, selected, notes), [week, fill, pools, selected, notes]);

  const mounted = (arg: EventMountArg): void => {
    const kind = (arg.event.extendedProps['kind'] as string | undefined) ?? 'template';
    if (kind === 'template') return;
    // A slot over midnight is drawn in two pieces; the second says so, so the two are told apart.
    arg.el.setAttribute('aria-label', `${kind === 'slot' && !arg.isStart ? 'Continues: ' : ''}${String(arg.event.extendedProps['label'])}`);
    arg.el.setAttribute('role', kind === 'gap' ? 'img' : 'button');
    if (kind === 'slot') arg.el.setAttribute('aria-pressed', String(arg.event.extendedProps['key'] === selected));
  };
  const slotOf = (e: { extendedProps: Record<string, unknown> }): string => e.extendedProps['key'] as string;

  return (
    <div className={`weekgrid ${armed ? 'armed' : ''}`} role="group" aria-label="The week">
      <FullCalendar
        plugins={[timeGridPlugin, interactionPlugin]}
        initialView="timeGridWeek"
        initialDate={iso(0)}
        validRange={{ start: iso(0), end: iso(WEEK) }}
        timeZone="UTC"
        firstDay={0}
        headerToolbar={false}
        allDaySlot={false}
        dayHeaderFormat={{ weekday: 'short' }}
        slotMinTime="00:00:00"
        slotMaxTime="24:00:00"
        slotDuration="01:00:00"
        snapDuration={durationText(grid)}
        slotLabelFormat={{ hour: '2-digit', minute: '2-digit', hour12: false }}
        height="auto"
        contentHeight={24 * HOUR_PX + 4}
        expandRows={false}
        nowIndicator={false}
        editable
        droppable
        eventOverlap={(still) => still.extendedProps['kind'] === 'gap'}
        slotEventOverlap={false}
        eventInteractive
        events={events}
        eventContent={(arg) => {
          const k = arg.event.extendedProps['kind'] as string;
          if (k === 'gap') return { html: `<span class="gaplabel">${fill ? `fill: ${fill}` : 'empty'}</span>` };
          const s = arg.event.extendedProps['slot'] as SlotModel | undefined;
          if (!s) return <div className="evbody"><strong>{arg.event.title}</strong></div>; // a template card being dragged in
          return (
            <div className="evbody">
              <strong>{k === 'carry' ? `↳ ${s.pool}` : s.pool}</strong>
              <span className="when">{k === 'carry' ? `from ${DAY_NAMES[s.day]} ${hm(s.at)}` : `${hm(s.at)}, ${hours(s.length)} h`}</span>
              {s.link && k === 'slot' && <span className="chip">{s.linkMode === 'rerun' ? '↺' : '⇄'} {s.link}</span>}
              {arg.event.extendedProps['note'] ? <span className="note" aria-hidden="true">!</span> : null}
            </div>
          );
        }}
        eventDidMount={mounted}
        eventClick={(arg: EventClickArg) => { arg.jsEvent.preventDefault(); if (arg.event.extendedProps['kind'] !== 'gap') onSelect(slotOf(arg.event)); }}
        eventDrop={(arg: EventDropArg) => {
          const start = arg.event.start;
          if (!start) return arg.revert();
          const to = split(absOf(start));
          arg.revert(); // the page redraws from its own state, which is the one source of truth
          onMove(slotOf(arg.event), to.day, to.at);
        }}
        eventResize={(arg: EventResizeDoneArg) => {
          const { start, end } = arg.event;
          if (!start || !end) return arg.revert();
          const length = absOf(end) - absOf(start);
          arg.revert();
          onResize(slotOf(arg.event), length);
        }}
        eventReceive={(arg: EventReceiveArg) => {
          const start = arg.event.start;
          const name = arg.event.extendedProps['template'] as string | undefined;
          arg.event.remove();
          if (start && name && onDropTemplate) { const at = split(absOf(start)); onDropTemplate(name, at.day, at.at); }
        }}
        dateClick={(arg) => { if (armed && onPlace) { const at = split(absOf(arg.date)); onPlace(at.day, at.at); } }}
      />
    </div>
  );
}

/** Makes the template cards inside `el` draggable onto the week; each card carries its name and length. */
export { Draggable } from '@fullcalendar/interaction';
export const templateEventData = (el: HTMLElement): { title: string; duration: number; create: boolean; extendedProps: { template: string } } => ({
  title: el.dataset['name'] ?? '', duration: Number(el.dataset['length'] ?? HOUR * 2), create: true, extendedProps: { template: el.dataset['name'] ?? '' },
});
