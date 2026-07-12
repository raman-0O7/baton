package opencode

import (
	"database/sql"
	"encoding/json"
	"errors"
	"flag"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/raman-0O7/baton/internal/adapters"
	"github.com/raman-0O7/baton/internal/model"
	"github.com/raman-0O7/baton/internal/registry"
)

var update = flag.Bool("update", false, "regenerate golden files")

const fixtureDir = "../../../testdata/fixtures/opencode/" + formatVersion

// loadFixtureDB creates a temp database seeded from a fixture SQL script
// and points the adapter at it.
func loadFixtureDB(t *testing.T, script string) {
	t.Helper()
	dir := t.TempDir()
	p := filepath.Join(dir, "opencode.db")
	db, err := sql.Open("sqlite", p)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := ensureSchema(db); err != nil {
		t.Fatal(err)
	}
	sqlBytes, err := os.ReadFile(filepath.Join(fixtureDir, script))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(string(sqlBytes)); err != nil {
		t.Fatalf("seed fixture %s: %v", script, err)
	}
	dbPathOverride = p
	t.Cleanup(func() { dbPathOverride = "" })
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
	for _, name := range []string{"session-basic", "session-tools"} {
		t.Run(name, func(t *testing.T) {
			loadFixtureDB(t, name+".sql")
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

func TestToolSemantics(t *testing.T) {
	loadFixtureDB(t, "session-tools.sql")
	a := &adapter{}
	refs, _ := a.ListSessions(project())
	s, err := a.ReadSession(refs[0])
	if err != nil {
		t.Fatal(err)
	}
	if s.Title != "Add config loader" {
		t.Errorf("Title = %q", s.Title)
	}
	if len(s.ToolCalls) != 2 || s.ToolCalls[0].Name != "write" {
		t.Fatalf("tool calls: %+v", s.ToolCalls)
	}
	if s.ToolCalls[0].OutputSummary == "" {
		t.Error("write output summary empty")
	}
	if len(s.FileOps) != 1 || s.FileOps[0].Kind != model.FileCreate {
		t.Fatalf("file ops: %+v", s.FileOps)
	}
	var linked int
	for _, turn := range s.Turns {
		linked += len(turn.ToolCallIDs)
	}
	if linked != 2 {
		t.Errorf("linked tool ids = %d, want 2", linked)
	}
}

func TestRoundTrip(t *testing.T) {
	loadFixtureDB(t, "session-tools.sql")
	a := &adapter{}
	refs, _ := a.ListSessions(project())
	orig, err := a.ReadSession(refs[0])
	if err != nil {
		t.Fatal(err)
	}

	// Fresh empty DB = "device B".
	dir := t.TempDir()
	dbPathOverride = filepath.Join(dir, "opencode.db")

	targetProj := registry.Project{ID: "p1", Path: "/somewhere/else/project"}
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
	ga, gb := stripVolatile(orig), stripVolatile(back)
	if !reflect.DeepEqual(ga, gb) {
		aj, _ := json.Marshal(ga)
		bj, _ := json.Marshal(gb)
		t.Errorf("IR not equal after round-trip\n orig: %s\n back: %s", aj, bj)
	}
}

func TestWriteSessionRequiresBundle(t *testing.T) {
	dbPathOverride = filepath.Join(t.TempDir(), "opencode.db")
	defer func() { dbPathOverride = "" }()
	a := &adapter{}
	err := a.WriteSession(project(), &model.Session{ID: "x"})
	if !errors.Is(err, adapters.ErrNotSupported) {
		t.Fatalf("empty raw: want ErrNotSupported, got %v", err)
	}
	err = a.WriteSession(project(), &model.Session{ID: "x", Raw: []byte(`{"some":"json"}`)})
	if !errors.Is(err, adapters.ErrNotSupported) {
		t.Fatalf("non-bundle raw: want ErrNotSupported, got %v", err)
	}
}

func TestUnknownSessionAndCorruptRows(t *testing.T) {
	loadFixtureDB(t, "session-basic.sql")
	a := &adapter{}
	_, err := a.ReadSession(model.SessionRef{Agent: "opencode", ID: "ses_nonexistent"})
	if !errors.Is(err, adapters.ErrUnknownFormat) {
		t.Fatalf("missing session: want ErrUnknownFormat, got %v", err)
	}

	// Corrupt message row: parse must skip it, not fail (NFR-3).
	db, err := sql.Open("sqlite", dbPathOverride)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(
		`INSERT INTO message (id, session_id, time_created, time_updated, data)
		 VALUES ('msg_corrupt','ses_basic0000000000000000',5,5,'{not json')`); err != nil {
		t.Fatal(err)
	}
	db.Close()

	refs, _ := a.ListSessions(project())
	s, err := a.ReadSession(refs[0])
	if err != nil {
		t.Fatalf("corrupt row must not fail the parse: %v", err)
	}
	if len(s.Turns) != 2 {
		t.Errorf("turns = %d, want 2 despite corrupt row", len(s.Turns))
	}
}

func TestListFiltersByDirectory(t *testing.T) {
	loadFixtureDB(t, "session-basic.sql")
	a := &adapter{}
	refs, err := a.ListSessions(registry.Project{ID: "q", Path: "/some/other/dir"})
	if err != nil || len(refs) != 0 {
		t.Fatalf("directory filter failed: %+v err=%v", refs, err)
	}
	// Missing database → no sessions, no error.
	dbPathOverride = filepath.Join(t.TempDir(), "absent", "opencode.db")
	refs, err = a.ListSessions(project())
	if err != nil || refs != nil {
		t.Fatalf("missing db: refs=%v err=%v", refs, err)
	}
}
