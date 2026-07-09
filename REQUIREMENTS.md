# Requirements: Coding-Agent Session Sync

**Status:** Draft v1 — decisions locked via design interview, 2026-07-09
**Working name:** `agent-sync` (final name TBD)

## 1. Problem Statement

Developers use multiple AI coding agents (Claude Code, opencode, Codex CLI) and multiple devices. Two pain points:

1. **Rate-limit stranding.** When an agent's usage limit is exhausted mid-task, all accumulated session context is trapped in that agent. The developer must wait for the limit reset instead of continuing in another agent whose quota is fresh.
2. **Device stranding.** Session history, custom skills, and MCP server configurations live on one machine. Switching devices means starting from a blank context.

## 2. Product Vision

A single open-source CLI tool that:

- **Syncs** agent sessions, skills, and MCP configs across devices via a git remote the user owns ("git for your agent sessions").
- **Hands off** an in-progress session from one agent to another (e.g., Claude Code → opencode) so work continues when a limit is hit.

Both capabilities are part of the v1 vision; they ship in sequence (see §9 Milestones).

## 3. Locked Design Decisions

| # | Decision | Choice |
|---|----------|--------|
| 1 | Primary scope | Cross-agent handoff **and** cross-device sync, both in v1 vision, phased delivery |
| 2 | Cross-agent import mechanism | Context-priming **handoff document** first; native storage injection as best-effort per-agent adapters later |
| 3 | Handoff generation | **Mechanical extraction, no LLM required** — target agent ingests the structured handoff with its fresh quota. Optional LLM-compress flag later |
| 4 | Agent export matrix v1 | **claude-code, opencode, codex** parsers; plugin architecture for community-contributed parsers |
| 5 | Sync backend | **Git remote as backend** — any remote the user owns (GitHub private repo, Gitea, etc.). No custom server in v1 |
| 6 | Secrets | **Mandatory scrub pass** on all exports/commits + MCP secret values never leave the device + **optional client-side encryption** (age) |
| 7 | Conflict model | **Fork-on-conflict** — divergent session histories become sibling sessions; no data loss, no locks |
| 8 | Sync triggers | **File-watcher daemon** auto-commits after each settled turn; push is configurable (interval / session-end / manual) |
| 9 | Skill & MCP sync scope | Cross-device same-agent replication for skills; **MCP configs additionally translate across agents** (mechanical mapping). Cross-agent skill translation deferred to v2 |
| 10 | Data layout | **Opt-in per project** (`agent-sync enable`), all enabled projects in **one private sync repo**, per-device path-mapping table |
| 11 | Stack | **Go, single static binary** — cobra (CLI), fsnotify (daemon), go-git (git layer). Distribution: Homebrew, curl-sh, GitHub Releases |
| 12 | Build order | M1 cross-device sync → M2 cross-agent handoff → M3 daemon + skills/MCP |
| 13 | License | **Open source, MIT or Apache-2.0** |

## 4. Functional Requirements

### 4.1 Cross-device session sync (M1)

- **FR-1** `agent-sync init` — create/clone the sync repo, configure the git remote, register this device (device ID + path-mapping entry).
- **FR-2** `agent-sync enable` — opt the current project directory into syncing. Nothing syncs without explicit enable.
- **FR-3** `agent-sync push` / `agent-sync pull` — manual sync of enabled projects' sessions to/from the remote.
- **FR-4** `agent-sync status` — show enabled projects, unpushed commits, remote divergence, active forks.
- **FR-5 Path mapping.** Agents key session storage by absolute project path (e.g. Claude Code: `~/.claude/projects/<path-slug>/`). The sync repo stores sessions under a stable project ID; on pull, the tool rewrites/places sessions into the device-local storage path so the agent's own `--resume`/session list sees them. The per-device path map lives in the sync repo.
- **FR-6 Fork-on-conflict.** When push detects divergent history for the same session, the tool preserves both timelines as sibling sessions (clear naming: origin device + timestamp). Never overwrite, never block on locks. `status` lists forks.
- **FR-7 Session parser: claude-code.** Read/write session JSONL under `~/.claude/projects/`. Parsers are versioned and behind a plugin interface (Go interface; community parsers can be added without touching core).

### 4.2 Cross-agent handoff (M2)

- **FR-8** `agent-sync export --to <agent>` — produce a **handoff document** from the current/selected session containing, extracted mechanically (no LLM call):
  - original task / user messages (verbatim),
  - files created/edited with diffs or summaries of tool activity,
  - todo/plan state if present in the session,
  - last N conversational turns verbatim (configurable),
  - explicit "you are continuing this work" preamble addressed to the target agent.
- **FR-9** `agent-sync import` (or copy-paste flow) — start a session in the target agent primed with the handoff document. v1 may simply emit the document + the exact launch command; deeper integration later.
- **FR-10 Session parsers: opencode, codex.** Export-side read support for opencode's local session storage and Codex CLI's `~/.codex/sessions/`.
- **FR-11 Native injection (post-v1, best-effort).** Per-agent adapters that convert a transcript into the target agent's native session format so it appears in its session list. Explicitly best-effort: gated per agent on format stability, allowed to lag agent releases.

