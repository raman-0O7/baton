package opencode

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"agent-sync/internal/adapters"
	"agent-sync/internal/model"
	"agent-sync/internal/registry"
)

// rawBundle is the deterministic serialization of one session's database
// rows, carried in Session.Raw so WriteSession can reconstruct the session
// in another device's database.
type rawBundle struct {
	Format  string      `json:"format"` // "opencode-db/1"
	Session sessionRow  `json:"session"`
	Msgs    []msgBundle `json:"messages"`
}

type sessionRow struct {
	ID          string `json:"id"`
	ProjectID   string `json:"project_id"`
	Slug        string `json:"slug"`
	Directory   string `json:"directory"`
	Title       string `json:"title"`
	Version     string `json:"version"`
	TimeCreated int64  `json:"time_created"`
	TimeUpdated int64  `json:"time_updated"`
}

type msgBundle struct {
	ID          string    `json:"id"`
	TimeCreated int64     `json:"time_created"`
	TimeUpdated int64     `json:"time_updated"`
	Data        string    `json:"data"`
	Parts       []partRow `json:"parts"`
}

type partRow struct {
	ID          string `json:"id"`
	TimeCreated int64  `json:"time_created"`
	TimeUpdated int64  `json:"time_updated"`
	Data        string `json:"data"`
}

// msgData is the subset of message.data the parser consumes.
type msgData struct {
	Role string `json:"role"`
}

// partData is the union of part.data shapes the parser consumes.
type partData struct {
	Type   string          `json:"type"`
	Text   string          `json:"text"`
	CallID string          `json:"callID"`
	Tool   string          `json:"tool"`
	State  json.RawMessage `json:"state"`
	Time   struct {
		Start int64 `json:"start"`
		End   int64 `json:"end"`
	} `json:"time"`
}

// toolState is the subset of a tool part's state field.
type toolState struct {
	Status string          `json:"status"`
	Input  json.RawMessage `json:"input"`
	Output string          `json:"output"`
	Title  string          `json:"title"`
}

func (a *adapter) ReadSession(ref model.SessionRef) (*model.Session, error) {
	db, err := open()
	if err != nil {
		return nil, err
	}
	defer db.Close()

	var sr sessionRow
	err = db.QueryRow(
		`SELECT id, project_id, slug, directory, title, version, time_created, time_updated
		 FROM session WHERE id = ?`, ref.ID).
		Scan(&sr.ID, &sr.ProjectID, &sr.Slug, &sr.Directory, &sr.Title, &sr.Version,
			&sr.TimeCreated, &sr.TimeUpdated)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, fmt.Errorf("opencode: session %s not found: %w", ref.ID, adapters.ErrUnknownFormat)
	}
	if err != nil {
		return nil, fmt.Errorf("opencode: read session row: %w", err)
	}

	bundle := rawBundle{Format: "opencode-db/1", Session: sr}

	msgRows, err := db.Query(
		`SELECT id, time_created, time_updated, data FROM message
		 WHERE session_id = ? ORDER BY time_created, id`, ref.ID)
	if err != nil {
		return nil, err
	}
	defer msgRows.Close()
	for msgRows.Next() {
		var m msgBundle
		if err := msgRows.Scan(&m.ID, &m.TimeCreated, &m.TimeUpdated, &m.Data); err != nil {
			return nil, err
		}
		bundle.Msgs = append(bundle.Msgs, m)
	}
	if err := msgRows.Err(); err != nil {
		return nil, err
	}

	for i := range bundle.Msgs {
		m := &bundle.Msgs[i]
		partRows, err := db.Query(
			`SELECT id, time_created, time_updated, data FROM part
			 WHERE message_id = ? ORDER BY id`, m.ID)
		if err != nil {
			return nil, err
		}
		for partRows.Next() {
			var p partRow
			if err := partRows.Scan(&p.ID, &p.TimeCreated, &p.TimeUpdated, &p.Data); err != nil {
				partRows.Close()
				return nil, err
			}
			m.Parts = append(m.Parts, p)
		}
		if err := partRows.Err(); err != nil {
			partRows.Close()
			return nil, err
		}
		partRows.Close()
	}

	s := buildIR(a, &bundle)
	raw, err := json.MarshalIndent(&bundle, "", " ")
	if err != nil {
		return nil, err
	}
	s.Raw = raw
	return s, nil
}

// buildIR converts a bundle into the canonical session.
func buildIR(a *adapter, b *rawBundle) *model.Session {
	s := &model.Session{
		ID:    b.Session.ID,
		Agent: a.Name(),
		Title: b.Session.Title,
		Turns: []model.Turn{},
		Meta: model.SessionMeta{
			CreatedAt:     time.UnixMilli(b.Session.TimeCreated).UTC(),
			UpdatedAt:     time.UnixMilli(b.Session.TimeUpdated).UTC(),
			FormatVersion: a.FormatVersion(),
		},
	}
	for _, m := range b.Msgs {
		var md msgData
		if json.Unmarshal([]byte(m.Data), &md) != nil || md.Role == "" {
			continue // NFR-3: skip unparseable rows
		}
		role := model.RoleUser
		if md.Role == "assistant" {
			role = model.RoleAssistant
		}
		var texts []string
		var toolIDs []string
		for _, p := range m.Parts {
			var pd partData
			if json.Unmarshal([]byte(p.Data), &pd) != nil {
				continue
			}
			switch pd.Type {
			case "text":
				if pd.Text != "" {
					texts = append(texts, pd.Text)
				}
			case "tool":
				tc := model.ToolCall{
					ID:        pd.CallID,
					Name:      pd.Tool,
					Timestamp: time.UnixMilli(p.TimeCreated).UTC(),
				}
				var st toolState
				if json.Unmarshal(pd.State, &st) == nil {
					tc.InputSummary = clip(compactJSON(st.Input), 200)
					tc.OutputSummary = clip(st.Output, 200)
					addFileOp(s, pd.Tool, st.Input, p.TimeCreated)
				}
				s.ToolCalls = append(s.ToolCalls, tc)
				if pd.CallID != "" {
					toolIDs = append(toolIDs, pd.CallID)
				}
			}
		}
		if len(texts) == 0 && len(toolIDs) == 0 {
			continue
		}
		s.Turns = append(s.Turns, model.Turn{
			Role:        role,
			Text:        strings.Join(texts, "\n\n"),
			Timestamp:   time.UnixMilli(m.TimeCreated).UTC(),
			ToolCallIDs: toolIDs,
		})
	}
	return s
}

