import type { IncomingMessage, ServerResponse } from 'node:http';

// Import the built factory by relative path (not the `@baton/api/server`
// self-reference): pnpm creates no self-symlink for a package, so Vercel's
// function bundler cannot resolve the self-reference, whereas `../dist/server.js`
// is a real file produced by the `pnpm --filter @baton/api... build` step.
import { createConfiguredApi } from '../dist/server.js';

/**
 * Vercel serverless entrypoint for the Baton API.
 *
 * The API is stateless (every request reads/writes Postgres; no in-memory
 * session store, timers, or sockets), so the whole Fastify app runs as a single
 * serverless function instead of an always-on container. All routes are rewired
 * to this handler by `vercel.json`.
 *
 * The wired app is built once at module scope and reused across invocations on
 * the same warm instance, so the Postgres pool is shared rather than reopened
 * per request. Point `DATABASE_URL` at Neon's pooled endpoint.
 */
const ready = (async () => {
  const { app } = await createConfiguredApi();
  await app.ready();
  return app;
})();

export default async function handler(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const app = await ready;
  app.server.emit('request', request, response);
}
