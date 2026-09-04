# Hosted Baton threat model

**Status:** Phase 0 security contract  
**Review cadence:** before each beta milestone and after any new data class,
subprocessor, auth flow, or MCP write capability

## 1. Scope and security objectives

Baton captures normalized events from explicitly enabled coding projects, stores
readable content in Baton Cloud, derives search and memory data, and returns
selected context through the dashboard and MCP.

The objectives, in priority order, are:

1. prevent one tenant from reading or changing another tenant's data;
2. prevent credentials, disallowed local data, and complete native transcripts
   from reaching Baton Cloud;
3. prevent stored prompt injection from controlling workers, retrieval, or
   tools;
4. preserve canonical event integrity, ordering provenance, and auditability;
5. make consent withdrawal, export, and deletion effective and observable; and
6. keep the service available without weakening the preceding controls.

End-to-end encryption, offline retrieval, and restoration of native agent
sessions are not v1 security properties. Baton Cloud is intentionally able to
read content for the features to which the user consented.

## 2. Protected assets

- Conversation events, diffs, bounded tool results, summaries, indexes,
  embeddings, evidence, and memory candidates.
- Approved memories and their scope.
- User identity, project and device metadata, consent records, and audit events.
- Browser sessions, OAuth device credentials, MCP grants, signing keys, and
  encryption keys.
- Export archives, object-store artifacts, backups, logs, traces, and job
  payloads.
- Integrity of tenant, project, source-session, thread, and event relationships.

## 3. Trust boundaries

```text
agent files (untrusted)
  -> adapter / allowlist / local scrubber
  -> CLI credential store
  -> TLS API boundary
  -> tenant authorization + schema/size validation
  -> database / object storage / jobs / search
  -> model subprocessor (untrusted response)
  -> dashboard or narrowly scoped MCP caller
```

Each arrow is a validation boundary. Agent files, conversation text, uploaded
identifiers, model output, browser input, archive contents, and MCP arguments
are untrusted. A valid identifier is not proof of authorization.

Tenant identity MUST be derived from the verified credential. A client-supplied
tenant or workspace field may be checked for consistency but MUST NOT select the
authorization scope.

## 4. Threat actors and assumptions

Threat actors include an unauthenticated attacker, a malicious or compromised
tenant, an attacker holding a device/browser/MCP token, malicious content inside
a transcript or repository, a compromised dependency or subprocessor, and an
authorized operator misusing access.

The local operating system and supported agent stores are assumed to enforce
their own user boundary. A fully compromised developer device can impersonate
that device until its credential is revoked; Baton limits the resulting cloud
access but cannot make the compromised device trustworthy.

## 5. Required mitigations

