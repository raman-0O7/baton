# @baton/capture

Local, incremental conversation capture for Claude Code, Codex, and OpenCode.
The package turns native sources into deterministic `AdapterEvent` batches; it
does not define an upload transport.

## Contract

`EventSource` exposes discovery, checkpointed reads, and fingerprints. A
`SourceSessionRef` contains a local-only locator and must never be used as an
ingestion DTO. `EventBatch` deliberately contains only:

- a deterministic UUIDv8 `sourceId` suitable for `sourceSessionId`;
- a one-way native-session hash and parser version;
- normalized semantic events;
- content-free offsets, row cursors, counts, and SHA-256 fingerprints.

No API can return a native JSONL record, SQLite row, complete native snapshot,
database path, or project checkout path in an event batch. Policy and scrubbing
still run after capture and before upload.

## Sources

- `ClaudeCodeEventSource` implements Claude's path slug and enumerates only
  top-level session JSONL files. It verifies the native `cwd` to avoid slug
  collision leaks.
- `CodexEventSource` walks only `YYYY/MM/DD/rollout-*.jsonl` shards and filters
  by `session_meta.cwd`.
- `OpenCodeEventSource` polls a narrow `OpenCodeSnapshotProvider`. The included
  `DatabaseSyncOpenCodeProvider` opens SQLite read-only, disables extension
  loading, and reads the session/message/part view in one transaction.

JSONL checkpoints verify the acknowledged byte prefix as well as the adapter's
semantic prefix. SQLite checkpoints retain a row count, `(time_created, id)`
high-water mark, and snapshot digest. Truncation or rewrite returns `replace`; a
valid extension returns only new normalized events.

## Reconciliation

Filesystem notifications are an optimization, not the correctness mechanism.
Call `reconcileDue` from the collector's periodic loop. It performs stable,
full-source reconciliation at the configured interval, so missed or coalesced
watch notifications converge on the same deterministic checkpoint.
