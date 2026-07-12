// Package handoff turns a canonical session into a context-priming
// document a different agent can continue from (FR-8). Extraction is
// purely mechanical — no LLM call — because the exporting agent's quota
// is exactly what just ran out (design decision Q3).
package handoff

import (
	"fmt"
	"strings"

	"github.com/raman-0O7/baton/internal/model"
)

// Options tunes extraction. Zero values get defaults.
type Options struct {
	// TargetAgent is the agent that will read the document ("opencode",
	// "codex", "claudecode", or a display name).
	TargetAgent string
	// BudgetTokens caps the rendered document size (approximate; ~4 bytes
	// per token heuristic). Default 20000.
	BudgetTokens int
	// RecentTurns is the number of trailing conversation turns rendered
	// verbatim. Default 10. The budgeter may shrink it.
	RecentTurns int
}

func (o Options) withDefaults() Options {
	if o.BudgetTokens <= 0 {
		o.BudgetTokens = 20000
	}
	if o.RecentTurns <= 0 {
		o.RecentTurns = 10
	}
	if o.TargetAgent == "" {
		o.TargetAgent = "another AI coding agent"
	}
	return o
}

// fileState is the collapsed per-path outcome of a session's FileOps.
type fileState struct {
	Path string
	Kind model.FileOpKind
	Diff string // last diff seen for the path, may be empty
}

// Build renders the handoff document for s within opts' budget.
// The degradation ladder when over budget: drop diffs → halve recent
// turns (floor 2) → cap user-goal list → clip individual message texts
// (huge pastes live in turns) → hard-truncate as the last resort.
func Build(s *model.Session, opts Options) string {
	opts = opts.withDefaults()
	budgetBytes := opts.BudgetTokens * 4

	p := renderParams{includeDiffs: true, turns: opts.RecentTurns, maxGoals: 20}
	doc := render(s, opts, p)
	if len(doc) <= budgetBytes {
		return doc
	}
	p.includeDiffs = false
	doc = render(s, opts, p)
	for len(doc) > budgetBytes && p.turns > 2 {
		p.turns /= 2
		doc = render(s, opts, p)
	}
	if len(doc) > budgetBytes {
		p.maxGoals = 5
		doc = render(s, opts, p)
	}
	for _, clip := range []int{1500, 400} {
		if len(doc) <= budgetBytes {
			break
		}
		p.clipChars = clip
		doc = render(s, opts, p)
	}
	if len(doc) > budgetBytes {
		doc = doc[:budgetBytes] + "\n\n[handoff truncated at budget]\n"
	}
	return doc
}

// renderParams are the budgeter's degradation knobs.
type renderParams struct {
	includeDiffs bool
	turns        int
	maxGoals     int
	clipChars    int // 0 = no clipping of message texts
}

