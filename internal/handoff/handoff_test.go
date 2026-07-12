package handoff

import (
	"fmt"
	"strings"
	"testing"

	"github.com/raman-0O7/baton/internal/model"
)

func sampleSession() *model.Session {
	return &model.Session{
		ID:    "s-1",
		Agent: "claudecode",
		Title: "Add greeting helper",
		Turns: []model.Turn{
			{Role: model.RoleUser, Text: "Create a greet.go with a Greet function."},
			{Role: model.RoleAssistant, Text: "Creating greet.go now."},
			{Role: model.RoleUser, Text: "Now rename it to Hello."},
			{Role: model.RoleAssistant, Text: "Renamed. Tests still pending."},
		},
		ToolCalls: []model.ToolCall{
			{ID: "t1", Name: "Write"}, {ID: "t2", Name: "Edit"},
		},
		FileOps: []model.FileOp{
			{Path: "greet.go", Kind: model.FileCreate, Summary: "wrote 80 bytes"},
			{Path: "greet.go", Kind: model.FileEdit, Diff: "--- a/greet.go\n+++ b/greet.go\n-func Greet(\n+func Hello(\n"},
		},
		Todos: []model.Todo{
			{Text: "Create greet.go", Status: model.TodoCompleted},
			{Text: "Add unit tests", Status: model.TodoInProgress},
		},
	}
}

func TestBuildContainsCoreSections(t *testing.T) {
	doc := Build(sampleSession(), Options{TargetAgent: "opencode"})
	for _, want := range []string{
		"# Session Handoff: Add greeting helper",
		"continuing work begun in Claude Code",
		"## Original task",
		"Create a greet.go with a Greet function.",
		"## Task state at handoff",
		"- [x] Create greet.go",
		"- [~] Add unit tests",
		"`greet.go` (create)", // created-then-edited collapses to create
		"```diff",
		"+func Hello(",
		"## Final conversation",
		"Renamed. Tests still pending.",
		"## How to continue",
	} {
		if !strings.Contains(doc, want) {
			t.Errorf("handoff missing %q\n---\n%s", want, doc)
		}
	}
}

func TestBudgetDegradation(t *testing.T) {
	s := sampleSession()
	// Inflate: many turns with big text and a huge diff.
	big := strings.Repeat("word ", 2000) // ~10KB per turn
	for i := 0; i < 40; i++ {
		role := model.RoleUser
		if i%2 == 1 {
			role = model.RoleAssistant
		}
		s.Turns = append(s.Turns, model.Turn{Role: role, Text: fmt.Sprintf("turn %d: %s", i, big)})
	}
	s.FileOps = append(s.FileOps, model.FileOp{
		Path: "big.go", Kind: model.FileCreate,
		Diff: "+++ b/big.go\n" + strings.Repeat("+line\n", 5000),
	})

	budget := 4000 // tokens → ~16KB
	doc := Build(s, Options{TargetAgent: "codex", BudgetTokens: budget, RecentTurns: 10})
	if len(doc) > budget*4+100 {
		t.Fatalf("doc exceeds budget: %d bytes for %d tokens", len(doc), budget)
	}
	// Diffs must be the first casualty; the file list must survive.
	if strings.Contains(doc, "```diff") {
		t.Error("budgeted doc still contains diffs")
	}
	if !strings.Contains(doc, "`big.go` (create)") {
		t.Error("file list did not survive budgeting")
	}
	if !strings.Contains(doc, "## How to continue") {
		t.Error("closing instructions lost")
	}
}

func TestCollapseFileOps(t *testing.T) {
	states := collapseFileOps([]model.FileOp{
		{Path: "a.go", Kind: model.FileCreate},
		{Path: "a.go", Kind: model.FileEdit, Diff: "d1"},
		{Path: "b.go", Kind: model.FileEdit, Diff: "d2"},
		{Path: "b.go", Kind: model.FileDelete},
		{Path: "c.go", Kind: model.FileEdit},
	})
	if len(states) != 3 {
		t.Fatalf("states = %+v", states)
	}
	if states[0].Kind != model.FileCreate || states[0].Diff != "d1" {
		t.Errorf("a.go: %+v", states[0])
	}
	if states[1].Kind != model.FileDelete || states[1].Diff != "" {
		t.Errorf("b.go: %+v", states[1])
	}
	if states[2].Kind != model.FileEdit {
		t.Errorf("c.go: %+v", states[2])
	}
}

func TestEmptySessionStillRenders(t *testing.T) {
	doc := Build(&model.Session{ID: "x", Agent: "opencode"}, Options{})
	if !strings.Contains(doc, "# Session Handoff: untitled session") {
		t.Errorf("empty session doc: %s", doc)
	}
}
