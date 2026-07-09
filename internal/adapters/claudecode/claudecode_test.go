package claudecode

import (
	"encoding/json"
	"errors"
	"flag"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"agent-sync/internal/adapters"
	"agent-sync/internal/model"
	"agent-sync/internal/registry"
)

var update = flag.Bool("update", false, "regenerate golden files")

const fixtureDir = "../../../testdata/fixtures/claudecode/" + formatVersion

func fixtureRef(t *testing.T, name string) model.SessionRef {
	t.Helper()
	path, err := filepath.Abs(filepath.Join(fixtureDir, name+".jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	return model.SessionRef{Agent: "claudecode", ID: name, Path: path}
}

// stripVolatile zeroes fields that legitimately differ across environments
// before golden comparison. Raw is checked separately (byte identity).
func stripVolatile(s *model.Session) *model.Session {
	c := *s
	c.Raw = nil
	return &c
}

func TestGolden(t *testing.T) {
	a := &adapter{}
	for _, name := range []string{"session-basic", "session-tools"} {
		t.Run(name, func(t *testing.T) {
			got, err := a.ReadSession(fixtureRef(t, name))
			if err != nil {
				t.Fatalf("ReadSession: %v", err)
			}
			gotJSON, err := json.MarshalIndent(stripVolatile(got), "", "  ")
			if err != nil {
				t.Fatal(err)
			}
			gotJSON = append(gotJSON, '\n')
			goldenPath := filepath.Join(fixtureDir, "expected-"+name+".json")
			if *update {
				if err := os.WriteFile(goldenPath, gotJSON, 0o644); err != nil {
					t.Fatal(err)
				}
				return
			}
			want, err := os.ReadFile(goldenPath)
			if err != nil {
				t.Fatalf("read golden (run with -update to create): %v", err)
			}
			if string(want) != string(gotJSON) {
				t.Errorf("IR differs from golden %s\n--- got ---\n%s", goldenPath, gotJSON)
			}
		})
	}
}

func TestParseBasicSemantics(t *testing.T) {
	a := &adapter{}
	s, err := a.ReadSession(fixtureRef(t, "session-basic"))
	if err != nil {
		t.Fatal(err)
	}
	if s.ID != "session-basic" {
		t.Errorf("ID = %q (ref.ID should win)", s.ID)
	}
	if s.Title != "Go directory listing question" {
		t.Errorf("Title = %q", s.Title)
	}
	// user, assistant (thinking-only line merged w/ text line via msg id), user, assistant
	wantRoles := []model.Role{model.RoleUser, model.RoleAssistant, model.RoleUser, model.RoleAssistant}
	if len(s.Turns) != len(wantRoles) {
		t.Fatalf("turns = %d, want %d: %+v", len(s.Turns), len(wantRoles), s.Turns)
	}
	for i, r := range wantRoles {
		if s.Turns[i].Role != r {
			t.Errorf("turn %d role = %s, want %s", i, s.Turns[i].Role, r)
		}
	}
	if s.Meta.CreatedAt.IsZero() || s.Meta.UpdatedAt.Before(s.Meta.CreatedAt) {
		t.Errorf("meta timestamps wrong: %+v", s.Meta)
	}
	if s.Meta.FormatVersion != formatVersion {
		t.Errorf("FormatVersion = %q", s.Meta.FormatVersion)
	}
}

func TestParseToolSemantics(t *testing.T) {
	a := &adapter{}
	s, err := a.ReadSession(fixtureRef(t, "session-tools"))
	if err != nil {
		t.Fatal(err)
	}
	if s.Title != "Add greeting helper with tests" {
		t.Errorf("Title = %q", s.Title)
	}
	if len(s.ToolCalls) != 3 {
		t.Fatalf("tool calls = %d, want 3 (Write, Edit, TodoWrite): %+v", len(s.ToolCalls), s.ToolCalls)
	}
	if s.ToolCalls[0].Name != "Write" || s.ToolCalls[0].OutputSummary == "" {
		t.Errorf("Write call missing output summary: %+v", s.ToolCalls[0])
	}

	if len(s.FileOps) != 2 {
		t.Fatalf("file ops = %d, want 2: %+v", len(s.FileOps), s.FileOps)
	}
	if s.FileOps[0].Path != "greet.go" || s.FileOps[0].Kind != model.FileCreate {
		t.Errorf("write op wrong (path should be cwd-relative): %+v", s.FileOps[0])
	}
	if s.FileOps[1].Kind != model.FileEdit || s.FileOps[1].Diff == "" {
		t.Errorf("edit op missing diff: %+v", s.FileOps[1])
	}

	if len(s.Todos) != 2 {
		t.Fatalf("todos = %d, want 2: %+v", len(s.Todos), s.Todos)
	}
	if s.Todos[0].Status != model.TodoCompleted || s.Todos[1].Status != model.TodoPending {
		t.Errorf("todo statuses wrong: %+v", s.Todos)
	}

	// tool_use ids must be linked from the owning assistant turn.
	var linked int
	for _, turn := range s.Turns {
		linked += len(turn.ToolCallIDs)
	}
	if linked != 3 {
		t.Errorf("linked tool call ids = %d, want 3", linked)
	}
}

func TestRoundTrip(t *testing.T) {
	base := t.TempDir()
	projectsBaseOverride = base
	defer func() { projectsBaseOverride = "" }()

	a := &adapter{}
	orig, err := a.ReadSession(fixtureRef(t, "session-tools"))
	if err != nil {
		t.Fatal(err)
	}
	proj := registry.Project{ID: "p1", Path: "/home/user/project"}
	if err := a.WriteSession(proj, orig); err != nil {
		t.Fatalf("WriteSession: %v", err)
	}

	refs, err := a.ListSessions(proj)
	if err != nil {
		t.Fatal(err)
	}
	if len(refs) != 1 || refs[0].ID != orig.ID {
		t.Fatalf("ListSessions after write: %+v", refs)
	}
	back, err := a.ReadSession(refs[0])
	if err != nil {
		t.Fatalf("ReadSession after write: %v", err)
	}
	if string(back.Raw) != string(orig.Raw) {
		t.Error("raw payload not byte-identical after round-trip")
	}
	ga, gb := stripVolatile(orig), stripVolatile(back)
	// ID differs only if filename changed — it didn't; everything else must match.
	if !reflect.DeepEqual(ga, gb) {
		aj, _ := json.Marshal(ga)
		bj, _ := json.Marshal(gb)
		t.Errorf("IR not equal after round-trip\n orig: %s\n back: %s", aj, bj)
	}
}

func TestWriteSessionRequiresRaw(t *testing.T) {
	projectsBaseOverride = t.TempDir()
	defer func() { projectsBaseOverride = "" }()
	a := &adapter{}
	err := a.WriteSession(registry.Project{Path: "/p"}, &model.Session{ID: "x"})
	if !errors.Is(err, adapters.ErrNotSupported) {
		t.Fatalf("want ErrNotSupported, got %v", err)
	}
}

func TestUnknownFormat(t *testing.T) {
	dir := t.TempDir()
	alien := filepath.Join(dir, "alien.jsonl")
	content := `{"kind":"chat","who":"me","utterance":"hi"}` + "\n" +
		`{"kind":"chat","who":"bot","utterance":"hello"}` + "\n"
	if err := os.WriteFile(alien, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	a := &adapter{}
	_, err := a.ReadSession(model.SessionRef{Agent: "claudecode", ID: "alien", Path: alien})
	if !errors.Is(err, adapters.ErrUnknownFormat) {
		t.Fatalf("want ErrUnknownFormat, got %v", err)
	}
}

func TestCorruptLineSkipped(t *testing.T) {
	src, err := os.ReadFile(fixtureRef(t, "session-basic").Path)
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	corrupt := filepath.Join(dir, "corrupt.jsonl")
	// Inject garbage between valid lines.
	data := append([]byte("{not json at all\n"), src...)
	if err := os.WriteFile(corrupt, data, 0o600); err != nil {
		t.Fatal(err)
	}
	a := &adapter{}
	s, err := a.ReadSession(model.SessionRef{Agent: "claudecode", ID: "corrupt", Path: corrupt})
	if err != nil {
		t.Fatalf("corrupt line must not fail the parse: %v", err)
	}
	if len(s.Turns) != 4 {
		t.Errorf("turns = %d, want 4 despite corrupt line", len(s.Turns))
	}
}

func TestPathSlug(t *testing.T) {
	cases := []struct{ in, want string }{
		{"/Volumes/Extended256/coding/coding-agent-session-sync", "-Volumes-Extended256-coding-coding-agent-session-sync"},
		{"/Users/ramankumar/coding/my.app_v2", "-Users-ramankumar-coding-my-app-v2"},
		{"/home/user/project", "-home-user-project"},
	}
	for _, c := range cases {
		if got := pathSlug(c.in); got != c.want {
			t.Errorf("pathSlug(%q) = %q, want %q", c.in, got, c.want)
		}
	}
	// Long paths: truncated to 200 + "-" + base36 hash, deterministic.
	long := "/very" + repeat("/deep-dir", 40)
	s1, s2 := pathSlug(long), pathSlug(long)
	if s1 != s2 || len(s1) <= maxSlugLen || s1[:maxSlugLen] != pathSlug(long)[:maxSlugLen] {
		t.Errorf("long slug unstable or untruncated: %q", s1)
	}
}

func repeat(s string, n int) string {
	out := ""
	for range n {
		out += s
	}
	return out
}

func TestListSessionsFiltersAndOrder(t *testing.T) {
	base := t.TempDir()
	projectsBaseOverride = base
	defer func() { projectsBaseOverride = "" }()
	proj := registry.Project{ID: "p", Path: "/home/user/project"}
	root := filepath.Join(base, pathSlug(proj.Path))
	if err := os.MkdirAll(filepath.Join(root, "subagent-dir"), 0o755); err != nil {
		t.Fatal(err)
	}
	for _, f := range []string{"bbb.jsonl", "aaa.jsonl", ".hidden.jsonl", "notes.txt"} {
		if err := os.WriteFile(filepath.Join(root, f), []byte("{}\n"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	a := &adapter{}
	refs, err := a.ListSessions(proj)
	if err != nil {
		t.Fatal(err)
	}
	if len(refs) != 2 || refs[0].ID != "aaa" || refs[1].ID != "bbb" {
		t.Fatalf("refs wrong: %+v", refs)
	}
	for _, r := range refs {
		if r.UpdatedAt.IsZero() || time.Since(r.UpdatedAt) > time.Minute {
			t.Errorf("UpdatedAt not from mtime: %+v", r)
		}
	}
	// Missing dir → empty, no error.
	empty, err := a.ListSessions(registry.Project{ID: "q", Path: "/nowhere/else"})
	if err != nil || empty != nil {
		t.Fatalf("missing dir: refs=%v err=%v", empty, err)
	}
}
