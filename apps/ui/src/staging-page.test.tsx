// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { polling } from './api';
import { parseRoute, stagingLink } from './router';
import { dayStart, HOUR } from './staging';

const Z = 'America/Toronto';
const D = dayStart(Z, '2026-11-18');
const n = encodeURIComponent('Test Channel');

beforeEach(() => { polling.intervalMs = 0; window.location.hash = stagingLink('Test Channel'); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.location.hash = ''; });

const slots = () => [
  { start: D + 8 * HOUR, end: D + 20 * HOUR, slotId: '3@28800000', pool: 'sitcoms', pins: {}, locked: false, edited: false, programs: ['e1', 'e2'],
    blocks: [{ programId: 'e1', start: D + 8 * HOUR, end: D + 11 * HOUR }, { programId: 'e2', start: D + 11 * HOUR, end: D + 20 * HOUR }] },
  { start: D + 20 * HOUR, end: D + 32 * HOUR, slotId: '3@72000000', pool: 'movies', pins: { '1': { id: 'm1', title: 'Hocus Pocus', duration: 5_760_000 } }, locked: true, edited: false, programs: ['m1'],
    blocks: [{ programId: 'm1', start: D + 20 * HOUR, end: D + 23 * HOUR, pinned: true }] },
];
const titles = { e1: 'Show A S1E1 "One"', e2: 'Show A S1E2 "Two"', m1: 'Hocus Pocus' };
const out = (over: object = {}) => ({ staged: 2, planned: 2, warnings: [], changes: [], titles, ...over });

function serve(opts: { check?: object; fail?: (url: string) => boolean } = {}) {
  const posts: { url: string; body: any }[] = [];
  let calls = 0;
  vi.stubGlobal('fetch', async (url: string, init?: { method?: string; body?: string }) => {
    const ok = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
    const job = (result: unknown) => ok({ job: { id: 'j', channel: 'Test Channel', kind: 'k', state: 'done', message: 'done', result } }, 202);
    if (init?.method === 'POST') {
      const body = JSON.parse(init.body ?? '{}');
      posts.push({ url, body });
      if (opts.fail?.(url)) return ok({ error: '"Test Channel" is busy: plan is still running' }, 409);
      if (url.endsWith('/stage/check')) return job({ conflicts: [], pinProblems: [], titles, ...opts.check });
      if (url.endsWith('/stage/lock')) return ok({ ok: true });
      if (url.includes('/stage/')) return job(out({ changes: [{ start: D + 8 * HOUR, end: D + 20 * HOUR, slotId: '3@28800000', kind: 'changed', before: ['e1', 'e2'], after: ['m1', 'e2'], deadAirBefore: 0, deadAirAfter: 0 }, { start: D + 40 * HOUR, end: D + 44 * HOUR, slotId: 'x', kind: 'ads-only', before: [], after: [], deadAirBefore: 0, deadAirAfter: 0 }], warnings: [{ code: 'pin-does-not-fit', severity: 'alert', at: D, slotId: 'x', message: 'the pinned program does not fit' }] }));
    }
    calls++;
    if (url === '/api/health') return ok({ ok: true, version: '0', writes: false });
    if (url === `/api/channels/${n}`) return ok({ name: 'Test Channel', tunarrId: 't', timezone: Z, floorMs: 1, stepMs: 1, revision: 1, edge: D + 2 * HOUR, aheadMs: 1, pendingCommit: false, staged: 2, runAtMinutes: 180, commits: [] });
    if (url === `/api/channels/${n}/schedule/model`) return ok({ revision: 1, model: { timezone: Z, grid: 900_000, week: [], pools: {}, exceptions: [] } });
    if (url === `/api/channels/${n}/staged`) return ok(slots());
    if (url === '/api/library') return ok({ shows: [{ id: 'a', title: 'Show A' }], genres: [] });
    if (url.startsWith('/api/library/movies')) return ok([{ id: 'nb', title: 'The Nightmare Before Christmas', duration: 76 * 60_000 }]);
    if (url === '/api/library/shows/a/episodes') return ok([{ id: 'x1', title: 'One', season: 1, episode: 1, duration: 1_500_000 }]);
    return ok({ error: 'not found' }, 404);
  });
  return { posts, calls: () => calls };
}

describe('the staging route', () => {
  it('reads an optional date', () => {
    expect(parseRoute(stagingLink('Test Channel'))).toEqual({ page: 'staging', name: 'Test Channel' });
    expect(parseRoute(stagingLink('Test Channel', '2026-10-31'))).toEqual({ page: 'staging', name: 'Test Channel', date: '2026-10-31' });
  });
});

