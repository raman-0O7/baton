# Applications

The hosted Baton applications will live here:

- `cli`: local capture, cloud synchronization, and MCP bootstrap/proxy;
- `api`: Fastify modular-monolith API;
- `worker`: indexing, summaries, memory, export, and deletion jobs;
- `dashboard`: Next.js hosted dashboard.

Applications may depend on packages, but must not import another application's
internals. They communicate through the versioned contracts in
`packages/protocol`.
