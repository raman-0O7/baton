# ADR 0003: PostgreSQL tenant and event store

- Status: accepted
- Date: 2026-08-01

## Context

Baton Cloud needs transactional ingestion, tenant authorization, idempotent
retry, event edges, mutable projections, lifecycle workflows, and conventional
operational tooling. Git remains useful for the prototype but does not provide
an appropriate multi-tenant query or deletion boundary.

## Decision

Use PostgreSQL as the authoritative store for account, consent, normalized
event, projection, retrieval, memory, and lifecycle metadata. TypeScript
services use Drizzle-owned SQL migrations.

- Every tenant-owned table carries an immutable `tenant_id`; project and user
  identifiers never substitute for the tenant boundary.
- Authorization-aware repositories derive `tenant_id` from the verified
  credential. A request field cannot choose it.
- Foreign keys and unique indexes include tenant scope where an identifier can
  cross an authorization boundary.
- Ingestion validates consent, inserts idempotent events, records audit
  metadata, and advances its checkpoint in one transaction.
- Row-level security is enabled as defense in depth after repository-level
  negative tests exist. It is not the only authorization control.
- PostgreSQL full-text search is the first retrieval implementation. `pgvector`
  is optional and may be added without changing the canonical event store.
- Database rows are private persistence types. Public DTOs come only from
  `@baton/protocol`.
- Backups are encrypted, rolling, and capped by the retention contract. Restore
  drills apply deletion tombstones before serving traffic.

## Consequences

- Phase 1 must establish tenant-aware repository interfaces before feature
  queries are added.
- Schema changes require checked-in forward migrations and rollback/recovery
  notes; applications never create schema implicitly at startup.
- Partitioning is deferred until measured event volume requires it.
- Derived projections remain rebuildable from events and can be deleted and
  regenerated independently.
