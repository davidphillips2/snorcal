import { useEffect, useRef, useState } from 'react';

interface SSEMessage {
  type: string;
  data: Record<string, unknown>;
}

const KNOWN_EVENTS = [
  'job:progress', 'job:completed', 'job:failed',
  'printer:status', 'printer:connected', 'printer:disconnected',
];

const RECONNECT_DELAY_MS = 2000;

/** Subscribe to all SSE event types. Returns bounded message buffer (last 200). */
export function useSSE(url: string) {
  const [messages, setMessages] = useState<SSEMessage[]>([]);
  const closedRef = useRef(false);

  useEffect(() => {
    closedRef.current = false;

    const addMessage = (type: string, event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data);
        setMessages((prev) => [...prev.slice(-200), { type, data }]);
      } catch {
        // ignore malformed SSE data
      }
    };

    let es: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (closedRef.current) return;
      es = new EventSource(url);

      for (const type of KNOWN_EVENTS) {
        es.addEventListener(type, (e) => addMessage(type, e as MessageEvent));
      }

      // Native EventSource auto-reconnects, but gives up silently after some
      // browsers' internal cap when the backend is down for too long (dev
      // restarts). Force a fresh connection on error.
      es.onerror = () => {
        try { es?.close(); } catch { /* ignore */ }
        es = null;
        if (!closedRef.current) {
          reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
        }
      };
    };

    connect();

    return () => {
      closedRef.current = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      try { es?.close(); } catch { /* ignore */ }
      es = null;
    };
  }, [url]);

  return { messages };
}
