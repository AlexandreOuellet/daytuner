// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { polling } from './api';
import { breakCounts, breaksOf, clockSec, moveSlotPlan, rowsOf, snapSecond, entriesOf, groupsOf, piecesOf, segsOfBlock, timelineOf, weekDates, weekStartOf, withTitles } from './calview';
import { calendarLink, parseRoute } from './router';
import { msOf, wallOf } from './staging';


const MIN = 60_000;
const HOUR = 3_600_000;
// Toronto is UTC-5 on 2 December 2026 (standard time): 16:00 there is 21:00 UTC.
const at = (h: number, m = 0): number => Date.UTC(2026, 11, 2, h + 5, m);
const totals = (p: Partial<Record<string, number>> = {}) => ({ programMs: 40 * MIN, adMs: 4 * MIN, bumperMs: 20_000, interstitialMs: 0, deadAirMs: 0, adShare: 0.1, ...p });
const slot = (start: number, end: number, pool: string, items: unknown[], extra: Record<string, unknown> = {}) => ({ slotId: '3@0', start, end, pool, programs: ['p1'], exception: false, blocks: [], items, ...extra });
const items = [
  { kind: 'filler', role: 'bumper', position: 'head', list: 'idents', clipId: 'ident-1', duration: 20_000 },
  { kind: 'filler', role: 'ad', position: 'head', list: 'ads', clipId: 'ad-7', duration: 60_000 },
  { kind: 'content', programId: 'p1', startOffset: 0, duration: 20 * MIN },
  { kind: 'filler', role: 'ad', position: 'mid', list: 'ads', clipId: 'ad-9', duration: 90_000 },
  { kind: 'content', programId: 'p1', startOffset: 20 * MIN, duration: 20 * MIN },
  { kind: 'flex', duration: 30_000 },
];

describe('the calendar helpers', () => {
  it('puts a program\'s title where a warning names its id', () => {
    const id = 'f9dd8995-1984-44f6-a416-aa10a8ae7108';
    expect(withTitles(`${id} was shown again; ${id.replace('f','0')} stays`, { [id]: 'The Office' })).toBe(`The Office was shown again; ${id.replace('f','0')} stays`);
  });

  it('lays a week out from its Sunday', () => {
    expect(weekStartOf('2026-12-02')).toBe('2026-11-29');
    expect(weekDates('2026-12-02')[6]).toBe('2026-12-05');
  });
  it('orders the pieces of a slot with when each starts, and groups the breaks', () => {
    const segs = timelineOf(items as never, { p1: 'Home Alone' });
    expect(segs.map((s) => s.group)).toEqual(['head', 'head', 'program', 'mid', 'program', 'dead air']);
    expect(segs.map((s) => s.at)).toEqual([0, 20_000, 80_000, 80_000 + 20 * MIN, 80_000 + 20 * MIN + 90_000, 80_000 + 40 * MIN + 90_000]);
    expect(segs[4]!.what).toBe('Home Alone (part 2)');
    expect(groupsOf(segs).map((g) => [g.group, g.ms])).toEqual([['head', 80_000], ['program', 20 * MIN], ['mid', 90_000], ['program', 20 * MIN], ['dead air', 30_000]]);
    expect(breaksOf(segs).map((b) => [b.group, b.parts])).toEqual([['head', ['bumper 0:20', 'ads 1:00']], ['mid', ['ads 1:30']]]);
    expect(clockSec('America/Toronto', at(16))).toBe('16:00:00');
  });
  it('gathers each break into one row, and keeps programs and dead air as rows of their own', () => {
    const rows = rowsOf(timelineOf(items as never, { p1: 'Home Alone' }, { 'ad-7': 'Molson Canadian' }));
    expect(rows.map((r) => (r.kind === 'break' ? `${r.group} break (${r.segs.length})` : r.seg.what))).toEqual(['head break (2)', 'Home Alone', 'mid break (1)', 'Home Alone (part 2)', 'dead air']);
    const head = rows[0]!;
    expect(head.kind === 'break' && head.ms).toBe(80_000);
    expect(head.kind === 'break' && breakCounts(head.segs)).toBe('1 ad, 1 bumper');
  });
  it('rounds a time that falls a few milliseconds before the hour to the hour', () => {
    const edge = Date.UTC(2026, 10, 20, 0, 59, 59, 929); // Tunarr's lineup ends here: 19:59:59.929 in Toronto
    expect(snapSecond(edge)).toBe(Date.UTC(2026, 10, 20, 1, 0, 0));
    expect(clockSec('America/Toronto', edge)).toBe('20:00:00');
  });
  it('cuts a long slot into its blocks', () => {
    const two = [{ kind: 'content', programId: 'a', startOffset: 0, duration: 30 * MIN }, { kind: 'filler', role: 'ad', position: 'post', list: 'ads', clipId: 'x', duration: 60_000 }, { kind: 'content', programId: 'b', startOffset: 0, duration: 20 * MIN }];
    const segs = timelineOf(two as never, {});
    const second = segsOfBlock(segs, 1000, { start: 1000 + 31 * MIN, end: 1000 + 51 * MIN });
    expect(second.map((s) => [s.what, s.at])).toEqual([['program b', 0]]);
  });
  it('keeps committed, staged and planned apart, and draws a slot over midnight in two days', () => {
    const e = entriesOf([{ start: at(10), end: at(14), pool: null, programs: ['p1'], blocks: [], items: [], totals: totals() }], [{ slot: slot(at(23), at(26), 'movies', []), source: 'planned', hand: [], rule: false, differs: false, totals: totals(), plan: [], warnings: [] }] as never, { p1: 'T' });
    expect(e.map((x) => x.place)).toEqual(['committed', 'planned']);
    expect(piecesOf(e, at(0), at(24)).map((p) => [p.entry.place, p.continues])).toEqual([['committed', false], ['planned', true]]);
    expect(piecesOf(e, at(24), at(48)).map((p) => [p.entry.place, p.carry])).toEqual([['planned', true]]);
  });
});

