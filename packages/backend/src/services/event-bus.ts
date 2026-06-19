import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { PrinterStatus } from '@slorca/shared';

type EventHandler = (type: string, data: unknown) => void;

class EventBus {
  private handlers = new Set<EventHandler>();

  subscribe(fn: EventHandler): () => void {
    this.handlers.add(fn);
    return () => { this.handlers.delete(fn); };
  }

  emit(type: string, data: unknown): void {
    for (const h of this.handlers) {
      try { h(type, data); } catch {}
    }
  }
}

export const eventBus = new EventBus();

/** Format an SSE message string. */
function formatSSE(type: string, data: unknown): string {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Register the SSE endpoint — clients subscribe to all events here. */
export async function eventRoutes(app: FastifyInstance) {
  app.get('/api/events', (req: FastifyRequest, reply: FastifyReply) => {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    reply.raw.flushHeaders();
    reply.raw.write(':ok\n\n');

    // Subscribe this client to the event bus
    const send = (type: string, data: unknown) => {
      try { reply.raw.write(formatSSE(type, data)); } catch {}
    };
    const unsub = eventBus.subscribe(send);

    // Heartbeat every 30 seconds
    const heartbeat = setInterval(() => {
      try { reply.raw.write(':heartbeat\n\n'); } catch {}
    }, 30000);

    // Clean up on client disconnect
    req.raw.on('close', () => {
      clearInterval(heartbeat);
      unsub();
    });

    reply.hijack();
  });
}

/** Convenience emitters. */
export function emitJobProgress(jobId: string, progress: number, currentStep?: string): void {
  eventBus.emit('job:progress', { jobId, progress, currentStep });
}
export function emitJobCompleted(jobId: string): void {
  eventBus.emit('job:completed', { jobId });
}
export function emitJobFailed(jobId: string, error: string): void {
  eventBus.emit('job:failed', { jobId, error });
}
export function emitPrinterStatus(status: PrinterStatus): void {
  eventBus.emit('printer:status', status);
}
export function emitPrinterConnected(printerId: string): void {
  eventBus.emit('printer:connected', { printerId });
}
export function emitPrinterDisconnected(printerId: string, reason?: string): void {
  eventBus.emit('printer:disconnected', { printerId, reason });
}
