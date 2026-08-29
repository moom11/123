import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { currentAccessToken, realtimeUrl } from './api.js';

export interface RealtimeEvent { type: string; payload: any; at?: string }

type Handler = (event: RealtimeEvent) => void;

interface RealtimeValue {
  connected: boolean;
  subscribe: (handler: Handler) => () => void;
}

const RealtimeContext = createContext<RealtimeValue | null>(null);

/**
 * A single websocket for the whole app, fanned out to subscribers.
 *
 * The floor board, the waiter's approval inbox and the notification bell all
 * listen to the same connection rather than opening one each.
 */
export function RealtimeProvider({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const [connected, setConnected] = useState(false);
  const handlers = useRef(new Set<Handler>());

  useEffect(() => {
    if (!enabled) return;
    let socket: WebSocket | null = null;
    let closed = false;
    let attempt = 0;
    let timer: number | undefined;

    const open = () => {
      if (closed) return;
      const token = currentAccessToken();
      if (!token) { timer = window.setTimeout(open, 1500); return; }

      socket = new WebSocket(`${realtimeUrl()}?access_token=${encodeURIComponent(token)}`);
      socket.onopen = () => { attempt = 0; setConnected(true); };
      socket.onmessage = (e) => {
        try {
          const event = JSON.parse(e.data) as RealtimeEvent;
          handlers.current.forEach((h) => h(event));
        } catch { /* ignore malformed frame */ }
      };
      socket.onclose = () => {
        setConnected(false);
        if (closed) return;
        attempt += 1;
        // Back off, but keep trying: the floor cannot be left blind.
        timer = window.setTimeout(open, Math.min(1000 * 2 ** attempt, 15000));
      };
      socket.onerror = () => socket?.close();
    };

    open();
    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      socket?.close();
    };
  }, [enabled]);

  const value = useMemo<RealtimeValue>(() => ({
    connected,
    subscribe: (handler) => {
      handlers.current.add(handler);
      return () => { handlers.current.delete(handler); };
    },
  }), [connected]);

  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>;
}

export function useRealtime(): RealtimeValue {
  return useContext(RealtimeContext) ?? { connected: false, subscribe: () => () => {} };
}

/** Subscribe to specific event types with automatic cleanup. */
export function useRealtimeEvent(types: string[], handler: Handler): void {
  const { subscribe } = useRealtime();
  const ref = useRef(handler);
  ref.current = handler;

  useEffect(() => subscribe((event) => {
    if (types.includes(event.type)) ref.current(event);
  }), [subscribe, types.join('|')]);
}
