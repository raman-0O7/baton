package cli

import (
	"fmt"
	"os"

	"github.com/spf13/cobra"

	"agent-sync/internal/engine"
	"agent-sync/internal/handoff"
)

func init() {
	var (
		to      string
		from    string
		session string
		out     string
		budget  int
		turns   int
	)
	exportCmd := &cobra.Command{
		Use:   "export",
		Short: "Produce a cross-agent handoff document from a session",
		Long: `Extracts task state, file changes, todos, and the recent conversation
from a local session into a handoff document the target agent ingests as
its first message. Purely mechanical — no LLM call, works when the source
agent's usage limit is exhausted.`,
		RunE: func(cmd *cobra.Command, args []string) error {
			e, err := engine.Open()
			if err != nil {
				return err
			}
			cwd, err := os.Getwd()
			if err != nil {
				return err
			}
			doc, s, err := e.Export(cwd, from, session, handoff.Options{
				TargetAgent:  to,
				BudgetTokens: budget,
				RecentTurns:  turns,
			})
			if err != nil {
				return err
			}
			if err := os.WriteFile(out, []byte(doc), 0o600); err != nil {
				return err
			}
			fmt.Printf("handoff for session %s (%d turns) written to %s\n", s.ID, len(s.Turns), out)
			fmt.Println("\ncontinue in", to, "with:")
			fmt.Println(" ", engine.LaunchHint(to, out))
			return nil
		},
	}
	exportCmd.Flags().StringVar(&to, "to", "opencode", "target agent (opencode|codex|claudecode)")
	exportCmd.Flags().StringVar(&from, "from", "claudecode", "source agent whose session to export")
	exportCmd.Flags().StringVar(&session, "session", "", "session ID (default: most recent)")
	exportCmd.Flags().StringVar(&out, "out", "handoff.md", "output file")
	exportCmd.Flags().IntVar(&budget, "budget", 0, "size budget in tokens (default 20000)")
	exportCmd.Flags().IntVar(&turns, "turns", 0, "verbatim trailing turns (default 10)")

	importCmd := &cobra.Command{
		Use:   "import <handoff.md>",
		Short: "Show how to start a target-agent session primed with a handoff document",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if _, err := os.Stat(args[0]); err != nil {
				return err
			}
			fmt.Println("start the target agent with the handoff as its first message:")
			for _, agent := range []string{"claudecode", "opencode", "codex"} {
				fmt.Printf("  %-10s %s\n", agent+":", engine.LaunchHint(agent, args[0]))
			}
			return nil
		},
	}

	rootCmd.AddCommand(exportCmd, importCmd)
}
