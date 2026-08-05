# Baton Hosted Product Implementation Plan

**Status:** Phases 0–3 complete; Phase 4 (indexed retrieval) is next  
**Last updated:** 2026-08-05  
**Supersedes for new development:** The product direction in `REQUIREMENTS.md`
and `IMPLEMENTATION_PLAN.md`. Those documents remain the record of the completed
local/Git-based prototype.

New hosted development is TypeScript-first. The Go module is preserved as the
legacy prototype and compatibility implementation; it is not the foundation of
the cloud runtime.

## 1. Product thesis

Baton is a hosted, portable memory layer for developers and their AI coding
agents.

It continuously captures explicitly enabled coding-agent conversations,
organizes multiple agent sessions into goal-oriented work threads, and lets a
new agent retrieve only the context it needs. It also learns user-approved
preferences and workflows as structured, evidence-backed memory.

The core promise is:

> Continue any piece of development work in any supported coding agent, on any
> device, without replaying the entire conversation.

Session synchronization remains useful infrastructure, but it is no longer the
product users must understand. Users do not create Git repositories, resolve
conversation merges, or manage storage backends.

## 2. Agreed product decisions

| Area                 | Decision                                                                                  |
| -------------------- | ----------------------------------------------------------------------------------------- |
| Product identity     | Portable AI memory for developers                                                         |
| Implementation stack | TypeScript monorepo for the hosted product, CLI, workers, and dashboard                   |
| Storage              | Baton-managed cloud storage; no user-managed Git remote                                   |
| Cloud readability    | Baton may process conversation content after explicit consent                             |
| Collection scope     | Explicitly enabled projects only                                                          |
| Sync behavior        | Continuous background upload with a visible pause control                                 |
| Offline behavior     | Internet required for v1 retrieval and cross-device use; offline queues are deferred      |
| Continuation model   | A fresh agent session retrieves prior context; native session restoration is not the core |
| Work organization    | A work thread can span devices, agents, and native conversations                          |
| Context strategy     | Progressive disclosure through a compact bootstrap and on-demand retrieval                |
| Personalization      | Structured, evidence-backed memory rendered as `SOUL.md`; not an opaque generated profile |
| Memory approval      | New personal preferences enter an approval inbox before agents may use them               |
| Memory scopes        | Global user, organization-ready, project, and work-thread layers                          |
| Initial customer     | Individual developers; schema and authorization remain organization-ready                 |
| AI provider          | Baton-managed models by default; BYOK/local models deferred                               |
| Historical data      | New capture starts immediately; historical import is optional and previewed               |
| Dashboard            | Action-oriented home centered on active work, with archive/search available               |
| Ingestion            | Agent-file watcher plus MCP enrichment and periodic reconciliation                        |
| Privacy              | Local secret scrub before upload, configurable collection depth, deletion/export controls |

## 3. Explicit non-goals for the first hosted release

- Reproducing an exact native Claude, Codex, or OpenCode chat on another device.
- Using Git as the cloud system of record.
- Team collaboration or shared organization memory in the first paid release.
- End-to-end/zero-knowledge encryption. The service must be able to process
  opted-in content to provide retrieval and personalization.
- Full functionality without an internet connection.
- Automatically uploading every historical conversation found on a device.
- Uploading arbitrary repository contents or complete environment snapshots.
- Allowing unapproved inferred personal preferences to influence agents.
- Training foundation models on customer content.
- Treating an LLM summary as authoritative without links to source evidence.

## 4. User experience

### 4.1 First use

```console
baton login
cd ~/code/my-project
baton enable
baton daemon
```

`baton login` uses a browser/device authorization flow and stores a revocable
device credential in the operating-system credential store where possible.
`baton enable` detects installed supported agents, shows exactly what will be
collected, records consent, and begins continuous synchronization.

After enabling, the dashboard should show the project and its newly captured
work within one settled conversation turn.

### 4.2 Continue work

```console
cd ~/code/my-project
baton continue
```

Baton ranks likely active work threads using project, current Git branch, recent
activity, and recently changed file paths:

```text
Continue “Implement hosted authentication”? Updated 2 hours ago.
[Y] Continue  [L] Choose another thread  [N] Start fresh
```

After confirmation, Baton provides a small bootstrap prompt containing a work
thread ID and instructions to use Baton MCP. The agent retrieves an overview,
then requests decisions, evidence, errors, or file history only as needed.

### 4.3 Dashboard home

The first dashboard release is an action workspace, not merely a transcript
viewer:

- active work threads and their current state;
- pending tasks and blockers;
- likely work to continue;
- recent decisions and changed files;
- global search;
- sync/device health;
- proposed memories awaiting approval.

Detailed transcripts, raw event evidence, privacy controls, export, and deletion
remain accessible from secondary views.

## 5. System architecture

