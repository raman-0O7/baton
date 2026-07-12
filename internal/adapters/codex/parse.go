package codex

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"time"

	"agent-sync/internal/adapters"
	"agent-sync/internal/model"
)

const maxLineBytes = 32 << 20

// line is the envelope of one rollout JSONL line.
type line struct {
	Timestamp string          `json:"timestamp"`
	Type      string          `json:"type"`
	Payload   json.RawMessage `json:"payload"`
}

// sessionMeta is the payload of type=session_meta.
type sessionMeta struct {
	ID         string `json:"id"`
	Timestamp  string `json:"timestamp"`
	CWD        string `json:"cwd"`
	Originator string `json:"originator"`
	CLIVersion string `json:"cli_version"`
}

// responseItem is the payload of type=response_item.
type responseItem struct {
	Type      string          `json:"type"`
	Role      string          `json:"role"`
	Content   []contentPiece  `json:"content"`
	Name      string          `json:"name"`      // function_call
	Arguments string          `json:"arguments"` // function_call (JSON string)
	CallID    string          `json:"call_id"`
	Output    json.RawMessage `json:"output"` // function_call_output: string or object
}

type contentPiece struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

// peekCWD reads just far enough into a rollout file to find session_meta's
// cwd. ok=false when the file is not a recognizable rollout.
func peekCWD(path string) (string, bool) {
	f, err := os.Open(path)
	if err != nil {
		return "", false
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 64*1024), maxLineBytes)
	for i := 0; sc.Scan() && i < 10; i++ {
		var l line
		if json.Unmarshal(bytes.TrimSpace(sc.Bytes()), &l) != nil {
			continue
		}
		if l.Type == "session_meta" {
			var m sessionMeta
			if json.Unmarshal(l.Payload, &m) == nil && m.CWD != "" {
				return m.CWD, true
			}
		}
	}
	return "", false
}

func (a *adapter) ReadSession(ref model.SessionRef) (*model.Session, error) {
	data, err := os.ReadFile(ref.Path)
	if err != nil {
		return nil, fmt.Errorf("codex: read session %s: %w", ref.Path, err)
	}
	s := &model.Session{
		ID:    ref.ID,
		Agent: a.Name(),
		Turns: []model.Turn{},
		Raw:   data,
		Meta:  model.SessionMeta{FormatVersion: a.FormatVersion()},
	}

	toolIdx := map[string]int{} // call_id → ToolCalls index
	recognized := 0
	var firstTS, lastTS time.Time

	sc := bufio.NewScanner(bytes.NewReader(data))
	sc.Buffer(make([]byte, 64*1024), maxLineBytes)
	for sc.Scan() {
		raw := bytes.TrimSpace(sc.Bytes())
		if len(raw) == 0 {
			continue
		}
		var l line
		if json.Unmarshal(raw, &l) != nil {
			continue // NFR-3: skip corrupt lines
		}
		ts := parseTS(l.Timestamp)
		if !ts.IsZero() {
			if firstTS.IsZero() {
				firstTS = ts
			}
			lastTS = ts
		}

		switch l.Type {
		case "session_meta":
			var m sessionMeta
			if json.Unmarshal(l.Payload, &m) != nil || m.ID == "" {
				continue
			}
			recognized++
			if s.ID == "" {
				s.ID = m.ID
			}
		case "turn_context", "event_msg", "compacted":
			recognized++
		case "response_item":
			var item responseItem
			if json.Unmarshal(l.Payload, &item) != nil {
				continue
			}
			recognized++
			consumeItem(s, &item, ts, toolIdx)
		}
	}
	if err := sc.Err(); err != nil {
		return nil, fmt.Errorf("codex: scan %s: %w", ref.Path, err)
	}
	if recognized == 0 {
		return nil, fmt.Errorf("codex: %s has no recognizable rollout lines: %w",
			ref.Path, adapters.ErrUnknownFormat)
	}
	s.Meta.CreatedAt = firstTS
	s.Meta.UpdatedAt = lastTS
	return s, nil
}