describe('moving a whole slot', () => {
  const e = (key: string, place: 'committed' | 'staged' | 'planned', start: number, end: number, extra: Record<string, unknown> = {}) =>
    ({ key, place, start, end, label: key, marks: [], editable: place !== 'committed', locked: false, view: { items: [], totals: totals(), warnings: [], plan: [], programs: [], blocks: [] }, ...extra }) as never;
  const row = [e('a', 'staged', at(10), at(12)), e('b', 'planned', at(12), at(14)), e('c', 'planned', at(14), at(16))] as never[];
  const grid = 15 * MIN;

  it('later: the slot ends later first, then starts later, so the neighbours give and take the time', () => {
    const plan = moveSlotPlan(row as never, row[1]!, at(12) + grid, grid);
    expect(plan).toEqual({ steps: [{ start: at(12), end: at(14) + grid }, { start: at(10), end: at(12) + grid }], reach: at(16), planned: true });
  });
  it('earlier: it starts earlier first, then ends earlier', () => {
    const plan = moveSlotPlan(row as never, row[1]!, at(12) - grid, grid);
    expect(plan).toEqual({ steps: [{ start: at(10), end: at(12) - grid }, { start: at(12) - grid, end: at(14) - grid }], reach: at(16), planned: true });
  });
  it('is no change when it stays, and says why when it cannot move', () => {
    expect(moveSlotPlan(row as never, row[1]!, at(12), grid)).toMatchObject({ steps: [] });
    // the slot before it is in Tunarr
    const inTunarr = [e('a', 'committed', at(10), at(12)), ...row.slice(1)] as never[];
    expect(moveSlotPlan(inTunarr as never, inTunarr[1]!, at(12) + grid, grid)).toMatchObject({ error: expect.stringContaining('already in Tunarr') });
    // nothing after it
    expect(moveSlotPlan(row as never, row[2]!, at(14) + grid, grid)).toMatchObject({ error: expect.stringContaining('No slot comes after') });
    // a neighbour would be left with nothing, or it is locked
    expect(moveSlotPlan(row as never, row[1]!, at(14) - grid + 2 * grid, grid)).toMatchObject({ error: expect.stringContaining('no time') });
    expect(moveSlotPlan([row[0], e('b', 'planned', at(12), at(14), { locked: true }), row[2]] as never, e('b', 'planned', at(12), at(14), { locked: true }), at(12) + grid, grid)).toMatchObject({ error: expect.stringContaining('locked') });
  });
});

