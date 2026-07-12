package codex

import (
	"encoding/json"
	"errors"
	"flag"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"agent-sync/internal/adapters"
	"agent-sync/internal/model"
	"agent-sync/internal/registry"
)

var update = flag.Bool("update", false, "regenerate golden files")

const fixtureDir = "../../../testdata/fixtures/codex/" + formatVersion

const (
	basicFile = "rollout-2026-07-09T10-00-00-aaaa1111-bbbb-4ccc-8ddd-eeee00000001.jsonl"
	toolsFile = "rollout-2026-07-09T11-00-00-bbbb2222-cccc-4ddd-8eee-ffff00000002.jsonl"
	basicID   = "aaaa1111-bbbb-4ccc-8ddd-eeee00000001"
	toolsID   = "bbbb2222-cccc-4ddd-8eee-ffff00000002"
)

// seedBase copies fixtures into a temp date-sharded sessions root and
// points the adapter at it.
func seedBase(t *testing.T, files ...string) string {
	t.Helper()
	base := t.TempDir()
	shard := filepath.Join(base, "2026", "07", "09")
	if err := os.MkdirAll(shard, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, f := range files {
		data, err := os.ReadFile(filepath.Join(fixtureDir, f))
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(shard, f), data, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	sessionsBaseOverride = base
	t.Cleanup(func() { sessionsBaseOverride = "" })
	return base
}

func project() registry.Project {
	return registry.Project{ID: "p1", Path: "/home/user/project"}
}

func stripVolatile(s *model.Session) *model.Session {
	c := *s
	c.Raw = nil
	return &c
}

func TestGolden(t *testing.T) {
	cases := map[string]string{basicFile: "session-basic", toolsFile: "session-tools"}
	for file, name := range cases {
		t.Run(name, func(t *testing.T) {
			seedBase(t, file)
			a := &adapter{}
			refs, err := a.ListSessions(project())
			if err != nil || len(refs) != 1 {
				t.Fatalf("refs=%v err=%v", refs, err)
			}
			got, err := a.ReadSession(refs[0])
			if err != nil {
				t.Fatal(err)
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
				t.Fatalf("read golden (run -update to create): %v", err)
			}
			if string(want) != string(gotJSON) {
				t.Errorf("IR differs from golden\n--- got ---\n%s", gotJSON)
			}
		})
	}
}

func TestParseSemantics(t *testing.T) {
	seedBase(t, toolsFile)
	a := &adapter{}
	refs, _ := a.ListSessions(project())
	if len(refs) != 1 || refs[0].ID != toolsID {
		t.Fatalf("refs: %+v", refs)
	}
	s, err := a.ReadSession(refs[0])
	if err != nil {
		t.Fatal(err)
	}
	// user, assistant(text) + attached call, assistant(text)
	if len(s.Turns) != 3 {
		t.Fatalf("turns = %d: %+v", len(s.Turns), s.Turns)
	}
	if len(s.Turns[1].ToolCallIDs) != 1 {
		t.Errorf("function call not attached to assistant turn: %+v", s.Turns[1])
	}
	if len(s.ToolCalls) != 1 || s.ToolCalls[0].Name != "shell" {
		t.Fatalf("tool calls: %+v", s.ToolCalls)
	}
	if s.ToolCalls[0].OutputSummary == "" {
		t.Error("function_call_output not joined")
	}
	if len(s.FileOps) != 1 || s.FileOps[0].Path != "greet.go" || s.FileOps[0].Kind != model.FileCreate {
		t.Fatalf("apply_patch file op: %+v", s.FileOps)
	}
}

func TestHarnessNoiseFiltered(t *testing.T) {
	seedBase(t, basicFile)
	a := &adapter{}
	refs, _ := a.ListSessions(project())
	s, err := a.ReadSession(refs[0])
	if err != nil {
		t.Fatal(err)
	}
	if len(s.Turns) != 2 {
		t.Fatalf("turns = %d, want 2 (environment_context filtered): %+v", len(s.Turns), s.Turns)
	}
	if s.Turns[0].Role != model.RoleUser || s.Turns[1].Role != model.RoleAssistant {
		t.Errorf("roles wrong: %+v", s.Turns)
	}
}

func TestCWDFilter(t *testing.T) {
	seedBase(t, basicFile, toolsFile)
	a := &adapter{}
	refs, err := a.ListSessions(registry.Project{ID: "q", Path: "/some/other/place"})
	if err != nil || len(refs) != 0 {
		t.Fatalf("cwd filter failed: %+v err=%v", refs, err)
	}
	// Missing root → no sessions, no error.
	sessionsBaseOverride = filepath.Join(t.TempDir(), "absent")
	refs, err = a.ListSessions(project())
	if err != nil || len(refs) != 0 {
		t.Fatalf("missing root: refs=%v err=%v", refs, err)
	}
}

func TestRoundTrip(t *testing.T) {
	seedBase(t, toolsFile)
	a := &adapter{}
	refs, _ := a.ListSessions(project())
	orig, err := a.ReadSession(refs[0])
	if err != nil {
		t.Fatal(err)
	}

	// Fresh root = "device B".
	sessionsBaseOverride = t.TempDir()
	targetProj := registry.Project{ID: "p1", Path: "/home/user/project"}
	if err := a.WriteSession(targetProj, orig); err != nil {
		t.Fatalf("WriteSession: %v", err)
	}
	refs2, err := a.ListSessions(targetProj)
	if err != nil || len(refs2) != 1 || refs2[0].ID != orig.ID {
		t.Fatalf("ListSessions on target: %+v err=%v", refs2, err)
	}
	back, err := a.ReadSession(refs2[0])
	if err != nil {
		t.Fatal(err)
	}
	if string(back.Raw) != string(orig.Raw) {
		t.Error("raw payload not byte-identical")
	}
	if !reflect.DeepEqual(stripVolatile(orig), stripVolatile(back)) {
		t.Error("IR not equal after round-trip")
	}
}

func TestWriteRequiresRaw(t *testing.T) {
	sessionsBaseOverride = t.TempDir()
	defer func() { sessionsBaseOverride = "" }()
	a := &adapter{}
	err := a.WriteSession(project(), &model.Session{ID: "x"})
	if !errors.Is(err, adapters.ErrNotSupported) {
		t.Fatalf("want ErrNotSupported, got %v", err)
	}
}

func TestUnknownFormatAndCorruptLines(t *testing.T) {
	base := seedBase(t)
	shard := filepath.Join(base, "2026", "07", "09")
	alien := filepath.Join(shard, "rollout-2026-07-09T12-00-00-cccc.jsonl")
	if err := os.WriteFile(alien, []byte(`{"kind":"chat","who":"me"}`+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	a := &adapter{}
	_, err := a.ReadSession(model.SessionRef{Agent: "codex", ID: "cccc", Path: alien})
	if !errors.Is(err, adapters.ErrUnknownFormat) {
		t.Fatalf("want ErrUnknownFormat, got %v", err)
	}

	// Corrupt line injected mid-file: parse survives.
	src, err := os.ReadFile(filepath.Join(fixtureDir, basicFile))
	if err != nil {
		t.Fatal(err)
	}
	corrupt := filepath.Join(shard, "rollout-2026-07-09T13-00-00-dddd.jsonl")
	if err := os.WriteFile(corrupt, append([]byte("{garbage\n"), src...), 0o600); err != nil {
		t.Fatal(err)
	}
	s, err := a.ReadSession(model.SessionRef{Agent: "codex", ID: "dddd", Path: corrupt})
	if err != nil {
		t.Fatalf("corrupt line must not fail parse: %v", err)
	}
	if len(s.Turns) != 2 {
		t.Errorf("turns = %d, want 2", len(s.Turns))
	}
}

func TestRolloutID(t *testing.T) {
	if got := rolloutID(basicFile); got != basicID {
		t.Errorf("rolloutID = %q, want %q", got, basicID)
	}
	if got := rolloutID("rollout-short.jsonl"); got != "short" {
		t.Errorf("fallback = %q", got)
	}
}
