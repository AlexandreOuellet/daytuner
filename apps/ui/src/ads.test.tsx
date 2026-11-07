// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { polling } from './api';
import { mmss, minutes } from './format';
import { adsLink, parseRoute } from './router';

beforeEach(() => { polling.intervalMs = 0; window.location.hash = adsLink('Test Channel'); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.location.hash = ''; });

const n = encodeURIComponent('Test Channel');
const settings = () => ({
  step: 15_000, ratio: { min: 0.15, max: 0.6 },
  positions: { post: { list: 'Old Ads', min: 0, max: 300_000 }, tail: { list: 'Old Ads', min: 0, max: 1_500_000 } },
  mid: { list: 'Old Ads', every: 480_000, min: 120_000, max: 180_000, tailBuffer: 60_000 },
  bumpers: { pre: 'Station Idents' }, interstitial: 'Fillers',
});
const lists = [{ id: 'a', name: 'Old Ads', count: 40 }, { id: 'b', name: 'Station Idents', count: 6 }, { id: 'c', name: 'Fillers', count: 10 }];
const sample = (kind: 'episode' | 'movie') => ({
  kind, title: kind === 'episode' ? 'Show A S1E1 "Ep 1"' : 'Movie 3', programMs: 22 * 60_000, windowMs: 30 * 60_000, adMs: 6 * 60_000, adShare: 0.27, midBreaks: 2, deadAirMs: 12_000, warnings: ['one thing to know'],
  segments: [
    { type: 'bumper', position: 'pre', ms: 20_000, list: 'Station Idents' }, { type: 'content', position: '', ms: 10 * 60_000 },
    { type: 'ad', position: 'mid', ms: 150_000, list: 'Old Ads' }, { type: 'content', position: '', ms: 12 * 60_000 }, { type: 'dead-air', position: 'gap', ms: 12_000 },
  ],
});

function serve(over: { save?: (b: any) => unknown } = {}) {
  const posts: { url: string; body: any }[] = [];
  vi.stubGlobal('fetch', async (url: string, init?: { method?: string; body?: string }) => {
    const ok = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body });
    const job = (result: unknown) => ok({ job: { id: 'j', channel: 'Test Channel', kind: 'k', state: 'done', message: 'done', result } }, 202);
    if (init?.method === 'POST') {
      const body = JSON.parse(init.body ?? '{}');
      posts.push({ url, body });
      if (url.endsWith('/ads/sample')) return job({ samples: [sample('episode'), sample('movie')] });
      if (url.endsWith('/ads')) return job(over.save ? over.save(body) : { saved: true, revision: 2 });
    }
    if (url === '/api/health') return ok({ ok: true, version: '0', writes: false });
    if (url === `/api/channels/${n}/ads`) return ok({ revision: 1, settings: settings(), lists });
    return ok({ error: 'not found' }, 404);
  });
  return posts;
}

describe('helpers and routing', () => {
  it('formats minutes and lengths, and reads the ads route', () => {
    expect(minutes(90_000)).toBe('1.5'); expect(minutes(300_000)).toBe('5'); expect(mmss(150_000)).toBe('2:30');
    expect(parseRoute(adsLink('Test Channel'))).toEqual({ page: 'ads', name: 'Test Channel' });
  });
});

