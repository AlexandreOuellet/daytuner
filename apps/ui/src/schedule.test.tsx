// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { configure } from '@testing-library/react';
import { polling, type SlotModel } from './api';
import { poolSummary } from './components/Templates';
import { parseRoute, scheduleLink } from './router';
import { eventsOf } from './components/WeekGrid';
import { DAY, HOUR, WEEK, daySegments, gapSegments, hasGaps, moveTo, place, resizeTo, roomFrom } from './week';

configure({ asyncUtilTimeout: 8000 }); // the calendar draws its events a moment after the page
beforeEach(() => { polling.intervalMs = 0; window.location.hash = scheduleLink('Test Channel'); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.location.hash = ''; });

const G = 900_000;
const slot = (day: number, h: number, len: number, pool: string, extra: object = {}): SlotModel => ({ day, at: h * HOUR, length: len * HOUR, pool, ...extra });
// Mon 08-20 sitcoms, Mon 20:00-22:15 movies, Mon 22:15-Tue 08:00 sitcoms rerun, Tue 08-20 sitcoms; the rest of the week is a gap.
const week = (): SlotModel[] => [
  slot(1, 8, 12, 'sitcoms', { link: 'office', linkMode: 'continue', template: 'Sitcom block' }), slot(1, 20, 2.25, 'movies', { template: 'Movie night' }),
  slot(1, 22.25, 9.75, 'sitcoms', { link: 'office', linkMode: 'rerun' }), slot(2, 8, 12, 'sitcoms', { link: 'office', linkMode: 'continue' }),
];