| Threat                                    | Required controls                                                                                                                                                                                                                                                                                                                                                                   | Verification                                                                                                                                                                        |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cross-tenant access or ID enumeration     | Put tenant scope on every content row, job, index document, cache key, object key, and audit lookup. Derive it from the credential; deny by default. Use PostgreSQL row-level security as defense in depth. Signed object URLs MUST be short-lived and tenant scoped.                                                                                                               | Negative integration tests cover read, search, write, batch retry, object access, export, deletion, and background jobs using another tenant's valid IDs.                           |
| Confused deputy                           | Resolve project, thread, event, and object ownership inside the same authorized transaction. Workers receive scoped opaque IDs and re-authorize their scope. Never trust a tenant ID from a queue or request alone.                                                                                                                                                                 | Tests substitute individually valid IDs belonging to different tenants and projects.                                                                                                |
| OAuth device-flow phishing or token theft | Use a standards-based device authorization flow. Device and user codes are random, single-use, rate-limited, short-lived, and bound to the initiating client. The approval page shows the official origin and device metadata. Access tokens are short-lived; device credentials rotate, are revocable, audience restricted, and stored in the OS credential store where available. | Automated expiry, replay, polling-rate, rotation, logout, and revoke tests; two-device E2E proves a revoked device cannot read metadata or content.                                 |
| Over-broad credentials                    | Separate browser, CLI ingestion, and MCP audiences. Use least-privilege scopes; later MCP write grants are distinct from read grants. A token cannot enable collection, approve memory, export, or delete unless explicitly scoped for that action.                                                                                                                                 | API authorization matrix is generated from routes and tested for every token kind.                                                                                                  |
| Accidental sensitive upload               | Adapters construct canonical events from an allowlist; they do not serialize a native session and subtract fields. Mandatory local secret scrubbing follows the allowlist. Server scanning is defense in depth, not the primary control.                                                                                                                                            | Seeded-secret corpus has zero unredacted uploads; schema and API tests reject unknown fields, raw/native payload fields, environment dumps, and oversized bodies.                   |
| Complete native transcript upload         | The upload DTO, artifact flow, and internal ingestion API MUST have no raw/native-session field. Complete Claude, Codex, or OpenCode files are never accepted as artifacts.                                                                                                                                                                                                         | Compile/schema tests plus malicious-request tests prove rejection before storage.                                                                                                   |
| Stored prompt injection                   | Transcript and retrieved content is delimited and labeled as evidence, never instructions. Extraction workers use schema-constrained output, validate every cited evidence ID, and have no ambient credentials, network access, or tool authority beyond required data reads/writes. Model output cannot approve memory, change consent, call MCP tools, or delete/export data.     | Adversarial corpus attempts data exfiltration, instruction override, false evidence, cross-tenant references, and tool invocation; all produce no unauthorized action or reference. |
| Malicious model response                  | Treat model output as untrusted. Validate schema, tenant, source IDs, category, scope, size, and prohibited-sensitive categories deterministically. Only user-approved memories can be returned to agents.                                                                                                                                                                          | Memory evaluation includes malformed, unsupported, prohibited, contradictory, and wrong-scope candidates.                                                                           |
| MCP exfiltration                          | Authorize each call to the requesting user and project; cap tokens/results; cite returned evidence; do not expose unrelated projects by default. Read-only MCP ships first. Stored text cannot select a tool or widen arguments.                                                                                                                                                    | Project-isolation and prompt-injection E2E tests run through MCP, not only service methods.                                                                                         |
| Payload or archive abuse                  | Enforce compressed and decompressed limits, event/field caps, content types, timeouts, and rate limits before durable processing. Never follow archive paths or symlinks.                                                                                                                                                                                                           | Decompression-bomb, oversized-batch, malformed Unicode, path traversal, and retry-flood tests.                                                                                      |
| Log, trace, or analytics leakage          | Conversation bodies, prompts, model responses, secrets, diffs, and signed URLs MUST NOT appear in normal logs, traces, error reports, or analytics. Use opaque IDs and coarse metrics. Sanitize errors at every boundary.                                                                                                                                                           | Canary-secret tests inspect captured logs, traces, analytics, and error responses.                                                                                                  |
| Export disclosure                         | Require recent/step-up authentication, scope the export, build it in an isolated job, encrypt it at rest, use an expiring one-use download grant, and audit request/download/expiry. Export content follows the same tenant checks as online reads.                                                                                                                                 | Cross-tenant and expired-link tests; generated archives are scanned for entries outside the requested scope.                                                                        |
| Incomplete deletion or revoked consent    | Stop new ingestion immediately on disable or consent withdrawal. Deletion cascades through primary and derived stores and is verified by negative query checks. Backups expire within the published window.                                                                                                                                                                         | Lifecycle E2E and periodic restore/deletion drills use unique canary records.                                                                                                       |
| Insider or support access                 | Production access is least privilege, time bounded, MFA protected, approved, and audited. Support tooling shows metadata by default; content access requires explicit user authorization and a recorded reason. No shared accounts.                                                                                                                                                 | Quarterly access review and alerting on privileged content access.                                                                                                                  |
| Subprocessor misuse or model training     | Maintain a public subprocessor inventory and data-flow record. Contracts prohibit training on customer content and set retention/deletion limits. Send only the minimum scoped content needed for a job.                                                                                                                                                                            | Pre-use legal/security review; annual contract review; deletion tests include Baton-controlled provider caches.                                                                     |
| Key or backup compromise                  | TLS in transit, KMS-backed encryption at rest, separated production roles, rotation procedures, encrypted backups, and tested restoration. Secrets never live in source or normal logs.                                                                                                                                                                                             | Secret scanning in CI, annual key-rotation exercise, and at least quarterly backup-restore test before paid beta.                                                                   |
| Supply-chain compromise                   | Lock dependencies, review install scripts, scan dependencies and images, generate an SBOM, protect CI/release credentials, and sign release artifacts where supported.                                                                                                                                                                                                              | CI blocks known critical exploitable vulnerabilities or requires a time-bounded security exception.                                                                                 |

## 6. Data integrity and replay

Events are immutable after acceptance. The server validates content hashes,
schema versions, parent ownership, project consent, and scoped idempotency keys
in one transaction. Duplicate or out-of-order delivery MUST converge without
overwriting an existing event. A retry response MUST reveal no information about
another tenant's idempotency key or event ID.

Derived summaries, chunks, embeddings, and memories record source event IDs and
generator version. They can be rebuilt and are never treated as stronger
evidence than their sources.

## 7. Incident response

Security-relevant authentication, credential, consent, export, deletion,
privileged access, and memory-approval actions create content-free audit events.
The incident process MUST support token revocation, ingestion suspension,
subprocessor suspension, tenant notification assessment, and preservation of
content-free forensic metadata. Incident handling does not override deletion or
retention promises unless a documented legal hold applies.

## 8. Measurable pre-beta gate

Private beta is blocked until:

- the cross-tenant suite has **zero** unauthorized reads, writes, existence
  leaks, search hits, object grants, export entries, or worker outputs across
  all content routes;
- seeded credential fixtures and canary secrets produce **zero** unredacted
  values in accepted events, storage, indexes, model requests, logs, traces,
  analytics, and exports;
- raw/native-session and unknown-field requests are rejected before durable
  storage in **100%** of contract tests;
- device-code replay, expired-code use, refresh replay, and revoked-token access
  fail in **100%** of auth tests;
- every API route has a declared audience, scope, tenant rule, size limit, and
  rate-limit class;
- the stored-injection corpus causes **zero** tool calls, consent changes,
  memory approvals, unsupported evidence references, or cross-project results;
- one project and one account deletion drill meet the deadlines in the retention
  matrix and return **zero** results from all live query paths;
- a restore drill succeeds and proves that records already expired from the
  backup window are not restored; and
- no unresolved high or critical finding remains without a fix. Risk acceptance
  is allowed only for lower severity findings with an owner and expiry date.
