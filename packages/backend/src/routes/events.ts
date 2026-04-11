import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

export async function eventRoutes(app: FastifyInstance) {
  app.get('/api/events', (req: FastifyRequest, reply: FastifyReply) => {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    reply.raw.flushHeaders();
    reply.raw.write(':ok\n\n');

    // Heartbeat every 30 seconds
    const heartbeat = setInterval(() => {
      try { reply.raw.write(':heartbeat\n\n'); } catch {}
    }, 30000);

    // Clean up on client disconnect
    req.raw.on('close', () => {
      clearInterval(heartbeat);
    });

    // Do NOT await a never-resolving promise —
    // instead, hijack the reply so Fastify doesn't try to send a body
    reply.hijack();
  });
}
