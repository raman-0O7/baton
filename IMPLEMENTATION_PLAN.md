# Implementation Plan: baton

**Status:** Draft v1 — 2026-07-09
**Source of truth for scope:** `REQUIREMENTS.md` (13 locked decisions). This document covers *how* and *in what order*.

---

## 1. Architecture Overview

```
                        ┌────────────────────────────────────────────┐
                        │                CLI (cobra)                  │
                        │ init enable push pull status export import  │
                        │ daemon doctor skills mcp                    │
                        └──────┬─────────────────────────┬───────────┘
                               │                         │
                ┌──────────────▼───────────┐   ┌─────────▼──────────┐
                │        Core Engine        │   │      Daemon        │
                │                           │   │ fsnotify watcher   │
                │  ┌─────────┐ ┌─────────┐  │   │ debouncer         │
                │  │Registry │ │GitStore │  │   │ commit queue      │
                │  │projects │ │go-git   │  │   │ push scheduler    │
                │  │devices  │ │fork     │  │   └─────────┬─────────┘
                │  │path-map │ │logic    │  │             │
                │  └─────────┘ └─────────┘  │◄────────────┘
                │  ┌─────────┐ ┌─────────┐  │   (daemon calls same
                │  │Scrubber │ │ Crypt   │  │    engine APIs as CLI)
                │  │patterns │ │ (age,   │  │
                │  │entropy  │ │  opt-in)│  │
                │  └─────────┘ └─────────┘  │
                └──────┬───────────┬────────┘
                       │           │
        ┌──────────────▼──┐   ┌────▼────────────────┐
        │ Adapter Plugins │   │  Handoff Engine     │
        │ (AgentAdapter)  │   │  extractor → IR     │
        │  claudecode     │──►│  IR → markdown      │
        │  opencode       │   │  size budgeter      │
        │  codex          │   └─────────────────────┘
        └──────┬──────────┘
               │ reads/writes
   ┌───────────▼────────────────────────────────┐
   │ Agent storage dirs                          │
   │ ~/.claude/projects/…  opencode store        │
   │ ~/.codex/sessions/…                         │
   └─────────────────────────────────────────────┘

   Sync repo (local clone ~/.baton/repo) ⇄ user's git remote
```

### 1.1 Design principles

- **Everything flows through the canonical IR.** Adapters parse native formats into one `model.Session`; sync, scrub, handoff, and (later) native injection all consume the IR. One conversion point per agent.
- **Adapters are plugins behind a Go interface.** Core never imports agent-specific code directly; a registry maps agent name → adapter. Community parsers land without touching core.
- **CLI and daemon share one engine.** The daemon is only a trigger source; every operation it performs is a public engine API the CLI also calls. No divergent code paths.
- **Scrub is a chokepoint, not a feature.** The only function that writes into the sync repo (`gitstore.StageArtifact`) requires a `scrub.Result` token, making it a compile-time error to commit unscrubbed data.
- **Agent storage writes are paranoid.** Temp file + rename, prior-file backup, refuse when the agent process holds the session (SR/NFR-4).

### 1.2 Source tree

```
baton/
├── cmd/baton/main.go
├── internal/
│   ├── cli/            # cobra commands, thin: parse flags → engine calls
│   ├── engine/         # orchestration: sync, handoff, skills ops
│   ├── model/          # canonical IR: Session, Turn, ToolCall, FileOp, Todo,
│   │                   #   MCPServer, Skill, ProjectID, DeviceID
│   ├── registry/       # projects.toml, devices.toml, path mapping
│   ├── gitstore/       # go-git wrapper, layout, fork-on-conflict
│   ├── scrub/          # pattern + entropy redaction pipeline
│   ├── crypt/          # optional age encryption
│   ├── adapters/
│   │   ├── adapter.go  # AgentAdapter interface + registry
│   │   ├── claudecode/
│   │   ├── opencode/
│   │   └── codex/
│   ├── handoff/        # extractor, budgeter, markdown renderer
│   ├── mcptrans/       # canonical MCP model ⇄ per-agent config syntax
│   ├── daemon/         # fsnotify, debounce, scheduler, lock detection
│   └── config/         # tool config (~/.config/baton/config.toml)
├── testdata/fixtures/  # real (sanitized) session files per agent per version
└── .goreleaser.yaml
```

### 1.3 Key interfaces (contracts between phases/subagents)

