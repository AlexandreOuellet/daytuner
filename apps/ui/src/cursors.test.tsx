// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { polling } from './api';
import { slotLabel } from './format';
import { cursorsLink, parseRoute } from './router';

beforeEach(() => { polling.intervalMs = 0; window.location.hash = cursorsLink('Test Channel'); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.location.hash = ''; });

const n = encodeURIComponent('Test Channel');
const EDGE = Date.UTC(2026, 10, 14, 19, 59);
const card = { key: 'seq:a', pool: 'sitcoms', length: 161, slots: ['1@28800000', '1@81000000'], slotInfo: [{ id: '1@28800000', mode: 'continue' }, { id: '1@81000000', mode: 'rerun' }], perWeek: 5, position: 10, history: 10, next: { programId: 'ep11', title: 'Ep 11' } };
const titles = { ep9: 'Ep 9', ep10: 'Ep 10', ep11: 'Ep 11', ep12: 'Ep 12' };
const preview = (over: object = {}) => ({
  key: 'seq:a', pool: 'sitcoms', length: 161, before: { position: 10, history: 10 }, after: { position: 10, history: 10 }, committedUntil: EDGE,
  next: { before: 'ep11', after: 'ep11' }, titles,
  airings: [
    { start: Date.UTC(2026, 10, 16, 13), slotId: '1@28800000', kind: 'continue', before: ['ep11'], after: ['ep11'], staged: true, locked: false },
    { start: Date.UTC(2026, 10, 17, 13), slotId: '1@28800000', kind: 'continue', before: ['ep12'], after: ['ep12'], staged: false, locked: false },
  ], ...over,
});

function serve(handlers: { preview: (body: any) => unknown | Response }) {
  const posts: { url: string; body: any }[] = [];
  let cursorLoads = 0;
  vi.stubGlobal('fetch', async (url: string, init?: { method?: string; body?: string }) => {
    const ok = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
    if (init?.method === 'POST') {
      const body = JSON.parse(init.body ?? '{}');
      posts.push({ url, body });
      if (url.endsWith('/cursors/preview')) {
        const r = handlers.preview(body) as { status?: number; error?: string } | object;
        if ((r as { status?: number }).status) return ok({ error: (r as { error?: string }).error }, (r as { status: number }).status);
        return ok({ job: { id: 'j', channel: 'Test Channel', kind: 'p', state: 'done', message: 'done', result: r } }, 202);
      }
      if (url.endsWith('/cursors/adjust')) return ok({ job: { id: 'a', channel: 'Test Channel', kind: 'adjust', state: 'done', message: 'done', result: { before: { position: 10 }, after: { position: 5 } } } }, 202);
    }
    if (url === '/api/health') return ok({ ok: true, version: '0', writes: false });
    if (url === `/api/channels/${n}`) return ok({ name: 'Test Channel', tunarrId: 't', timezone: 'America/Toronto', floorMs: 1, stepMs: 1, revision: 1, edge: EDGE, aheadMs: 1, pendingCommit: false, staged: 0, runAtMinutes: 180, commits: [] });
    if (url === `/api/channels/${n}/cursors`) { cursorLoads++; return ok([card]); }
    return ok({ error: 'not found' }, 404);
  });
  return { posts, loads: () => cursorLoads };
}

describe('routing and labels', () => {
  it('reads the cursors route, and labels a slot by day and time', () => {
    expect(parseRoute(cursorsLink('Test Channel'))).toEqual({ page: 'cursors', name: 'Test Channel' });
    expect(parseRoute('#/channel/X')).toEqual({ page: 'channel', name: 'X' });
    expect(slotLabel('1@72000000')).toBe('Mon 20:00');
    expect(slotLabel('nonsense')).toBe('nonsense');
  });
});

