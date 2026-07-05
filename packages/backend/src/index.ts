import { buildApp } from './app.js';

const PORT = parseInt(process.env.PORT || '3000');
const HOST = process.env.HOST || '0.0.0.0';

async function main() {
  const { app, db } = await buildApp();

  // Graceful shutdown
  const shutdown = async () => {
    console.log('Shutting down...');
    await app.close();
    db.close();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  // Global safety nets — log and continue rather than crashing the long-running
  // server on a stray rejected promise or uncaught exception. For a LAN-only
  // self-hosted process, restarting silently on every unexpected error is worse
  // than logging it (you'd lose mid-print state with no clue why). The known
  // unhandled-rejection source (queue.ts connectionPromise.then) is fixed at
  // the source; these handlers are the backstop for anything we missed.
  process.on('unhandledRejection', (reason) => {
    app.log.error({ reason }, 'Unhandled promise rejection');
  });
  process.on('uncaughtException', (err) => {
    app.log.error({ err }, 'Uncaught exception');
  });

  try {
    await app.listen({ port: PORT, host: HOST });
    console.log(`Snorcal server running on http://${HOST}:${PORT}`);
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

main();