describe('the ads page', () => {
  it('draws the block in order and says what each position holds', async () => {
    serve();
    render(<App />);
    const block = await screen.findByRole('group', { name: /A block, from the start of the slot to its end/ });
    const boxes = within(block).getAllByRole('button');
    expect(boxes.map((b) => b.querySelector('strong')!.textContent)).toEqual(['Head', 'Before the show', 'During the show', 'After the show', 'Tail of the slot']);
    expect(within(block).getByText('Old Ads, 2–3 min')).toBeTruthy();
    expect(within(block).getByText('no ads; bumper: Station Idents')).toBeTruthy(); // before the show
    expect(within(block).getByText('Old Ads, up to 5 min; no bumper')).toBeTruthy(); // after
    expect(screen.getByText('No changes.')).toBeTruthy();
  });

  it('edits a position: picking a list and a length changes the box and enables saving', async () => {
    const posts = serve();
    render(<App />);
    await screen.findByRole('group', { name: /A block/ });
    fireEvent.click(screen.getByRole('button', { name: /^Head/ }));
    fireEvent.change(screen.getByLabelText('Ads from'), { target: { value: 'Old Ads' } });
    expect(screen.getByRole('button', { name: /^Head/ }).textContent).toContain('Old Ads, up to 2 min');
    fireEvent.change(screen.getByLabelText('up to (minutes)'), { target: { value: '1.5' } });
    expect(screen.getByRole('button', { name: /^Head/ }).textContent).toContain('up to 1.5 min');
    fireEvent.click(screen.getByRole('button', { name: 'Save as a new revision' }));
    expect(await screen.findByText(/Saved as revision 2/)).toBeTruthy();
    const sent = posts.at(-1)!;
    expect(sent.url).toBe(`/api/channels/${n}/ads`);
    expect(sent.body.settings.positions.head).toEqual({ list: 'Old Ads', min: 0, max: 90_000 });
    expect(sent.body.force).toBe(false);
  });

  it('removes ads from a position, sets a bumper, and takes the mid breaks away', async () => {
    const posts = serve();
    render(<App />);
    await screen.findByRole('group', { name: /A block/ });
    fireEvent.click(screen.getByRole('button', { name: /^After the show/ }));
    fireEvent.change(screen.getByLabelText('Ads from'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Bumper from'), { target: { value: 'Station Idents' } });
    fireEvent.click(screen.getByRole('button', { name: /^During the show/ }));
    fireEvent.change(screen.getByLabelText('Ads from'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save as a new revision' }));
    await screen.findByText(/Saved as revision/);
    const s = posts.at(-1)!.body.settings;
    expect(s.positions.post).toBeUndefined();
    expect(s.bumpers.post).toBe('Station Idents');
    expect(s.mid).toBeUndefined();
  });

  it('edits the ad share and the filler list, and can discard the changes', async () => {
    serve();
    render(<App />);
    await screen.findByRole('group', { name: /A block/ });
    fireEvent.change(screen.getByLabelText('At least (% of the show\'s length)'), { target: { value: '20' } });
    fireEvent.change(screen.getByLabelText('Fill gaps from'), { target: { value: '' } });
    expect((screen.getByRole('button', { name: 'Save as a new revision' }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect((screen.getByLabelText('At least (% of the show\'s length)') as HTMLInputElement).value).toBe('15');
    expect((screen.getByLabelText('Fill gaps from') as HTMLSelectElement).value).toBe('Fillers');
  });

  it('shows a sample drawn from the real planner, says when it is out of date, and keeps a table', async () => {
    const posts = serve();
    render(<App />);
    await screen.findByRole('group', { name: /A block/ });
    fireEvent.click(screen.getByRole('button', { name: 'Show a sample' }));
    expect(await screen.findByText(/Show A S1E1/)).toBeTruthy();
    expect(posts.at(-1)!.url).toBe(`/api/channels/${n}/ads/sample`);
    expect(screen.getAllByRole('img', { name: /episode block of 30:00/ }).length).toBe(1);
    expect(screen.getAllByText(/Ads are 27.0% of the program, in 2 mid breaks/)).toHaveLength(2); // one per sample
    expect(screen.getAllByText('one thing to know')).toHaveLength(2);
    expect(screen.queryByText(/settings changed since this sample/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^Head/ }));
    fireEvent.change(screen.getByLabelText('Bumper from'), { target: { value: 'Station Idents' } });
    expect(screen.getByText(/settings changed since this sample/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Update the sample' })).toBeTruthy();
  });

  it('refuses to save over locked slots until told to, and then saves anyway', async () => {
    const posts = serve({ save: (b) => (b.force ? { saved: true, revision: 2 } : { saved: false, revision: 1, impact: { conflicts: [{ start: 1, reason: 'window-changed', message: 'no slot starts there any more' }], changes: [], staged: 3 } }) });
    render(<App />);
    await screen.findByRole('group', { name: /A block/ });
    fireEvent.change(screen.getByLabelText('At least (% of the show\'s length)'), { target: { value: '10' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save as a new revision' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Not saved');
    expect(alert.textContent).toContain('1 locked staged slot would no longer fit');
    expect(alert.textContent).toContain('no slot starts there any more');
    fireEvent.click(within(alert).getByRole('button', { name: 'Save anyway' }));
    expect(await screen.findByText(/Saved as revision 2/)).toBeTruthy();
    expect(posts.at(-1)!.body.force).toBe(true);
  });
});
