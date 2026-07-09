package claudecode

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"agent-sync/internal/adapters"
	"agent-sync/internal/model"
)

// maxLineBytes bounds a single JSONL line. Tool payloads (Write inputs,
// pasted content) can be large; 32 MiB is far beyond anything observed.
const maxLineBytes = 32 << 20

// lineEnvelope is the union of top-level fields across observed line types.
// See docs/formats/claudecode.md for the per-type schema tables.
type lineEnvelope struct {
	Type          string          `json:"type"`
	UUID          string          `json:"uuid"`
	SessionID     string          `json:"sessionId"`
	Timestamp     string          `json:"timestamp"`
	CWD           string          `json:"cwd"`
	Version       string          `json:"version"`
	IsSidechain   bool            `json:"isSidechain"`
	IsMeta        bool            `json:"isMeta"`
	LeafUUID      string          `json:"leafUuid"`
	MessageID     string          `json:"messageId"` // file-history-snapshot
	Summary       string          `json:"summary"`   // type=summary (older releases)
	AITitle       string          `json:"aiTitle"`   // type=ai-title
	Message       *messageBody    `json:"message"`
	ToolUseResult json.RawMessage `json:"toolUseResult"`
}

type messageBody struct {
	ID      string          `json:"id"` // assistant API message id
	Role    string          `json:"role"`
	Content json.RawMessage `json:"content"` // string or []contentBlock
}

type contentBlock struct {
	Type      string          `json:"type"`
	Text      string          `json:"text"`
	Thinking  string          `json:"thinking"`
	ID        string          `json:"id"`   // tool_use
	Name      string          `json:"name"` // tool_use
	Input     json.RawMessage `json:"input"`
	ToolUseID string          `json:"tool_use_id"` // tool_result
	Content   json.RawMessage `json:"content"`     // tool_result: string or blocks
}

// recognizedTypes are the line discriminators this parser understands.
var recognizedTypes = map[string]bool{
	"user": true, "assistant": true, "system": true,
	"summary": true, "ai-title": true, "last-prompt": true,
	"mode": true, "permission-mode": true, "attachment": true,
	"file-history-snapshot": true,
}

// parser accumulates IR state across lines of one session file.
type parser struct {
	s   *model.Session
	cwd string // first non-empty cwd; used to relativize FileOp paths

	toolIdx   map[string]int // tool_use id → index in s.ToolCalls
	fileOpIdx map[string]int // tool_use id → index in s.FileOps (Write upgrade)
	taskIdx   map[string]int // TaskCreate task id → index in s.Todos
	pendTask  map[string]int // tool_use id of TaskCreate → todo index awaiting id

	lastAsstMsgID string // API message id of the most recent assistant turn
	lastAsstTurn  int    // index into s.Turns, -1 when none

	firstTS, lastTS time.Time
	recognized      int
}

// ReadSession parses one native JSONL transcript into the canonical IR.
// Malformed lines are skipped (NFR-3); a file with zero recognizable
// claude-code lines fails with adapters.ErrUnknownFormat (wrapped).
func (a *adapter) ReadSession(ref model.SessionRef) (*model.Session, error) {
	data, err := os.ReadFile(ref.Path)
	if err != nil {
		return nil, fmt.Errorf("claudecode: read session %s: %w", ref.Path, err)
	}
	p := &parser{
		s: &model.Session{
			ID:    ref.ID,
			Agent: a.Name(),
			Turns: []model.Turn{},
			Raw:   data,
			Meta:  model.SessionMeta{FormatVersion: a.FormatVersion()},
		},
		toolIdx:      map[string]int{},
		fileOpIdx:    map[string]int{},
		taskIdx:      map[string]int{},
		pendTask:     map[string]int{},
		lastAsstTurn: -1,
	}

	sc := bufio.NewScanner(bytes.NewReader(data))
	sc.Buffer(make([]byte, 64*1024), maxLineBytes)
	for sc.Scan() {
		line := bytes.TrimSpace(sc.Bytes())
		if len(line) == 0 {
			continue
		}
		var env lineEnvelope
		if err := json.Unmarshal(line, &env); err != nil {
			continue // corrupt line: skip, keep parsing (NFR-3)
		}
		p.consume(&env)
	}
	if err := sc.Err(); err != nil {
		return nil, fmt.Errorf("claudecode: scan %s: %w", ref.Path, err)
	}
	if p.recognized == 0 {
		return nil, fmt.Errorf("claudecode: %s has no recognizable claude-code lines: %w",
			ref.Path, adapters.ErrUnknownFormat)
	}

	if p.s.ID == "" {
		// No ref.ID and no sessionId on any line: fall back to the filename.
		p.s.ID = strings.TrimSuffix(filepath.Base(ref.Path), ".jsonl")
	}
	p.s.Meta.CreatedAt = p.firstTS
	p.s.Meta.UpdatedAt = p.lastTS
	return p.s, nil
}

