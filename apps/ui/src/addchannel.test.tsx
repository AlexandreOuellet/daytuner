// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { polling } from './api';

beforeEach(() => { polling.intervalMs = 0; window.location.hash = '#/add'; });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.location.hash = ''; });

function serve(canCreate: boolean, channels = [{ id: 'old-1', number: 7, name: 'Old Channel' }]) {
  const posts: { url: string; body: any }[] = [];
  vi.stubGlobal('fetch', async (url: string, init?: { method?: string; body?: string }) => {
    const ok = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
    if (init?.method === 'POST') {
      const body = JSON.parse(init.body ?? '{}');
      posts.push({ url, body });
      return ok({ job: { id: 'j', channel: 'x', kind: 'k', state: 'done', message: 'done', result: { name: body.name ?? 'Old Channel', tunarrName: 'x', edge: 0, notes: [] } } }, 202);
    }
    if (url === '/api/health') return ok({ ok: true, version: '0', writes: canCreate });
    if (url === '/api/add-channel') return ok({ timezone: 'America/Toronto', canCreate, grids: [5, 10, 15, 20, 30, 60], nextNumber: 9, lists: [{ name: 'Old Ads', count: 40 }, { name: 'Funny Filler', count: 10 }], channels });
    return ok({ error: 'not found' }, 404);
  });
  return posts;
}

describe('adding a channel', () => {
  it('creates a hidden channel with the suggested number, the server time zone shown, and goes on to its schedule', async () => {
    const posts = serve(true);
    render(<App />);
    await screen.findByText(/America\/Toronto/);
    const create = screen.getByRole('button', { name: 'Create the channel' }) as HTMLButtonElement;
    expect(create.disabled).toBe(true); // no name yet
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Late Night' } });
    expect((screen.getByLabelText('Number') as HTMLInputElement).value).toBe('9');
    expect((screen.getByLabelText(/Hidden/) as HTMLInputElement).checked).toBe(true);
    fireEvent.change(screen.getByLabelText('Ad list'), { target: { value: 'Old Ads' } });
    expect((screen.getByLabelText('Grid') as HTMLSelectElement).value).toBe('15');
    fireEvent.change(screen.getByLabelText('Grid'), { target: { value: '30' } });
    fireEvent.click(create);
    expect(await screen.findByText(/Late Night is added with an empty week/)).toBeTruthy();
    expect(posts).toEqual([{ url: '/api/add-channel/create', body: { name: 'Late Night', number: 9, hidden: true, gridMinutes: 30, adList: 'Old Ads' } }]);
    expect((screen.getByRole('link', { name: 'Design its schedule' }) as HTMLAnchorElement).getAttribute('href')).toBe('#/channel/Late%20Night/schedule');
  });

  it('attaches a Tunarr channel that exists, and offers only that when the server cannot write', async () => {
    const posts = serve(false);
    render(<App />);
    await screen.findByText(/read only, so it cannot create a channel/);
    expect((screen.getByLabelText(/Create a new channel in Tunarr/) as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Create the channel' })).toBeNull();
    fireEvent.change(screen.getByLabelText('Tunarr channel'), { target: { value: 'old-1' } });
    fireEvent.change(screen.getByLabelText('Filler list'), { target: { value: 'Funny Filler' } });
    fireEvent.click(screen.getByRole('button', { name: 'Attach the channel' }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({ url: '/api/add-channel/attach', body: { tunarrChannel: 'old-1', gridMinutes: 15, fillerList: 'Funny Filler' } });
  });

  it('says so when every Tunarr channel is managed already', async () => {
    serve(false, []);
    render(<App />);
    expect(await screen.findByText(/Every Tunarr channel is already managed/)).toBeTruthy();
  });

  it('shows the reason when the server refuses', async () => {
    serve(true);
    vi.stubGlobal('fetch', async (url: string, init?: { method?: string }) => {
      const ok = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
      if (init?.method === 'POST') return ok({ error: 'Tunarr already has a channel 1' }, 400);
      if (url === '/api/health') return ok({ ok: true, version: '0', writes: true });
      return ok({ timezone: 'UTC', canCreate: true, nextNumber: 9, lists: [], channels: [] });
    });
    render(<App />);
    await screen.findByText(/UTC/);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Clash' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create the channel' }));
    expect((await screen.findByRole('alert')).textContent).toContain('already has a channel 1');
  });
});