// addFileOp derives a FileOp from write/edit tool inputs.
func addFileOp(s *model.Session, tool string, input json.RawMessage, tsMs int64) {
	var kind model.FileOpKind
	switch tool {
	case "write":
		kind = model.FileCreate
	case "edit":
		kind = model.FileEdit
	default:
		return
	}
	var in struct {
		FilePath string `json:"filePath"`
	}
	if json.Unmarshal(input, &in) != nil || in.FilePath == "" {
		return
	}
	s.FileOps = append(s.FileOps, model.FileOp{
		Path:      in.FilePath,
		Kind:      kind,
		Summary:   tool + " via opencode",
		Timestamp: time.UnixMilli(tsMs).UTC(),
	})
}

// WriteSession reconstructs the bundle's rows in the local database in one
// transaction. Missing database → the schema subset we need is created
// (fresh device where opencode hasn't run yet).
func (a *adapter) WriteSession(project registry.Project, s *model.Session) error {
	if s == nil || s.ID == "" {
		return errors.New("opencode: invalid session")
	}
	if len(s.Raw) == 0 {
		return fmt.Errorf("opencode: session %s has no raw bundle: %w", s.ID, adapters.ErrNotSupported)
	}
	var b rawBundle
	if err := json.Unmarshal(s.Raw, &b); err != nil || b.Format != "opencode-db/1" {
		return fmt.Errorf("opencode: session %s raw payload is not an opencode bundle: %w",
			s.ID, adapters.ErrNotSupported)
	}

	p, err := dbPath()
	if err != nil {
		return err
	}
	db, err := sql.Open("sqlite", p+"?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)")
	if err != nil {
		return err
	}
	defer db.Close()
	if err := ensureSchema(db); err != nil {
		return err
	}

	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	// The session lands under the *target* project path and keeps the
	// bundle's own ID unless the sync layer renamed it (fork sibling).
	dir := b.Session.Directory
	if project.Path != "" {
		dir = project.Path
	}
	if _, err := tx.Exec(
		`INSERT OR REPLACE INTO session
		 (id, project_id, slug, directory, title, version, time_created, time_updated)
		 VALUES (?,?,?,?,?,?,?,?)`,
		s.ID, b.Session.ProjectID, b.Session.Slug, dir, b.Session.Title,
		b.Session.Version, b.Session.TimeCreated, b.Session.TimeUpdated); err != nil {
		return fmt.Errorf("opencode: insert session: %w", err)
	}
	for _, m := range b.Msgs {
		if _, err := tx.Exec(
			`INSERT OR REPLACE INTO message (id, session_id, time_created, time_updated, data)
			 VALUES (?,?,?,?,?)`,
			m.ID, s.ID, m.TimeCreated, m.TimeUpdated, m.Data); err != nil {
			return fmt.Errorf("opencode: insert message: %w", err)
		}
		for _, pr := range m.Parts {
			if _, err := tx.Exec(
				`INSERT OR REPLACE INTO part (id, message_id, session_id, time_created, time_updated, data)
				 VALUES (?,?,?,?,?,?)`,
				pr.ID, m.ID, s.ID, pr.TimeCreated, pr.TimeUpdated, pr.Data); err != nil {
				return fmt.Errorf("opencode: insert part: %w", err)
			}
		}
	}
	return tx.Commit()
}

// ensureSchema creates the session/message/part subset when absent —
// enough for opencode to migrate/adopt on next start, and for tests.
func ensureSchema(db *sql.DB) error {
	_, err := db.Exec(`
CREATE TABLE IF NOT EXISTS session (
  id text PRIMARY KEY, project_id text NOT NULL DEFAULT '', slug text NOT NULL DEFAULT '',
  directory text NOT NULL DEFAULT '', title text NOT NULL DEFAULT '',
  version text NOT NULL DEFAULT '', time_created integer NOT NULL DEFAULT 0,
  time_updated integer NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS message (
  id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL DEFAULT 0,
  time_updated integer NOT NULL DEFAULT 0, data text NOT NULL DEFAULT '{}');
CREATE TABLE IF NOT EXISTS part (
  id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL,
  time_created integer NOT NULL DEFAULT 0, time_updated integer NOT NULL DEFAULT 0,
  data text NOT NULL DEFAULT '{}');`)
	return err
}

func compactJSON(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var buf bytes.Buffer
	if err := json.Compact(&buf, raw); err != nil {
		return string(raw)
	}
	return buf.String()
}

func clip(s string, n int) string {
	s = strings.TrimSpace(s)
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n-1]) + "…"
}

// sortRefs is used by tests for deterministic comparison.
func sortRefs(refs []model.SessionRef) {
	sort.Slice(refs, func(i, j int) bool { return refs[i].ID < refs[j].ID })
}