describe('the wall clock of a zone', () => {
  it('draws the channel hours: 20:00 in Toronto sits on the 20:00 line, in standard and summer time, and converts back', () => {
    for (const ms of [Date.UTC(2026, 11, 3, 1, 0), Date.UTC(2026, 6, 3, 0, 0)]) {
      const wall = new Date(wallOf('America/Toronto', ms));
      expect(wall.getUTCHours()).toBe(20);
      expect(msOf('America/Toronto', wallOf('America/Toronto', ms))).toBe(ms);
    }
    expect(msOf('America/Toronto', Date.UTC(2026, 11, 2, 20, 0, 30))).toBe(Date.UTC(2026, 11, 3, 1, 0, 30));
  });
});

beforeEach(() => {
  polling.intervalMs = 0;
  vi.useFakeTimers({ toFake: ['Date'], now: at(9) });
  window.location.hash = calendarLink('Test Channel', '2026-12-02');
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); window.location.hash = ''; });

function serve() {
  const posts: { from: number; to: number }[] = [];
  const stages: { url: string; body: Record<string, unknown> }[] = [];
  const result = {
    committedUntil: at(14), from: at(0), to: at(24 * 7), rerunnable: ['p1'],
    committed: [{ start: at(10), end: at(14), pool: 'sitcoms', programs: ['p1'], blocks: [{ programId: 'p1', start: at(10), end: at(14) }], items, totals: totals() }],
    titles: { p1: 'Home Alone', p2: 'Columbo' },
    clips: { 'ad-7': 'Molson Canadian', 'ad-9': 'Labatt 50', 'ident-1': 'Station ident' },
    slots: [
      { slot: slot(at(14), at(16), 'sitcoms', items, { blocks: [{ programId: 'p1', start: at(14), end: at(16) }] }), source: 'planned', hand: [], rule: false, differs: false, totals: totals(), plan: [], warnings: [] },
      { slot: slot(at(16), at(24), 'movies', items, { slotId: 'added@1', programs: ['p1'], blocks: [{ programId: 'p1', start: at(16), end: at(20) }, { programId: 'p2', start: at(20), end: at(24), pinned: true }] }), source: 'staged', hand: ['slot added', '1 pin', 'locked'], rule: true, differs: true, totals: totals({ adShare: 0.12 }),
        plan: [{ start: at(16), end: at(24), slotId: '3@57600000', pool: 'crime', programs: ['p2'], totals: totals() }], warnings: [] },
    ],
  };
  vi.stubGlobal('fetch', async (url: string, init?: { method?: string; body?: string }) => {
    const ok = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
    if (url.endsWith('/calendar')) {
      posts.push(JSON.parse(init?.body ?? '{}'));
      return ok({ job: { id: 'j', channel: 'Test Channel', kind: 'k', state: 'done', message: 'done', result } }, 202);
    }
    if (url.includes('/stage/') || url.endsWith('/lock')) {
      stages.push({ url: url.slice(url.indexOf('/stage/')), body: JSON.parse(init?.body ?? '{}') });
      return ok({ job: { id: 's', channel: 'Test Channel', kind: 'k', state: 'done', message: 'done', result: { staged: 1, planned: 1, warnings: [], changes: [], titles: {} } } }, 202);
    }
    if (url.includes('/api/channels/') && !url.includes('/', 14 + 'Test%20Channel'.length + 15)) return ok({ name: 'Test Channel', timezone: 'America/Toronto', commits: [] });
    return ok({ ok: true, version: 'x', writes: false });
  });
  return Object.assign(posts, { stages });
}

const open = async () => {
  render(<App />);
  const day = await screen.findByRole('group', { name: 'The day' }, { timeout: 8000 });
  await waitFor(() => expect(day.querySelectorAll('.cslot').length).toBe(3));
  return day;
};
const slotBox = (day: HTMLElement, start: string) => [...day.querySelectorAll('.cslot')].find((b) => b.getAttribute('aria-label')!.startsWith(start))!;