describe('the cursors page', () => {
  it('shows each show with its next episode, its slots and its next airings', async () => {
    serve({ preview: () => preview() });
    render(<App />);
    const heading = await screen.findByRole('heading', { name: 'sitcoms' });
    const art = heading.closest('article')!;
    expect(within(art).getByText('Ep 11', { selector: 'strong' })).toBeTruthy();
    expect(within(art).getByText('(11 of 161)')).toBeTruthy();
    expect(within(art).getByText(/Mon 08:00 \(continues\), Mon 22:30 \(rerun\)/)).toBeTruthy();
    expect(await within(art).findByText('staged')).toBeTruthy();
    expect(within(art).getAllByText(/Ep 12/).length).toBeGreaterThan(0);
    expect(within(art).getByText(/rewinds by 5/)).toBeTruthy();
  });

  it('previews "missed a week" before applying: the new next episode, what is committed, what each airing becomes', async () => {
    const s = serve({
      preview: (b) => (b.amount === 0 ? preview() : preview({
        after: { position: 5, history: 5 }, next: { before: 'ep11', after: 'ep10' },
        airings: [{ start: Date.UTC(2026, 10, 16, 13), slotId: '1@28800000', kind: 'continue', before: ['ep11'], after: ['ep10'], staged: true, locked: false },
                  { start: Date.UTC(2026, 10, 17, 13), slotId: '1@28800000', kind: 'continue', before: ['ep12'], after: ['ep12'], staged: true, locked: true }],
      })),
    });
    render(<App />);
    await screen.findByRole('heading', { name: 'sitcoms' });
    fireEvent.click(screen.getByRole('button', { name: 'Missed a week' }));
    const panel = await screen.findByLabelText('What this would change');
    expect(s.posts.at(-1)).toMatchObject({ body: { key: 'seq:a', kind: 'rewind', amount: 5 } });
    expect(panel.querySelector('p strong')!.textContent).toBe('Ep 10'); // the new next-up episode
    expect(within(panel).getAllByText('Ep 10', { selector: 'strong' })).toHaveLength(2); // and the airing it changes
    expect(within(panel).getByText(/was Ep 11/)).toBeTruthy();
    expect(within(panel).getByText(/Already in Tunarr until 2026-11-14 14:59: that stays as it is/)).toBeTruthy();
    expect(within(panel).getByText('locked: keeps its episodes')).toBeTruthy();
    expect(within(panel).getByText(/A locked slot keeps its episodes/)).toBeTruthy();
    expect(s.posts.some((p) => p.url.endsWith('/adjust'))).toBe(false); // nothing applied yet
    fireEvent.click(within(panel).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByLabelText('What this would change')).toBeNull();
  });

  it('applies the adjustment, says it is done, and reloads the page\'s data', async () => {
    const s = serve({ preview: () => preview({ next: { before: 'ep11', after: 'ep10' } }) });
    render(<App />);
    await screen.findByRole('heading', { name: 'sitcoms' });
    const before = s.loads();
    fireEvent.click(screen.getByRole('button', { name: 'Missed a week' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Apply' }));
    expect(await screen.findByText('Done: rewound 5 episodes.')).toBeTruthy();
    expect(s.posts.find((p) => p.url.endsWith('/adjust'))!.body).toEqual({ key: 'seq:a', kind: 'rewind', amount: 5 });
    await waitFor(() => expect(s.loads()).toBeGreaterThan(before));
  });

  it('rewinds by a number, and sets to an episode (numbered from 1, sent from 0)', async () => {
    const s = serve({ preview: () => preview() });
    render(<App />);
    await screen.findByRole('heading', { name: 'sitcoms' });
    fireEvent.change(screen.getByLabelText(/Rewind by/), { target: { value: '3' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Preview' })[0]!);
    await screen.findByLabelText('What this would change');
    expect(s.posts.at(-1)!.body).toEqual({ key: 'seq:a', kind: 'rewind', amount: 3 });
    fireEvent.change(screen.getByLabelText(/Set to episode/), { target: { value: '50' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Preview' })[1]!);
    await waitFor(() => expect(s.posts.at(-1)!.body).toEqual({ key: 'seq:a', kind: 'set', amount: 49 }));
  });

  it('says why when the channel is busy, and leaves the page usable', async () => {
    serve({ preview: (b) => (b.amount === 0 ? preview() : { status: 409, error: '"Test Channel" is busy: stage is still running' }) });
    render(<App />);
    await screen.findByRole('heading', { name: 'sitcoms' });
    fireEvent.click(screen.getByRole('button', { name: 'Missed a week' }));
    expect((await screen.findByRole('alert')).textContent).toContain('is busy');
    expect(screen.queryByLabelText('What this would change')).toBeNull();
  });
});
