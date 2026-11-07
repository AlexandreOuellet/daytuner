// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { polling } from './api';
import { daysIn, fallsOn, monthWeeks, monthsFrom, playName, weekdayOf } from './calendar';
import { parseRoute, specialLink } from './router';

beforeEach(() => {
  polling.intervalMs = 0;
  vi.useFakeTimers({ toFake: ['Date'], now: Date.UTC(2026, 10, 7, 17, 0) }); // 7 November 2026, 12:00 in Toronto
  window.location.hash = specialLink('Test Channel');
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); window.location.hash = ''; });

describe('calendar helpers', () => {
  it('knows weekdays, month lengths and how a month is laid out', () => {
    expect(weekdayOf(2026, 10, 31)).toBe(6); // a Saturday
    expect(daysIn(2028, 2)).toBe(29); expect(daysIn(2027, 2)).toBe(28);
    const nov = monthWeeks(2026, 11);
    expect(nov[0]!.slice(0, 2)).toEqual([1, 2]); // 1 November 2026 is a Sunday
    expect(nov).toHaveLength(5);
    expect(nov.flat().filter((d) => d !== null)).toHaveLength(30);
    expect(monthsFrom('2026-11-07').map((m) => `${m.year}-${m.month}`)).toEqual(['2026-11', '2026-12', '2027-1', '2027-2', '2027-3', '2027-4', '2027-5', '2027-6', '2027-7', '2027-8', '2027-9', '2027-10']);
  });
  it('matches a special day to a date, every year or one', () => {
    const e = { on: { month: 10, day: 31 }, at: 0, play: { movie: 'x' } };
    expect(fallsOn(e, '2027-10-31')).toBe(true);
    expect(fallsOn({ ...e, on: { month: 10, day: 31, year: 2026 } }, '2027-10-31')).toBe(false);
    expect(playName({ ...e, play: { show: 'Doctor Who', title: 'Halloween Special' } })).toBe('Doctor Who: Halloween Special');
    expect(parseRoute(specialLink('Test Channel'))).toEqual({ page: 'special', name: 'Test Channel' });
  });
});

const n = encodeURIComponent('Test Channel');
const HOUR = 3_600_000;
const halloween = { on: { month: 10, day: 31 }, at: 20 * HOUR, play: { show: 'Doctor Who', id: 'who', title: 'Halloween Special' } };
const model = (exceptions: unknown[] = [halloween]) => ({
  timezone: 'America/Toronto', grid: 900_000,
  week: [{ day: 6, at: 20 * HOUR, pool: 'movies' }, { day: 6, at: 8 * HOUR, pool: 'sitcoms' }, { day: 1, at: 20 * HOUR, pool: 'movies' }],
  pools: { movies: { movies: {} }, sitcoms: { shows: [{ show: 'Show A' }] } }, exceptions,
});

function serve(opts: { exceptions?: unknown[]; noMatch?: boolean; save?: (b: any) => unknown } = {}) {
  const posts: { url: string; body: any }[] = [];
  vi.stubGlobal('fetch', async (url: string, init?: { method?: string; body?: string }) => {
    const ok = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
    const job = (result: unknown) => ok({ job: { id: 'j', channel: 'Test Channel', kind: 'k', state: 'done', message: 'done', result } }, 202);
    if (init?.method === 'POST') {
      const body = JSON.parse(init.body ?? '{}');
      posts.push({ url, body });
      if (url.endsWith('/special-days')) {
        const list = (body.exceptions as { on: { month: number; day: number; year?: number } }[]).flatMap((e, index) => [2026, 2027].flatMap((y) => {
          if (e.on.year !== undefined && e.on.year !== y) return [];
          const date = `${y}-${String(e.on.month).padStart(2, '0')}-${String(e.on.day).padStart(2, '0')}`;
          return date < '2026-11-01' ? [] : [{ index, date, start: Date.parse(date), matchesSlot: !opts.noMatch, state: 'rule' }];
        }));
        return ok(list);
      }
      if (url.endsWith('/schedule/model')) return job(opts.save ? opts.save(body) : { saved: true, revision: 2 });
    }
    if (url === '/api/health') return ok({ ok: true, version: '0', writes: false });
    if (url === `/api/channels/${n}/schedule/model`) return ok({ revision: 1, model: model(opts.exceptions) });
    if (url === '/api/library') return ok({ shows: [{ id: 'who', title: 'Doctor Who' }, { id: 'a', title: 'Show A' }], genres: [] });
    if (url.startsWith('/api/library/movies')) return ok([{ id: 'nb', title: 'The Nightmare Before Christmas', duration: 76 * 60_000 }, { id: 'nx', title: 'Nightmare Next Door', duration: 90 * 60_000 }]);
    if (url === '/api/library/shows/who/episodes') return ok([{ id: 'w1', title: 'Halloween Special', season: 1, episode: 4, duration: 3_000_000 }, { id: 'w2', title: 'Another One', season: 1, episode: 5, duration: 3_000_000 }]);
    return ok({ error: 'not found' }, 404);
  });
  return posts;
}

