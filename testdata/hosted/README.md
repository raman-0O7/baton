# Hosted-product evaluation data

This directory contains the Phase 0 evaluation corpus for the hosted TypeScript
product. It contains no real user transcript.

Provenance is explicit:

- `derived_from_sanitized_fixture` means the case references an existing
  sanitized native fixture under `testdata/fixtures/` and its checked-in Go
  canonical-IR golden. SHA-256 pins prevent the evidence from changing
  unnoticed.
- `synthetic_scenario` means the data was authored solely to exercise a
  transition or policy outcome not demonstrated by those fixtures.

`adapters/expected-events-v1.json` intentionally locks only event payload
semantics and source provenance. It does not guess event UUIDs, idempotency
keys, hashes, device IDs, or cursors that the streaming TypeScript adapter
contract has not yet defined.

The retrieval cases are grounded in the existing sanitized golden files. Memory
cases are synthetic because the adapter fixtures contain task instructions, not
enough repeated personal-preference evidence for a safe SOUL evaluation.
