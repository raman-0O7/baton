# Baton trust, privacy, and terms outline

This is the product's trust contract for the private beta. It is a working
outline to be reviewed by counsel before any paid release; it is not a
substitute for a lawyer-reviewed privacy policy and terms of service.

## What Baton collects

Only from **explicitly enabled** projects, and only after recorded consent for a
specific collection policy version:

- user/assistant conversational text;
- explicit plans and todo state;
- commands with locally scrubbed arguments;
- bounded, scrubbed tool results useful for failures and decisions;
- file paths and unified diffs already present in the session;
- agent, model, timestamps, project, branch, and session metadata.

Baton never uploads environment dumps, credential files, complete repository
snapshots, binary content, oversized tool output beyond the configured cap,
collection-policy-ignored files, or inferred sensitive personal attributes.
Complete native session payloads cannot be represented by the upload schema.

## How content is protected

- Local secret scrubbing runs before any content leaves the device; the server
  performs defense-in-depth scanning and payload validation.
- TLS in transit; encryption at rest with managed KMS-backed keys.
- Every content row, index entry, object, cache key, and background job is
  scoped to a tenant; PostgreSQL row-level security is forced and tenant
  identity is derived from the credential, never a request field.
- Conversation bodies, prompts, and model responses are never written to normal
  application logs.

## No training on customer content

Baton does **not** train foundation models on customer content, and
contractually commits its subprocessors to the same. Managed models are used
only to serve the user's own retrieval, summarization, and memory features.

## Personalization requires approval

Inferred personal preferences enter an approval inbox and never reach an agent
until the user approves them. Baton does not infer protected or sensitive
personal traits (health, political, religious, sexual, or intimate data), and
the deterministic validator rejects such inferences regardless of evidence.

## User controls

- **Export:** download a documented JSON archive of your projects, events, work
  threads, and approved memories at any time (`/v1/account/export`).
- **Delete:** delete a project or your entire account across every store
  (primary, derived, object, and controlled model caches) with an observable
  completion receipt (`/v1/projects/:id/delete`, `/v1/account/delete`). Account
  deletion is performed from the authenticated dashboard.
- **Devices:** list and revoke device credentials; revocation is immediate.
- **Consent & retention:** consent is recorded per enabled project and policy
  version; retention windows are configurable and enforced by an expiry sweep.

## Subprocessors (to be finalized before paid beta)

Baton will publish and keep current a list of subprocessors (managed PostgreSQL,
object storage, managed-model provider, email delivery) with the data each
processes. Each is bound by contract to the no-training commitment and to
tenant-scoped access.

## Terms outline

- Individual-developer accounts; organization/team sharing is out of scope for
  the first paid release.
- Metered managed-AI usage in paid tiers, within published quotas and budgets.
- Published reliability and latency targets; graceful degradation preserves the
  deterministic capture and retrieval path when optional AI features are
  unavailable.
- The legacy Git-mode prototype remains independently runnable during a defined
  sunset window; existing Git repositories and age keys are never silently
  uploaded, moved, or deleted.
