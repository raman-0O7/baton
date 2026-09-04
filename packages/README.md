# Shared packages

Shared TypeScript code is organized around product boundaries, not deployment
boundaries. Public network types originate in `protocol`; database rows and
application-private types must not become wire contracts accidentally.

Phase 0 packages:

- `@baton/protocol` owns cloud-safe APIs and normalized event envelopes;
- `@baton/adapters` reads supported native agent formats incrementally;
- `@baton/scrubber` is the mandatory local upload-privacy boundary; and
- `@baton/evaluation` owns pinned parity, convergence, retrieval, and memory
  gates.

Native transcript bytes are intentionally absent from public network contracts.
