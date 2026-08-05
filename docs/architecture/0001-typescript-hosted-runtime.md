# ADR 0001: TypeScript hosted runtime

- Status: accepted
- Date: 2026-07-29

## Context

The completed Baton prototype is a Go CLI centered on user-managed Git sync and
native agent-session restoration. The hosted product has different boundaries:
an authenticated CLI, ingestion API, worker pipeline, hosted dashboard,
retrieval service, and MCP endpoint.

The primary maintainer is substantially more productive in TypeScript, and the
dashboard and MCP ecosystem are TypeScript-native. Continuing hosted development
in Go would create a permanent two-language product or force the maintainer to
work primarily in an unfamiliar language.

## Decision

Build the hosted product as a strict TypeScript monorepo using Node.js, pnpm,
and Turborepo.

- `apps/cli`: capture and cloud client;
- `apps/api`: Fastify modular monolith;
- `apps/worker`: durable background processing;
- `apps/dashboard`: Next.js dashboard;
- `packages/*`: versioned contracts and product-domain boundaries.

The existing Go module stays in place and remains independently buildable during
a compatibility window. Hosted applications do not import, execute, or extend Go
packages.

## Consequences

- Proven Go behavior must be ported and checked against existing fixtures.
- The Go and TypeScript suites both run in CI during migration.
- New users may initially need a supported Node.js runtime; standalone CLI
  packaging is deferred until the capture path is stable.
- Git synchronization, age encryption, and native session restoration remain
  legacy capabilities rather than being reimplemented for the hosted runtime.
- Wire contracts and database schemas must be explicit because TypeScript lacks
  Go's compile-time `internal/` package boundary.
