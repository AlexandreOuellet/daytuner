// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { polling } from './api';
import { parseRoute, scheduleLink } from './router';
import { DAY, HOUR, daySegments, slotLength, snap, startRange } from './week';

beforeEach(() => { polling.intervalMs = 0; window.location.hash = scheduleLink('Test Channel'); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.location.hash = ''; });

const slot = (day: number, h: number, pool: string, extra: object = {}) => ({ day, at: h * HOUR, pool, ...extra });
const week = () => [slot(1, 8, 'sitcoms', { link: 'office', linkMode: 'continue' }), slot(1, 20, 'movies'), slot(1, 22.25, 'sitcoms', { link: 'office', linkMode: 'rerun' }), slot(2, 8, 'sitcoms', { link: 'office', linkMode: 'continue' })];

describe('week geometry', () => {
  it('a slot lasts until the next one starts, and the week wraps', () => {
    const w = week();
    expect(slotLength(w, w[0]!)).toBe(12 * HOUR);
    expect(slotLength(w, w[1]!)).toBe(2.25 * HOUR);
    expect(slotLength(w, w[3]!)).toBe(6 * DAY); // from Tuesday 08:00 round the week to Monday 08:00
    expect(slotLength([w[0]!], w[0]!)).toBe(7 * DAY);
  });
  it('draws a slot that crosses midnight in both days, and one that wraps in the first days', () => {
    const w = week();
    const tue = daySegments(w, 2);
    expect(tue[0]).toMatchObject({ carry: true, from: 0, to: 8 * HOUR });
    expect(tue[0]!.slot.pool).toBe('sitcoms'); // the 22:15 rerun of Monday carries on until 08:00
    const sun = daySegments(w, 0);
    expect(sun).toHaveLength(1);
    expect(sun[0]).toMatchObject({ carry: true, from: 0, to: DAY, continues: true }); // Tuesday's slot runs through the weekend
    const mon = daySegments(w, 1);
    expect(mon.map((s) => [s.from / HOUR, s.carry])).toEqual([[0, true], [8, false], [20, false], [22.25, false]]);
  });
  it('snaps to the grid and keeps a slot one step clear of its neighbours', () => {
    expect(snap(8.1 * HOUR, 900_000)).toBe(8 * HOUR);
    const w = week();
    expect(startRange(w, w[1]!, 900_000)).toEqual({ min: 8 * HOUR + 900_000, max: 22.25 * HOUR - 900_000 });
    expect(startRange(w, w[3]!, 900_000)).toEqual({ min: 0, max: DAY - 900_000 }); // alone in its day: any time
  });
  it('reads the schedule route', () => {
    expect(parseRoute(scheduleLink('Test Channel'))).toEqual({ page: 'schedule', name: 'Test Channel' });
  });
});

const n = encodeURIComponent('Test Channel');
const model = () => ({
  timezone: 'America/Toronto', grid: 900_000, week: week(),
  pools: { sitcoms: { shows: [{ show: 'Show A' }, { show: 'Show B', id: 'b' }], order: 'sequential' }, movies: { movies: { genre: 'Comedy', duration: { op: '<=', ms: 117 * 60_000 } }, order: 'shuffle' } },
});
const stats = { sitcoms: { count: 300, durations: [22 * 60_000, 44 * 60_000] }, movies: { count: 34, durations: [80 * 60_000, 90 * 60_000, 120 * 60_000] } };

