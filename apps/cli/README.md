# Baton CLI

Portable working memory for coding agents. Baton captures your Claude Code,
Codex, and OpenCode sessions locally, syncs them to your Baton Cloud account,
and lets any agent resume the right context on any machine — with secrets
scrubbed before they ever leave your device.

## Install

```bash
npm i -g baton-cloud
```

Requires Node.js ≥ 22. The command is installed as `baton` (and `baton-cloud`).

## Point it at your cloud

The CLI talks to a Baton Cloud API. Set the URL once (defaults to
`https://api.baton.dev`):

```bash
export BATON_API_URL=https://your-baton-api.example.com
```

## Quickstart

```bash
baton login              # OAuth device login — opens your dashboard to approve
cd ~/your-project
baton enable             # opt this repo into capture (shows what is collected)
baton daemon             # watch sessions, scrub secrets, sync to the cloud
```

Later, in a fresh agent session:

```bash
baton continue           # rank work threads and print a bootstrap to resume
```

Run the daemon as a background OS service instead of a foreground process:

```bash
baton service install
```

## Connect your coding agent (MCP)

Baton exposes your cloud context to an agent as a **read-only** MCP server over
stdio (it never writes or ingests):

```bash
baton mcp install claudecode   # prints config to paste into the agent
```

That registers a `baton` MCP server (`command: "baton", args: ["mcp"]`) offering
cited work-thread context and approved-memory tools.

## Commands

| Command                                | Purpose                                              |
| -------------------------------------- | ---------------------------------------------------- |
| `login` / `logout` / `whoami`          | Device-grant auth and identity                       |
| `doctor`                               | Check API URL, credentials, cloud reachability, auth |
| `enable` / `disable`                   | Opt a project in / out (records or revokes consent)  |
| `status` / `pause` / `resume`          | Per-project capture state                            |
| `daemon`                               | Continuous capture + sync (5-min reconciliation)     |
| `service <install\|uninstall\|status>` | Run the daemon as an OS service                      |
| `continue`                             | Rank threads and print a resume bootstrap            |
| `mcp` / `mcp install [AGENT]`          | Read-only MCP stdio server / print config            |
| `migrate cloud --dry-run`              | Preview a legacy Git → cloud migration               |

## Privacy

Capture is opt-in per project, secrets are scrubbed locally before upload, and
you can export or delete your data at any time from the dashboard. Credentials
are stored in your OS keychain (with a `0600` file fallback under
`$XDG_CONFIG_HOME/baton/`).
