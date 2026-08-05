# `@baton/evaluation`

Typed loaders and structural checks for Baton's locked evaluation data.

The corpus deliberately separates two kinds of data:

- `derived_from_sanitized_fixture` cases reuse the existing, manually reviewed
  native fixtures and Go canonical-IR goldens. Their expected event semantics
  carry JSON pointers back to those goldens.
- `synthetic_scenario` cases exercise state transitions that the existing
  fixtures do not demonstrate, such as an incomplete final JSONL line,
  truncation/rewrite, retry, out-of-order delivery, and divergence.

The adapter parity files omit generated event UUIDs, idempotency keys, content
hashes, cursors, and device IDs. Those identities are adapter-contract work and
cannot honestly be inferred from the legacy snapshot goldens. The corpus locks
observable event payload semantics and their native/golden provenance instead.

Run:

```console
pnpm --filter @baton/evaluation test
```