describe('week geometry', () => {
  it('slots keep their own length, a slot over midnight is drawn in both days, and the rest is gaps', () => {
    const w = week();
    const tue = daySegments(w, 2);
    expect(tue[0]).toMatchObject({ carry: true, from: 0, to: 8 * HOUR });
    expect(tue.map((s) => [s.from / HOUR, s.to / HOUR])).toEqual([[0, 8], [8, 20]]);
    expect(gapSegments(w, 2)).toEqual([{ from: 20 * HOUR, to: DAY }]);
    expect(gapSegments(w, 0)).toEqual([{ from: 0, to: DAY }]);
    expect(gapSegments(w, 1)).toEqual([{ from: 0, to: 8 * HOUR }]);
    expect(gapSegments([slot(1, 0, 24, 'a'), slot(2, 0, 144, 'b')], 1)).toEqual([]);
    expect(hasGaps(w)).toBe(true);
    expect(hasGaps([slot(1, 8, 168, 'a')])).toBe(false);
  });
  it('a slot wrapping round the week is drawn in the first days', () => {
    const w = [slot(6, 20, 12, 'late'), slot(1, 8, 1, 'a')];
    expect(daySegments(w, 0)[0]).toMatchObject({ carry: true, from: 0, to: 8 * HOUR });
  });
  it('places a template where it is free, cut short by the next slot, never inside another slot', () => {
    const w = week();
    const t = { pool: 'movies', length: 4 * HOUR };
    expect(place(w, t, 3, 20 * HOUR, G)).toMatchObject({ day: 3, at: 20 * HOUR, length: 4 * HOUR });
    expect(place(w, t, 2, 19 * HOUR, G)).toBeUndefined(); // Tuesday 19:00 is inside the 08:00-20:00 slot
    expect(place(w, t, 0, 8 * HOUR, G)!.length).toBe(4 * HOUR);
    expect(place([...w, slot(0, 10, 1, 'x')], t, 0, 8 * HOUR, G)!.length).toBe(2 * HOUR); // the next slot starts at 10:00
    expect(place(w, { ...t, name: 'Movie night' }, 3, 20.1 * HOUR, G)).toMatchObject({ at: 20 * HOUR, template: 'Movie night' }); // snapped
    expect(roomFrom(w, 3 * DAY, undefined)).toBe(5 * DAY + 8 * HOUR); // until Monday 08:00
  });
  it('moves a slot by its start and resizes it up to the next slot', () => {
    const w = week();
    const movies = w[1]!;
    expect(moveTo(w, movies, 3, 9 * HOUR, G)).toMatchObject({ day: 3, at: 9 * HOUR, length: 2.25 * HOUR });
    expect(moveTo(w, movies, 1, 9 * HOUR, G)).toBeUndefined(); // inside the morning slot
    expect(resizeTo(w, w[3]!, 30 * HOUR, G).length).toBe(30 * HOUR);
    expect(resizeTo(w, movies, 5 * HOUR, G).length).toBe(2.25 * HOUR); // the rerun starts at 22:15
    expect(resizeTo(w, movies, 0, G).length).toBe(G);
    expect(WEEK).toBe(7 * DAY);
  });
  it('draws the week as calendar events: a slot each, a fixed piece for what runs past Saturday, and the gaps', () => {
    const w = [slot(6, 20, 12, 'late'), slot(1, 8, 1, 'a')];
    const ev = eventsOf(w, 'a', ['late', 'a'], undefined, {});
    const late = ev.filter((e) => e.extendedProps?.['key'] === '6@72000000');
    expect(late.map((e) => [e.extendedProps!['kind'], e.start, e.end, e.editable])).toEqual([
      ['slot', '2023-01-07T20:00:00.000Z', '2023-01-08T08:00:00.000Z', undefined],
      ['carry', '2022-12-31T20:00:00.000Z', '2023-01-01T08:00:00.000Z', false],
    ]);
    const gaps = ev.filter((e) => e.display === 'background');
    expect(gaps.length).toBeGreaterThan(0);
    expect(gaps.every((g) => /plays a$/.test(String(g.extendedProps!['label'])))).toBe(true);
  });
  it('summarises a pool in a line', () => {
    expect(poolSummary({ shows: [{ show: 'A' }, { show: 'B' }, { show: 'C' }, { show: 'D' }], order: 'shuffle' })).toBe('A, B, C +1 (shuffled)');
    expect(poolSummary({ movies: { genre: 'Comedy', duration: { op: '<=', ms: 117 * 60_000 } } })).toBe('Comedy movies <= 117 min');
    expect(poolSummary({ raw: { movies: { match: [{ audio: 'fra' }] } }, order: 'shuffle' })).toBe('movies by rules (shuffled)');
    expect(poolSummary({ raw: { shows: [{ match: { genre: 'Comedy' } }] } })).toBe('shows by rules');
  });
  it('reads the schedule route', () => {
    expect(parseRoute(scheduleLink('Test Channel'))).toEqual({ page: 'schedule', name: 'Test Channel' });
  });
});

const n = encodeURIComponent('Test Channel');
const model = () => ({
  timezone: 'America/Toronto', grid: 900_000, week: week(), fill: 'sitcoms',
  templates: { 'Movie night': { pool: 'movies', length: 135 * 60_000 }, 'Sitcom block': { pool: 'sitcoms', length: 4 * HOUR } },
  pools: { sitcoms: { shows: [{ show: 'Show A' }, { show: 'Show B', id: 'b' }], order: 'sequential' }, movies: { movies: { genre: 'Comedy', duration: { op: '<=', ms: 117 * 60_000 } }, order: 'shuffle' } },
});
const stats = { sitcoms: { count: 300, durations: [22 * 60_000, 44 * 60_000] }, movies: { count: 34, durations: [80 * 60_000, 90 * 60_000, 120 * 60_000] } };

const saves = (posts: { url: string; body: any }[]) => posts.filter((p) => p.url.endsWith('/schedule/model'));

function serve(save?: (b: any) => unknown, extraPools: Record<string, unknown> = {}) {
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
    if (url === `/api/channels/${n}/schedule/model`) return ok({ revision: 1, model: { ...model(), pools: { ...model().pools, ...extraPools } } });
    if (url === '/api/library') return ok({ shows: [{ id: 'a', title: 'Show A' }, { id: 'b', title: 'Show B' }, { id: 'c', title: 'Show C' }], genres: ['Comedy', 'Drama'], values: { genre: [{ value: 'Comedy' }, { value: 'Drama' }, { value: 'Documentary' }], rating: [{ value: 'CA-G' }, { value: 'CA-PG' }], studio: [], tag: [], actor: [], director: [], audio: [{ value: 'fra', label: 'French (fra)' }, { value: 'deu', label: 'German (deu)' }], subtitles: [{ value: 'fra', label: 'French (fra)' }] } });
    return ok({ error: 'not found' }, 404);
  });
  return posts;
}

