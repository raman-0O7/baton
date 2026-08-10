# Baton

Baton is becoming a hosted, portable memory layer for developers and their AI
coding agents.

The product will continuously capture conversations from explicitly enabled
projects, organize Claude Code, Codex, and OpenCode sessions into cross-agent
work threads, and let a fresh agent retrieve only the context it needs. It will
also maintain user-approved, evidence-backed preferences and workflows through
layered memory.

The hosted product has completed its Phase 0 engineering foundation, Phase 1
cloud identity/device-login foundation, Phase 2 incremental capture and cloud
sync (live PostgreSQL gate included), Phase 3 cross-agent work threads with a
first useful dashboard, Phase 4 indexed retrieval with a token-budgeted, fully
cited context compiler, Phase 5 a read-only Baton MCP surface, Phase 6
user-approved, evidence-backed personal memory, and Phase 7 the trust and
lifecycle layer — export, cross-store deletion, quotas, and a privacy dashboard.
A work thread can begin in Claude on one device and continue in Codex on another
as a single, user-confirmed thread; a fresh agent — through the Baton MCP server
— resumes it with a compact, cited context instead of the whole transcript;
Baton proposes personal preferences that only reach an agent after the user
approves them; and a user can export or permanently delete all of their data at
any time. The application is feature-complete through the plan's Phase 7; Phase
8 options are deferred until usage justifies them, and remaining production
readiness is operational (managed infrastructure, billing, load and
accessibility testing). It is not yet available as a production service.

## Product direction

The intended experience is:

```console
baton login
cd ~/code/my-project
baton enable
baton daemon
baton continue
```

Users will not configure Git repositories or restore private native-agent
session files. Baton Cloud will store normalized, append-only conversation
events and provide compact, cited context through the CLI, dashboard, and MCP.

Core principles:

- explicit project opt-in and continuous cloud synchronization;
- local secret scrubbing before content leaves the device;
- work threads that span agents, conversations, devices, and time;
- progressive context retrieval instead of full-transcript handoffs;
- generated summaries and memories linked to original evidence;
- inferred personal preferences require user approval;
- export, deletion, retention, and device controls are product requirements.

The architecture and phased delivery plan are in
[`HOSTED_PRODUCT_IMPLEMENTATION_PLAN.md`](HOSTED_PRODUCT_IMPLEMENTATION_PLAN.md).

## Development

New hosted development is TypeScript-first:

```console
pnpm install
pnpm check
```

The repository uses strict TypeScript, pnpm workspaces, and Turborepo. Hosted
applications will live under `apps/`, while shared product packages live under
`packages/`.

The Phase 0 packages define cloud-safe protocols, incremental Claude/Codex/
OpenCode adapters, the mandatory local secret scrubber, and the evaluation
corpus. Phase 1 adds the hosted API, PostgreSQL identity store, dashboard,
worker, typed cloud client, and device login. Phase 2 adds incremental Claude
Code, Codex, and OpenCode capture; tenant-aware ingestion; and the TypeScript
CLI commands `enable`, `status`, `pause`, `resume`, `disable`, and `daemon`.
Complete native session payloads are intentionally excluded from upload schemas.
Phase 3 adds cross-agent work threads: thread CRUD and source-session
assignment, conservative evidence-based thread suggestions, materialized thread
state, a dashboard work view and thread timeline, and the `baton continue`
command. Phase 4 adds indexed retrieval: a semantic-boundary chunker,
deterministic lexical search (PostgreSQL full-text search with an in-memory
mirror), and a token-budgeted, fully cited context compiler exposed as retrieval
search and thread-context APIs plus dashboard search. Phase 5 adds the read-only
Baton MCP surface: cited-context tools, a stdio MCP server, and the `baton mcp`
command so a fresh agent can resume a work thread without the full transcript.
Phase 6 adds layered personal memory: a deterministic candidate validator with a
prohibited-sensitive-category filter, a SOUL renderer, an approval inbox, and an
MCP tool that returns only user-approved, evidence-backed claims. Phase 7 adds
the trust and lifecycle layer: account/project export, cross-store deletion with
an observable receipt, deterministic quotas and retention, a privacy dashboard,
and `baton migrate cloud --dry-run`. Operator runbooks and the trust/privacy
outline are under `docs/operations/` and `docs/legal/`.

For local hosted setup, see
[`docs/development/hosted-local.md`](docs/development/hosted-local.md). The
Phase 2 capture behavior and controls are documented in
[`docs/development/incremental-sync.md`](docs/development/incremental-sync.md).

## Legacy Go prototype

The existing Go implementation remains in `cmd/` and `internal/` as a working
legacy prototype and behavioral reference. It supports user-managed Git sync,
native session restoration, mechanical Markdown handoffs, skills/MCP
replication, secret scrubbing, and optional age encryption.

It will remain independently buildable during the migration:

```console
go test ./...
go build ./cmd/baton
```

Existing Git repositories, configuration, and age keys will not be silently
uploaded, moved, or deleted. A future migration command will provide a preview
and require explicit confirmation.

No new hosted functionality should be implemented in Go. Its adapter fixtures,
format research, scrubber corpus, and tests serve as specifications for the
TypeScript port.

## Documentation

- `HOSTED_PRODUCT_IMPLEMENTATION_PLAN.md` — current hosted product direction,
  architecture, migration strategy, and phased execution plan
- `REQUIREMENTS.md` — original local/Git prototype product decisions
- `IMPLEMENTATION_PLAN.md` — completed local/Git prototype architecture and
  phase plan
- `docs/formats/` — reverse-engineered per-agent storage formats
- `docs/architecture/` — hosted-runtime and event-store decisions
- `docs/security/` — hosted threat, consent, retention, and deletion contracts

## License

MIT
