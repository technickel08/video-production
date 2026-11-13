import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { api } from './api';

type Listener = (e: any) => void;
const Ctx = createContext<{ version: number; subscribe: (fn: Listener) => () => void; connected: boolean }>({
  version: 0, subscribe: () => () => {}, connected: false,
});

/** One EventSource for the whole app; `version` bumps on every data change so pages can refetch. */
export function LiveProvider({ children }: { children: React.ReactNode }) {
  const [version, setVersion] = useState(0);
  const [connected, setConnected] = useState(false);
  const listeners = useRef(new Set<Listener>());
  const timer = useRef<number | null>(null);

  useEffect(() => {
    const es = new EventSource('/api/events');
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (m) => {
      const e = JSON.parse(m.data);
      if (e.kind === 'ping') return;
      listeners.current.forEach((fn) => fn(e));
      if (e.kind !== 'log' && timer.current === null) {
        timer.current = window.setTimeout(() => { timer.current = null; setVersion((v) => v + 1); }, 250);
      }
    };
    return () => es.close();
  }, []);

  const subscribe = useCallback((fn: Listener) => { listeners.current.add(fn); return () => { listeners.current.delete(fn); }; }, []);
  return <Ctx.Provider value={{ version, subscribe, connected }}>{children}</Ctx.Provider>;
}

export const useLive = () => useContext(Ctx);

/** Fetch JSON and refetch whenever live data changes. */
export function useData<T>(path: string | null, deps: unknown[] = []) {
  const { version } = useLive();
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!path) return;
    let alive = true;
    api<T>(path).then((d) => { if (alive) { setData(d); setError(null); } }, (e) => alive && setError(e.message));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, version, tick, ...deps]);
  return { data, error, reload: () => setTick((t) => t + 1), setData };
}