func consumeItem(s *model.Session, item *responseItem, ts time.Time, toolIdx map[string]int) {
	switch item.Type {
	case "message":
		var texts []string
		for _, c := range item.Content {
			if (c.Type == "input_text" || c.Type == "output_text" || c.Type == "text") && c.Text != "" {
				texts = append(texts, c.Text)
			}
		}
		text := strings.Join(texts, "\n\n")
		if text == "" || isHarnessNoise(text) {
			return
		}
		role := model.RoleUser
		if item.Role == "assistant" {
			role = model.RoleAssistant
		}
		s.Turns = append(s.Turns, model.Turn{Role: role, Text: text, Timestamp: ts})

	case "function_call":
		tc := model.ToolCall{
			ID:           item.CallID,
			Name:         item.Name,
			InputSummary: clip(item.Arguments, 200),
			Timestamp:    ts,
		}
		s.ToolCalls = append(s.ToolCalls, tc)
		if item.CallID != "" {
			toolIdx[item.CallID] = len(s.ToolCalls) - 1
		}
		// Attach to the latest assistant turn, or synthesize one: codex
		// emits function calls as standalone items.
		if n := len(s.Turns); n > 0 && s.Turns[n-1].Role == model.RoleAssistant {
			s.Turns[n-1].ToolCallIDs = append(s.Turns[n-1].ToolCallIDs, item.CallID)
		} else {
			s.Turns = append(s.Turns, model.Turn{
				Role: model.RoleAssistant, Timestamp: ts,
				ToolCallIDs: []string{item.CallID},
			})
		}
		fileOpsFromPatch(s, item.Arguments, ts)

	case "function_call_output":
		if idx, ok := toolIdx[item.CallID]; ok {
			s.ToolCalls[idx].OutputSummary = clip(flattenOutput(item.Output), 200)
		}
	}
}

// fileOpsFromPatch extracts FileOps from apply_patch envelopes inside
// function call arguments (shell or apply_patch calls).
func fileOpsFromPatch(s *model.Session, arguments string, ts time.Time) {
	if !strings.Contains(arguments, "*** Begin Patch") {
		return
	}
	// Arguments are a JSON string; the patch body has \n escapes decoded
	// once we unmarshal whatever wrapper it sits in. Cheap route: scan the
	// raw argument text for the markers with either real or escaped breaks.
	text := strings.ReplaceAll(arguments, `\n`, "\n")
	for _, ln := range strings.Split(text, "\n") {
		ln = strings.TrimSpace(ln)
		var kind model.FileOpKind
		var rest string
		switch {
		case strings.HasPrefix(ln, "*** Add File: "):
			kind, rest = model.FileCreate, strings.TrimPrefix(ln, "*** Add File: ")
		case strings.HasPrefix(ln, "*** Update File: "):
			kind, rest = model.FileEdit, strings.TrimPrefix(ln, "*** Update File: ")
		case strings.HasPrefix(ln, "*** Delete File: "):
			kind, rest = model.FileDelete, strings.TrimPrefix(ln, "*** Delete File: ")
		default:
			continue
		}
		path := strings.Trim(strings.TrimSpace(rest), `"\`)
		if path == "" {
			continue
		}
		s.FileOps = append(s.FileOps, model.FileOp{
			Path: path, Kind: kind,
			Summary:   "apply_patch via codex",
			Timestamp: ts,
		})
	}
}

// isHarnessNoise skips environment/instruction wrapper messages codex
// records as user items.
func isHarnessNoise(text string) bool {
	t := strings.TrimSpace(text)
	for _, prefix := range []string{"<environment_context>", "<user_instructions>", "<turn_context>"} {
		if strings.HasPrefix(t, prefix) {
			return true
		}
	}
	return false
}

func flattenOutput(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	var obj struct {
		Content string `json:"content"`
		Output  string `json:"output"`
	}
	if json.Unmarshal(raw, &obj) == nil {
		if obj.Content != "" {
			return obj.Content
		}
		return obj.Output
	}
	return string(raw)
}

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
