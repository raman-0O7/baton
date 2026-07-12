# baton

Sync AI coding-agent sessions, skills, and MCP server configs across
devices — and hand off an in-progress session from one agent to another
when a usage limit strikes.

Supported agents: **Claude Code**, **opencode**, **Codex CLI**.
Platforms: **macOS, Linux, Windows** (amd64 + arm64) — one static binary,
zero dependencies. Backend: **any git remote you own** (a private
GitHub/Gitea repo). No accounts, no hosted service, fully offline-capable.

## Install

Grab the binary for your OS from
[Releases](../../releases/latest) and put it on your PATH — that's the
whole install. Or with Go: `go install <module>/cmd/baton@latest`.

## Why

- **Rate-limit stranding.** Your Claude Code quota runs out mid-task; the
  accumulated context is trapped. `baton export --to opencode`
  produces a mechanical handoff document (no LLM call — your quota is
  exactly what just died) that the next agent ingests and continues from.
- **Device stranding.** Sessions live on one machine. `baton push`
  on the desktop, `baton pull` on the laptop, `claude --resume`
  shows the same session at the laptop's own project path.

## Quick start

```console
# one-time, per device
baton init --remote git@github.com:you/baton-data.git

# per project, per device
cd ~/code/myproject
baton enable

# work with your agent, then
baton push        # scrub → commit → push
# on another device
baton pull        # place sessions into local agent storage
claude --resume        # continue

# limit hit? hand off to another agent
baton export --to opencode
opencode run "$(cat handoff.md)"

# zero-touch mode
baton daemon      # or: baton daemon install-template
```

Skills and MCP configs:

```console
baton skills push / pull          # replicate skill dirs per agent
baton mcp import --agent claudecode --path .mcp.json
baton mcp emit --agent codex      # translate to another agent's syntax
```

## Security model

- **Mandatory scrub.** Every artifact passes a pattern + entropy secret
  scanner before staging; the git layer's only write path requires a
  scrub result by construction. Scrubbing is best-effort — use a private
  remote, and encryption for sensitive work.
- **MCP secrets never sync.** Credential values are externalized to a
  device-local, 0600, never-synced `secrets.toml` and travel as
  placeholders.
- **Optional end-to-end encryption.** `baton init --encrypt`
  generates an age identity; artifacts are sealed after scrubbing, so the
  git host sees opaque blobs. Trade-off: no remote-side diffs.
- **Fork, never merge.** Divergent session timelines are both preserved
  as sibling sessions; nothing is overwritten, nothing locks.

## Documentation

- `REQUIREMENTS.md` — locked product decisions
- `IMPLEMENTATION_PLAN.md` — architecture and phase plan
- `docs/formats/` — reverse-engineered per-agent storage formats

## Status

All M1–M3 milestone gates pass in CI (two-device sync E2E, handoff
validation, daemon soak, encrypted round-trip). Codex adapter is built
from public format documentation — not yet validated against a live
install; see `docs/formats/codex.md`.

## License

MIT