// The calendar's events are found by their label; role queries over its many elements are very slow in jsdom.
const evs = (re: RegExp): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('.fc-event')].filter((e) => re.test(e.getAttribute('aria-label') ?? ''));
const ev = (re: RegExp): Promise<HTMLElement> => waitFor(() => { const found = evs(re); if (found.length === 0) throw new Error(`no slot matches ${re}`); return found[0]!; });

describe('the schedule designer', () => {
  it('draws the week with a block per slot and no unsaved changes', async () => {
    serve();
    render(<App />);
    const grid = await screen.findByRole('group', { name: 'The week' });
    await ev(/^Mon 20:00/);
    const labels = [...grid.querySelectorAll('.fc-event')].map((b) => b.getAttribute('aria-label')!);
    expect(labels.some((l) => /^Mon 20:00, movies, lasts 2\.25 h/.test(l))).toBe(true);
    expect(labels.some((l) => /^Mon 08:00, sitcoms, continues office, lasts 12 h/.test(l))).toBe(true);
    // (the gaps are background events, which the calendar draws only where it can measure, so they are checked as data above)
    expect(screen.getByText('No changes.')).toBeTruthy();
  });

  it('shows each template as a card with its name, length, pool, what is in it and how many are placed', async () => {
    serve();
    render(<App />);
    const palette = await screen.findByRole('list', { name: 'Slot templates' });
    const movie = within(palette).getByRole('button', { name: /^Movie night: 2 h 15 min, movies: Comedy movies <= 117 min/ });
    expect(movie.textContent).toContain('1 on the week');
    const sit = within(palette).getByRole('button', { name: /^Sitcom block: 4 h, sitcoms: Show A, Show B/ });
    expect(sit.textContent).toContain('1 on the week');
  });

  it('a new template without a length is 2 hours, and it can then be placed', async () => {
    const posts = serve();
    render(<App />);
    await screen.findByRole('list', { name: 'Slot templates' });
    fireEvent.click(screen.getByText('New template', { selector: 'button' }));
    const editor = screen.getByLabelText('Template editor');
    expect((within(editor).getByLabelText('Template length') as HTMLInputElement).value).toBe('120');
    fireEvent.change(within(editor).getByLabelText('Template name'), { target: { value: 'Late sitcoms' } });
    fireEvent.change(within(editor).getByLabelText('Template length'), { target: { value: '' } });
    fireEvent.click(within(editor).getByText('Add the template', { selector: 'button' }));
    expect(screen.getByRole('button', { name: /^Late sitcoms: 2 h, sitcoms/ })).toBeTruthy();
    fireEvent.click(screen.getByText('Save as a new revision', { selector: 'button' }));
    await screen.findByText(/Saved as revision/);
    expect(saves(posts).at(-1)!.body.templates['Late sitcoms']).toEqual({ pool: 'sitcoms', length: 2 * HOUR });
    expect(saves(posts).at(-1)!.body.fill).toBe('sitcoms');
  });

  it('refuses a template with a taken name or a length off the grid', async () => {
    serve();
    render(<App />);
    await screen.findByRole('list', { name: 'Slot templates' });
    fireEvent.click(screen.getByText('New template', { selector: 'button' }));
    const editor = screen.getByLabelText('Template editor');
    fireEvent.change(within(editor).getByLabelText('Template name'), { target: { value: 'Movie night' } });
    fireEvent.click(within(editor).getByText('Add the template', { selector: 'button' }));
    expect((await screen.findByRole('alert')).textContent).toContain('already a template called "Movie night"');
    fireEvent.change(within(editor).getByLabelText('Template name'), { target: { value: 'Odd' } });
    fireEvent.change(within(editor).getByLabelText('Template length'), { target: { value: '100' } });
    fireEvent.click(within(editor).getByText('Add the template', { selector: 'button' }));
    expect(screen.getByRole('alert').textContent).toContain('15-minute grid');
  });

  it('selecting a slot opens its editor; its time, length and pool change the block and saving sends the length and the fill pool', async () => {
    const posts = serve();
    render(<App />);
    const grid = await screen.findByRole('group', { name: 'The week' });
    fireEvent.click(await ev(/^Mon 20:00, movies/));
    let editor = await screen.findByLabelText('The selected slot');
    expect(within(editor).getByRole('heading').textContent).toBe('Mon 20:00');
    fireEvent.change(within(editor).getByLabelText('Lasts, minutes'), { target: { value: '60' } });
    expect(await ev(/^Mon 20:00, movies, lasts 1 h/)).toBeTruthy();
    fireEvent.change(within(editor).getByLabelText('Day of the slot'), { target: { value: '4' } });
    editor = screen.getByLabelText('The selected slot');
    expect(within(editor).getByRole('heading').textContent).toBe('Thu 20:00');
    fireEvent.change(within(editor).getByLabelText('Plays from'), { target: { value: 'sitcoms' } });
    fireEvent.click(screen.getByText('Save as a new revision', { selector: 'button' }));
    expect(await screen.findByText(/Saved as revision 2/)).toBeTruthy();
    const sent = saves(posts).at(-1)!;
    expect(sent.body.week.find((s: any) => s.day === 4 && s.at === 20 * HOUR)).toMatchObject({ pool: 'sitcoms', length: HOUR });
    expect(sent.body.fill).toBe('sitcoms');
    expect(sent.body.force).toBe(false);
  });

  it('places from the form, refuses an occupied moment, and removing a slot leaves a gap', async () => {
    const posts = serve();
    render(<App />);
    await screen.findByRole('group', { name: 'The week' });
    const form = screen.getByLabelText('Place a template');
    fireEvent.change(within(form).getByLabelText('Template to place'), { target: { value: 'Movie night' } });
    fireEvent.change(within(form).getByLabelText('Time'), { target: { value: '21:00' } });
    fireEvent.change(within(form).getByDisplayValue('Mon'), { target: { value: '6' } });
    fireEvent.click(within(form).getByText('Place', { selector: 'button' }));
    expect(await ev(/^Sat 21:00, movies/)).toBeTruthy();
    fireEvent.click(within(form).getByText('Place', { selector: 'button' }));
    expect((await screen.findByRole('alert')).textContent).toContain('no room');
    fireEvent.click(await ev(/^Sat 21:00, movies/));
    fireEvent.click(screen.getByText('Remove this slot', { selector: 'button' }));
    expect(evs(/^Sat 21:00/)).toHaveLength(0);
    expect(posts.some((p) => p.url.endsWith('/schedule/model'))).toBe(false);
  });

  it('asks for a fill pool when part of the week has no slot, and will not save without one', async () => {
    serve();
    render(<App />);
    await screen.findByRole('group', { name: 'The week' });
    fireEvent.change(screen.getByLabelText('Fill pool'), { target: { value: '' } });
    expect(screen.getByRole('alert').textContent).toContain('choose a fill pool');
    expect((screen.getByText('Save as a new revision', { selector: 'button' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Fill pool'), { target: { value: 'movies' } });
    expect(screen.queryByText('No changes.')).toBeNull();
    expect((screen.getByText('Save as a new revision', { selector: 'button' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('changing a template changes the slots placed from it that still match, and keeps hand-edited ones', async () => {
    const posts = serve();
    render(<App />);
    const grid = await screen.findByRole('group', { name: 'The week' });
    // Place a second Movie night, then change the first by hand so only the second still matches.
    fireEvent.change(screen.getByLabelText('Template to place'), { target: { value: 'Movie night' } });
    fireEvent.change(screen.getByDisplayValue('Mon'), { target: { value: '6' } });
    fireEvent.click(screen.getByText('Place', { selector: 'button' }));
    fireEvent.click(await ev(/^Mon 20:00, movies/));
    fireEvent.change(screen.getByLabelText('Lasts, minutes'), { target: { value: '120' } });
    fireEvent.click(screen.getByRole('button', { name: 'Edit template Movie night' }));
    const editor = screen.getByLabelText('Template editor');
    expect(within(editor).getByText(/Also change the 1 slot on the week/)).toBeTruthy();
    fireEvent.change(within(editor).getByLabelText('Template length'), { target: { value: '90' } });
    fireEvent.change(within(editor).getByLabelText('Template name'), { target: { value: 'Short movie' } });
    fireEvent.click(within(editor).getByText('Save the template', { selector: 'button' }));
    expect(await ev(/^Sat 20:00, movies, lasts 1\.5 h/)).toBeTruthy(); // followed the template
    expect(await ev(/^Mon 20:00, movies, lasts 2 h/)).toBeTruthy(); // kept its own length
    fireEvent.click(screen.getByText('Save as a new revision', { selector: 'button' }));
    await screen.findByText(/Saved as revision/);
    const body = saves(posts).at(-1)!.body;
    expect(Object.keys(body.templates)).toContain('Short movie');
    expect(Object.keys(body.templates)).not.toContain('Movie night');
    expect(body.week.filter((s: any) => s.template === 'Short movie')).toHaveLength(2);
  });

  it('links a slot, with a name, and clears the link', async () => {
    const posts = serve();
    render(<App />);
    const grid = await screen.findByRole('group', { name: 'The week' });
    fireEvent.click(await ev(/^Mon 20:00, movies/));
    const editor = screen.getByLabelText('The selected slot');
    fireEvent.change(within(editor).getByLabelText('Link'), { target: { value: 'rerun' } });
    expect(await ev(/^Mon 20:00, movies, rerun of office/)).toBeTruthy();
    fireEvent.change(within(editor).getByLabelText('Link name'), { target: { value: 'night' } });
    expect(await ev(/rerun of night/)).toBeTruthy();
    fireEvent.change(within(editor).getByLabelText('Link'), { target: { value: '' } });
    expect(screen.getByText('No changes.')).toBeTruthy();
    fireEvent.click(await ev(/^Mon 22:15, sitcoms, rerun of office/));
    fireEvent.change(within(screen.getByLabelText('The selected slot')).getByLabelText('Link'), { target: { value: '' } });
    fireEvent.click(screen.getByText('Save as a new revision', { selector: 'button' }));
    await screen.findByText(/Saved as revision/);
    const sent = saves(posts).at(-1)!.body.week.find((s: any) => s.day === 1 && s.at === 22.25 * HOUR);
    expect(sent.link).toBeUndefined();
    expect(sent.linkMode).toBeUndefined();
  });

  it('shows what each pool holds and warns about a slot no program fits', async () => {
    serve();
    render(<App />);
    const grid = await screen.findByRole('group', { name: 'The week' });
    await waitFor(() => expect(screen.getByText(/300 programs, 22 to 44 min/)).toBeTruthy());
    fireEvent.click(await ev(/^Mon 20:00, movies/));
    fireEvent.change(screen.getByLabelText('Lasts, minutes'), { target: { value: '75' } });
    expect(await ev(/No program of movies fits this 75-minute slot/)).toBeTruthy();
  });

  it('edits pools: shows are added and removed, a movie filter changes, a used pool cannot be removed, a new pool is added', async () => {
    const posts = serve();
    render(<App />);
    await screen.findByRole('group', { name: 'The week' });
    fireEvent.change(screen.getByLabelText('Add a show to sitcoms'), { target: { value: 'c' } });
    const chips = (): string[] => [...document.querySelectorAll('.poolcard .chips .chip')].map((c) => c.textContent!.replace('×', ''));
    expect(chips()).toEqual(['Show A', 'Show B', 'Show C']);
    fireEvent.click(screen.getByRole('button', { name: 'Remove Show A from sitcoms' }));
    expect(chips()).toEqual(['Show B', 'Show C']);
    fireEvent.change(screen.getByLabelText('Genre for movies'), { target: { value: 'Drama' } });
    fireEvent.change(screen.getByLabelText('Longest movie in movies, minutes'), { target: { value: '100' } });
    expect((screen.getAllByRole('button', { name: 'Remove pool' })[0] as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Name of the new pool'), { target: { value: 'kids' } });
    fireEvent.change(screen.getByLabelText('Kind of the new pool'), { target: { value: 'movies' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add the pool' }));
    fireEvent.click(screen.getByText('Save as a new revision', { selector: 'button' }));
    await screen.findByText(/Saved as revision/);
    const pools = saves(posts).at(-1)!.body.pools;
    expect(pools.sitcoms.shows.map((s: any) => s.show)).toEqual(['Show B', 'Show C']);
    expect(pools.movies.movies).toEqual({ genre: 'Drama', duration: { op: '<=', ms: 100 * 60_000 } });
    expect(pools.kids).toEqual({ movies: {}, order: 'shuffle' });
  });

  it('edits the rules of a pool: conditions, a list of rules, shows by rule, and a plain pool turned into rules', async () => {
    const posts = serve(undefined, {
      french: { raw: { movies: { match: [{ audio: 'French' }, { subtitles: 'fra' }], duration: '<=135m' } }, order: 'shuffle' },
      comedy: { raw: { shows: ['Show A', { match: { genre: 'Comedy' } }], episodes: { specials: 'skip' } } },
    });
    render(<App />);
    await screen.findByRole('group', { name: 'The week' });
    const input = (label: string): HTMLInputElement => screen.getByLabelText(label) as HTMLInputElement;
    expect(input('french rule 1: Audio language').value).toBe('French');
    expect(input('french always: Length').value).toBe('<=135m');
    fireEvent.change(input('french rule 1: Audio language'), { target: { value: 'French, German' } });
    fireEvent.click(within(screen.getByLabelText('Rules of french')).getAllByRole('button', { name: 'Add a rule' })[0]!);
    fireEvent.change(input('french rule 3: Year'), { target: { value: '1980-1989' } });
    fireEvent.click(screen.getByRole('button', { name: 'Remove french rule 2' }));
    fireEvent.change(input('comedy entry 2 rule 1: Rating'), { target: { value: 'CA-G, CA-PG' } });
    fireEvent.change(input('comedy entry 2: shows left out'), { target: { value: 'Archer' } });
    fireEvent.change(screen.getByLabelText('comedy episodes: seasons'), { target: { value: '1-3' } });
    fireEvent.change(screen.getByLabelText('comedy episodes: order'), { target: { value: 'airdate' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Edit as rules' })[0]!); // the first plain pool: sitcoms
    fireEvent.click(screen.getByText('Save as a new revision', { selector: 'button' }));
    await screen.findByText(/Saved as revision/);
    const pools = saves(posts).at(-1)!.body.pools;
    expect(pools.french.raw.movies).toEqual({ match: [{ audio: ['French', 'German'] }, { year: '1980-1989' }], duration: '<=135m' });
    expect(pools.comedy.raw.shows[1]).toEqual({ match: { genre: 'Comedy', rating: ['CA-G', 'CA-PG'] }, except: [{ show: 'Archer' }] });
    expect(pools.comedy.raw.episodes).toEqual({ specials: 'skip', seasons: '1-3', order: 'airdate' });
    expect(pools.sitcoms.raw).toEqual({ shows: ['Show A', { show: 'Show B', id: 'b' }] });
  });

  it('suggests library values in a rule box, finishes the last one of a list, and marks a value the library lacks', async () => {
    const posts = serve(undefined, { french: { raw: { movies: { match: [{ genre: 'Comedy' }] } }, order: 'shuffle' } });
    render(<App />);
    await screen.findByRole('group', { name: 'The week' });
    const box = screen.getByLabelText('french rule 1: Genre') as HTMLInputElement;
    expect(screen.queryByText(/Not in the library/)).toBeNull();
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: 'Comedy, Do' } });
    const list = await screen.findByRole('listbox', { name: 'french rule 1: Genre: suggestions' });
    expect(within(list).getAllByRole('option').map((o) => o.textContent)).toEqual(['Documentary', 'Drama'].filter((x) => x.toLowerCase().includes('do')));
    fireEvent.click(within(list).getByRole('option', { name: 'Documentary' }));
    expect(box.value).toBe('Comedy, Documentary');
    fireEvent.change(box, { target: { value: 'Comdey' } });
    expect(await screen.findByText('Not in the library: Comdey')).toBeTruthy();
    // a language is found by its name and kept as typed
    const audio = screen.getByLabelText('french rule 1: Audio language');
    fireEvent.focus(audio);
    fireEvent.change(audio, { target: { value: 'fren' } });
    fireEvent.click(await screen.findByRole('option', { name: 'French (fra)' }));
    expect((audio as HTMLInputElement).value).toBe('fra');
    expect(screen.queryByText(/Not in the library: fra/)).toBeNull();
    void posts;
  });

  it('keeps a comma while a list is typed one character at a time, in a rule box and in the shows left out', async () => {
    const posts = serve(undefined, {
      french: { raw: { movies: { match: [{ genre: 'Comedy' }] } }, order: 'shuffle' },
      comedy: { raw: { shows: ['Show A', { match: { genre: 'Comedy' } }] } },
    });
    render(<App />);
    await screen.findByRole('group', { name: 'The week' });
    const typeIn = (box: HTMLInputElement, text: string): void => { for (const ch of text) fireEvent.change(box, { target: { value: box.value + ch } }); }; // a key adds to what the box shows now
    const genre = screen.getByLabelText('french rule 1: Genre') as HTMLInputElement;
    fireEvent.change(genre, { target: { value: '' } });
    typeIn(genre, 'Comedy, Horror');
    expect(genre.value).toBe('Comedy, Horror');
    const left = screen.getByLabelText('comedy entry 2: shows left out') as HTMLInputElement;
    typeIn(left, 'Archer, Lucifer');
    expect(left.value).toBe('Archer, Lucifer');
    fireEvent.click(screen.getByText('Save as a new revision', { selector: 'button' }));
    await screen.findByText(/Saved as revision/);
    const pools = saves(posts).at(-1)!.body.pools;
    expect(pools.french.raw.movies.match).toEqual({ genre: ['Comedy', 'Horror'] });
    expect(pools.comedy.raw.shows[1].except).toEqual([{ show: 'Archer' }, { show: 'Lucifer' }]);
  });

  it('will not save over locked slots until told to, and can discard changes', async () => {
    const posts = serve((b) => (b.force ? { saved: true, revision: 2 } : { saved: false, revision: 1, impact: { conflicts: [{ start: 1, reason: 'window-changed', message: 'no slot starts there any more' }], changes: [], staged: 2 } }));
    render(<App />);
    const grid = await screen.findByRole('group', { name: 'The week' });
    fireEvent.click(await ev(/^Mon 20:00, movies/));
    fireEvent.change(screen.getByLabelText('Lasts, minutes'), { target: { value: '60' } });
    fireEvent.click(screen.getByText('Save as a new revision', { selector: 'button' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Not saved');
    fireEvent.click(within(alert).getByText('Save anyway', { selector: 'button' }));
    expect(await screen.findByText(/Saved as revision 2/)).toBeTruthy();
    expect(saves(posts).at(-1)!.body.force).toBe(true);
    const again = await screen.findByRole('group', { name: 'The week' });
    fireEvent.click(await ev(/^Mon 20:00, movies/));
    fireEvent.change(screen.getByLabelText('Lasts, minutes'), { target: { value: '45' } });
    fireEvent.click(screen.getByText('Discard changes', { selector: 'button' }));
    expect(screen.getByText('No changes.')).toBeTruthy();
  });
});