func render(s *model.Session, opts Options, p renderParams) string {
	includeDiffs, recentTurns, maxGoals := p.includeDiffs, p.turns, p.maxGoals
	clip := func(text string) string {
		if p.clipChars <= 0 || len(text) <= p.clipChars {
			return text
		}
		return text[:p.clipChars] + " […clipped for handoff budget]"
	}
	var b strings.Builder

	title := s.Title
	if title == "" {
		title = "untitled session"
	}
	fmt.Fprintf(&b, "# Session Handoff: %s\n\n", title)
	fmt.Fprintf(&b, "You are continuing work begun in %s (session %s). ", agentDisplay(s.Agent), s.ID)
	fmt.Fprintf(&b, "This document was extracted mechanically from that session's transcript. ")
	fmt.Fprintf(&b, "Treat it as ground truth about what already happened; verify current file state with your own tools before changing anything.\n\n")

	// Original task: the first user turn is almost always the assignment.
	if ut := userTurns(s); len(ut) > 0 {
		b.WriteString("## Original task\n\n")
		writeQuoted(&b, clip(ut[0].Text))
		if len(ut) > 1 {
			b.WriteString("\n## Follow-up requests from the user (chronological)\n\n")
			goals := ut[1:]
			if len(goals) > maxGoals {
				fmt.Fprintf(&b, "(%d earlier requests omitted)\n\n", len(goals)-maxGoals)
				goals = goals[len(goals)-maxGoals:]
			}
			for _, t := range goals {
				writeQuoted(&b, clip(t.Text))
			}
		}
	}

	if len(s.Todos) > 0 {
		b.WriteString("\n## Task state at handoff\n\n")
		for _, td := range s.Todos {
			mark := " "
			switch td.Status {
			case model.TodoCompleted:
				mark = "x"
			case model.TodoInProgress:
				mark = "~"
			}
			fmt.Fprintf(&b, "- [%s] %s\n", mark, td.Text)
		}
		b.WriteString("\n(`~` = was in progress when the session ended — start here.)\n")
	}

	if states := collapseFileOps(s.FileOps); len(states) > 0 {
		b.WriteString("\n## Files changed in that session\n\n")
		for _, fs := range states {
			fmt.Fprintf(&b, "- `%s` (%s)\n", fs.Path, fs.Kind)
		}
		if includeDiffs {
			for _, fs := range states {
				if fs.Diff == "" {
					continue
				}
				fmt.Fprintf(&b, "\n### Last change to `%s`\n\n```diff\n%s```\n", fs.Path, fs.Diff)
			}
		}
	}

	if len(s.ToolCalls) > 0 {
		fmt.Fprintf(&b, "\n## Activity summary\n\n%d tool calls were made in the original session.\n", len(s.ToolCalls))
	}

	if turns := tailTurns(s.Turns, recentTurns); len(turns) > 0 {
		fmt.Fprintf(&b, "\n## Final conversation (last %d turns, verbatim)\n\n", len(turns))
		for _, t := range turns {
			role := "User"
			if t.Role == model.RoleAssistant {
				role = "Assistant"
			}
			fmt.Fprintf(&b, "**%s:**\n\n%s\n\n---\n\n", role, clip(t.Text))
		}
	}

	b.WriteString("## How to continue\n\n")
	b.WriteString("1. Inspect the files listed above to confirm the described state.\n")
	b.WriteString("2. Pick up the in-progress/pending items from the task state.\n")
	b.WriteString("3. If anything contradicts the actual repository state, trust the repository and say so.\n")
	return b.String()
}

func agentDisplay(name string) string {
	switch name {
	case "claudecode":
		return "Claude Code"
	case "opencode":
		return "opencode"
	case "codex":
		return "Codex CLI"
	case "":
		return "another AI coding agent"
	}
	return name
}

func userTurns(s *model.Session) []model.Turn {
	var out []model.Turn
	for _, t := range s.Turns {
		if t.Role == model.RoleUser {
			out = append(out, t)
		}
	}
	return out
}

func tailTurns(turns []model.Turn, n int) []model.Turn {
	if len(turns) <= n {
		return turns
	}
	return turns[len(turns)-n:]
}

// collapseFileOps keeps one entry per path: created-then-edited stays
// "create" (the file is new to this session), an edit's diff wins as the
// most recent change description. Deleted paths report delete.
func collapseFileOps(ops []model.FileOp) []fileState {
	idx := map[string]int{}
	var out []fileState
	for _, op := range ops {
		i, seen := idx[op.Path]
		if !seen {
			idx[op.Path] = len(out)
			out = append(out, fileState{Path: op.Path, Kind: op.Kind, Diff: op.Diff})
			continue
		}
		if op.Kind == model.FileDelete {
			out[i].Kind = model.FileDelete
			out[i].Diff = ""
			continue
		}
		if out[i].Kind != model.FileCreate {
			out[i].Kind = op.Kind
		}
		if op.Diff != "" {
			out[i].Diff = op.Diff
		}
	}
	return out
}

func writeQuoted(b *strings.Builder, text string) {
	for _, line := range strings.Split(strings.TrimSpace(text), "\n") {
		b.WriteString("> ")
		b.WriteString(line)
		b.WriteString("\n")
	}
	b.WriteString("\n")
}
