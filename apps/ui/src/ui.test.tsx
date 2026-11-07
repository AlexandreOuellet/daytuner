// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { Trend } from './components/Trend';
import { clock, days, inZone, pct } from './format';
import { channelLink, parseRoute } from './router';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.location.hash = '';
});

const health = (over: object = {}) => ({
  status: 'ok', checks: [{ name: 'Committed ahead', ok: true, detail: 'committed 8.1 days ahead (the floor is 7.0 days)' }],
  headline: { aheadMs: 8.1 * 86_400_000, adLoad: 0.224, deadAirShare: 0.0021, repeats: 0, alerts: 0 }, ...over,
});
const summary = (name: string) => ({ name, tunarrId: 't', timezone: 'America/Toronto', floorMs: 7 * 86_400_000, stepMs: 86_400_000, revision: 2, edge: Date.UTC(2026, 10, 14, 19, 59), aheadMs: 8.1 * 86_400_000, pendingCommit: false, staged: 0, runAtMinutes: 180 });

function serve(routes: Record<string, unknown>) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (url: string) => {
    calls.push(url);
    if (!(url in routes)) return { ok: false, status: 404, json: async () => ({ error: 'not found' }) };
    return { ok: true, status: 200, json: async () => routes[url] };
  });
  return calls;
}

describe('formatting', () => {
  it('writes days, percentages, clock times and times in a zone', () => {
    expect(days(8.1 * 86_400_000)).toBe('8.1 days');
    expect(pct(0.2243)).toBe('22.4%');
    expect(pct(0.0021, 2)).toBe('0.21%');
    expect(clock(185)).toBe('03:05');
    expect(inZone(Date.UTC(2026, 10, 14, 19, 59), 'America/Toronto')).toBe('2026-11-14 14:59');
  });
});

describe('the router', () => {
  it('reads the dashboard and a channel, with names that need escaping', () => {
    expect(parseRoute('')).toEqual({ page: 'dashboard' });
    expect(parseRoute('#/')).toEqual({ page: 'dashboard' });
    expect(parseRoute(channelLink('Test Channel'))).toEqual({ page: 'channel', name: 'Test Channel' });
    expect(channelLink('Test Channel')).toBe('#/channel/Test%20Channel');
  });
});

describe('the dashboard', () => {
  it('shows a card per channel with its numbers, marks the one that needs attention and says why', async () => {
    serve({
      '/api/health': { ok: true, version: '0', writes: false },
      '/api/dashboard': [
        { ...summary('The Funny Bone'), health: health() },
        { ...summary('Betamax'), pendingCommit: true, staged: 2, health: health({ status: 'needs-attention', checks: [{ name: 'Last run', ok: false, detail: 'the last run refused: the lineup ran out' }], headline: { aheadMs: 2.3 * 86_400_000 } }) },
      ],
    });
    render(<App />);
    const funny = await screen.findByRole('heading', { name: 'The Funny Bone' });
    const card = funny.closest('article')!;
    expect(within(card).getByText('ok')).toBeTruthy();
    expect(within(card).getByText('22.4%')).toBeTruthy();
    expect(within(card).getByText('0.21%')).toBeTruthy();
    expect(within(card).getByText(/committed 8\.1 days ahead/)).toBeTruthy();
    const beta = screen.getByRole('heading', { name: 'Betamax' }).closest('article')!;
    expect(within(beta).getByText('needs attention')).toBeTruthy();
    expect(within(beta).getByText(/the lineup ran out/)).toBeTruthy();
    expect(within(beta).getByText('a commit is pending')).toBeTruthy();
    expect(within(beta).getByText('2 staged slots')).toBeTruthy();
    expect(screen.getByText('read only')).toBeTruthy();
  });

  it('says so when there are no channels, and when the server cannot be reached', async () => {
    serve({ '/api/health': { ok: true, version: '0', writes: true }, '/api/dashboard': [] });
    render(<App />);
    expect(await screen.findByText(/No channels yet/)).toBeTruthy();
    expect(screen.getByText('may write to Tunarr')).toBeTruthy();
    cleanup();
    serve({});
    render(<App />);
    expect((await screen.findAllByRole('alert')).length).toBeGreaterThan(0);
  });
});