```go
// internal/adapters/adapter.go
type AgentAdapter interface {
    Name() string                                  // "claudecode" | "opencode" | "codex"
    StorageRoots(project registry.Project) []string // dirs to watch/sync
    ListSessions(project registry.Project) ([]model.SessionRef, error)
    ReadSession(ref model.SessionRef) (*model.Session, error)
    // WriteSession places a session into local storage so the agent's own
    // resume/session-list sees it. Atomic; backs up any file it replaces.
    WriteSession(project registry.Project, s *model.Session) error
    FormatVersion() string                         // bump when parser targets new agent release
}

// internal/model/session.go (canonical IR — trimmed)
type Session struct {
    ID        string
    Agent     string
    ProjectID string
    Turns     []Turn        // role, text, timestamp
    ToolCalls []ToolCall    // name, input summary, output summary
    FileOps   []FileOp      // path, op(create/edit/delete), diff or summary
    Todos     []Todo
    Raw       []byte        // original native payload, for lossless round-trip
    Meta      SessionMeta   // device, timestamps, format version, fork lineage
}

// internal/scrub/scrub.go
type Result struct { Data []byte; Redactions []Redaction } // only path into gitstore
func Scrub(data []byte, policy Policy) (Result, error)

// internal/gitstore/store.go
func (s *Store) StageArtifact(path string, r scrub.Result) error
func (s *Store) CommitAndPush(msg string, mode PushMode) error
func (s *Store) Pull() (PullReport, error)   // PullReport includes detected forks
```

### 1.4 Sync repo layout (data model at rest)

```
<sync-repo>/
├── devices/<device-id>.toml        # hostname, os, path-map: project-id → abs path
├── projects/<project-id>/
│   ├── meta.toml                   # display name, enabled agents, created
│   ├── sessions/<agent>/<session-id>.json   # scrubbed IR (+ .age if encrypted)
│   ├── skills/<agent>/...          # replicated skill trees
│   └── mcp/servers.toml            # canonical MCP config, secret placeholders
└── syncrepo.toml                   # repo format version
```

Fork naming: `<session-id>.fork-<device-id>-<utc-timestamp>.json`, lineage recorded in `Meta`.

---

## 2. Phase Plan

Ten phases. Each sized for one subagent: self-contained goal, explicit inputs (interfaces it consumes), outputs (interfaces it must satisfy), and acceptance criteria a reviewer can run. Dependency graph:

```
P0 ──► P1 ──► P2 ──► P4 ──► P5a ─┬─► P6 ──► P7 ──► P9
        │      ▲            P5b ─┘           ▲
        └─► P3 ┘ (P3 ∥ P2)                   P8 ──┘ (P8 ∥ P7)
```

Parallel lanes: **P2 ∥ P3** · **P5a ∥ P5b** · **P7 ∥ P8**.

| Phase | Name | Milestone | Depends on | Parallel with |
|-------|------|-----------|-----------|---------------|
| P0 | Scaffold & CI | — | — | — |
| P1 | Canonical model + adapter iface + claude-code adapter | M1 | P0 | — |
| P2 | GitStore + registry + path mapping | M1 | P1 (model types only) | P3 |
| P3 | Scrubber | M1 | P0 | P2 |
| P4 | Sync CLI wiring + fork-on-conflict (**M1 ships**) | M1 | P1–P3 | — |
| P5a | opencode adapter | M2 | P1 | P5b |
| P5b | codex adapter | M2 | P1 | P5a |
| P6 | Handoff engine + export/import (**M2 ships**) | M2 | P1, P5a, P5b | — |
| P7 | Daemon | M3 | P4 | P8 |
| P8 | Skills replication + MCP translation | M3 | P4 | P7 |
| P9 | Encryption, doctor, release pipeline (**M3 ships**) | M3 | P7, P8 | — |

---

### P0 — Scaffold & CI

**Goal:** compilable skeleton every later phase builds on.
**Deliverables:** Go module; cobra root + stub subcommands; `internal/config` (TOML at `~/.config/baton/config.toml`, XDG-aware); structured logging (slog); GitHub Actions (build, test, lint, race); `.goreleaser.yaml` stub; `testdata/fixtures/` layout convention documented.
**Acceptance:** `go build ./... && go test ./... && golangci-lint run` green in CI; `baton --help` lists all planned commands as stubs.
**Subagent brief:** "Scaffold Go CLI project per IMPLEMENTATION_PLAN.md §1.2 + P0. No business logic."

### P1 — Canonical model, adapter interface, claude-code adapter

