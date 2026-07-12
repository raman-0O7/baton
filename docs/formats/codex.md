# Codex CLI session storage

Codex CLI is not installed on the development machine; this adapter is
built against the rollout format of the Rust Codex CLI (openai/codex) as
of its 2025/2026 releases, from its public repository documentation and
source (codex-rs/core/src/rollout/). Confidence: medium — the CI canary
(P9) and fixture updates are the correction mechanism when a real
installation is available.

## Location

`~/.codex/sessions/YYYY/MM/DD/rollout-YYYY-MM-DDThh-mm-ss-<uuid>.jsonl`
— one JSONL file per session, sharded by date.

## Line schema

Every line: `{"timestamp":"<RFC3339>","type":"<type>","payload":{…}}`.

| type | payload fields used |
|------|---------------------|
| `session_meta` | `id` (uuid), `timestamp`, `cwd`, `originator`, `cli_version`, `instructions` |
| `response_item` | see below |
| `turn_context` | `cwd`, `model` (ignored except as format marker) |
| `event_msg` | ignored |
| `compacted` | ignored |

`response_item` payloads (`payload.type`):

| payload.type | fields used |
|--------------|-------------|
| `message` | `role` (`user`/`assistant`), `content`: array of `{type:"input_text"\|"output_text", text}` |
| `function_call` | `name`, `arguments` (JSON string), `call_id` |
| `function_call_output` | `call_id`, `output` (string or `{content}`) |
| `reasoning` | ignored (internal) |

## Adapter mapping

- Project scoping: `session_meta.cwd` equal to or under `project.Path`.
- Turns ← `message` items; ToolCalls ← `function_call`(+output) pairs.
- FileOps ← `function_call` named `shell`/`apply_patch` whose arguments
  contain an `apply_patch` envelope: `*** Add File: <path>` → create,
  `*** Update File: <path>` → edit, `*** Delete File: <path>` → delete.
- User messages wrapped in environment/instruction tags
  (`<environment_context>`, `<user_instructions>`) are harness plumbing
  and skipped.
- Raw = full original JSONL; WriteSession restores it into the
  date-sharded path derived from the session's meta timestamp.

## Format version

`2026-07-rollout`. Bump on schema change.
