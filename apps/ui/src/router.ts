// A tiny hash router: "#/" is the dashboard, "#/channel/NAME" a channel. No library for two pages.
import { useEffect, useState } from 'react';

export type Route = { page: 'dashboard' } | { page: 'channel'; name: string };

export function parseRoute(hash: string): Route {
  const m = /^#\/channel\/(.+)$/.exec(hash);
  return m ? { page: 'channel', name: decodeURIComponent(m[1]!) } : { page: 'dashboard' };
}

export const channelLink = (name: string): string => `#/channel/${encodeURIComponent(name)}`;

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));
  useEffect(() => {
    const on = (): void => setRoute(parseRoute(window.location.hash));
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}
