# `@baton/sync`

Phase 2's device-side synchronization boundary. It owns project installation
consent, enable/pause/resume/disable state, operational source checkpoints,
policy filtering, local scrubbing, compressed upload preparation, bounded retry,
watcher coordination, reconciliation, and actionable status.

It deliberately does not own native agent parsing or HTTP. Integrators provide
`EventSource`, `SourceChangeWatcher`, `CloudUploader`, and `ConnectivityProbe`
implementations. The cloud uploader cannot receive absolute project paths or
native locators.

## Safety invariants

- Discovery and login do not create or enable an installation.
- `enable` requires the frozen disclosure, a server consent record bound to the
  specific installation/device, both processing acknowledgements, and an
  explicit affirmative action.
- Existing sources are baselined before the first capture. Re-enable and resume
  baseline again, so disabled/paused-window content is not caught up later.
- Category/path/cap filtering runs on normalized events before the mandatory
  local scrubber. Serialization accepts only the scrubber's opaque capability.
- A checkpoint advances only after a matching cloud acknowledgement, or when a
  page contains no uploadable fields after the accepted local policy.
- `consent_required` and `project_disabled` are non-retryable and never advance
  a checkpoint.
- Watcher triggers are memory-only. Offline mode reads and queues no content.
  Later reconciliation reconstructs the same deterministic batch ID from the
  unchanged cursor, without a persistent conversation cache.
- Legacy Git detection only reads the old TOML configuration and never invokes
  Git, changes a remote, or imports history.

The JSON installation store contains local paths, consent metadata, and source
cursors, but no conversation content. Its file should remain device-local and
mode `0600`.
