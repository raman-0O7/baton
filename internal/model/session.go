// Package model defines the canonical intermediate representation (IR).
// Every adapter parses its native session format into these types; sync,
// scrub, handoff, and native injection all consume them. This is the
// contract frozen at end of P1 — changes require an IMPLEMENTATION_PLAN.md
// update first.
package model

import "time"

// Role of a conversational turn.
type Role string

const (
	RoleUser      Role = "user"
	RoleAssistant Role = "assistant"
	RoleSystem    Role = "system"
)

// SessionRef identifies a session inside an agent's local storage without
// loading it. Returned by AgentAdapter.ListSessions.
type SessionRef struct {
	Agent     string    // adapter name: "claudecode" | "opencode" | "codex"
	ID        string    // agent-native session identifier
	Path      string    // absolute path of the native session file/dir
	UpdatedAt time.Time // last activity, for ordering and sync decisions
}

// Session is the canonical IR of one agent session.
type Session struct {
	ID        string      `json:"id"`
	Agent     string      `json:"agent"`
	ProjectID string      `json:"project_id"`
	Title     string      `json:"title,omitempty"` // agent-provided summary/slug if any
	Turns     []Turn      `json:"turns"`
	ToolCalls []ToolCall  `json:"tool_calls,omitempty"`
	FileOps   []FileOp    `json:"file_ops,omitempty"`
	Todos     []Todo      `json:"todos,omitempty"`
	Raw       []byte      `json:"raw,omitempty"` // original native payload for lossless round-trip
	Meta      SessionMeta `json:"meta"`
}

// Turn is one conversational message.
type Turn struct {
	Role      Role      `json:"role"`
	Text      string    `json:"text"`
	Timestamp time.Time `json:"timestamp,omitempty"`
	// ToolCallIDs links tool activity that happened within this turn.
	ToolCallIDs []string `json:"tool_call_ids,omitempty"`
}

// ToolCall summarizes one tool invocation. Inputs/outputs are summaries,
// not full payloads — full fidelity lives in Raw.
type ToolCall struct {
	ID            string    `json:"id"`
	Name          string    `json:"name"`
	InputSummary  string    `json:"input_summary,omitempty"`
	OutputSummary string    `json:"output_summary,omitempty"`
	Timestamp     time.Time `json:"timestamp,omitempty"`
}

// FileOpKind classifies a file operation.
type FileOpKind string

const (
	FileCreate FileOpKind = "create"
	FileEdit   FileOpKind = "edit"
	FileDelete FileOpKind = "delete"
)

// FileOp records one file mutation performed during the session.
type FileOp struct {
	Path string     `json:"path"` // project-relative where possible
	Kind FileOpKind `json:"kind"`
	// Diff is a unified diff when cheaply available, else empty and
	// Summary carries a one-line description.
	Diff      string    `json:"diff,omitempty"`
	Summary   string    `json:"summary,omitempty"`
	Timestamp time.Time `json:"timestamp,omitempty"`
}

// TodoStatus mirrors the common pending/in-progress/done triple.
type TodoStatus string

const (
	TodoPending    TodoStatus = "pending"
	TodoInProgress TodoStatus = "in_progress"
	TodoCompleted  TodoStatus = "completed"
)

// Todo is one plan/task item the agent tracked during the session.
type Todo struct {
	Text   string     `json:"text"`
	Status TodoStatus `json:"status"`
}

// SessionMeta carries provenance and sync bookkeeping.
type SessionMeta struct {
	DeviceID      string    `json:"device_id,omitempty"`
	CreatedAt     time.Time `json:"created_at,omitempty"`
	UpdatedAt     time.Time `json:"updated_at,omitempty"`
	FormatVersion string    `json:"format_version"` // adapter FormatVersion() that produced this IR
	// ForkOf is set when this session was created by fork-on-conflict:
	// the session ID it diverged from.
	ForkOf string `json:"fork_of,omitempty"`
	// ForkDevice/ForkedAt record which device's timeline this fork preserves.
	ForkDevice string    `json:"fork_device,omitempty"`
	ForkedAt   time.Time `json:"forked_at,omitempty"`
}