// recognize reports whether the line carries enough claude-code markers to
// count toward format detection. Known type alone is not enough — arbitrary
// JSONL could carry {"type":"user"} — so identity fields must corroborate.
func recognize(env *lineEnvelope) bool {
	if !recognizedTypes[env.Type] {
		return false
	}
	switch env.Type {
	case "user", "assistant":
		return env.Message != nil && (env.SessionID != "" || env.UUID != "")
	case "summary":
		return env.Summary != "" && env.LeafUUID != ""
	case "file-history-snapshot":
		return env.MessageID != ""
	default: // system, ai-title, last-prompt, mode, permission-mode, attachment
		return env.SessionID != "" || env.UUID != ""
	}
}

func (p *parser) consume(env *lineEnvelope) {
	if !recognize(env) {
		return
	}
	p.recognized++
	if p.s.ID == "" && env.SessionID != "" {
		p.s.ID = env.SessionID
	}
	if p.cwd == "" && env.CWD != "" {
		p.cwd = env.CWD
	}
	ts := parseTS(env.Timestamp)
	if !ts.IsZero() {
		if p.firstTS.IsZero() || ts.Before(p.firstTS) {
			p.firstTS = ts
		}
		if ts.After(p.lastTS) {
			p.lastTS = ts
		}
	}

	switch env.Type {
	case "summary":
		p.s.Title = env.Summary
	case "ai-title":
		if env.AITitle != "" {
			p.s.Title = env.AITitle
		}
	case "user":
		p.consumeUser(env, ts)
	case "assistant":
		p.consumeAssistant(env, ts)
	}
}

func (p *parser) consumeUser(env *lineEnvelope, ts time.Time) {
	if env.IsSidechain || env.Message == nil {
		return // sub-agent traffic is not part of the main conversation
	}
	var text string
	// content is either a plain string or an array of blocks.
	var asString string
	if err := json.Unmarshal(env.Message.Content, &asString); err == nil {
		text = asString
	} else {
		var blocks []contentBlock
		if err := json.Unmarshal(env.Message.Content, &blocks); err != nil {
			return
		}
		var parts []string
		for i := range blocks {
			b := &blocks[i]
			switch b.Type {
			case "text":
				if b.Text != "" {
					parts = append(parts, b.Text)
				}
			case "tool_result":
				p.applyToolResult(b, env.ToolUseResult)
			}
		}
		text = strings.Join(parts, "\n\n")
	}
	if text == "" || env.IsMeta || isHarnessNoise(text) {
		return
	}
	p.s.Turns = append(p.s.Turns, model.Turn{
		Role:      model.RoleUser,
		Text:      text,
		Timestamp: ts,
	})
	// A real user turn ends any assistant message-id merge window.
	p.lastAsstMsgID, p.lastAsstTurn = "", -1
}

func (p *parser) consumeAssistant(env *lineEnvelope, ts time.Time) {
	if env.IsSidechain || env.Message == nil {
		return
	}
	var blocks []contentBlock
	if err := json.Unmarshal(env.Message.Content, &blocks); err != nil {
		return
	}
	var text string
	var toolIDs []string
	for i := range blocks {
		b := &blocks[i]
		switch b.Type {
		case "text":
			if b.Text != "" {
				if text != "" {
					text += "\n\n"
				}
				text += b.Text
			}
		case "tool_use":
			p.addToolCall(b, ts, env.CWD)
			if b.ID != "" {
				toolIDs = append(toolIDs, b.ID)
			}
		}
		// thinking blocks are internal reasoning; not part of Turn text.
	}
	if text == "" && len(toolIDs) == 0 {
		return
	}
	msgID := env.Message.ID
	// Claude Code writes one content block per line; lines sharing the API
	// message id are one logical turn — merge them.
	if p.lastAsstTurn >= 0 && msgID != "" && msgID == p.lastAsstMsgID {
		t := &p.s.Turns[p.lastAsstTurn]
		if text != "" {
			if t.Text != "" {
				t.Text += "\n\n"
			}
			t.Text += text
		}
		t.ToolCallIDs = append(t.ToolCallIDs, toolIDs...)
		return
	}
	p.s.Turns = append(p.s.Turns, model.Turn{
		Role:        model.RoleAssistant,
		Text:        text,
		Timestamp:   ts,
		ToolCallIDs: toolIDs,
	})
	p.lastAsstTurn = len(p.s.Turns) - 1
	p.lastAsstMsgID = msgID
}

