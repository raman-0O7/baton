package cli

import (
	"github.com/spf13/cobra"
)

// Stub commands. Each phase replaces its stub with a real implementation
// wired to internal/engine. RunE returning errNotImplemented keeps --help
// accurate from day one without lying about capability.

func notImplemented(cmd *cobra.Command, args []string) error {
	return &NotImplementedError{Command: cmd.Name()}
}

// NotImplementedError marks a command whose phase has not landed yet.
type NotImplementedError struct{ Command string }

func (e *NotImplementedError) Error() string {
	return e.Command + ": not implemented yet (see IMPLEMENTATION_PLAN.md for the phase that ships it)"
}

func init() {
	for _, c := range []*cobra.Command{
		{Use: "disable", Short: "Stop syncing the current project", RunE: notImplemented},
		{Use: "export", Short: "Produce a cross-agent handoff document from a session", RunE: notImplemented},
		{Use: "import", Short: "Start a target-agent session primed with a handoff document", RunE: notImplemented},
		{Use: "daemon", Short: "Run the auto-commit watcher daemon", RunE: notImplemented},
		{Use: "doctor", Short: "Check agent installs, repo health, and configuration", RunE: notImplemented},
		{Use: "skills", Short: "Sync agent skills across devices", RunE: notImplemented},
		{Use: "mcp", Short: "Sync and translate MCP server configs", RunE: notImplemented},
	} {
		rootCmd.AddCommand(c)
	}
}
