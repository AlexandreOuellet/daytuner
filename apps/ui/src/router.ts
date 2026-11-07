// A tiny hash router: "#/" is the dashboard, "#/channel/NAME" a channel. No library for two pages.
import { useEffect, useState } from 'react';

export type Route = { page: 'dashboard' } | { page: 'channel'; name: string } | { page: 'cursors'; name: string } | { page: 'ads'; name: string } | { page: 'schedule'; name: string } | { page: 'special'; name: string } | { page: 'staging'; name: string; date?: string };

export function parseRoute(hash: string): Route {
  const st = /^#\/channel\/(.+)\/staging(?:\/(\d{4}-\d{2}-\d{2}))?$/.exec(hash);
  if (st) return { page: 'staging', name: decodeURIComponent(st[1]!), ...(st[2] ? { date: st[2] } : {}) };
  const sp = /^#\/channel\/(.+)\/special-days$/.exec(hash);
  if (sp) return { page: 'special', name: decodeURIComponent(sp[1]!) };
  const sc = /^#\/channel\/(.+)\/schedule$/.exec(hash);
  if (sc) return { page: 'schedule', name: decodeURIComponent(sc[1]!) };
  const a = /^#\/channel\/(.+)\/ads$/.exec(hash);
  if (a) return { page: 'ads', name: decodeURIComponent(a[1]!) };
  const c = /^#\/channel\/(.+)\/cursors$/.exec(hash);
  if (c) return { page: 'cursors', name: decodeURIComponent(c[1]!) };
  const m = /^#\/channel\/(.+)$/.exec(hash);
  return m ? { page: 'channel', name: decodeURIComponent(m[1]!) } : { page: 'dashboard' };
}

export const channelLink = (name: string): string => `#/channel/${encodeURIComponent(name)}`;
export const stagingLink = (name: string, date?: string): string => `#/channel/${encodeURIComponent(name)}/staging${date ? `/${date}` : ''}`;
export const specialLink = (name: string): string => `#/channel/${encodeURIComponent(name)}/special-days`;
export const scheduleLink = (name: string): string => `#/channel/${encodeURIComponent(name)}/schedule`;
export const adsLink = (name: string): string => `#/channel/${encodeURIComponent(name)}/ads`;
export const cursorsLink = (name: string): string => `#/channel/${encodeURIComponent(name)}/cursors`;

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));
  useEffect(() => {
    const on = (): void => setRoute(parseRoute(window.location.hash));
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}
