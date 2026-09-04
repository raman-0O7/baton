# Incremental capture and cloud sync

Phase 2 captures normalized events from Claude Code, Codex, and OpenCode for
projects the user explicitly enables. Login and agent discovery never enable a
project or upload content.

## CLI flow

```console
baton login
cd /path/to/project
baton enable
baton daemon
```

`baton enable` shows the frozen disclosure, detected agents, allowed categories,
excluded path patterns, byte caps, and policy versions. The user must type
`ENABLE`; `--yes` is the explicit non-interactive equivalent and does not hide
the disclosure. Baton records consent for this exact project installation and
device.

Enablement reads only enough native data to establish content-free cursors. It
does not upload conversations that already exist. Normalized turns appended
afterward are allowlist-filtered, size-limited, scrubbed locally, compressed,
and uploaded in idempotent batches.

Controls are intentionally distinct:

- `baton status [PATH]` performs one online reconciliation and reports an
  actionable state.
- `baton pause [PATH]` stops native reads and uploads immediately. Resuming
  establishes a new baseline, so content created during the paused window is
  skipped.
- `baton resume [PATH]` resumes from the new baseline.
- `baton disable [PATH]` disables capture locally first, then revokes the exact
  cloud consent record. Existing cloud data is retained until a separate delete
  workflow is requested.
- `baton daemon` combines best-effort filesystem notifications with a periodic
  reconciliation pass.

The v1 CLI requires Baton Cloud connectivity. It does not keep a local content
queue when offline and does not read source content before connectivity is
restored. The only local persistent file contains canonical project identity,
consent versions, state, content-free source cursors, fingerprints, and cloud
IDs.

## Local paths

Defaults:

- operational map: `$XDG_CONFIG_HOME/baton/installation-map.json` (or
  `~/.config/baton/installation-map.json`);
- Claude Code: `~/.claude/projects`;
- Codex: `~/.codex/sessions`;
- OpenCode: `$XDG_DATA_HOME/opencode/opencode.db` (or
  `~/.local/share/opencode/opencode.db`).

Override them when testing fixtures or non-default installations:

```console
BATON_STATE_PATH=/absolute/state.json
BATON_CLAUDE_PROJECTS_DIR=/absolute/claude/projects
BATON_CODEX_SESSIONS_DIR=/absolute/codex/sessions
BATON_OPENCODE_DATABASE=/absolute/opencode.db
```

The OpenCode reader opens SQLite read-only with extension loading disabled.
Absolute source and checkout paths stay on the device and are absent from cloud
upload DTOs.

## Legacy Git users

`baton doctor` detects the prior Git-backed configuration read-only and prints
migration guidance. Phase 2 never invokes Git, accesses the configured remote,
or modifies the legacy repository. Historical cloud import remains a separate
future preview and consent flow.
