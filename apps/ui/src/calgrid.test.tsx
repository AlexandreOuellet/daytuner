// @vitest-environment jsdom
// What the calendar grid does with a drag, a resize and a click. FullCalendar itself cannot be dragged in jsdom (it measures the
// layout), so it is replaced by a stand-in that hands the props to the test, which calls them as FullCalendar would.
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const seen: { props: Record<string, any> } = { props: {} };
vi.mock('@fullcalendar/react', () => ({ default: (props: Record<string, unknown>) => { seen.props = props; return null; } }));

import { CalGrid } from './components/CalGrid';
import type { Entry } from './calview';
import { wallOf } from './staging';

const ZONE = 'America/Toronto';
const MIN = 60_000;
const HOUR = 60 * MIN;
const totals = { programMs: 0, adMs: 0, bumperMs: 0, interstitialMs: 0, deadAirMs: 0, adShare: 0 };
const entry = (key: string, place: Entry['place'], start: number, end: number, over: Partial<Entry> = {}): Entry =>
  ({ key, place, start, end, label: key, marks: [], editable: place !== 'committed', locked: false, view: { items: [], totals, warnings: [], plan: [], programs: [], blocks: [] }, ...over });

function show(entries: Entry[], date = '2026-12-02', over: Record<string, unknown> = {}) {
  const calls = { move: vi.fn(), edge: vi.fn(), select: vi.fn() };
  render(<CalGrid entries={entries} zone={ZONE} from={date} days={1} titles={{}} clips={{}} selected={undefined} onSelect={calls.select} grid={15 * MIN}
    onMove={calls.move} onEdge={calls.edge} timeOf={() => ''} busy={false} {...over} />);
  return calls;
}
const wall = (ms: number): Date => new Date(wallOf(ZONE, ms));
const at = (h: number, m = 0): number => Date.UTC(2026, 11, 2, h + 5, m); // 2 December 2026, Toronto is UTC-5
afterEach(cleanup);

describe('the calendar grid, as FullCalendar drives it', () => {
  const a = entry('staged:1', 'staged', at(14), at(16));
  const b = entry('planned:2', 'planned', at(16), at(18));

  it('hands each slot over as an event on the zone\'s own clock, editable only where a change can be staged', () => {
    show([entry('c:0', 'committed', at(12), at(14)), a, entry('l', 'staged', at(18), at(20), { locked: true }), entry('p', 'planned', at(20), at(22))]);
    const events = seen.props['events'] as { id: string; start: string; end: string; editable: boolean; extendedProps: { key: string } }[];
    expect(events.map((e) => [e.extendedProps.key, e.editable])).toEqual([['c:0', false], ['staged:1', true], ['l', false], ['p', true]]);
    expect(events[1]!.start).toBe(wall(at(14)).toISOString()); // 14:00 Toronto is drawn at 14:00
    expect(events[1]!.start.slice(11, 16)).toBe('14:00');
    expect(seen.props['eventResizableFromStart']).toBe(true);
  });

  it('draws nothing as editable while a change is running', () => {
    show([a, b], '2026-12-02', { busy: true });
    expect((seen.props['events'] as { editable: boolean }[]).every((e) => !e.editable)).toBe(true);
  });

  it('a drop reports the slot and the instant it now starts, and puts the grid back (the page redraws from its own state)', () => {
    const calls = show([a, b]);
    const revert = vi.fn();
    seen.props['eventDrop']({ event: { start: wall(at(14, 30)), extendedProps: { key: 'staged:1' } }, revert });
    expect(revert).toHaveBeenCalledTimes(1);
    expect(calls.move).toHaveBeenCalledWith(expect.objectContaining({ key: 'staged:1' }), at(14, 30));
    expect(calls.edge).not.toHaveBeenCalled();
  });

  it('a resize from the bottom reports the end, from the top the start, and never both', () => {
    const calls = show([a, b]);
    const revert = vi.fn();
    seen.props['eventResize']({ event: { start: wall(at(14)), end: wall(at(16, 15)), extendedProps: { key: 'staged:1' } }, revert });
    expect(calls.edge).toHaveBeenLastCalledWith(expect.objectContaining({ key: 'staged:1' }), 'end', at(16, 15));
    seen.props['eventResize']({ event: { start: wall(at(13, 45)), end: wall(at(16)), extendedProps: { key: 'staged:1' } }, revert });
    expect(calls.edge).toHaveBeenLastCalledWith(expect.objectContaining({ key: 'staged:1' }), 'start', at(13, 45));
    expect(calls.edge).toHaveBeenCalledTimes(2);
    expect(revert).toHaveBeenCalledTimes(2);
  });

  it('a resize that changes nothing reports nothing', () => {
    const calls = show([a]);
    seen.props['eventResize']({ event: { start: wall(at(14)), end: wall(at(16)), extendedProps: { key: 'staged:1' } }, revert: vi.fn() });
    expect(calls.edge).not.toHaveBeenCalled();
  });

  it('a click on a slot picks it, but a click on one of its blocks is left to the block', () => {
    const calls = show([a]);
    const block = document.createElement('button');
    block.className = 'cblk';
    const inner = document.createElement('span');
    block.appendChild(inner);
    seen.props['eventClick']({ jsEvent: { preventDefault() {}, target: inner }, event: { extendedProps: { key: 'staged:1' } } });
    expect(calls.select).not.toHaveBeenCalled();
    seen.props['eventClick']({ jsEvent: { preventDefault() {}, target: document.createElement('div') }, event: { extendedProps: { key: 'staged:1' } } });
    expect(calls.select).toHaveBeenCalledWith('staged:1');
  });
});

