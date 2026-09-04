# `@baton/protocol`

Versioned, cloud-safe transport contracts shared by the Baton CLI and hosted
services.

The schemas establish several non-negotiable hosted boundaries:

- events are normalized and immutable;
- batches are idempotent and cursor-based;
- agent, source-session, and device attribution must agree;
- unknown fields are rejected;
- complete native session payloads cannot be represented.

Phase 2 batches bind every upload to an authenticated device, project
installation, active consent record, policy version, and disclosure version. The
server acknowledges one opaque cursor per device/installation/source and the
OpenAPI transport permits only bounded identity or gzip request bodies.

Database rows and native-agent parser records must not be exported from this
package.

Adapters produce `SourceEventInput` values inside an `IngestionBatchDraft`. The
mandatory local scrubber redacts content fields before calling
`createSourceEvent`. Baton then hashes the strictly parsed scrubbed payload with
deterministic canonical JSON and derives a stable idempotency key plus a
deterministic UUIDv8 event ID. Both identities are independent of the observing
device, observation time, and later work-thread assignment.

The OpenAPI 3.1 document is generated directly from these Zod schemas:

```sh
pnpm --filter @baton/protocol openapi:generate
```

`api/openapi.json` is committed for consumers that cannot execute TypeScript. A
contract test fails when that artifact drifts from its Zod source.
