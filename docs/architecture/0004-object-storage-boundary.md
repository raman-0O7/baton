# ADR 0004: Restricted object-storage boundary

- Status: accepted
- Date: 2026-08-01

## Context

Most Baton events are deliberately bounded JSON stored in PostgreSQL. Some
explicitly allowed diffs, exports, and future user-approved artifacts can be too
large for normal event rows. Object storage is useful, but an unrestricted
upload path would bypass the normalized-event and local-scrubbing guarantees.

## Decision

Use S3-compatible object storage only for registered artifact classes: bounded
scrubbed event artifacts, short-lived exports, and controlled internal
processing outputs. Complete native agent sessions, repository snapshots,
credential files, environment dumps, binaries, and arbitrary conversation
attachments are never valid artifact classes.

- PostgreSQL artifact metadata is authoritative and records tenant, project,
  source event, class, content hash, byte count, media type, lifecycle state,
  and deletion deadline.
- Keys are opaque generated identifiers containing no tenant name, local path,
  filename, email, or customer text.
- A client first obtains a tenant- and purpose-scoped grant. Temporary uploads
  are quarantined until size, hash, media type, active consent, source event,
  and server-side secret-policy checks pass.
- Only finalized objects can be read. Read grants are single-purpose,
  tenant-scoped, HTTPS-only, and expire within 15 minutes.
- Service-side encryption and provider access logging are mandatory. Object
  bodies and signed URLs never enter application logs.
- Project/account deletion revokes grants immediately and deletes finalized,
  quarantined, multipart, replicated, and export copies within the retention
  contract deadline.

## Consequences

- Phase 2 may implement a provider adapter, but domain code depends on an
  authorization-aware artifact repository rather than an S3 SDK.
- Direct public buckets and permanent object URLs are forbidden.
- Orphan reconciliation, multipart cleanup, negative cross-tenant tests, and
  object lifecycle metrics are release requirements.
- Normal ingestion does not require object storage; oversized disallowed content
  is rejected instead of silently uploaded as an artifact.