describe('the calendar page', () => {
  it('parses its route', () => {
    expect(parseRoute(calendarLink('Test Channel', '2026-12-02'))).toEqual({ page: 'calendar', name: 'Test Channel', date: '2026-12-02' });
    expect(parseRoute(calendarLink('Test Channel'))).toEqual({ page: 'calendar', name: 'Test Channel' });
  });

  it('shows the day left to right, each slot with its blocks inside it, and says whether it is committed, staged or planned', async () => {
    serve();
    const day = await open();
    const labels = [...day.querySelectorAll('.cslot')].map((b) => b.getAttribute('aria-label'));
    expect(labels.some((l) => l!.startsWith('Committed: sitcoms, 10:00 to 14:00'))).toBe(true);
    expect(labels.some((l) => l!.startsWith('Planned: sitcoms, 14:00 to 16:00'))).toBe(true);
    expect(labels.some((l) => l!.startsWith('Staged: added, 16:00 to 00:00') && l!.includes('slot added, 1 pin, locked, rule'))).toBe(true);
    const staged = slotBox(day, 'Staged') as HTMLElement;
    // The blocks are inside the slot, one box each, and a pinned one says so.
    const blocks = [...staged.querySelectorAll('.cblk')];
    expect(blocks.map((b) => b.getAttribute('aria-label'))).toEqual(['Home Alone, 16:00', 'Columbo, 20:00, pinned']);
    // Each block shows how it is divided, and a minute of dead air or more is called out.
    expect(blocks[0]!.querySelectorAll('.seg').length).toBeGreaterThan(3);
    expect(blocks[0]!.querySelector('.seg.ad')).toBeTruthy();
    expect(blocks[0]!.querySelector('.seg.bumper')).toBeTruthy();
  });

  it('is one timeline of what plays, by name, under the day', async () => {
    serve();
    await open();
    const tl = screen.getByRole('complementary', { name: 'What plays' });
    // All three slots are in it, in order, without picking anything.
    const sections = [...tl.querySelectorAll('section.tlslot')].map((x) => x.getAttribute('aria-label'));
    expect(sections).toEqual(['Committed: sitcoms, 10:00', 'Planned: sitcoms, 14:00', 'Staged: added, 16:00']);
    const section = document.getElementById(`tl-staged:${at(16)}`)!;
    const text = () => within(section).getAllByRole('row').map((r) => r.textContent!);
    // Each block has a heading of its own, with its title.
    expect(document.getElementById(`tl-staged:${at(16)}-b1`)!.textContent).toContain('Columbo');
    // A break is one row: what is in it, and its length. The program stays a row of its own.
    expect(text().some((r) => r.includes('16:00:00') && r.includes('head break') && r.includes('1 ad, 1 bumper') && r.includes('Station ident, Molson Canadian') && r.includes('1:20'))).toBe(true);
    expect(text().some((r) => r.includes('16:01:20') && r.includes('Home Alone') && r.includes('program'))).toBe(true);
    expect(text().some((r) => r.includes('mid break') && r.includes('Labatt 50'))).toBe(true);
    expect(text().some((r) => r.includes('Home Alone (part 2)'))).toBe(true);
    expect(text().filter((r) => r.includes('Molson Canadian')).length).toBe(1); // inside the break row only
    // Opened, the clips are there one by one, with their lists.
    fireEvent.click(within(section).getAllByRole('button', { name: /head break/ })[0]!);
    expect(text().some((r) => r.includes('16:00:20') && r.includes('Molson Canadian') && r.includes('ad, ads'))).toBe(true);
    expect(text().some((r) => r.includes('16:00:00') && r.includes('Station ident') && r.includes('bumper, idents'))).toBe(true);
  });

  it('clicking a slot, anywhere on it, brings the list to it, and compares a changed slot with its plan', async () => {
    serve();
    const scrolled = vi.fn();
    (HTMLElement.prototype as { scrollTo?: unknown }).scrollTo = scrolled;
    const day = await open();
    fireEvent.click(slotBox(day, 'Staged').querySelector('.chead')!);
    await waitFor(() => expect(scrolled).toHaveBeenCalled());
    const section = document.getElementById(`tl-staged:${at(16)}`)!;
    expect(section.classList.contains('current')).toBe(true);
    expect(within(section).getByText('Compared with the plan')).toBeTruthy();
    expect(within(section).getByText(/crime/)).toBeTruthy();
    expect(within(section).getByRole('link', { name: 'Staging' })).toBeTruthy();
    // A committed block is in the same list, read from the lineup.
    expect(document.getElementById(`tl-c:${at(10)}`)).toBeTruthy();
    expect(within(document.getElementById(`tl-planned:${at(14)}`)!).queryByText('Compared with the plan')).toBeNull();
  });

  it('clicking a block brings the list to that block', async () => {
    serve();
    const scrolled = vi.fn();
    (HTMLElement.prototype as { scrollTo?: unknown }).scrollTo = scrolled;
    const day = await open();
    fireEvent.click(slotBox(day, 'Staged').querySelector('[aria-label^="Columbo"]')!);
    await waitFor(() => expect(scrolled).toHaveBeenCalled());
    const block = document.getElementById(`tl-staged:${at(16)}-b1`)!;
    expect(block.classList.contains('current')).toBe(true);
    expect(document.getElementById(`tl-staged:${at(16)}-b0`)!.classList.contains('current')).toBe(false);
    expect(screen.getByRole('heading', { name: /Block 2: Columbo/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Unpin/ })).toBeTruthy();
  });

  it('cannot change what is already in Tunarr', async () => {
    serve();
    const day = await open();
    fireEvent.click(slotBox(day, 'Committed'));
    const bar = await screen.findByLabelText('The picked slot');
    expect(bar.textContent).toContain('Already in Tunarr');
    expect(within(bar).queryByRole('button', { name: 'Delete slot' })).toBeNull();
  });

  it('changing a planned slot stages it first, and playing a rerun asks for the earlier episode', async () => {
    const posts = serve();
    const day = await open();
    fireEvent.click(slotBox(day, 'Planned').querySelector('[aria-label^="Home Alone"]')!);
    const rerun = await screen.findByRole('button', { name: /Play a rerun instead/ });
    fireEvent.click(rerun);
    await waitFor(() => expect(posts.stages.map((s) => s.url)).toEqual(['/stage/generate', '/stage/rerun']));
    expect(posts.stages[0]!.body).toMatchObject({ to: at(16) });
    expect(posts.stages[1]!.body).toEqual({ start: at(14), block: 1, pool: 'sitcoms', programId: 'p1' });
    await screen.findByText(/It is staged, not committed/);
  });

  it('moves the end of a slot one grid step, and the start by changing the slot before it', async () => {
    const posts = serve();
    const day = await open();
    fireEvent.click(slotBox(day, 'Planned'));
    fireEvent.click(await screen.findByRole('button', { name: 'End later' }));
    await waitFor(() => expect(posts.stages.map((s) => s.url)).toEqual(['/stage/generate', '/stage/edit']));
    expect(posts.stages[1]!.body).toEqual({ kind: 'resize', start: at(14), end: at(16) + 900_000 });
  });

  it('moves a whole slot from the bar, and says when it cannot (the slot before it is in Tunarr)', async () => {
    serve();
    const day = await open();
    fireEvent.click(slotBox(day, 'Planned'));
    fireEvent.click(await screen.findByRole('button', { name: 'Move later' }));
    expect((await screen.findByRole('alert')).textContent).toContain('already in Tunarr');
  });

  it('shows one, three or seven days', async () => {
    serve();
    await open();
    expect(screen.getByRole('group', { name: 'The day' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '3 days' }));
    expect(await screen.findByRole('group', { name: 'The days' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '3 days' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('reads more weeks as the timeline is scrolled, each only once', async () => {
    const posts = serve();
    await open();
    expect(posts).toHaveLength(1);
    const tl = screen.getByRole('complementary', { name: 'What plays' });
    // In jsdom the box is at its top and its bottom at once, so the week after and the week before are both asked for.
    fireEvent.scroll(tl);
    await waitFor(() => expect(posts).toHaveLength(3));
    const [now, ...others] = posts as unknown as [{ from: number; to: number }, ...{ from: number; to: number }[]];
    expect(others.some((p) => p.from > now.from)).toBe(true);
    expect(others.some((p) => p.from < now.from)).toBe(true);
    fireEvent.scroll(tl); fireEvent.scroll(tl);
    await waitFor(() => expect(posts.length).toBeGreaterThan(3));
    const froms = posts.map((p) => p.from);
    expect(new Set(froms).size).toBe(froms.length); // never the same week twice
  });
});
