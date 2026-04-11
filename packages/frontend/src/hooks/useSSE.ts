import { useEffect, useRef, useCallback, useState } from 'react';

interface SSEMessage {
  type: string;
  data: Record<string, unknown>;
}

export function useSSE(url: string) {
  const [messages, setMessages] = useState<SSEMessage[]>([]);
  const eventSourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    const es = new EventSource(url);
    eventSourceRef.current = es;

    const addMessage = (type: string, event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data);
        setMessages((prev) => [...prev.slice(-50), { type, data }]);
      } catch {
        // ignore malformed SSE data
      }
    };

    es.addEventListener('job:progress', (e) => addMessage('job:progress', e as MessageEvent));
    es.addEventListener('job:completed', (e) => addMessage('job:completed', e as MessageEvent));
    es.addEventListener('job:failed', (e) => addMessage('job:failed', e as MessageEvent));

    return () => {
      es.close();
      eventSourceRef.current = null;
    };
  }, [url]);

  return { messages };
}
