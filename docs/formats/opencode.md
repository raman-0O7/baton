# opencode session storage

Observed on the local installation (opencode ≥ 1.x, 2026-07), which has
migrated from per-file JSON storage to SQLite.

## Location

`~/.local/share/opencode/opencode.db` (WAL mode; `storage/`, `snapshot/`,
`repos/` siblings hold non-session data).

## Tables used by the adapter

| table | columns used | notes |
|-------|--------------|-------|
| `session` | `id` (`ses_*`), `project_id`, `directory`, `title`, `version`, `time_created`, `time_updated` (ms epoch) | `directory` is the absolute project path → project scoping |
| `message` | `id` (`msg_*`), `session_id`, `time_created`, `data` | `data` JSON: `role` (`user`/`assistant`), `path{cwd,root}`, token counts |
| `part` | `id` (`prt_*`), `message_id`, `session_id`, `time_created`, `data` | `data` JSON: `type` (`text`, `tool`, `reasoning`, `step-start`, …) |

## part.data shapes (observed)

- text: `{"type":"text","text":"…","time":{"start":ms,"end":ms}}`
- tool: `{"type":"tool","callID":"…","tool":"bash","state":{"status":"completed","input":{…},"output":"…","title":"…"}}`
- todo state travels in the `todo` table (`session_id`, `content` JSON) — read
  when present, tolerated when absent.

## Adapter mapping

- `ListSessions`: `SELECT … FROM session WHERE directory = ?`.
- Turns: messages ordered by `time_created`; text parts concatenated.
- ToolCalls: tool parts (callID, tool, input/output summaries ≤200 chars).
- FileOps: tool parts whose tool is `write`/`edit` with `filePath` input.
- Raw: deterministic JSON bundle `{session, messages:[{row, parts:[…]}]}` —
  the DB rows needed to reconstruct the session elsewhere.
- `WriteSession`: inserts the bundle's rows into the target DB in one
  transaction (`INSERT OR REPLACE`). Best-effort per FR-11: safe on the
  test DB; on a live opencode DB, WAL + busy_timeout make it tolerable but
  an open opencode instance may not display new sessions until restart.

## Format version

`2026-07-db`. Bump when the observed schema or `part.data` shapes change.
