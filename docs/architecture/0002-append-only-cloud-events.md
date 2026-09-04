# ADR 0002: Append-only cloud events

- Status: accepted
- Date: 2026-07-29

## Context

The Git prototype stores complete canonical-session snapshots. The hosted
product needs incremental synchronization, idempotent retry, multi-device
divergence, structured search, deletion, tenant authorization, and derived
memory.

Git can preserve versions, but it is a poor multi-tenant query and lifecycle
boundary. Mutable transcript rows are easier initially but make provenance,
replay, and divergence ambiguous.

## Decision

Use immutable normalized source events as the canonical cloud history.

- The CLI derives stable client event identities from native source records.
- Upload batches carry idempotency keys, parent relationships, and an
  acknowledgement cursor.
- PostgreSQL stores normal event content and metadata.
- S3-compatible storage holds only explicitly allowed oversized artifacts.
- Complete native session payloads remain on the device.
- Snapshots, chunks, summaries, decisions, tasks, and memories are rebuildable
  projections with source-event references.
- User deletion physically removes canonical content and all derived material;
  append-only does not override privacy deletion.

## Consequences

- Adapters must support incremental scans, rewrites, and reconciliation.
- Canonical serialization and hashing are protocol requirements.
- Duplicate and out-of-order delivery must converge in tests.
- Divergent children are preserved as branches without exposing Git concepts.
- Projections and model-generated artifacts can be regenerated when parsers,
  prompts, or models change.
