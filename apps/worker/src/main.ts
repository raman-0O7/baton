import { loadWorkerConfig } from '@baton/config';
import { safeError } from '@baton/observability';

import { runWorker } from './worker.js';

const config = loadWorkerConfig(process.env);
const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
process.once('SIGTERM', () => controller.abort());

await runWorker(controller.signal, {
  heartbeatIntervalMs: config.heartbeatIntervalMs,
  heartbeat: () => {
    // Phase 1 reserves the worker process boundary. Durable memory jobs arrive in Phase 2.
  },
  log: (message, fields = {}) =>
    console.log(JSON.stringify({ level: 'info', message, ...fields })),
}).catch((error: unknown) => {
  console.error(
    JSON.stringify({
      level: 'error',
      message: 'worker failed',
      error: safeError(error),
    }),
  );
  process.exitCode = 1;
});
