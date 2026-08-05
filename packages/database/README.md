# @baton/database

Drizzle schema, checked-in PostgreSQL migrations, and the production identity
and ingestion stores.

Every post-authentication query includes the verified tenant and user. Device
and audit tables also use PostgreSQL row-level security through a transaction-
local `baton.tenant_id` setting. Credential lookup tables are an intentional
identity-bootstrap exception: they are reachable only through the identity
repository using an opaque token ID plus a constant-time HMAC check, and must be
owned by the restricted identity database role in production.

Migrations are generated from `src/schema.ts`, reviewed, then extended with
custom constraints and policies. Production runs migrations as a distinct
non-runtime role.

Phase 2 adds tenant-scoped projects, per-device installations and consent
history, immutable normalized events, idempotent batch receipts, and source
checkpoints. Consent validation, event inserts, audit metadata, and checkpoint
advancement share one serializable transaction. The artifact interface accepts
only scrubbed diffs or scrubbed tool results; it cannot describe native session
files, repository snapshots, local paths, or arbitrary attachments.