```text
┌──────────────────────────────── Local device ──────────────────────────────┐
│                                                                           │
│ Agent storage ──► adapters ──► canonical events ──► local scrubber        │
│     ▲                 ▲                │                    │               │
│     │                 │                └── sync checkpoint  ▼               │
│ Claude/Codex/OC   watcher/reconcile                    Cloud client         │
│     ▲                                                        │             │
│     └────────────────── local MCP bootstrap/proxy ────────────┤             │
└──────────────────────────────────────────────────────────────┼─────────────┘
                                                               │ TLS
┌──────────────────────────────── Baton Cloud ──────────────────▼─────────────┐
│ API/auth gateway ─► ingestion service ─► append-only event store           │
│                               │                 │                           │
│                               ├──► artifact store│                           │
│                               └──► durable jobs  │                           │
│                                                 ▼                           │
│                                  index/chunk/materialization workers        │
│                                      │          │          │                │
│                                      ▼          ▼          ▼                │
│                                  retrieval   snapshots   memory candidates  │
│                                      │                     │                │
│                         ┌────────────┴────────────┐        approval          │
│                         ▼                         ▼          │                │
│                   Hosted MCP API            Dashboard/API ◄┘                │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 5.1 Technology choices

- **Language:** TypeScript across the hosted CLI, API, workers, shared
  contracts, retrieval, memory engine, and dashboard.
- **Runtime and workspace:** Node.js with pnpm workspaces and Turborepo. Pin the
  supported Node and package-manager versions in the repository and CI.
- **CLI:** Commander initially, with dependency injection around filesystem,
  credential-store, watcher, and network boundaries. Use `tsx` for development
  and a bundler for releases.
- **API:** Fastify with Zod-validated request/response schemas and generated
  OpenAPI. Keep transport DTOs separate from database and domain types.
- **Workers:** TypeScript processes sharing domain packages with the API but
  deployed and scaled independently.
- **Primary database:** PostgreSQL.
- **Database access:** Drizzle for typed queries and explicit SQL migrations.
- **Search:** PostgreSQL full-text search first; `pgvector` added for semantic
  recall once the lexical baseline and evaluation set exist.
- **Allowed oversized artifacts:** S3-compatible object storage. The upload
  contract has no field for the adapter's complete native `Session.Raw`.
- **Durable background work:** a PostgreSQL jobs table using
  `FOR UPDATE SKIP LOCKED` initially. Introduce a separate queue only after
  measured throughput requires it.
- **Dashboard:** Next.js and React, consuming a generated API client rather than
  importing API internals.
- **Authentication:** standards-based web identity plus OAuth-style device
  authorization for the CLI. Do not invent password or token protocols.
- **MCP:** the official TypeScript MCP SDK behind an authenticated remote
  endpoint; a CLI stdio proxy/bootstrap may bridge agent clients whose remote
  authentication support is incomplete.
- **Validation and testing:** Zod, Vitest, Testcontainers, and Playwright.
- **Code quality:** strict TypeScript, ESLint, and Prettier enforced in CI.
- **Observability:** structured metadata, traces, metrics, and redacted logs.
  Conversation bodies must never be placed in normal application logs.

Avoid premature distributed infrastructure. PostgreSQL, object storage, one API
deployment, and one worker deployment are sufficient for the first production
version.

The initial TypeScript CLI may require a supported Node.js runtime. Standalone
packaging is a release optimization, not a Phase 0 blocker. Do not choose an
unproven executable packager at the expense of filesystem, SQLite, keychain, or
watcher reliability.

## 6. Canonical data model

The unit of synchronization is an immutable event, not a mutable transcript
file. Periodic snapshots accelerate reads but never replace the event history.

### 6.1 Primary entities

#### Account and access

- `users`
- `organizations` and `organization_memberships` (dormant in v1)
- `devices`
- `device_credentials`
- `consent_records`
- `audit_events`

#### Work hierarchy

- `projects`: a stable cloud project, enabled explicitly by the user.
- `project_installations`: device/project/source associations. Absolute local
  paths remain on the device; only an optional non-sensitive label or hash is
  sent when cross-device matching requires it.
- `source_sessions`: one native Claude/Codex/OpenCode conversation.
- `work_threads`: the user-facing goal that may span source sessions.
- `work_thread_sessions`: joins source sessions to threads with ordering and
  provenance.

#### Conversation history

- `events`: immutable canonical user, assistant, system, tool, file, plan,
  error, and decision observations.
- `ingestion_checkpoints`: last source cursor/fingerprint acknowledged for a
  device and native session.
- `event_edges`: parent relationships for divergence and causal ordering.
- `session_snapshots`: materialized current state for fast reads.
- `artifacts`: references to explicitly allowed, locally scrubbed oversized
  diffs or tool results in object storage. Complete native session payloads
  remain on the device by default.

#### Retrieval

- `chunks`: stable, source-linked retrieval units.
- `chunk_terms`: full-text search representation.
- `chunk_embeddings`: optional semantic vectors and model version.
- `thread_summaries`: generated overview with source coverage and model
  provenance.
- `decisions`, `tasks`, `errors`, and `file_activities`: useful structured
  projections derived from events.

#### Personalization

- `memory_candidates`: proposed observations awaiting review.
- `memories`: approved facts/preferences.
- `memory_evidence`: links a memory or candidate to source events.
- `memory_revisions`: edits, contradictions, confirmations, expiry, and deletion
  history.

### 6.2 Event envelope

Every uploaded event needs:

```text
event_id             globally unique, client-generated
idempotency_key      deterministic for the native source event
user_id              authorization boundary
project_id
source_session_id
work_thread_id       nullable until assigned
source_agent
source_device_id
kind
native_sequence      nullable native ordering
parent_event_id      nullable divergence/causality link
occurred_at
observed_at
content_hash
schema_version
payload
```

The server enforces uniqueness on the scoped idempotency key. Retried batches
return the already-accepted result. Events may arrive out of order; projections
must be rebuildable.

### 6.3 Divergence

If two devices extend the same observed parent, both event branches are
preserved. Baton does not merge conversational prose. It can:

1. display both source histories under the same work thread;
2. mark concurrent branches;
3. generate a current-state projection that cites both;
4. ask the user only when the branches contain genuinely conflicting task state
   or decisions.

This retains the safety property of the current fork-on-conflict implementation
without exposing Git semantics.

## 7. Ingestion and synchronization

### 7.1 Adapter evolution

The current Go `AgentAdapter` parses a complete native session into
`model.Session`. Preserve it as a legacy implementation and behavioral reference
while defining the TypeScript streaming contract:

```ts
export interface EventSource {
  readonly name: AgentName;
  discover(project: ProjectBinding): Promise<SourceSessionRef[]>;
  readSince(ref: SourceSessionRef, cursor?: Cursor): Promise<EventBatch>;
  fingerprint(ref: SourceSessionRef): Promise<Fingerprint>;
}
```

The exact interface is frozen only after adapter fixture tests demonstrate
Claude Code JSONL, Codex rollout JSONL, and OpenCode SQLite cursor behavior.

JSONL sources should use stable native IDs/offset checkpoints when available.
OpenCode should use database row identifiers/timestamps inside a read
transaction. When an agent format lacks stable incremental identifiers, the
adapter may reparse and deterministically deduplicate events.

### 7.2 Upload protocol

1. Watcher notices a settled write.
2. Adapter reads events after the last acknowledged checkpoint.
3. Local policy excludes disallowed event fields and large payloads.
4. Local scrubber redacts known credentials and high-entropy secrets.
5. CLI sends a bounded, compressed event batch with an idempotency key.
6. Server validates authentication, project consent, schema, size, and tenant
   ownership inside one transaction.
7. Server stores normalized events, finalizes explicitly allowed oversized
   artifacts through a signed object path when applicable, and advances the
   checkpoint.
8. Server enqueues projection, indexing, summary, and memory-candidate jobs.
9. CLI records the acknowledged checkpoint.

The protocol must support safe retry after a timeout between steps 6 and 9.

### 7.3 Collection policy

Default upload:

- user/assistant conversational text;
- explicit plans and todo state;
- commands with locally scrubbed arguments;
- bounded, scrubbed tool results useful for failures and decisions;
- file paths and unified diffs already present in the session;
- agent, model, timestamps, project, branch, and session metadata.

Default exclusion:

- environment dumps;
- credential files;
- complete repository snapshots;
- binary content;
- oversized tool output beyond a configurable cap;
- files ignored by collection policy;
- inferred sensitive personal attributes.

The enable flow presents this policy plainly. Users can narrow or widen it per
project. Widening sensitive categories requires explicit confirmation.

### 7.4 Historical import

Enabling a project begins new capture immediately. The CLI separately offers:

```text
Found 84 conversations for this project
Date range: Jan 2025 – Jul 2026
Estimated upload: 126 MB