// addToolCall records the ToolCall and derives FileOps/Todos from the input.
func (p *parser) addToolCall(b *contentBlock, ts time.Time, cwd string) {
	if b.ID == "" && b.Name == "" {
		return
	}
	p.s.ToolCalls = append(p.s.ToolCalls, model.ToolCall{
		ID:           b.ID,
		Name:         b.Name,
		InputSummary: summarizeInput(b.Input),
		Timestamp:    ts,
	})
	if b.ID != "" {
		p.toolIdx[b.ID] = len(p.s.ToolCalls) - 1
	}
	if cwd == "" {
		cwd = p.cwd
	}
	switch b.Name {
	case "Write":
		p.fileOpFromWrite(b, ts, cwd)
	case "Edit":
		p.fileOpFromEdit(b, ts, cwd)
	case "TodoWrite":
		p.todosFromTodoWrite(b)
	case "TaskCreate":
		p.todoFromTaskCreate(b)
	case "TaskUpdate":
		p.todoFromTaskUpdate(b)
	}
}

// applyToolResult fills the matching ToolCall's output summary and applies
// the structured toolUseResult (Write create/update upgrade, task ids).
func (p *parser) applyToolResult(b *contentBlock, structured json.RawMessage) {
	idx, ok := p.toolIdx[b.ToolUseID]
	if ok {
		if out := flattenResultContent(b.Content); out != "" {
			p.s.ToolCalls[idx].OutputSummary = clip(out, 200)
		}
	}
	if len(structured) == 0 {
		return
	}
	// Write result: {"type":"create"|"update", ...} — a Write over an
	// existing file is an edit, not a create.
	if fi, ok := p.fileOpIdx[b.ToolUseID]; ok {
		var wr struct {
			Type string `json:"type"`
		}
		if json.Unmarshal(structured, &wr) == nil && wr.Type == "update" {
			p.s.FileOps[fi].Kind = model.FileEdit
		}
	}
	// TaskCreate result: {"task":{"id":...}} — bind the pending todo.
	if ti, ok := p.pendTask[b.ToolUseID]; ok {
		var tr struct {
			Task struct {
				ID string `json:"id"`
			} `json:"task"`
		}
		if json.Unmarshal(structured, &tr) == nil && tr.Task.ID != "" {
			p.taskIdx[tr.Task.ID] = ti
		}
		delete(p.pendTask, b.ToolUseID)
	}
}

func (p *parser) fileOpFromWrite(b *contentBlock, ts time.Time, cwd string) {
	var in struct {
		FilePath string `json:"file_path"`
		Content  string `json:"content"`
	}
	if json.Unmarshal(b.Input, &in) != nil || in.FilePath == "" {
		return
	}
	p.s.FileOps = append(p.s.FileOps, model.FileOp{
		Path:      relPath(cwd, in.FilePath),
		Kind:      model.FileCreate, // upgraded to edit if result says "update"
		Summary:   fmt.Sprintf("wrote %d bytes", len(in.Content)),
		Timestamp: ts,
	})
	if b.ID != "" {
		p.fileOpIdx[b.ID] = len(p.s.FileOps) - 1
	}
}

func (p *parser) fileOpFromEdit(b *contentBlock, ts time.Time, cwd string) {
	var in struct {
		FilePath   string `json:"file_path"`
		OldString  string `json:"old_string"`
		NewString  string `json:"new_string"`
		ReplaceAll bool   `json:"replace_all"`
	}
	if json.Unmarshal(b.Input, &in) != nil || in.FilePath == "" {
		return
	}
	rel := relPath(cwd, in.FilePath)
	summary := fmt.Sprintf("replaced %d bytes with %d bytes", len(in.OldString), len(in.NewString))
	if in.ReplaceAll {
		summary += " (all occurrences)"
	}
	p.s.FileOps = append(p.s.FileOps, model.FileOp{
		Path:      rel,
		Kind:      model.FileEdit,
		Diff:      miniDiff(rel, in.OldString, in.NewString),
		Summary:   summary,
		Timestamp: ts,
	})
	if b.ID != "" {
		p.fileOpIdx[b.ID] = len(p.s.FileOps) - 1
	}
}

// todosFromTodoWrite replaces the whole todo list: TodoWrite always carries
// the full list, so last write wins.
func (p *parser) todosFromTodoWrite(b *contentBlock) {
	var in struct {
		Todos []struct {
			Content string `json:"content"`
			Status  string `json:"status"`
		} `json:"todos"`
	}
	if json.Unmarshal(b.Input, &in) != nil || in.Todos == nil {
		return
	}
	todos := make([]model.Todo, 0, len(in.Todos))
	for _, t := range in.Todos {
		if t.Content == "" {
			continue
		}
		todos = append(todos, model.Todo{Text: t.Content, Status: todoStatus(t.Status)})
	}
	p.s.Todos = todos
	// Indices into the previous list are void.
	p.taskIdx = map[string]int{}
	p.pendTask = map[string]int{}
}

