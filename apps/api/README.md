# Baton API

This application will expose the Fastify modular-monolith API for identity
integration, projects, ingestion, work threads, retrieval, memory, dashboard
queries, and hosted MCP.

Domain authorization remains in shared server-side packages; transport handlers
must not expose database rows directly.

The ingestion endpoint accepts bounded JSON or gzip, validates the decompressed
normalized DTO, derives tenant and device ownership from the bearer credential,
and returns canonical problem responses for consent, checkpoint, encoding, and
size failures.
