# Claude Code session format

Findings from inspecting a live install (Claude Code CLI 2.1.205, session files
written by 2.1.195) on macOS, 2026-07. Adapter `FormatVersion()`: **`2026-07`**.

## Storage location

```
~/.claude/projects/<path-slug>/<session-uuid>.jsonl        # main transcript
~/.claude/projects/<path-slug>/<session-uuid>/subagents/   # sidechain (sub-agent)
    agent-<id>.jsonl                                       # transcripts + meta
    agent-<id>.meta.json
```

One JSONL file per session; the filename (minus `.jsonl`) is the session UUID
and matches the `sessionId` field on every line. Sub-agent transcripts live in
a *directory* named after the session UUID — they are not top-level `*.jsonl`
files, so enumerating `*.jsonl` in the slug dir yields exactly the resumable
sessions.

## Path-slug rule (verified against the CLI binary)

Extracted from the bundled JS in the `claude` 2.1.205 executable:

```js
function slug(p) {
  let t = p.replace(/[^a-zA-Z0-9]/g, "-");
  if (t.length <= 200) return t;
  return `${t.slice(0, 200)}-${Math.abs(h(p)).toString(36)}`;
}
// h = classic Java-style 31 hash over UTF-16 code units, 32-bit wrapping:
// h = (h << 5) - h + charCodeAt(i) | 0
```

- **Every** character outside `[a-zA-Z0-9]` becomes `-`: slashes, dots,
  underscores, spaces, unicode. `/Users/x/my.app_v2` → `-Users-x-my-app-v2`.
  (So the mapping is lossy: the slug alone cannot be inverted to a path;
  disambiguate via the `cwd` field inside the file.)
- Case is preserved (`/x/ERC-20` → `-x-ERC-20`).
- Absolute paths start with `/`, so slugs always start with `-`.
- Results longer than 200 chars are truncated to 200 and suffixed with
  `-<base36(abs(hash))>` of the *original* path.
- The regex has no `u` flag: JS replaces per UTF-16 code unit, so an astral
  character (e.g. emoji) becomes **two** dashes.

Verified empirically: `/Volumes/Extended256/coding/coding-agent-session-sync`
→ `~/.claude/projects/-Volumes-Extended256-coding-coding-agent-session-sync/`.

## Line schema

Each line is a standalone JSON object discriminated by top-level `type`.
Observed types and counts in this project's own sessions (v2.1.195):

| `type` | Purpose |
|---|---|
| `user` | User message *or* tool-result carrier |
| `assistant` | One API content block of an assistant response |
| `system` | Local events: `local_command`, `turn_duration`, `away_summary` |
| `summary` | (Older releases) session title: `{type, summary, leafUuid}` |
| `ai-title` | Session title: `{type, aiTitle, sessionId}` (repeated; last wins) |
| `last-prompt` | Pointer to leaf uuid of last prompt |
| `mode` / `permission-mode` | UI/permission state snapshots |
| `attachment` | Injected context (hooks, task reminders, skill listings, …) |
| `file-history-snapshot` | Checkpointing: `{messageId, snapshot{trackedFileBackups}}` |

### Common envelope (on `user` / `assistant` / `system` / `attachment` lines)

| Field | Type | Notes |
|---|---|---|
| `uuid` | string | Line identity |
| `parentUuid` | string\|null | Previous line in the conversation DAG |
| `sessionId` | string | Equals filename UUID |
| `timestamp` | string | RFC3339 with millis, UTC (`2026-07-09T10:21:14.204Z`) |
| `cwd` | string | Absolute project path (slug source) |
| `version` | string | Claude Code version that wrote the line (`2.1.195`) |
| `gitBranch` | string | Branch at time of write |
| `isSidechain` | bool | `true` on sub-agent lines (older releases inlined them) |
| `isMeta` | bool? | Injected/meta content, not a real user utterance |
| `userType` | string | `"external"` |
| `entrypoint` | string | `"cli"` |
| `slug` | string? | Human-readable session nickname (`functional-singing-zephyr`) |
| `requestId` | string? | Assistant lines: API request id |
| `toolUseResult` | object\|string? | User tool-result lines: structured result (see below) |

### `user` lines

`message` is `{role:"user", content}` where `content` is either a plain
**string** (typed prompt, or `<command-*>`/`<local-command-*>` XML for slash
commands, usually with `isMeta:true` on the caveat line) or an **array** of
blocks: `{type:"text", text}` or
`{type:"tool_result", tool_use_id, content: string|[{type:"text",text}], is_error}`.

### `assistant` lines

`message` is an API Message: `{id:"msg_…", type:"message", role, model,
content:[block], stop_reason, usage}`. **Each line carries one content
block**; consecutive lines sharing `message.id` belong to the same logical
assistant turn. Block types observed: `thinking`, `text`,
`tool_use {id:"toolu_…", name, input}`.

### `toolUseResult` shapes (paired to the `tool_result` block on same line)

| Tool | Keys |
|---|---|
| Write | `{type:"create"\|"update", filePath, content, structuredPatch, userModified}` |
| Edit | `{filePath, oldString, newString, originalFile, replaceAll, structuredPatch, userModified}` |
| Bash | `{stdout, stderr, interrupted, isImage, noOutputExpected}` |
| TaskCreate | `{task:{id, subject, description, status}}` |
| TaskUpdate | `{taskId, success, statusChange:{from,to}, updatedFields}` |
| (errors) | plain string `"Error: …"` |

`structuredPatch` is an array of unified-diff hunks
`{oldStart, oldLines, newStart, newLines, lines:[" ctx","-old","+new"]}`.

### Todo tracking

Two generations, both handled:

- **TodoWrite** (classic): `input.todos = [{content, status:
  pending|in_progress|completed, activeForm}]` — each call carries the full
  list; last write wins.
- **TaskCreate / TaskUpdate** (2.1.x): `TaskCreate{subject, description,
  activeForm}` creates one task whose id arrives in the paired
  `toolUseResult.task.id`; `TaskUpdate{taskId, status}` mutates it.

## Format-version markers keyed on

A line is recognized as claude-code when it has a known `type` **and**
corroborating identity fields (`sessionId`/`uuid` plus `message` for
user/assistant lines, `leafUuid` for `summary`, `messageId` for
`file-history-snapshot`). A file with zero recognizable lines is rejected with
`adapters.ErrUnknownFormat`; individually malformed lines are skipped (NFR-3).
The per-line `version` field is recorded but not gated on — schema shape, not
version string, is the contract.
