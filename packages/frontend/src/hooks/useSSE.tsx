import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { probeAuthOnSSEError } from '../api/client';

/**
 * Single shared SSE connection for the whole app.
 *
 * Previously HomeDashboard, PrinterDashboard, PrinterDetail, and App each
 * opened their own `new EventSource('/api/events')` — 4 parallel streams
 * with copy-pasted reconnect logic. This provider owns one connection and
 * fans events out to subscribers via a ref Set.
 *
 * Hooks:
 * - useSSEEvent(type, handler)  — subscribe to one event type (effect-safe,
 *   handler held in a ref so it can be inline without re-subscribing)
 * - useSSEMessages(types?)      — bounded buffer of recent messages, for
 *   components that want to scan history (App's job/printer reducer)
 */

const KNOWN_EVENTS = [
  'job:progress', 'job:completed', 'job:failed',
  'printer:status', 'printer:connected', 'printer:disconnected',
] as const;
export type SSEEventType = typeof KNOWN_EVENTS[number];

interface SSEMessage {
  type: string;
  data: Record<string, unknown>;
}

type Handler = (data: Record<string, unknown>) => void;

interface SSEContextValue {
  /** Bounded buffer of recent messages (last 200), all event types. */
  messages: SSEMessage[];
}

const SSEContext = createContext<SSEContextValue | null>(null);

const RECONNECT_DELAY_MS = 2000;

export function SSEProvider({ children }: { children: ReactNode }) {
  // Subscribers keyed by event type. Held in a ref so the SSE connection
  // effect doesn't re-run when handlers change.
  const subscribersRef = useRef<Map<string, Set<Handler>>>(new Map());
  const [messages, setMessages] = useState<SSEMessage[]>([]);
  const closedRef = useRef(false);

  // Expose the subscribe API via a module-level ref so useSSEEvent (outside
  // React render) can register handlers without threading context. Set in
  // an effect on mount.
  useEffect(() => {
    closedRef.current = false;
    const subs = subscribersRef.current;

    const dispatch = (type: string, data: Record<string, unknown>) => {
      setMessages(prev => [...prev.slice(-200), { type, data }]);
      const handlers = subs.get(type);
      if (handlers) for (const h of handlers) { try { h(data); } catch { /* handler error */ } }
    };

    let es: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (closedRef.current) return;
      es = new EventSource('/api/events');

      for (const type of KNOWN_EVENTS) {
        es.addEventListener(type, (e) => {
          try {
            const data = JSON.parse((e as MessageEvent).data);
            dispatch(type, data);
          } catch { /* malformed SSE data */ }
        });
      }

      // Native EventSource auto-reconnects, but gives up silently after the
      // browser's internal cap when the backend is down too long (dev
      // restarts). Force a fresh connection on error.
      es.onerror = () => {
        try { es?.close(); } catch { /* ignore */ }
        es = null;
        void probeAuthOnSSEError();
        if (!closedRef.current) {
          reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
        }
      };
    };

    connect();

    // Register the module-level subscribe fn so hooks can add/remove handlers.
    sseSubscribeRef.current = (type: string, handler: Handler) => {
      let set = subs.get(type);
      if (!set) { set = new Set(); subs.set(type, set); }
      set.add(handler);
      return () => { set!.delete(handler); };
    };

    return () => {
      closedRef.current = true;
      sseSubscribeRef.current = null;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      try { es?.close(); } catch { /* ignore */ }
      es = null;
    };
  }, []);

  return (
    <SSEContext.Provider value={{ messages }}>
      {children}
    </SSEContext.Provider>
  );
}

// Module-level bridge: the provider sets this on mount so useSSEEvent can
// register handlers without re-rendering the provider. Null when no provider
// is mounted (e.g. in tests).
const sseSubscribeRef: { current: ((type: string, handler: Handler) => () => void) | null } = { current: null };

/**
 * Subscribe to one SSE event type. Handler is held in a ref so it can be an
 * inline closure without causing re-subscribes.
 */
export function useSSEEvent(type: SSEEventType, handler: Handler): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    const subscribe = sseSubscribeRef.current;
    if (!subscribe) return; // no provider mounted
    const wrapped: Handler = (data) => handlerRef.current(data);
    return subscribe(type, wrapped);
  }, [type]);
}

function useSSEContext(): SSEContextValue {
  const ctx = useContext(SSEContext);
  if (!ctx) throw new Error('useSSEMessages must be used within SSEProvider');
  return ctx;
}

/** Bounded buffer of recent messages (last 200). Filters by type if given. */
export function useSSEMessages(types?: SSEEventType[]): SSEMessage[] {
  const { messages } = useSSEContext();
  if (!types || types.length === 0) return messages;
  const set = new Set(types);
  return messages.filter(m => set.has(m.type as SSEEventType));
}

/**
 * Back-compat wrapper for the old `useSSE('/api/events')` API. The url arg is
 * ignored — there is now one shared connection owned by SSEProvider. Returns
 * `{ messages }` shaped like the old hook so callers that scan the buffer
 * (App.tsx) work unchanged.
 */
export function useSSE(_url = '/api/events'): { messages: SSEMessage[] } {
  return { messages: useSSEMessages() };
}