function serve(save?: (b: any) => unknown) {
  const posts: { url: string; body: any }[] = [];
  vi.stubGlobal('fetch', async (url: string, init?: { method?: string; body?: string }) => {
    const ok = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
    const job = (result: unknown) => ok({ job: { id: 'j', channel: 'Test Channel', kind: 'k', state: 'done', message: 'done', result } }, 202);
    if (init?.method === 'POST') {
      const body = JSON.parse(init.body ?? '{}');
      posts.push({ url, body });
      if (url.endsWith('/pools/stats')) return job(stats);
      if (url.endsWith('/schedule/model')) return job(save ? save(body) : { saved: true, revision: 2 });
    }
    if (url === '/api/health') return ok({ ok: true, version: '0', writes: false });
    if (url === `/api/channels/${n}/schedule/model`) return ok({ revision: 1, model: model() });
    if (url === '/api/library') return ok({ shows: [{ id: 'a', title: 'Show A' }, { id: 'b', title: 'Show B' }, { id: 'c', title: 'Show C' }], genres: ['Comedy', 'Drama'] });
    return ok({ error: 'not found' }, 404);
  });
  return posts;
}

describe('the schedule designer', () => {
  it('draws the week with a block per slot, labelled with its pool, time and link', async () => {
    serve();
    render(<App />);
    const grid = await screen.findByRole('group', { name: 'The week' });
    const blocks = within(grid).getAllByRole('button', { pressed: false });
    const labels = blocks.map((b) => b.getAttribute('aria-label')!);
    expect(labels.some((l) => /^Mon 20:00, movies, lasts 2\.25 h/.test(l))).toBe(true);
    expect(labels.some((l) => /^Mon 08:00, sitcoms, continues office, lasts 12 h/.test(l))).toBe(true);
    expect(labels.some((l) => /^Mon 22:15, sitcoms, rerun of office/.test(l))).toBe(true);
    expect(screen.getByText('No changes.')).toBeTruthy();
  });

  it('selecting a slot opens its editor; changing its time and pool changes the block and enables saving', async () => {
    const posts = serve();
    render(<App />);
    const grid = await screen.findByRole('group', { name: 'The week' });
    fireEvent.click(within(grid).getByRole('button', { name: /^Mon 20:00, movies/ }));
    const editor = await screen.findByLabelText('The selected slot');
    expect(within(editor).getByRole('heading').textContent).toBe('Mon 20:00');
    fireEvent.change(within(editor).getByLabelText('Starts at'), { target: { value: '20:30' } });
    expect(within(grid).getByRole('button', { name: /^Mon 20:30, movies, lasts 1\.75 h/ })).toBeTruthy();
    expect(screen.getByLabelText('The selected slot').querySelector('h2')!.textContent).toBe('Mon 20:30');
    fireEvent.change(within(screen.getByLabelText('The selected slot')).getByLabelText('Plays from'), { target: { value: 'sitcoms' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save as a new revision' }));
    expect(await screen.findByText(/Saved as revision 2/)).toBeTruthy();
    const sent = posts.at(-1)!;
    expect(sent.url).toBe(`/api/channels/${n}/schedule/model`);
    expect(sent.body.week.find((s: any) => s.day === 1 && s.at === 20.5 * HOUR)).toMatchObject({ pool: 'sitcoms' });
    expect(sent.body.force).toBe(false);
  });

  it('moves a slot with the arrow keys, one grid step at a time, and never past its neighbour', async () => {
    serve();
    render(<App />);
    const grid = await screen.findByRole('group', { name: 'The week' });
    const btn = within(grid).getByRole('button', { name: /^Mon 20:00, movies/ });
    fireEvent.keyDown(btn, { key: 'ArrowDown' });
    expect(within(grid).getByRole('button', { name: /^Mon 20:15, movies/ })).toBeTruthy();
    for (let i = 0; i < 20; i++) fireEvent.keyDown(within(grid).getByRole('button', { name: /^Mon \d\d:\d\d, movies/ }), { key: 'ArrowDown' });
    expect(within(grid).getByRole('button', { name: /^Mon 22:00, movies/ })).toBeTruthy(); // stops one step before the 22:15 slot
  });

  it('drags the top edge of a slot and snaps to the grid', async () => {
    serve();
    const { container } = render(<App />);
    await screen.findByRole('group', { name: 'The week' });
    const col = container.querySelectorAll('.daycol')[1] as HTMLElement; // Monday
    col.getBoundingClientRect = () => ({ top: 100, height: 720, left: 0, right: 100, bottom: 820, width: 100, x: 0, y: 100, toJSON() {} });
    const block = [...container.querySelectorAll('.slotblock')].find((b) => /movies/.test(b.textContent ?? '') && !b.classList.contains('carry'))!;
    fireEvent.pointerDown(block.querySelector('.handle')!, { clientY: 100 + 20 * 30 });
    fireEvent(window, Object.assign(new Event('pointermove'), { clientY: 100 + 21.1 * 30 })); // 21:06, snaps to 21:00
    expect(await screen.findByRole('button', { name: /^Mon 21:00, movies/ })).toBeTruthy();
    fireEvent(window, new Event('pointerup'));
    fireEvent(window, Object.assign(new Event('pointermove'), { clientY: 100 + 5 * 30 })); // after letting go, nothing moves
    expect(screen.getByRole('button', { name: /^Mon 21:00, movies/ })).toBeTruthy();
  });

  it('adds and removes a slot, and refuses two at one moment or one off the grid', async () => {
    const posts = serve();
    render(<App />);
    await screen.findByRole('group', { name: 'The week' });
    const form = screen.getByLabelText('Add a slot');
    fireEvent.change(within(form).getByLabelText('Day'), { target: { value: '6' } });
    fireEvent.change(within(form).getByLabelText('Time'), { target: { value: '21:00' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Add' }));
    expect(screen.getByRole('button', { name: /^Sat 21:00, sitcoms/ })).toBeTruthy(); // the first pool is the default
    fireEvent.click(within(form).getByRole('button', { name: 'Add' })); // the same moment again
    expect((await screen.findByRole('alert')).textContent).toContain('already a slot at 21:00 on Sat');
    fireEvent.change(within(form).getByLabelText('Time'), { target: { value: '21:07' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Add' }));
    expect((await screen.findByRole('alert')).textContent).toContain('on the 15-minute grid');
    fireEvent.click(screen.getByRole('button', { name: /^Sat 21:00, sitcoms/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove this slot' }));
    expect(screen.queryByRole('button', { name: /^Sat 21:00/ })).toBeNull();
    expect(posts.some((p) => p.url.endsWith('/schedule/model'))).toBe(false);
  });

  it('links a slot, with a name, and clears the link', async () => {
    const posts = serve();
    render(<App />);
    const grid = await screen.findByRole('group', { name: 'The week' });
    fireEvent.click(within(grid).getByRole('button', { name: /^Mon 20:00, movies/ }));
    const editor = screen.getByLabelText('The selected slot');
    fireEvent.change(within(editor).getByLabelText('Link'), { target: { value: 'rerun' } });
    expect(within(grid).getByRole('button', { name: /^Mon 20:00, movies, rerun of office/ })).toBeTruthy();
    fireEvent.change(within(editor).getByLabelText('Link name'), { target: { value: 'night' } });
    expect(within(grid).getByRole('button', { name: /rerun of night/ })).toBeTruthy();
    fireEvent.change(within(editor).getByLabelText('Link'), { target: { value: '' } });
    expect(within(grid).getByRole('button', { name: /^Mon 20:00, movies, lasts/ })).toBeTruthy();
    expect(screen.getByText('No changes.')).toBeTruthy(); // back to what was saved
    // Clear the link of the rerun slot instead: that is a change.
    fireEvent.click(within(grid).getByRole('button', { name: /^Mon 22:15, sitcoms, rerun of office/ }));
    fireEvent.change(within(screen.getByLabelText('The selected slot')).getByLabelText('Link'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save as a new revision' }));
    await screen.findByText(/Saved as revision/);
    const sent = posts.at(-1)!.body.week.find((s: any) => s.day === 1 && s.at === 22.25 * HOUR);
    expect(sent.link).toBeUndefined();
    expect(sent.linkMode).toBeUndefined();
  });

  it('shows what each pool holds and warns about a slot no program fits', async () => {
    serve();
    render(<App />);
    const grid = await screen.findByRole('group', { name: 'The week' });
    await waitFor(() => expect(screen.getByText(/300 programs, 22 to 44 min/)).toBeTruthy());
    expect(screen.getByText(/34 programs, 80 to 120 min; 3 fit the shortest slot that uses movies \(135 min\)/)).toBeTruthy();
    fireEvent.click(within(grid).getByRole('button', { name: /^Mon 20:00, movies/ }));
    for (let i = 0; i < 4; i++) fireEvent.keyDown(within(grid).getByRole('button', { name: /^Mon \d\d:\d\d, movies/ }), { key: 'ArrowDown' });
    // The movie slot now starts 21:00 and lasts 75 minutes; the shortest movie is 80.
    await waitFor(() => expect(within(grid).getByRole('button', { name: /No program of movies fits this 75-minute slot/ })).toBeTruthy());
  });

  it('edits pools: shows are added and removed, a movie filter changes, a used pool cannot be removed, a new pool is added', async () => {
    const posts = serve();
    render(<App />);
    await screen.findByRole('group', { name: 'The week' });
    fireEvent.change(screen.getByLabelText('Add a show to sitcoms'), { target: { value: 'c' } });
    const chips = (): string[] => [...document.querySelectorAll('.chips .chip')].map((c) => c.textContent!.replace('×', ''));
    expect(chips()).toEqual(['Show A', 'Show B', 'Show C']);
    fireEvent.click(screen.getByRole('button', { name: 'Remove Show A from sitcoms' }));
    expect(chips()).toEqual(['Show B', 'Show C']);
    fireEvent.change(screen.getByLabelText('Genre for movies'), { target: { value: 'Drama' } });
    fireEvent.change(screen.getByLabelText('Longest movie in movies, minutes'), { target: { value: '100' } });
    expect((screen.getAllByRole('button', { name: 'Remove pool' })[0] as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Name of the new pool'), { target: { value: 'kids' } });
    fireEvent.change(screen.getByLabelText('Kind of the new pool'), { target: { value: 'movies' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add the pool' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save as a new revision' }));
    await screen.findByText(/Saved as revision/);
    const pools = posts.at(-1)!.body.pools;
    expect(pools.sitcoms.shows.map((s: any) => s.show)).toEqual(['Show B', 'Show C']);
    expect(pools.movies.movies).toEqual({ genre: 'Drama', duration: { op: '<=', ms: 100 * 60_000 } });
    expect(pools.kids).toEqual({ movies: {}, order: 'shuffle' });
  });

  it('will not save over locked slots until told to, and can discard changes', async () => {
    const posts = serve((b) => (b.force ? { saved: true, revision: 2 } : { saved: false, revision: 1, impact: { conflicts: [{ start: 1, reason: 'window-changed', message: 'no slot starts there any more' }], changes: [], staged: 2 } }));
    render(<App />);
    const grid = await screen.findByRole('group', { name: 'The week' });
    fireEvent.click(within(grid).getByRole('button', { name: /^Mon 20:00, movies/ }));
    fireEvent.change(screen.getByLabelText('Starts at'), { target: { value: '21:00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save as a new revision' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Not saved');
    fireEvent.click(within(alert).getByRole('button', { name: 'Save anyway' }));
    expect(await screen.findByText(/Saved as revision 2/)).toBeTruthy();
    expect(posts.at(-1)!.body.force).toBe(true);
    // The page reloads what was saved (the mock still has the old week); a new change can be discarded.
    const again = await screen.findByRole('group', { name: 'The week' });
    fireEvent.click(await within(again).findByRole('button', { name: /^Mon 20:00, movies/ }));
    fireEvent.change(screen.getByLabelText('Starts at'), { target: { value: '21:15' } });
    expect(within(again).getByRole('button', { name: /^Mon 21:15, movies/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(within(screen.getByRole('group', { name: 'The week' })).getAllByRole('button', { name: /^Mon 20:00, movies/ })).toHaveLength(1);
    expect(screen.getByText('No changes.')).toBeTruthy();
  });
});