func (p *parser) todoFromTaskCreate(b *contentBlock) {
	var in struct {
		Subject string `json:"subject"`
	}
	if json.Unmarshal(b.Input, &in) != nil || in.Subject == "" {
		return
	}
	p.s.Todos = append(p.s.Todos, model.Todo{Text: in.Subject, Status: model.TodoPending})
	if b.ID != "" {
		p.pendTask[b.ID] = len(p.s.Todos) - 1
	}
}

func (p *parser) todoFromTaskUpdate(b *contentBlock) {
	var in struct {
		TaskID string `json:"taskId"`
		Status string `json:"status"`
	}
	if json.Unmarshal(b.Input, &in) != nil || in.TaskID == "" || in.Status == "" {
		return
	}
	if idx, ok := p.taskIdx[in.TaskID]; ok && idx < len(p.s.Todos) {
		p.s.Todos[idx].Status = todoStatus(in.Status)
	}
}

// isHarnessNoise reports user-role lines that are harness plumbing rather
// than something the human typed: slash-command wrappers, background-task
// notifications, local command output echoes.
func isHarnessNoise(text string) bool {
	t := strings.TrimSpace(text)
	for _, prefix := range []string{
		"<command-name>", "<task-notification>", "<local-command-stdout>",
		"<local-command-caveat>", "<bash-input>", "<bash-stdout>",
	} {
		if strings.HasPrefix(t, prefix) {
			return true
		}
	}
	return false
}

func todoStatus(s string) model.TodoStatus {
	switch s {
	case "in_progress":
		return model.TodoInProgress
	case "completed":
		return model.TodoCompleted
	default:
		return model.TodoPending
	}
}

// summarizeInput produces a ≤200-char human-oriented summary of a tool_use
// input: the most telling string field when present, else compact JSON.
func summarizeInput(raw json.RawMessage) string {
	var m map[string]any
	if json.Unmarshal(raw, &m) == nil {
		for _, k := range []string{"command", "file_path", "pattern", "description", "subject", "prompt", "query", "skill", "url"} {
			if v, ok := m[k].(string); ok && v != "" {
				return clip(v, 200)
			}
		}
	}
	var buf bytes.Buffer
	if err := json.Compact(&buf, raw); err != nil {
		return clip(string(raw), 200)
	}
	return clip(buf.String(), 200)
}

// flattenResultContent renders a tool_result content (string or block array)
// as plain text.
func flattenResultContent(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		return s
	}
	var blocks []contentBlock
	if err := json.Unmarshal(raw, &blocks); err != nil {
		return ""
	}
	var parts []string
	for _, b := range blocks {
		if b.Type == "text" && b.Text != "" {
			parts = append(parts, b.Text)
		}
	}
	return strings.Join(parts, "\n")
}

// miniDiff renders a small unified-ish diff from an Edit's old/new strings.
// Line numbers are unknown at the input side, so hunks carry only -/+ lines.
// Oversized edits yield no diff — the FileOp summary still records sizes.
func miniDiff(path, oldStr, newStr string) string {
	const maxDiffInput = 4096
	if len(oldStr)+len(newStr) > maxDiffInput {
		return ""
	}
	var sb strings.Builder
	fmt.Fprintf(&sb, "--- a/%s\n+++ b/%s\n", path, path)
	if oldStr != "" {
		for _, l := range strings.Split(strings.TrimSuffix(oldStr, "\n"), "\n") {
			sb.WriteString("-")
			sb.WriteString(l)
			sb.WriteString("\n")
		}
	}
	if newStr != "" {
		for _, l := range strings.Split(strings.TrimSuffix(newStr, "\n"), "\n") {
			sb.WriteString("+")
			sb.WriteString(l)
			sb.WriteString("\n")
		}
	}
	return sb.String()
}

// relPath makes path project-relative when it sits under cwd.
func relPath(cwd, path string) string {
	if cwd == "" || path == "" {
		return path
	}
	if path == cwd {
		return "."
	}
	if strings.HasPrefix(path, cwd+"/") {
		return path[len(cwd)+1:]
	}
	return path
}

// clip bounds s to n runes, marking truncation with an ellipsis.
func clip(s string, n int) string {
	s = strings.TrimSpace(s)
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n-1]) + "…"
}

func parseTS(s string) time.Time {
	if s == "" {
		return time.Time{}
	}
	t, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		return time.Time{}
	}
	return t.UTC()
}
