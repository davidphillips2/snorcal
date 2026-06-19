import { useEffect, useRef, useState } from 'react';

interface SSEMessage {
  type: string;
  data: Record<string, unknown>;
}

const KNOWN_EVENTS = [
  'job:progress', 'job:completed', 'job:failed',
  'printer:status', 'printer:connected', 'printer:disconnected',
];

/** Subscribe to all SSE event types. Returns bounded message buffer (last 200). */
export function useSSE(url: string) {
  const [messages, setMessages] = useState<SSEMessage[]>([]);
  const eventSourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    const es = new EventSource(url);
    eventSourceRef.current = es;

    const addMessage = (type: string, event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data);
        setMessages((prev) => [...prev.slice(-200), { type, data }]);
      } catch {
        // ignore malformed SSE data
      }
    };

    for (const type of KNOWN_EVENTS) {
      es.addEventListener(type, (e) => addMessage(type, e as MessageEvent));
    }

    return () => {
      es.close();
      eventSourceRef.current = null;
    };
  }, [url]);

  return { messages };
}