describe('the special days page', () => {
  it('shows twelve months from this one, with a marked day and its state in words', async () => {
    serve();
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'November 2026' })).toBeTruthy();
    expect(screen.getAllByRole('heading', { level: 2 }).slice(0, 12).map((h) => h.textContent)).toContain('October 2027');
    const day = await screen.findByRole('button', { name: /^2027-10-31: Doctor Who: Halloween Special, planned from the schedule when its time comes/ });
    expect(day.className).toContain('mark');
    expect(screen.getByRole('button', { name: '2026-11-07' }).className).toContain('today');
    // 31 October 2026 is before this month, so it is not shown; every other date is a plain button
    expect(screen.queryByRole('button', { name: /^2026-10-31/ })).toBeNull();
    expect(screen.getByRole('list', { name: 'Legend' }).textContent).toContain('already in Tunarr');
  });

  it('opens a day, shows what is planned there, warns when it would replace nothing, and removes it', async () => {
    const posts = serve({ noMatch: true });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: /^2027-10-31/ }));
    const panel = screen.getByLabelText('Special days on 2027-10-31');
    expect(within(panel).getByText(/Doctor Who: Halloween Special/)).toBeTruthy();
    expect(within(panel).getByText(/at 20:00, every year/)).toBeTruthy();
    expect(await within(panel).findByText(/No slot starts at 20:00 on a Sun, so this replaces nothing/)).toBeTruthy();
    fireEvent.click(within(panel).getByRole('button', { name: 'Remove' }));
    expect(within(panel).getByText('Nothing special is planned on this day.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save as a new revision' }));
    await screen.findByText(/Saved as revision 2/);
    expect(posts.find((p) => p.url.endsWith('/schedule/model'))!.body.exceptions).toEqual([]);
  });

  it('adds a movie to a day, every year by default, choosing the slot, with counts off if asked', async () => {
    const posts = serve({ exceptions: [] });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '2026-12-24' })); // a Thursday: the week has no slot on Thursday
    expect(within(screen.getByLabelText('Special days on 2026-12-24')).getByText(/The week has no slot on a Thu/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '2026-12-26' })); // a Saturday: two slots
    const panel = screen.getByLabelText('Special days on 2026-12-26');
    fireEvent.change(within(panel).getByLabelText('Slot to replace'), { target: { value: String(20 * HOUR) } });
    fireEvent.change(within(panel).getByLabelText('Search movies'), { target: { value: 'nightmare' } });
    await waitFor(() => expect(within(panel).getByRole('option', { name: /The Nightmare Before Christmas \(76 min\)/ })).toBeTruthy());
    expect((within(panel).getByRole('button', { name: 'Add the special day' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(panel).getByLabelText('Movie'), { target: { value: 'nb' } });
    fireEvent.click(within(panel).getByLabelText(/counts as played/));
    fireEvent.click(within(panel).getByRole('button', { name: 'Add the special day' }));
    expect(await screen.findByRole('button', { name: /^2026-12-26: The Nightmare Before Christmas/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save as a new revision' }));
    await screen.findByText(/Saved as revision/);
    expect(posts.at(-1)!.body.exceptions).toEqual([{ on: { month: 12, day: 26 }, at: 20 * HOUR, play: { movie: 'The Nightmare Before Christmas', id: 'nb' }, counts: false }]);
  });

  it('adds an episode of a show, for this year only', async () => {
    const posts = serve({ exceptions: [] });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '2026-12-07' })); // a Monday with a 20:00 slot
    const panel = screen.getByLabelText('Special days on 2026-12-07');
    fireEvent.change(within(panel).getByLabelText('Kind of program'), { target: { value: 'episode' } });
    fireEvent.change(within(panel).getByLabelText('Show'), { target: { value: 'who' } });
    await waitFor(() => expect(within(panel).getByRole('option', { name: /S1E4 Halloween Special/ })).toBeTruthy());
    fireEvent.change(within(panel).getByLabelText('Episode'), { target: { value: 'w1' } });
    fireEvent.click(within(panel).getByLabelText(/this year only \(2026\)/));
    fireEvent.click(within(panel).getByRole('button', { name: 'Add the special day' }));
    expect(await screen.findByRole('button', { name: /^2026-12-07: Doctor Who: Halloween Special/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save as a new revision' }));
    await screen.findByText(/Saved as revision/);
    expect(posts.at(-1)!.body.exceptions[0]).toEqual({ on: { month: 12, day: 7, year: 2026 }, at: 20 * HOUR, play: { show: 'Doctor Who', id: 'who', title: 'Halloween Special' } });
  });

  it('will not save over locked slots until told to, and discards changes', async () => {
    const posts = serve({ save: (b) => (b.force ? { saved: true, revision: 2 } : { saved: false, revision: 1, impact: { conflicts: [{ start: 1, reason: 'window-changed', message: 'a slot moved' }], changes: [], staged: 1 } }) });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: /^2027-10-31/ }));
    fireEvent.click(within(screen.getByLabelText('Special days on 2027-10-31')).getByRole('button', { name: 'Remove' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save as a new revision' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Not saved');
    fireEvent.click(within(alert).getByRole('button', { name: 'Save anyway' }));
    expect(await screen.findByText(/Saved as revision 2/)).toBeTruthy();
    expect(posts.at(-1)!.body.force).toBe(true);
  });
});
