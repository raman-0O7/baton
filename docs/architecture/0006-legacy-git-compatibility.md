# ADR 0006: Legacy Git compatibility

- Status: accepted
- Date: 2026-08-01

## Context

The Go prototype asks users to manage a private Git repository and can restore
native agent files. The hosted product removes that burden and continues work by
retrieving relevant normalized context. Existing prototype users must not lose
data or have their repositories silently uploaded.

## Decision

Keep Git synchronization and native restoration as a read-only compatibility
lane in the Go prototype. The TypeScript hosted runtime does not use Git as a
cloud store and does not write native agent session files.

- New hosted projects use Baton Cloud as their shared source of normalized
  memory.
- The TypeScript CLI may detect legacy configuration to explain migration, but
  does not mutate the repository, keys, remotes, or native sessions.
- A future `baton migrate cloud --dry-run` inventories eligible projects,
  sessions, date ranges, estimated post-policy bytes, and redactions.
- Migration requires login, explicit project enablement, current collection
  consent, and a separate historical-import confirmation.
- Imported data passes through the same adapter, allowlist, scrubber, ingestion,
  and deletion boundaries as new capture. Git history is never uploaded as an
  opaque artifact.
- Exact native session restoration remains unsupported by the hosted core.
  Continuation starts a fresh agent session with cited Baton context.

## Consequences

- The Go suite remains green during the compatibility window.
- Legacy fixture and scrubber corpora remain shared behavioral specifications.
- Users can retain their Git repositories indefinitely; migration never deletes
  local or remote data.
- A future end-of-support date requires a separate user-visible decision and
  export/migration path.
