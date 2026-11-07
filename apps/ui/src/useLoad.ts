import { useCallback, useEffect, useRef, useState } from 'react';

export interface Loaded<T> {
  data: T | undefined;
  error: string | undefined;
  loading: boolean;
  reload: () => void;
}

/** Runs `load` on mount and when `key` changes, keeping the last answer while a reload is in flight. */
export function useLoad<T>(load: () => Promise<T>, key: string): Loaded<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const latest = useRef(0);

  useEffect(() => {
    const mine = ++latest.current;
    setLoading(true);
    load().then(
      (d) => {
        if (mine !== latest.current) return;
        setData(d);
        setError(undefined);
        setLoading(false);
      },
      (e: unknown) => {
        if (mine !== latest.current) return;
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      },
    );
    // `load` is a fresh closure each render; the key says when to run again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload };
}