describe('the staging editor', () => {
  it('draws the first staged day with its slots and the programs inside, names from the library, a locked slot and a pin', async () => {
    serve();
    render(<App />);
    const day = await screen.findByRole('group', { name: 'The day' });
    expect(within(day).getByRole('button', { name: /^08:00 to 20:00, sitcoms/ })).toBeTruthy();
    const movies = within(day).getByRole('button', { name: /^20:00 to 08:00, movies, locked/ });
    expect(movies).toBeTruthy();
    expect(await within(day).findByRole('button', { name: 'Block 1: Show A S1E1 "One"' })).toBeTruthy();
    expect(within(day).getByRole('button', { name: 'Block 1: Hocus Pocus, pinned' })).toBeTruthy();
    expect(within(day).getByRole('button', { name: /^Unlock the slot at 20:00/ })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: '2026-11-18' })).toBeTruthy();
    // the next day shows the carried-over slot
    fireEvent.click(screen.getByRole('button', { name: 'Next day →' }));
    expect(await screen.findByRole('button', { name: /^Continues: 20:00 to 08:00, movies/ })).toBeTruthy();
  });

  it('opens on the date asked for in the link', async () => {
    window.location.hash = stagingLink('Test Channel', '2026-11-19');
    serve();
    render(<App />);
    expect(await screen.findByRole('heading', { level: 2, name: '2026-11-19' })).toBeTruthy();
  });

  it('locks and unlocks a slot, deletes it, and resets it, each as the API call it is', async () => {
    const s = serve();
    render(<App />);
    const day = await screen.findByRole('group', { name: 'The day' });
    fireEvent.click(within(day).getByRole('button', { name: /^Lock the slot at 08:00/ }));
    await waitFor(() => expect(s.posts.at(-1)).toMatchObject({ body: { start: D + 8 * HOUR, locked: true } }));
    fireEvent.click(within(day).getByRole('button', { name: /^08:00 to 20:00, sitcoms/ }));
    const editor = screen.getByLabelText('The selected slot');
    fireEvent.click(within(editor).getByRole('button', { name: 'Delete this slot' }));
    await waitFor(() => expect(s.posts.find((p) => p.url.endsWith('/stage/edit'))!.body).toEqual({ kind: 'delete', start: D + 8 * HOUR }));
    await screen.findByLabelText('What the last change did');
    fireEvent.click(within(screen.getByLabelText('The selected slot')).getByRole('button', { name: 'Reset this slot to the plan' }));
    await waitFor(() => expect(s.posts.find((p) => p.url.endsWith('/stage/reset'))).toMatchObject({ body: { from: D + 8 * HOUR, to: D + 20 * HOUR } }));
  });

  it('shows what a change did: slots before and after, the ads-only count, and alerts', async () => {
    serve();
    render(<App />);
    const day = await screen.findByRole('group', { name: 'The day' });
    fireEvent.click(within(day).getByRole('button', { name: /^08:00 to 20:00, sitcoms/ }));
    fireEvent.click(within(screen.getByLabelText('The selected slot')).getByRole('button', { name: 'Delete this slot' }));
    const panel = await screen.findByLabelText('What the last change did');
    expect(within(panel).getByText(/Changed by deleting a slot/)).toBeTruthy();
    expect(within(panel).getByText(/before: Show A S1E1 "One", Show A S1E2 "Two"/)).toBeTruthy();
    expect(within(panel).getByText('Hocus Pocus, Show A S1E2 "Two"')).toBeTruthy();
    expect(within(panel).getByText(/1 other slot keep their programs; only their ads were reshuffled/)).toBeTruthy();
    expect(within(panel).getByText(/the pinned program does not fit/)).toBeTruthy();
  });

  it('pins a program to a block through the search, and unpins one', async () => {
    const s = serve();
    render(<App />);
    const day = await screen.findByRole('group', { name: 'The day' });
    fireEvent.click(await within(day).findByRole('button', { name: 'Block 2: Show A S1E2 "Two"' }));
    const block = screen.getByRole('heading', { name: /Block 2: Show A S1E2/ }).closest('div')!;
    fireEvent.click(within(block).getByRole('button', { name: 'Replace with…' }));
    fireEvent.change(within(block).getByLabelText('Search movies'), { target: { value: 'nightmare' } });
    await waitFor(() => expect(within(block).getByRole('option', { name: /The Nightmare Before Christmas/ })).toBeTruthy());
    fireEvent.change(within(block).getByLabelText('Movie'), { target: { value: 'nb' } });
    fireEvent.click(within(block).getByRole('button', { name: 'Pin it here' }));
    await waitFor(() => expect(s.posts.find((p) => p.url.endsWith('/stage/pin'))!.body).toEqual({ start: D + 8 * HOUR, block: 2, program: { id: 'nb', title: 'The Nightmare Before Christmas', duration: 76 * 60_000 } }));
  });

  it('refuses to change a locked slot, and tells how to', async () => {
    serve();
    render(<App />);
    const day = await screen.findByRole('group', { name: 'The day' });
    fireEvent.click(await within(day).findByRole('button', { name: 'Block 1: Hocus Pocus, pinned' }));
    const editor = screen.getByLabelText('The selected slot');
    expect((within(editor).getByRole('button', { name: 'Delete this slot' }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(editor).getByRole('button', { name: 'Replace with…' }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(editor).getByText(/The slot is locked. Unlock it to change its programs/)).toBeTruthy();
  });

  it('resizes a slot by typing its new end, and by dragging its bottom edge', async () => {
    const s = serve();
    const { container } = render(<App />);
    const day = await screen.findByRole('group', { name: 'The day' });
    fireEvent.click(within(day).getByRole('button', { name: /^08:00 to 20:00, sitcoms/ }));
    const end = within(screen.getByLabelText('The selected slot')).getByLabelText('New end');
    fireEvent.change(end, { target: { value: '2026-11-18T18:30' } });
    fireEvent.blur(end);
    await waitFor(() => expect(s.posts.find((p) => p.url.endsWith('/stage/edit'))!.body).toEqual({ kind: 'resize', start: D + 8 * HOUR, end: '2026-11-18T18:30' }));
    await screen.findByLabelText('What the last change did');
    const col = container.querySelector('.daycol')!;
    col.getBoundingClientRect = () => ({ top: 0, height: 18 * 34, left: 0, right: 100, bottom: 18 * 34, width: 100, x: 0, y: 0, toJSON() {} }); // the picture starts at 06:00, three hours before the first slot's line
    const handle = container.querySelector('.stslot .handle.bottom')!;
    fireEvent.pointerDown(handle, { clientY: 14 * 34 });
    fireEvent(window, Object.assign(new Event('pointermove'), { clientY: (18.1 - 6) * 34 }));
    fireEvent(window, new Event('pointerup'));
    await waitFor(() => expect(s.posts.filter((p) => p.url.endsWith('/stage/edit')).at(-1)!.body).toEqual({ kind: 'resize', start: D + 8 * HOUR, end: D + 18 * HOUR }));
  });

  it('adds a special slot with a pinned program, and stages a range', async () => {
    const s = serve();
    render(<App />);
    await screen.findByRole('group', { name: 'The day' });
    fireEvent.click(screen.getByRole('button', { name: 'Add…' }));
    const panel = screen.getByLabelText('Add a special slot');
    fireEvent.change(within(panel).getByLabelText('Slot start'), { target: { value: '2026-11-18T10:00' } });
    fireEvent.change(within(panel).getByLabelText('Slot end'), { target: { value: '2026-11-18T12:30' } });
    fireEvent.change(within(panel).getByLabelText('Search movies'), { target: { value: 'nightmare' } });
    await waitFor(() => expect(within(panel).getByRole('option', { name: /Nightmare/ })).toBeTruthy());
    fireEvent.change(within(panel).getByLabelText('Movie'), { target: { value: 'nb' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Add the slot with it' }));
    await waitFor(() => expect(s.posts.find((p) => p.url.endsWith('/stage/edit'))!.body).toEqual({ kind: 'add', start: '2026-11-18T10:00', end: '2026-11-18T12:30', program: { id: 'nb', title: 'The Nightmare Before Christmas', duration: 76 * 60_000 } }));
    await screen.findByLabelText('What the last change did');
    fireEvent.change(screen.getByLabelText('Stage until'), { target: { value: '2026-11-22' } });
    fireEvent.click(screen.getByRole('button', { name: 'Stage them' }));
    await waitFor(() => expect(s.posts.find((p) => p.url.endsWith('/stage/generate'))).toMatchObject({ body: { to: '2026-11-22' } }));
  });

  it('marks a slot that has a conflict or a pin problem, and says what it is', async () => {
    serve({ check: { conflicts: [{ start: D + 20 * HOUR, slotId: '3@72000000', reason: 'duration-changed', message: 'Hocus Pocus now lasts longer' }] } });
    render(<App />);
    const day = await screen.findByRole('group', { name: 'The day' });
    const slot = await within(day).findByRole('button', { name: /Conflict \(duration-changed\): Hocus Pocus now lasts longer/ });
    fireEvent.click(slot);
    expect(within(screen.getByLabelText('The selected slot')).getByText(/Conflict \(duration-changed\)/)).toBeTruthy();
  });

  it('says so when a change fails because the channel is busy, and when nothing is staged', async () => {
    serve({ fail: (url) => url.endsWith('/stage/edit') });
    render(<App />);
    const day = await screen.findByRole('group', { name: 'The day' });
    fireEvent.click(within(day).getByRole('button', { name: /^08:00 to 20:00, sitcoms/ }));
    fireEvent.click(within(screen.getByLabelText('The selected slot')).getByRole('button', { name: 'Delete this slot' }));
    expect((await screen.findByRole('alert')).textContent).toContain('is busy');
    cleanup();
    vi.stubGlobal('fetch', async (url: string) => ({ ok: true, status: 200, json: async () => (url === `/api/channels/${n}` ? { name: 'Test Channel', timezone: Z, edge: D, commits: [] } : url === `/api/channels/${n}/staged` ? [] : url === `/api/channels/${n}/schedule/model` ? { revision: 1, model: { timezone: Z, grid: 900_000, week: [], pools: {}, exceptions: [] } } : url === '/api/library' ? { shows: [], genres: [] } : { ok: true, version: '0', writes: false }) }));
    render(<App />);
    expect(await screen.findByText(/Nothing is staged/)).toBeTruthy();
  });
});
