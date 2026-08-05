# Baton hosted trust contracts

**Status:** Phase 0 contract  
**Applies to:** hosted Baton CLI, API, workers, dashboard, and MCP  
**Last reviewed:** 2026-08-01

These documents are release requirements for the first hosted Baton private
beta:

- [Threat model](./threat-model.md)
- [Data classification, collection, and consent](./data-collection-and-consent.md)
- [Retention and deletion](./retention-and-deletion.md)
- [Control mapping](./control-mapping.md)
- [Approvals](./approvals.md)
- [Frozen collection disclosure](../product/collection-consent-copy.md)

They use **MUST**, **MUST NOT**, **SHOULD**, and **MAY** as normative terms.
Product code, infrastructure, support tooling, analytics, and subprocessors are
all in scope. A policy exception requires a documented owner, expiry date, risk
acceptance, and user-visible disclosure when it changes what users were told.

The governing trust promises are:

1. Baton collects only from a local project installation the user explicitly
   enables.
2. An allowlist and secret scrubber run on the device before any content upload.
3. Complete native agent payloads are forbidden at the cloud contract boundary.
4. Baton can read opted-in content to provide retrieval and personalization, but
   neither Baton nor its model providers may train models on customer content.
5. Tenant authorization applies to primary data and every derivative.
6. Stored conversation content is untrusted data, never an instruction to Baton
   workers or MCP tools.
7. Users can inspect, export, and delete their content and approved memory.

## Phase 0 exit gate (satisfied 2026-08-01)

Phase 1 implementation began after the following internal-development gate was
satisfied:

- one named engineering owner and one named product/privacy owner approve all
  three documents;
- every normative requirement has an issue, automated check, or later-phase
  acceptance-test owner;
- the event and ingestion schemas have no field capable of carrying a complete
  native session payload;
- the collection UI copy names cloud readability, managed-model processing, no
  training, retention, and deletion;
- the retention matrix contains an owner, deletion action, and maximum deadline
  for every stored data class; and
- unresolved high or critical threats have a blocking issue and cannot be
  accepted merely to open the beta.