**Goal:** the IR everything depends on, plus first real parser.
**Deliverables:** `internal/model` (all types §1.3); `internal/adapters/adapter.go` (interface + name-registry); `internal/adapters/claudecode` implementing full `AgentAdapter` against `~/.claude/projects/<path-slug>/*.jsonl`; fixture sessions (sanitized real ones) + golden-file tests; lossless round-trip (`ReadSession` → `WriteSession` → byte-comparable via `Raw`); atomic write + backup helper in shared adapter util.
**Acceptance:** golden tests pass; round-trip test proves a re-written session still loads in claude-code (`claude --resume` manual check documented); unknown format version → skip + warning, no error (NFR-3).
**Risk note:** collect fixtures from current claude-code release *first*; parser targets observed reality, not docs.
**Subagent brief:** "Implement §1.3 model + claude-code adapter. Fixtures in testdata. Golden + round-trip tests mandatory."

### P2 — GitStore, registry, path mapping

**Goal:** persistence + device identity layer.
**Deliverables:** `internal/gitstore` (go-git: init/clone, StageArtifact gated on `scrub.Result`, commit, push, pull with fork detection returning `PullReport`); `internal/registry` (project IDs — UUID stored in `meta.toml`; device IDs; path-map read/write; project enable/disable); repo layout §1.4; fork naming + lineage.
**Acceptance:** integration test: two temp clones simulate two devices, divergent commits to same session file → both preserved as fork siblings, `PullReport` reports them; path-map correctly resolves same project to different abs paths per device.
**Interface freeze:** P2 consumes only `model` types + the `scrub.Result` *type signature* (stub OK if P3 unfinished — lanes stay parallel).
**Subagent brief:** "Implement gitstore + registry per §1.3/§1.4 + P2. Two-device fork integration test is the core deliverable."

### P3 — Scrubber

**Goal:** mandatory redaction chokepoint.
**Deliverables:** `internal/scrub`: pattern rules (gitleaks-derived set: AWS, GitHub, Slack, generic API-key/bearer/PEM, connection strings) + Shannon-entropy detector for high-entropy strings in tool outputs; `[REDACTED:<type>]` replacement preserving JSON validity of IR; `Policy` (defaults strict; per-project additions); redaction report type; benchmark (must handle multi-MB transcripts, NFR-2-adjacent).
**Acceptance:** corpus test — seeded-secrets fixture set, 100% of seeded patterns caught, false-positive rate documented on clean corpus; scrubbing a `model.Session` JSON keeps it parseable.
**Subagent brief:** "Implement scrub package per P3. Ship seeded-secret corpus tests + benchmark."

### P4 — Sync CLI wiring + fork-on-conflict (**ships M1**)

**Goal:** end-to-end cross-device sync.
**Deliverables:** `internal/engine` sync orchestration; real implementations of `init` (clone/create repo, register device, write path-map), `enable`/`disable`, `push` (adapters→IR→scrub→stage→commit→push), `pull` (fetch→fork detect→place sessions via `WriteSession` with path-map rewrite), `status` (enabled projects, unpushed, forks); refuse-to-write-while-agent-running guard (process/lockfile check).
**Acceptance:** **M1 done-criterion** — scripted E2E: session created on "device A" (temp HOME) pushed, pulled on "device B" (different project path), appears in claude-code session list and resumes. Fork scenario E2E per P2 test but through CLI.
**Subagent brief:** "Wire P1–P3 into engine + CLI per P4. E2E script is the deliverable gate."

### P5a — opencode adapter · P5b — codex adapter (parallel subagents)

**Goal:** export-side parsers for remaining v1 agents.
**Deliverables (each):** fixture collection from current release (documented storage location/format findings — fills REQUIREMENTS §10 open question); `AgentAdapter` implementation — `ReadSession`/`ListSessions` required, `WriteSession` best-effort (may return `ErrNotSupported` in v1 per FR-11); golden tests; format-version guard.
**Acceptance:** golden tests over fixtures; graceful-skip on unknown versions; findings doc committed under `docs/formats/<agent>.md`.
**Subagent brief (×2):** "Research <agent> session storage on current release, collect sanitized fixtures, implement read-side AgentAdapter per P5. Document format in docs/formats/."

### P6 — Handoff engine + export/import (**ships M2**)