describe('a channel', () => {
  it('shows its checks, its trends over the commits, its commits and its runs', async () => {
    window.location.hash = channelLink('Test Channel');
    const n = encodeURIComponent('Test Channel');
    const point = (id: number, dead: number) => ({ commitId: id, at: Date.UTC(2026, 10, id), fromEdge: 0, toEdge: 1, alerts: 0, warnings: 1, metrics: { slots: 5, adLoadRatio: { count: 5, median: 0.3, p90: 0.4, p99: 0.4, max: 0.4 }, deadAirShare: dead, endOfSlotMinutes: { count: 5, median: 5, p90: 12, p99: 12, max: 12 }, repeatedProgramAirings: 0 } });
    serve({
      '/api/health': { ok: true, version: '0', writes: false },
      [`/api/channels/${n}`]: { ...summary('Test Channel'), commits: [{ id: 2, status: 'done', items: 99, totalMs: 86_400_000, fromEdge: Date.UTC(2026, 10, 7), toEdge: Date.UTC(2026, 10, 8), startedAt: 1, finishedAt: 2, note: 'locked slots that could not be kept: x' }] },
      [`/api/channels/${n}/health`]: health({ status: 'needs-attention', checks: [{ name: 'Dead air', ok: false, detail: '0.60% of air time (target: at most 0.50%)' }] }),
      [`/api/channels/${n}/metrics`]: [point(1, 0.001), point(2, 0.006)],
      [`/api/channels/${n}/targets`]: { deadAirMaxShare: 0.005, adLoadRange: null, endOfSlotP90MaxMinutes: 30, maxAlerts: 0, maxRepeats: 0 },
      [`/api/channels/${n}/runs`]: [{ id: 1, at: Date.UTC(2026, 10, 8, 8), outcome: 'appended', message: 'appended 9 slots' }],
    });
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Test Channel' })).toBeTruthy();
    expect(await screen.findByText(/0\.60% of air time/)).toBeTruthy();
    expect(await screen.findByText(/Schedule revision 2/)).toBeTruthy();
    expect(screen.getByText(/daily run at 03:00/)).toBeTruthy();
    expect(await screen.findByText(/locked slots that could not be kept/)).toBeTruthy();
    expect(await screen.findByText(/appended 9 slots/)).toBeTruthy();
    const dead = screen.getByRole('img', { name: /Dead air: 2 commits, latest 0\.60%/ });
    expect(dead).toBeTruthy();
    expect(screen.getAllByText(/Target:/).length).toBeGreaterThan(0);
  });
});

describe('the trend chart', () => {
  const fmt = (v: number) => `${v}!`;
  it('names the latest value, shows a tooltip for the nearest commit, and offers a table', () => {
    const { container } = render(<Trend title="Dead air" format={fmt} points={[{ label: 'commit 1', value: 1 }, { label: 'commit 2', value: 3 }, { label: 'commit 3', value: 2 }]} />);
    expect(container.querySelector('.trend-last')!.textContent).toBe('2!');
    const svg = screen.getByRole('img', { name: /3 commits, latest 2!/ });
    svg.getBoundingClientRect = () => ({ left: 0, width: 320, top: 0, height: 110, right: 320, bottom: 110, x: 0, y: 0, toJSON() {} });
    fireEvent.mouseMove(svg, { clientX: 150 });
    expect(screen.getByRole('status').textContent).toContain('3!');
    expect(screen.getByRole('status').textContent).toContain('commit 2');
    fireEvent.mouseLeave(svg);
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.getAllByRole('row')).toHaveLength(4); // header and three commits
  });
  it('copes with no points and with one', () => {
    const { rerender, container } = render(<Trend title="X" format={fmt} points={[]} />);
    expect(screen.getByText(/No commit with metrics yet/)).toBeTruthy();
    rerender(<Trend title="X" format={fmt} points={[{ label: 'commit 1', value: 4 }]} target={{ value: 5, label: 'at most 5' }} />);
    expect(container.querySelector('.trend-last')!.textContent).toBe('4!');
    expect(screen.getByText('Target: at most 5')).toBeTruthy();
  });
});
