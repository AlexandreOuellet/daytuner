import { useRef } from 'react';
import type { SlotModel } from '../api';
import { clock } from '../format';
import { DAY, DAY_NAMES, HOUR, daySegments, keyOf, slotLength, snap, startRange } from '../week';

export const HOUR_PX = 30;

interface Props {
  week: SlotModel[];
  grid: number;
  /** The pool names, in a fixed order, so each keeps its colour. */
  pools: string[];
  selected: string | undefined;
  onSelect: (key: string) => void;
  /** A slot's start moved (by dragging or by the arrow keys). `key` is the slot's key before the move. */
  onMove: (key: string, at: number) => void;
  /** Something worth knowing about a slot, by key (too long, nothing fits). */
  notes: Record<string, string>;
}

const hue = (pools: string[], pool: string): number => (Math.max(0, pools.indexOf(pool)) * 57 + 210) % 360;
const hm = (ms: number): string => clock(Math.floor(ms / 60_000));

/** The week: a column per day, a block per slot from its start to the next slot's start, drawn to scale. */
export function WeekGrid({ week, grid, pools, selected, onSelect, onMove, notes }: Props) {
  const dragging = useRef<string | undefined>(undefined);

  function startDrag(e: React.PointerEvent<HTMLElement>, key: string): void {
    e.preventDefault();
    e.stopPropagation();
    const col = e.currentTarget.closest('.daycol') as HTMLElement;
    const rect = col.getBoundingClientRect();
    dragging.current = key;
    onSelect(key);
    const move = (ev: PointerEvent): void => {
      const cur = week.find((s) => keyOf(s) === dragging.current);
      if (!cur) return;
      const range = startRange(week, cur, grid);
      const raw = ((ev.clientY - rect.top) / rect.height) * DAY;
      const at = Math.min(range.max, Math.max(range.min, snap(raw, grid)));
      if (at !== cur.at) {
        onMove(keyOf(cur), at);
        dragging.current = keyOf({ day: cur.day, at });
      }
    };
    const up = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      dragging.current = undefined;
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  function arrows(e: React.KeyboardEvent, s: SlotModel): void {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    const range = startRange(week, s, grid);
    const at = Math.min(range.max, Math.max(range.min, s.at + (e.key === 'ArrowUp' ? -grid : grid)));
    if (at !== s.at) onMove(keyOf(s), at);
  }

  return (
    <div className="weekgrid" role="group" aria-label="The week">
      <div className="axis" aria-hidden="true">
        <div className="dayhead">&nbsp;</div>
        <div className="axis-body" style={{ height: 24 * HOUR_PX }}>
          {Array.from({ length: 8 }, (_, i) => <span key={i} style={{ top: i * 3 * HOUR_PX }}>{String(i * 3).padStart(2, '0')}:00</span>)}
        </div>
      </div>
      {DAY_NAMES.map((name, day) => (
        <div className="day" key={name}>
          <div className="dayhead">{name}</div>
          <div className="daycol" style={{ height: 24 * HOUR_PX }}>
            {Array.from({ length: 7 }, (_, i) => <div key={i} className="hline" style={{ top: (i + 1) * 3 * HOUR_PX }} />)}
            {daySegments(week, day).map((seg) => {
              const key = keyOf(seg.slot);
              const length = slotLength(week, seg.slot);
              const note = notes[key];
              const label = `${DAY_NAMES[seg.slot.day]} ${hm(seg.slot.at)}, ${seg.slot.pool}${seg.slot.link ? `, ${seg.slot.linkMode === 'rerun' ? 'rerun of' : 'continues'} ${seg.slot.link}` : ''}, lasts ${(length / HOUR).toFixed(2).replace(/\.?0+$/, '')} h${note ? `. ${note}` : ''}`;
              return (
                <div key={`${key}:${seg.carry ? 'carry' : 'own'}`} className={`slotblock ${selected === key ? 'picked' : ''} ${seg.carry ? 'carry' : ''}`} style={{ top: (seg.from / HOUR) * HOUR_PX, height: Math.max(8, ((seg.to - seg.from) / HOUR) * HOUR_PX), ['--h' as string]: hue(pools, seg.slot.pool) }}>
                  <button type="button" className="slotbtn" aria-pressed={selected === key} aria-label={seg.carry ? `Continues: ${label}` : label} onClick={() => onSelect(key)} onKeyDown={(e) => arrows(e, seg.slot)}>
                    <strong>{seg.carry ? `↳ ${seg.slot.pool}` : seg.slot.pool}</strong>
                    <span className="when">{seg.carry ? `from ${DAY_NAMES[seg.slot.day]} ${hm(seg.slot.at)}` : hm(seg.slot.at)}{seg.continues ? ' →' : ''}</span>
                    {seg.slot.link && !seg.carry && <span className="chip">{seg.slot.linkMode === 'rerun' ? '↺' : '⇄'} {seg.slot.link}</span>}
                    {note && !seg.carry && <span className="note" aria-hidden="true">!</span>}
                  </button>
                  {!seg.carry && <span className="handle" role="presentation" title="Drag to change when this slot starts" onPointerDown={(e) => startDrag(e, key)} />}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