[Import all] [Choose date range] [Skip]
```

The preview must identify agents, date range, estimated post-policy size, and
likely secret redactions before upload.

## 8. Retrieval and context compilation

The indexed handoff is the first major product differentiator.

### 8.1 Progressive disclosure

Agents never receive a complete transcript by default. Baton compiles context in
layers:

1. **Bootstrap (target: 500–1,000 tokens):** identity of the selected work
   thread, goal, current state, top pending tasks, and MCP usage instruction.
2. **Overview (target: 1,500–3,000 tokens):** important decisions, changed
   files, blockers, recent progress, and evidence references.
3. **Retrieved evidence:** only chunks relevant to an agent query, within an
   explicit token budget.
4. **Raw source:** specific original turns/tool results requested by reference.

Every generated claim links to source event IDs. If generated state conflicts
with repository state, agents are told to trust the repository and report the
discrepancy.

### 8.2 Chunking

Chunk on semantic boundaries rather than fixed character windows:

- a user request and its immediate response;
- a tool call with its bounded result;
- a file operation/diff;
- a plan update;
- an error and the attempts resolving it;
- an explicit decision and rationale.

Chunks retain project, work thread, source session, timestamps, file paths,
symbols where cheaply extractable, Git branch/commit, token estimate, and source
event range.

### 8.3 Retrieval pipeline

1. Enforce user/project/thread authorization before searching.
2. Apply structured filters: current project and selected work thread by
   default.
3. Retrieve lexical candidates using PostgreSQL full-text search.
4. Add semantic candidates when embeddings are enabled.
5. Rank by relevance, source quality, recency, decision/task importance, and
   diversity.
6. Deduplicate overlapping chunks.
7. Compile within the caller's token budget.
8. Return citations and state whether results were lexical, semantic, or
   generated.

LLMs may extract queries, rerank, and summarize, but retrieval must have a
deterministic lexical fallback.

### 8.4 MCP surface

Initial read tools:

- `baton_suggest_threads(project)`
- `baton_list_threads(project, status)`
- `baton_get_thread_overview(thread_id, token_budget)`
- `baton_search_context(query, project_id, thread_id?, token_budget)`
- `baton_get_evidence(reference_ids)`
- `baton_get_file_history(path, project_id, thread_id?)`
- `baton_get_approved_memories(project_id?, categories?, token_budget)`

Later write tools, after the read-only continuation flow is proven:

- `baton_record_decision(thread_id, decision, evidence?)`
- `baton_update_task(thread_id, task, status)`
- `baton_propose_memory(scope, claim, evidence)`
- `baton_close_thread(thread_id, outcome)`

The first MCP beta is read-only. Later write tools record attributable events or
proposals. They do not silently approve personal memory, delete history, or
widen collection scope, and receive separate narrow OAuth scopes.

## 9. SOUL and layered memory

`SOUL.md` is a useful rendering, not the canonical store. The canonical form is
structured so it can be inspected, scoped, corrected, and selectively shared.

### 9.1 Memory record

```yaml
id: mem_...
category: engineering_workflow
claim: 'Prefers reversible database migrations.'
scope:
  type: global
  id: null
