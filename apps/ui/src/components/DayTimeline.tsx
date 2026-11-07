import { useRef } from 'react';
import type { StagedSlot } from '../api';
import { clock } from '../format';
import { DaySeg, daySegs, HOUR, timeOf } from '../staging';

export const PX = 34;

interface Props {
  slots: StagedSlot[];
  zone: string;
  dayStart: number;
  dayEnd: number;
  grid: number;
  titles: Record<string, string>;
  selected: number | undefined;
  selectedBlock: number | undefined;
  /** Slot starts that have a conflict or a pin problem. */
  problems: Record<number, string>;
  onSelect: (start: number, block?: number) => void;
  onLock: (start: number, locked: boolean) => void;
  /** The bottom edge was dragged to `end` (snapped to the grid). */
  onResize: (start: number, end: number) => void;
  busy: boolean;
}

const hm = (ms: number): string => clock(Math.floor(ms / 60_000));

/** One day, drawn to scale: a box per staged slot with its programs inside, a padlock, and a handle on the bottom edge. */
export function DayTimeline({ slots, zone, dayStart, dayEnd, grid, titles, selected, selectedBlock, problems, onSelect, onLock, onResize, busy }: Props) {
  const col = useRef<HTMLDivElement>(null);
  const segs = daySegs(slots, dayStart, dayEnd);
  // Start the picture a little before the first slot of the day, on a three-hour line, so an evening day is not mostly empty.
  const first = segs.length ? Math.min(...segs.map((x) => x.from)) : 0;
  const skip = Math.max(0, Math.floor(first / (3 * HOUR)) * 3);
  const origin = dayStart + skip * HOUR;
  const hours = Math.round((dayEnd - dayStart) / HOUR) - skip;

  function startDrag(e: React.PointerEvent<HTMLElement>, seg: DaySeg): void {
    e.preventDefault();
    e.stopPropagation();
    if (busy || seg.slot.locked) return;
    const rect = col.current!.getBoundingClientRect();
    let end = seg.slot.end;
    const move = (ev: PointerEvent): void => {
      const raw = origin + ((ev.clientY - rect.top) / rect.height) * (dayEnd - origin);
      end = Math.max(seg.slot.start + grid, Math.round(raw / grid) * grid);
    };
    const up = (): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (end !== seg.slot.end) onResize(seg.slot.start, end);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  return (
    <div className="daytl" role="group" aria-label="The day">
      <div className="axis-body" style={{ height: hours * PX }} aria-hidden="true">
        {Array.from({ length: Math.floor(hours / 3) + 1 }, (_, i) => <span key={i} style={{ top: i * 3 * PX }}>{String(skip + i * 3).padStart(2, '0')}:00</span>)}
      </div>
      <div className="daycol wide" ref={col} style={{ height: hours * PX }}>
        {Array.from({ length: Math.floor(hours / 3) }, (_, i) => <div key={i} className="hline" style={{ top: (i + 1) * 3 * PX }} />)}
        {segs.map((seg) => {
          const s = seg.slot;
          const top = ((seg.from - skip * HOUR) / HOUR) * PX;
          const height = Math.max(10, ((seg.to - seg.from) / HOUR) * PX);
          const problem = problems[s.start];
          const what = `${timeOf(zone, s.start)} to ${timeOf(zone, s.end)}, ${s.slotId?.startsWith('added@') ? 'added slot' : s.pool}${s.locked ? ', locked' : ''}${s.edited ? ', shaped' : ''}`;
          return (
            <div key={`${s.start}:${seg.carry}`} className={`stslot ${selected === s.start ? 'picked' : ''} ${s.locked ? 'locked' : ''} ${seg.carry ? 'carry' : ''} ${problem ? 'problem' : ''}`} style={{ top, height }}>
              <button type="button" className="stslot-head" aria-pressed={selected === s.start} aria-label={`${seg.carry ? 'Continues: ' : ''}${what}${problem ? `. ${problem}` : ''}`} onClick={() => onSelect(s.start)}>
                <strong>{s.slotId?.startsWith('added@') ? 'added' : s.pool}</strong> {timeOf(zone, s.start)}–{timeOf(zone, s.end)}{s.edited ? ' · shaped' : ''}{problem ? ' · !' : ''}
              </button>
              {!seg.carry && (
                <button type="button" className="padlock" aria-pressed={s.locked} aria-label={s.locked ? `Unlock the slot at ${hm(s.start - dayStart)}` : `Lock the slot at ${hm(s.start - dayStart)}`} disabled={busy} onClick={() => onLock(s.start, !s.locked)}>
                  {s.locked ? '🔒' : '🔓'}
                </button>
              )}
              <div className="blocks">
                {s.blocks.map((b, i) => {
                  const bh = Math.max(0, Math.min(b.end, dayStart + seg.to) - Math.max(b.start, dayStart + seg.from));
                  if (bh <= 0) return null;
                  const key = `${s.start}:${i}`;
                  return (
                    <button key={key} type="button" className={`blk ${b.pinned ? 'pinned' : ''} ${selected === s.start && selectedBlock === i ? 'picked' : ''}`}
                      style={{ top: (Math.max(b.start, dayStart + seg.from) - (dayStart + seg.from)) / HOUR * PX, height: Math.max(8, (bh / HOUR) * PX - 2) }}
                      aria-pressed={selected === s.start && selectedBlock === i} aria-label={`Block ${i + 1}: ${titles[b.programId] ?? b.programId}${b.pinned ? ', pinned' : ''}`} onClick={() => onSelect(s.start, i)}>
                      {b.pinned && <span aria-hidden="true">📌 </span>}{titles[b.programId] ?? b.programId}
                    </button>
                  );
                })}
              </div>
              {!seg.carry && !seg.continues && <span className="handle bottom" role="presentation" title={s.locked ? 'Unlock to change its length' : 'Drag to change when this slot ends'} onPointerDown={(e) => startDrag(e, seg)} />}
            </div>
          );
        })}
      </div>
    </div>
  );
}