describe('the grid on the day the clocks go back (Toronto, 1 November 2026: 01:30 happens twice)', () => {
  const first = Date.UTC(2026, 10, 1, 5, 30);
  const second = Date.UTC(2026, 10, 1, 6, 30);
  const dst = (key: string, start: number, end: number) => entry(key, 'staged', start, end);

  it('dragging the start of a slot that ends in the repeated hour reports the start, not an end an hour early', () => {
    // 00:30 to 01:30 (the second 01:30), so the slot lasts two hours of real time
    const e = dst('x', Date.UTC(2026, 10, 1, 4, 30), second);
    const calls = show([e], '2026-11-01');
    seen.props['eventResize']({ event: { start: wall(Date.UTC(2026, 10, 1, 4, 15)), end: wall(second), extendedProps: { key: 'x' } }, revert: vi.fn() });
    expect(calls.edge).toHaveBeenCalledTimes(1);
    expect(calls.edge).toHaveBeenCalledWith(expect.objectContaining({ key: 'x' }), 'start', Date.UTC(2026, 10, 1, 4, 15));
  });

  it('dragging the end of that slot reports the later instant it was near, not the earlier one', () => {
    const e = dst('y', Date.UTC(2026, 10, 1, 4, 30), second);
    const calls = show([e], '2026-11-01');
    seen.props['eventResize']({ event: { start: wall(Date.UTC(2026, 10, 1, 4, 30)), end: wall(second + 15 * MIN), extendedProps: { key: 'y' } }, revert: vi.fn() });
    expect(calls.edge).toHaveBeenCalledWith(expect.objectContaining({ key: 'y' }), 'end', second + 15 * MIN);
  });

  it('a slot that starts in the repeated hour can be moved within it', () => {
    const e = dst('z', second, second + HOUR);
    const calls = show([e], '2026-11-01');
    seen.props['eventDrop']({ event: { start: wall(second + 15 * MIN), extendedProps: { key: 'z' } }, revert: vi.fn() });
    expect(calls.move).toHaveBeenCalledWith(expect.objectContaining({ key: 'z' }), second + 15 * MIN);
    void first;
  });
});