### 4.3 Skills & MCP config sync (M3)

- **FR-12 Skill replication.** Sync each agent's skill/prompt/config directories (e.g. `~/.claude/skills/`, project `.claude/skills/`, opencode equivalents, `~/.codex/` prompts) across devices, same-agent only.
- **FR-13 MCP config translation.** Maintain a canonical MCP server list (server name, transport, command/URL, arg schema). Emit per-agent config syntax (`.mcp.json`, opencode config, codex `config.toml`). Secret values are referenced by placeholder and resolved from a device-local, never-synced secrets file.
- **FR-14 Daemon.** `agent-sync daemon` — fsnotify watcher on enabled agents' storage dirs; debounced auto-commit after a turn's writes settle; push per user config (every commit / interval / session end / manual only).

## 5. Security & Privacy Requirements

- **SR-1 Mandatory scrub.** Every commit path runs a redaction pass (gitleaks-style patterns + entropy detection) over transcripts. Matches are replaced with `[REDACTED:<type>]`. Not optional, not disableable per-file without an explicit `--i-understand` style flag.
- **SR-2 MCP secrets never sync.** Env values in MCP configs are stripped at the source; synced artifacts contain placeholders only. Device-local secrets file is git-ignored by construction.
- **SR-3 Optional client-side encryption.** `age`-based encryption of blobs before push for users whose threat model includes the git host. Documented trade-off: encrypted blobs disable remote-side diff/merge views.
- **SR-4 Opt-in only.** No project's data leaves the machine without explicit `enable`. No telemetry in v1.
- **SR-5 Scrubber humility.** Docs must state plainly that scrubbing is best-effort; private remote + encryption recommended for sensitive work.

## 6. Non-Functional Requirements

- **NFR-1** Single static binary, no runtime deps; macOS + Linux at v1 (Windows later).
- **NFR-2** Daemon idle overhead negligible (<1% CPU, low memory); debounce prevents commit storms during rapid tool output.
- **NFR-3** Parser failures degrade gracefully: unknown/new session format versions are skipped with a warning, never corrupt the repo or the agent's storage.
- **NFR-4** All writes into agent storage dirs are atomic (temp file + rename) and preceded by a local backup of the file being replaced.
- **NFR-5** Works fully offline; push/pull are the only network operations.

## 7. Explicit Non-Goals (v1)

- No custom/hosted sync server, no accounts, no SaaS (git remote is the server).
- No cross-agent **skill** translation (v2 candidate).
- No LLM-dependent processing in any core path.
- No real-time collaborative sessions / team features.
- No Windows support at v1.
- No GUI; CLI + daemon only.

## 8. Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Agent storage formats change without notice | Parsers break on agent updates | Versioned parsers, graceful skip (NFR-3), plugin architecture so fixes ship fast; CI canary that parses fixture sessions from latest agent releases |
| Agents ship native cross-device sync | Erodes M1 value | Cross-agent handoff (M2) and multi-agent skill/MCP story remain differentiated; vendors are unlikely to sync to *competitors* |
| Scrubber misses a secret | Credential leak to git host | Layered: private-repo default guidance, optional encryption, entropy + pattern scan, loud docs (SR-5) |
| Handoff doc too shallow — target agent flounders | Core value prop fails | Tune extraction (diffs + todos + verbatim recent turns); optional LLM-compress flag as escape hatch; measure with real task continuations |
| Long transcripts blow target agent's context on ingest | Handoff unusable for big sessions | Size budget in exporter; oldest content summarized structurally (file list instead of full diffs) as budget tightens |
| Injected/pulled sessions confuse the source agent (IDs, locks, in-flight state) | Agent storage corruption | Atomic writes + backups (NFR-4); never write while agent process holds the session (detect via lockfiles/process check) |

## 9. Milestones

- **M1 — Cross-device sync (foundation).** init/enable/push/pull/status, claude-code parser, scrubber, path mapping, fork-on-conflict. *Done when:* a session started on device A continues natively on device B via `--resume`.
- **M2 — Cross-agent handoff.** export/import handoff docs, opencode + codex read parsers. *Done when:* a rate-limited Claude Code task demonstrably continues to completion in opencode using only the handoff.
- **M3 — Automation & configs.** daemon auto-commit/push, skill replication, MCP translation, optional encryption. *Done when:* zero-touch sync during a normal workday across two devices.

## 10. Open Questions

- Final product name / CLI binary name.
- Handoff doc format details (markdown structure, size budget defaults, N for verbatim turns).
- opencode and codex storage-format research findings (fixture collection needed before M2 estimates).
- Whether M2 `import` should drive the target agent directly (spawn process with primed prompt) or just print instructions.
- Monetization posture if a hosted offering is ever added (open-core boundary).

## 11. Feasibility Verdict

**Feasible.** No component requires research-grade work: git layer, file watching, JSONL parsing, secret scanning, and config translation are all well-trodden. The two real risks are ongoing (format churn → mitigated by plugin parsers + graceful degradation) and product-level (handoff quality → mitigated by mechanical-extraction design that improves iteratively). The riskiest assumption to validate first is that a mechanically-extracted handoff is good enough for a target agent to continue real work — M2's done-criterion tests exactly this.