confidence: 0.86
status: approved
evidence:
  - event: evt_...
  - event: evt_...
model:
  provider: ...
  model: ...
  prompt_version: ...
first_observed_at: ...
last_confirmed_at: ...
expires_at: null
```

### 9.2 Scope and precedence

1. work-thread memory;
2. project memory;
3. organization memory (future);
4. global user memory.

Specific context overrides broader context. Conflicts are surfaced, not silently
resolved. A project technology decision must not become a global personal
preference.

### 9.3 Candidate pipeline

1. A background job selects new, eligible source events.
2. A managed LLM emits schema-constrained candidate claims and evidence IDs.
3. Deterministic validation rejects unsupported evidence, prohibited categories,
   malformed scope, and duplicates.
4. Similar candidates reinforce confidence; contradicting candidates create a
   review item.
5. Candidate appears in the dashboard approval inbox.
6. The user approves globally, approves for a narrower scope, edits, or rejects.
7. Only approved memories are returned to agents.

### 9.4 Safety rules

- Do not infer protected or highly sensitive personal traits.
- Do not convert secrets, credentials, private keys, health information,
  political beliefs, or intimate personal data into memory.
- One isolated instruction should normally remain work-thread context, not a
  personal preference.
- Every claim must show evidence and model/prompt provenance.
- Rejection prevents immediate regeneration of the same claim.
- Users can edit, expire, revoke, export, or delete any memory.
- Prompt injection inside stored conversations is untrusted data. Extraction
  prompts and workers must treat transcript content as evidence, never as
  instructions.

## 10. Security, privacy, and trust

Readable cloud content makes the product possible and creates a high trust
obligation.

### 10.1 Required controls before private beta

- TLS for all traffic and encryption at rest using managed KMS-backed keys.
- Short-lived access tokens, rotating/revocable device credentials, and
  operating-system credential-store integration.
- Tenant-scoped authorization in every repository/query path; deny by default.
- `workspace_id`/personal-tenant scope on every content row, index entry,
  object, cache key, and background job. PostgreSQL row-level security provides
  defense in depth, and tenant identity is derived from the credential rather
  than a request field.
- Explicit consent version recorded per enabled project and collection policy.
- Local secret scrub remains mandatory before upload.
- Server-side defense-in-depth scanning and payload validation.
- No conversation content, prompts, or model responses in normal logs.
- Strict upload, decompression, event, and per-field size limits.
- Signed, tenant-scoped object-storage access.
- Audit log for login, device changes, export, deletion, consent changes, and
  memory approvals.
- Rate limiting, abuse controls, dependency scanning, secret scanning, and
  regular backup-restore tests.
- Documented subprocessors and a contractual promise not to train models on
  customer content.

### 10.2 Deletion and retention

Deletion is a workflow, not a single database statement. A project/session/user
deletion job must remove or tombstone:

- events and projections;
- search indexes and embeddings;
- object-storage artifacts;
- generated summaries;
- memory evidence and unsupported memories;
- cached model input/output where controlled by Baton;
- operational replicas according to a published backup expiry.

The dashboard reports deletion progress and final completion. Automated tests
must prove that deleted tenant content is no longer queryable.

### 10.3 Export

Users can export projects, work threads, source events, evidence, and approved
memory in documented JSON/Markdown archives. A Git-compatible directory may be
one export format, but Git is not required to use Baton.

## 11. API boundaries

Use versioned APIs and generated clients from a single contract.

Minimum service boundaries:

- **Identity API:** browser login, device authorization, token rotation,
  devices, logout/revoke.
- **Project API:** enable/disable, consent, source installations, collection
  policy.
- **Ingestion API:** batch events, checkpoints, reconciliation, import status.
- **Work API:** threads, source-session assignment, tasks, decisions, current
  state.
- **Retrieval API:** search, evidence, context compilation, summaries.
- **Memory API:** candidates, approvals, edits, scopes, export/delete.
- **MCP gateway:** maps authenticated tools to Work/Retrieval/Memory APIs.
- **Dashboard API:** a browser-oriented composition layer; it must not bypass
  domain authorization.

The first deployment may be a modular monolith. These are code and ownership
boundaries, not a requirement for separate network services.

## 12. Repository transition

### 12.1 Reuse

The Go implementation remains runnable during the migration, but hosted
production code does not call into Go packages. Reuse means porting behavior
behind TypeScript contracts and proving parity against the same fixtures:

- `internal/adapters`: native format knowledge and golden fixtures become the
  specification for `packages/adapters`.
- `internal/model`: seed for versioned Zod event schemas in `packages/protocol`.
- `internal/scrub`: patterns, entropy rules, seeded clean/leak corpora, and
  mandatory pre-upload semantics become `packages/scrubber`.
- `internal/daemon`: watcher, debounce, and rescan behavior becomes
  `packages/collector`.
- `internal/handoff`: token-budget tests and deterministic degradation inform
  `packages/context`.
- `internal/mcptrans`: behavior is ported into the CLI's MCP installer.
- Adapter, scrubber, handoff, daemon, and two-device fixtures remain shared
  regression assets until TypeScript parity is complete.

### 12.2 Replace or de-emphasize

- The current Go `internal/gitstore`, `internal/registry`, `internal/crypt`,
  native `WriteSession`, and Git orchestration remain legacy-only.
- The TypeScript CLI becomes the supported cloud client. The existing Go CLI
  remains independently buildable and receives critical compatibility and
  security fixes during a defined sunset window.
- The TypeScript CLI can read legacy configuration only to preview and perform
  an explicitly confirmed cloud migration. It does not execute Git push/pull or
  invoke the Go binary.
- Go `baton push`/`pull` and Markdown export remain available through the legacy
  release temporarily. Cloud export is rebuilt from the TypeScript
  retrieval/context compiler.
- Do not delete, bulk-move, or rewrite the working Go tree at the beginning of
  the migration. Tag it, keep its test suite green, and move it under
  `legacy/go` only when build/release automation is ready for the relocation.

### 12.3 Proposed tree

```text
apps/
  cli/                   TypeScript CLI and MCP stdio bridge
  api/                   Fastify modular-monolith API
  worker/                indexing, summaries, memory, deletion
  dashboard/             Next.js application