**Goal:** cross-agent continuation.
**Deliverables:** `internal/handoff`: extractor (IR → handoff struct: task statement, decisions, FileOps w/ diffs, todos, last-N verbatim turns), size budgeter (token estimate; degrade oldest content diffs→file lists as budget tightens), markdown renderer with target-agent preamble; CLI `export --to <agent> [--budget N] [--turns N]` writing `handoff.md` + printing exact launch command; `import` v1 = spawn target agent with primed prompt where CLI supports it (`claude "…"`, `opencode run …`), else print instructions.
**Acceptance:** **M2 done-criterion** — recorded validation: real mid-task claude-code session exported, opencode continues to task completion from handoff alone. Unit: budgeter never exceeds budget; renderer snapshot tests.
**Subagent brief:** "Implement handoff package + export/import per P6. Validation run against real agents required, write up results."

### P7 — Daemon

**Goal:** zero-touch sync.
**Deliverables:** `internal/daemon`: fsnotify watchers over `StorageRoots()` of enabled projects; debounce (settle window, default 5s, configurable); commit queue calling same engine APIs as CLI; push scheduler (modes: every-commit / interval / session-end / manual); agent-process detection to defer mid-write commits; `daemon start|stop|status` + launchd/systemd unit templates.
**Acceptance:** soak test script — simulated rapid session writes produce coalesced commits (no commit storm); idle CPU <1% measured; kill -9 mid-commit leaves repo recoverable (go-git state check on start).
**Subagent brief:** "Implement daemon per P7 reusing engine APIs only. Soak + crash-recovery tests."

### P8 — Skills replication + MCP translation (parallel with P7)

**Goal:** M3 config legs.
**Deliverables:** skills replicator (per-agent dir trees §1.4, scrub pass applies, same-agent only per FR-12); `internal/mcptrans`: canonical `MCPServer` model, readers/writers for `.mcp.json`, opencode config, codex `config.toml`; secret-value stripping to placeholders + device-local never-synced secrets file (`~/.config/baton/secrets.toml`, created 0600, path git-ignored by construction); `skills push/pull`, `mcp push/pull/emit --agent <a>` commands.
**Acceptance:** round-trip: canonical → each agent syntax → parse back → equal; secrets never appear in staged artifacts (test greps staged tree for seeded values); skill tree replication E2E across two temp HOMEs.
**Subagent brief:** "Implement skills replication + mcptrans per P8. Secret-leak grep test is a hard gate."

### P9 — Encryption, doctor, release (**ships M3**)

**Goal:** hardening + distribution.
**Deliverables:** `internal/crypt` age encryption behind config flag (encrypt-at-stage, decrypt-at-pull; documented trade-offs SR-3); `doctor` command (checks: agent installs detected, repo health, path-map validity, daemon status, scrub policy loaded); goreleaser finalized (darwin/linux, arm64/amd64), Homebrew tap, curl-sh installer; README + docs site skeleton; CI canary job parsing fixtures against latest agent releases (risk table, REQUIREMENTS §8).
**Acceptance:** **M3 done-criterion** — two-device zero-touch workday simulation green; `brew install` from tap works; encrypted-mode E2E (push/pull with age key) passes.
**Subagent brief:** "Implement crypt + doctor + release pipeline per P9. Distribution must be installable end-to-end."

---

## 3. Subagent Execution Notes

- **Contract-first:** interfaces in §1.3 freeze at end of P1. Later phases code against them; changes require updating this doc first.
- **Each phase = one branch + PR** with its acceptance tests included; reviewer (or review subagent) runs acceptance before merge.
- **Fixtures are shared property:** every adapter phase contributes sanitized fixtures under `testdata/fixtures/<agent>/<version>/`; never commit unsanitized transcripts (scrub applies to our own repo too).
- **Parallel-lane safety:** P2/P3 touch disjoint packages; P5a/P5b disjoint; P7/P8 disjoint. Merge order within a lane pair is arbitrary.
- **What a subagent gets:** this file + REQUIREMENTS.md + its phase section + current main. Phase sections are written to be sufficient without conversation context.

## 4. Estimation (rough, single dev + subagents)

| Phase | Size |
|-------|------|
| P0 | S (day) |
| P1 | L (fixtures + golden + round-trip) |
| P2 | M–L (fork logic) |
| P3 | M |
| P4 | M (mostly wiring + E2E) |
| P5a/P5b | M each (research-heavy) |
| P6 | L (quality iteration on handoff) |
| P7 | M |
| P8 | M |
| P9 | M |

Critical path: P0→P1→P2→P4→P5→P6 (M2 = first externally demo-able wow). P3 off critical path only if stubbed `scrub.Result` used during P2.