packages/
  protocol/              Zod wire schemas and generated OpenAPI inputs
  domain/                framework-free domain types and rules
  adapters/              Claude, Codex, and OpenCode event sources
  collector/             watcher, cursor, admission, upload orchestration
  cloud-client/          generated/typed API client
  scrubber/              local secret detection and policy
  auth/                  shared auth contracts; no browser secrets
  database/              Drizzle schema, SQL migrations, repositories
  jobs/                  durable job contracts and worker registration
  indexing/              chunking and derived projections
  retrieval/             search and ranking
  context/               token-budgeted evidence compiler
  memory/                candidate, approval, and layered SOUL logic
  observability/         content-safe telemetry helpers
api/
  openapi.yaml
db/
  migrations/
testdata/
  fixtures/
  retrieval/
  memory/
deploy/
cmd/                     existing Go CLI during compatibility window
internal/                existing Go prototype during compatibility window
```

Package boundaries should prevent server applications from importing CLI
internals, prevent the dashboard from importing API/database internals, and
prevent domain packages from reaching around authorization-aware repositories.
Public API types originate in `packages/protocol`; database rows are never
reused as wire DTOs.

## 13. Delivery phases

Each phase ends in a demonstrable vertical result. Contracts are established
before broad parallel implementation so sub-agents do not invent incompatible
interfaces.

### Phase 0 — Product contracts and evaluation corpus

**Goal:** Freeze the first hosted vertical slice before infrastructure work
spreads.

**Progress as of 2026-08-01**

Completed:

- pnpm/Turborepo foundation and TypeScript/legacy-Go CI lanes;
- strict Zod event and ingestion schemas;
- canonical JSON, deterministic SHA-256 identity, and UUIDv8 event IDs;
- generated OpenAPI 3.1 ingestion contract with OAuth scope and drift tests;
- device authorization, project/consent, work-thread, readback, and canonical
  API error contracts;
- threat model, collection/consent policy, and retention/deletion matrix;
- six fixture-pinned adapter semantic goldens plus transition, convergence,
  retrieval, and memory evaluation corpora;
- executable Claude Code, Codex, and OpenCode incremental TypeScript adapters;
- Go-parity secret scrubber and opaque scrubbed-upload capability;
- end-to-end native-snapshot to scrubbed-upload integration gate;
- accepted PostgreSQL, object-storage, model-processing, and legacy-Git ADRs;
- normative security-control mapping and frozen collection disclosure copy; and
- workspace dependency-boundary validation.

The engineering deliverables, automated gate, and accountable internal
trust-contract approvals are complete. Phase 0 was formally frozen on
2026-08-01. Independent product/privacy review remains a release gate before
design-partner or private-beta collection, as recorded in
`docs/security/approvals.md`.

**Deliverables**

- pnpm/Turborepo workspace, shared strict TypeScript configuration, formatting,
  linting, Vitest, and package-boundary conventions.
- Replace draft product requirements with the decisions in this document.
- Threat model and data-classification/collection-policy specification.
- Versioned Zod event envelope, work-thread model, and ingestion protocol.
- OpenAPI skeleton covering device auth, projects, ingestion, and readback.
- Sanitized multi-agent fixture corpus including incremental append,
  truncation/rewrite, out-of-order arrival, duplicate upload, and divergence.
- Versioned `expected-events-v1.json` goldens beside the existing Go snapshot
  goldens; old fixtures and expected outputs are never rewritten merely to fit
  the TypeScript implementation.
- Retrieval evaluation set: real questions, expected evidence, and maximum token
  budgets.
- Memory evaluation set: acceptable candidate, wrong scope, insufficient
  evidence, contradiction, and prohibited-sensitive-inference cases.
- Architecture decision records for PostgreSQL, object storage, hosted content
  processing, and legacy Git compatibility.

**Parallel lanes after a short shared schema kickoff**

- Agent A (`packages/protocol`, `api/`): event schemas, ingestion protocol, and
  generated-contract drift checks.
- Agent B (`docs/security/`): threat model, consent, collection policy, and
  deletion matrix.
- Agent C (`testdata/`, evaluation package): retrieval and memory evaluation
  corpora plus TypeScript adapter-parity goldens.
- Agent D/root (root tooling and app boundaries): legacy compatibility, CI,
  dependency rules, and overall contract review.

**Gate**

All supported fixtures map deterministically into versioned events; full and
incremental reads converge; duplicate, retry, out-of-order, and rewrite
scenarios converge to the same authorized state; and no upload DTO can contain
complete native payloads. The legacy Go suite and the new TypeScript contract
suite are both green.

### Phase 1 — Cloud foundation and device login

**Goal:** A user can log in from two CLIs and see both registered devices.

**Deliverables**

- Fastify API and worker applications, Drizzle schema/SQL migrations, local
  development environment, and production configuration conventions.
- Web login and OAuth device authorization flow.
- Short-lived access/rotating device credentials with revoke/logout.
- Tenant-aware store interfaces and authorization middleware.
- Minimal dashboard shell showing account and devices.
- Audit events, structured redacted logging, tracing, metrics, and CI.
- CLI `login`, `logout`, `whoami`, and cloud-aware `doctor`.

**Parallel lanes**

- Agent A: schema/migrations and tenant-aware storage.
- Agent B: device-flow backend and CLI credential handling.
- Agent C: dashboard auth/account/devices shell.
- Agent D/root: deployment, observability, integration tests, review.

**Gate**

An end-to-end test registers two devices, refreshes credentials, revokes one,
and proves the revoked device cannot access either user metadata or another
tenant.

**Completion record (2026-08-02):** Phase 1 is complete and frozen. The hosted
Fastify API, Next.js dashboard, worker boundary, Drizzle/PostgreSQL identity
store, OAuth device flow, OIDC browser flow, rotating credentials, CLI commands,
audit/telemetry controls, local environment, and CI migration gate are in place.
The automated route-level gate registers two CLI devices, rotates one
credential, revokes it, verifies its account access is rejected, and proves a
principal from one tenant cannot revoke a device in another tenant. Phase 2 must
build on these public identity contracts rather than bypassing them.

### Phase 2 — Incremental capture and cloud sync

**Goal:** A newly appended conversation turn from an enabled project appears in
cloud storage once, without Git or manual push.

**Deliverables**

- `EventSource` contract and incremental implementations for Claude Code, Codex,
  and OpenCode.
- Local project installation map and explicit enable/disable/collection consent
  flow.
- Cloud ingestion batches, checkpoints, idempotency, compression, limits, and
  retry behavior.
- Continuous watcher plus periodic source reconciliation.
- Local scrubber policy applied before serialization/upload.
- Server-side validation, allowed-artifact object storage, and ingestion audit
  metadata. Complete native session payloads cannot be represented by the upload
  DTO.
- `baton status`, pause/resume capture, and actionable failure output.
- Read-only legacy Git config detection and migration guidance.

**Parallel lanes**

- Agent A: Claude/Codex incremental JSONL capture.
- Agent B: OpenCode SQLite capture and reconciliation.
- Agent C: ingestion API, checkpoints, object storage, and idempotency.
- Agent D/root: watcher/cloud client, consent UX, integration and security
  review.

**Gate**

A two-device test appends events, retries timed-out requests, sends duplicate
and out-of-order batches, and ends with exactly one copy of every event.
Cross-tenant batch IDs cannot reveal or mutate data.

**Implementation record (2026-08-02):** The Phase 2 code paths are implemented.
Native capture incrementally discovers Claude Code, Codex, and read-only
OpenCode sources; the sync coordinator applies explicit per-installation
consent, new-content baselines, collection policy, local scrubbing, bounded gzip
batches, retry/idempotency, watcher triggers, and periodic reconciliation. The
hosted API stores tenant-scoped projects, consent, immutable events, receipts,
and checkpoints behind forced PostgreSQL RLS and server-side policy validation.
The TypeScript CLI exposes `enable`, `status`, `pause`, `resume`, `disable`, and
`daemon`, while legacy Git detection remains read-only. The in-memory
two-device, duplicate/out-of-order, revocation, compression, forbidden-payload,
and cross-tenant gates pass. The live PostgreSQL transaction/RLS gate is closed:
it now passes against a non-superuser role (`NOSUPERUSER`, `NOBYPASSRLS`) so
`FORCE ROW LEVEL SECURITY` is genuinely exercised, and the Turbo `test` task
tracks `TEST_DATABASE_URL` so the gate can never silently replay as a cached
skip.

### Phase 3 — Work threads and first useful dashboard

**Goal:** Users see captured conversations organized as cross-agent work rather
than source-session files.

**Deliverables**

- Work-thread CRUD and source-session assignment.
- Conservative automatic thread suggestions using project, branch, temporal
  proximity, file overlap, and explicit session links.
- User confirmation for suggested joins and thread continuation.
- Materialized thread state: goal, recent activity, tasks, decisions, files,
  errors, and source sessions.
- Dashboard home, project view, thread timeline, transcript/evidence viewer,
  sync status, and manual reassignment.
- `baton continue` thread suggestion/selection flow without MCP retrieval yet.

**Parallel lanes**

- Agent A: thread domain and projection worker.
- Agent B: thread suggestion scoring and evaluation.
- Agent C: dashboard project/thread experiences.
- Agent D/root: CLI continue flow and end-to-end acceptance.

**Gate**

One work thread beginning in Claude on device A and continuing in Codex on
device B appears as a single user-confirmed thread while retaining both source
histories.

**Completion record (2026-08-05):** Phase 3 is complete. New `work_threads` and
`work_thread_sessions` tables (migration `0002`, forced RLS, a source session
belongs to at most one thread per tenant) join immutable source sessions into
user-facing goals. A tenant-scoped `WorkThreadStore` (Postgres and in-memory)
provides thread CRUD, source-session assignment with a `suggested`→`confirmed`
lifecycle, manual reassignment, and bounded cursor readback that merges every
assigned session's history. Materialized thread state (goal, tasks, decisions,
changed files, errors, sources) is a deterministic read-time projection of the
events, each item citing its source event. Conservative, deterministic thread
suggestions score shared source session, file overlap, Git branch, recent
activity, and sole-active-thread signals — never conversational prose — behind a
locked `thread_suggestion` evaluation corpus. The hosted API exposes work-thread
list/create/update, session assign/list/remove, event readback, overview,
project source-sessions, and thread suggestions under `work:read` /
`projects:write` scopes; the typed cloud client and the OpenAPI contract cover
them. The dashboard adds a work view and a thread timeline/evidence page with
manual reassignment, and the CLI adds `baton continue`, which ranks likely
threads and prints a compact bootstrap. The automated gate — an in-memory HTTP
end-to-end test plus a live PostgreSQL integration test — starts a thread in
Claude on device A, continues it in Codex on device B, confirms the suggested
join, reads back both histories as one thread, and proves a second tenant cannot
see or mutate it. MCP retrieval is intentionally still absent (Phase 5).

### Phase 4 — Indexed retrieval and context compiler

**Goal:** Baton answers work-history questions with materially less context than
a full transcript and with traceable evidence.

**Deliverables**

- Semantic-boundary chunker and structured projections.
- PostgreSQL full-text indexing and filtered retrieval.
- Token estimator, diversity/deduplication, and budgeted context compiler.
- Bootstrap and overview documents with stable evidence references.
- Retrieval API and dashboard search.
- Managed-LLM summarization/reranking behind versioned prompts and
  schema-constrained outputs.
- Optional embeddings only after lexical baseline metrics are recorded.
- Evaluation runner tracking retrieval recall, citation correctness, grounded
  claims, latency, and context reduction.

**Parallel lanes**

- Agent A: chunking and structured projections.
- Agent B: lexical/semantic retrieval and ranking.
- Agent C: context compiler, evidence format, and evaluation harness.
- Agent D/root: search UI, managed-model gateway, security review.

**Gate**

On the locked evaluation corpus:

- expected evidence recall meets the agreed threshold;
- every generated factual claim has valid source references;
- the median continuation bootstrap plus first retrieval is at least 80% smaller
  than the complete transcript;
- cross-project and cross-tenant retrieval tests return no unauthorized data.

### Phase 5 — Baton MCP and cross-agent continuation

**Goal:** A fresh supported agent can continue a work thread by retrieving only
needed Baton context.

**Deliverables**

- Authenticated hosted MCP gateway and tool schemas from section 8.4.
- CLI-assisted MCP installation/configuration for each supported agent.
- Local proxy/bootstrap path where an agent cannot complete remote MCP auth.
- `baton continue` launches or prints a concise agent-specific bootstrap.
- Read tools with strict thread/project defaults and token limits.
- OAuth audience and grants separate from CLI ingestion credentials.
- Dashboard display and audit history of MCP access.
- Prompt-injection, confused-deputy, token-exfiltration, and tool-authorization
  tests.

**Parallel lanes**

- Agent A: MCP auth/gateway and read tools.
- Agent B: agent-specific configuration/bootstrap and CLI.
- Agent C: scope enforcement, audit events, and dashboard activity.
- Agent D/root: continuation benchmark across Claude/Codex/OpenCode and
  adversarial review.

**Gate**

A developer stops work in one agent/device and completes the task in a different
agent/device. The target receives no full transcript, uses cited Baton
retrieval, and does not access unrelated project history.

### Phase 6 — SOUL memory and personalization

**Goal:** Baton produces useful, user-controlled personalization grounded in
conversation evidence.

**Deliverables**

- Managed-model gateway with cost limits, retries, provider isolation, and
  prompt/model versioning.
- Candidate extraction, deterministic validation, deduplication, contradiction
  detection, confidence, and layered scope.
- Prohibited-sensitive-category filter and adversarial extraction tests.
- Approval inbox with evidence viewer, edit, narrower-scope approval, reject,
  revoke, and expiry.
- Approved-memory retrieval and budgeted `SOUL.md` renderer.
- MCP memory reads restricted to approved claims relevant to the current
  context.
- Cost, candidate acceptance, rejection, correction, and usefulness metrics.

**Parallel lanes**

- Agent A: memory schema/domain and candidate lifecycle.
- Agent B: extraction prompts, validators, and evaluation suite.
- Agent C: approval/evidence/SOUL dashboard.
- Agent D/root: MCP integration, privacy review, and cost controls.

**Gate**

No rejected or unapproved personal claim reaches an agent. Every approved
rendered claim has accessible evidence. Prohibited inference tests produce no
candidate. Contradictory evidence creates review rather than silent overwrite.

### Phase 7 — Trust, lifecycle, and paid beta

**Goal:** Operate the complete individual-developer product safely.

**Deliverables**

- Historical-import preview and bounded background import.
- Project/session/account export.
- Project/session/account deletion across primary, object, derived, and model
  stores with observable completion.
- Retention controls, backup restoration, disaster recovery, and runbooks.
- Account/device/session privacy dashboard.
- Billing, quotas, model-cost budgets, abuse prevention, and graceful
  degradation.
- Email/product notifications for sync failures and pending security events.
- Performance/load testing, accessibility, support tooling, and staged rollout.
- Updated public documentation, privacy policy, terms, subprocessors, and
  no-training commitment.
- `baton migrate cloud --dry-run` for existing Git-mode users, showing projects,
  conversations, date range, estimated upload, collection exclusions, and
  redaction counts before explicit confirmation.
- Side-by-side TypeScript cloud and Go legacy releases during a compatibility
  window; no shared runtime. Existing Git repositories and age keys are never
  deleted or silently uploaded.

**Parallel lanes**

- Agent A: import/export/deletion lifecycle.
- Agent B: billing/quotas/cost controls.
- Agent C: privacy/settings/onboarding polish.
- Agent D/root: operations, recovery, load/security testing, release.

**Gate**

Private-beta users can onboard without staff help, continue cross-agent work,
inspect and correct memory, export/delete their data, and operate within
published latency/reliability targets. Restore and deletion drills pass.

### Phase 8 — Post-v1 options, validated by usage

Do not schedule these until product metrics justify them:

- organization sharing and team project memory;
- end-to-end encrypted/local-index mode;
- offline capture queue and local retrieval;
- BYOK and local models;
- IDE extension;
- proactive “you solved this before” suggestions;
- organization policies and administrative retention;
- native agent-session restoration;
- richer code-symbol and repository indexing.

## 14. Cross-phase testing strategy

### Deterministic tests

- Vitest adapter goldens and version-drift failures using the existing sanitized
  fixtures.
- Event canonicalization and stable idempotency keys.
- Property tests for duplicates, retries, out-of-order events, and divergence.
- Scrubber corpus, including false-positive and Unicode cases.
- Tenant authorization tests on every query/store method.
- Database migration forward/backward compatibility as policy permits.
- Context-budget invariants and evidence-reference integrity.

### Integration tests

- PostgreSQL and S3-compatible storage through Testcontainers or equivalent
  ephemeral environments.
- Device authorization, refresh, revoke, and expired credentials.
- Watcher to ingestion to projection to dashboard/API.
- Worker retries and poison-job handling.
- Managed-model timeouts, malformed output, and provider outages.
- Export and cascading deletion.
- Generated OpenAPI client/server contract compatibility.

### Product E2E

Maintain a sanitized scenario that:

1. starts a work thread in Claude on device A;
2. captures plans, commands, failures, decisions, and file changes;
3. continues through Codex on device B;
4. retrieves targeted context through MCP;
5. creates and approves a memory candidate;
6. verifies the approved preference helps a later thread;
7. exports and deletes the project.

### Security tests

- Cross-tenant object and query access.
- ID enumeration and confused-deputy attempts.
- Stored prompt injection against summary/memory workers.
- Malicious archives, decompression bombs, oversized payloads, and path
  traversal.
- Secret leakage in application logs, traces, model prompts, indexes, and
  exports.
- Revoked-device and revoked-consent behavior.
- Browser workflows, XSS regressions, and accessibility checks through
  Playwright.

## 15. Product and operational metrics

Measure whether Baton improves continuation rather than merely accumulating
data:

- time from login to first captured thread;
- enabled-project activation and capture reliability;
- successful cross-agent/device continuation rate;
- percentage of continuation attempts that use the suggested thread;
- retrieval evidence success and follow-up-query count;
- context tokens delivered versus full transcript size;
- thread correction/reassignment rate;
- memory candidate approval, edit, rejection, and later-use rates;
- secret-redaction count and user-reported privacy incidents;
- ingestion, retrieval, MCP, and dashboard latency;
- storage/model cost per active developer;
- export/deletion completion time.

Do not record raw conversation content in analytics events.

## 16. Parallel-agent execution protocol

The plan intentionally makes parallel work possible early, but shared contracts
must land first.

1. Root assigns bounded lanes with named packages/files and acceptance tests.
2. Phase 0 contracts and migrations are reviewed before feature agents build on
   them.
3. Each lane owns disjoint packages where practical. Shared generated API
   clients come from the committed contract rather than hand-written copies.
4. Every sub-agent receives this plan, the relevant phase, current migrations,
   API schema, security rules, and its exact gate.
5. Agents add fixtures/tests with implementation; they do not weaken gates to
   make a lane pass.
6. Root integrates continuously, runs cross-lane contract tests, and resolves
   architectural changes centrally.
7. Schema/API changes require a migration and compatibility note, not an
   uncoordinated edit.
8. A security/review lane starts during implementation, not after a phase is
   declared complete.

### First execution wave

Immediately after this plan is accepted:

- **Agent A — domain contracts (`packages/protocol`, `api/`):** finish the
  event/work-thread schemas and ingestion OpenAPI.
- **Agent B — trust contracts (`docs/security/`):** threat model, consent,
  collection policy, and deletion matrix.
- **Agent C — evaluation (`testdata/`, evaluation package):** extend sanitized
  fixtures and build adapter/retrieval/memory gold datasets.
- **Root — integration (root config and `apps/` boundaries):** establish CI,
  legacy compatibility rules, review outputs, and freeze contracts.

No production cloud feature begins until the Phase 0 gate passes.

## 17. Release strategy

1. **Internal dogfood:** one account, multiple local devices, synthetic and
   sanitized data.
2. **Design partners:** a small set of developers who use at least two agents;
   content processing and retention consent are explicit.
3. **Private beta:** individual accounts, quotas, support channel, export and
   deletion complete.
4. **Paid beta:** metered managed-AI usage, reliability targets, published
   privacy/security documentation.
5. **General availability:** only after adapter-format monitoring, deletion
   drills, backup restores, and cross-agent continuation metrics are stable.

Use feature flags for historical import, embeddings, model-generated summaries,
SOUL extraction, and MCP write tools. The deterministic capture and lexical
retrieval path must continue working when optional AI features are disabled.

## 18. Definition of the first compelling product

The first compelling Baton release is achieved when:

1. A user logs in without configuring storage.
2. They explicitly enable a project and conversations sync continuously.
3. Claude, Codex, and OpenCode sessions can contribute to one work thread.
4. On a second device, `baton continue` suggests the correct thread.
5. A fresh coding agent receives a small overview and retrieves cited details
   through MCP rather than ingesting the full transcript.
6. Baton proposes an evidence-backed preference, the user approves it, and a
   later agent receives it in the correct scope.
7. The dashboard clearly shows active work, evidence, memories, sync state, and
   privacy controls.
8. The user can export and delete their data.

Until this flow works end to end, additional dashboards, team features, and
native-session restoration are distractions.
