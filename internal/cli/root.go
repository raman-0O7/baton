// Package cli defines the cobra command tree. Commands stay thin: parse
// flags, load config, call into internal/engine. No business logic here.
package cli

import (
	"log/slog"
	"os"

	"github.com/spf13/cobra"

	"agent-sync/internal/config"
)

var (
	flagVerbose bool
	flagConfig  string
)

var rootCmd = &cobra.Command{
	Use:   "agent-sync",
	Short: "Sync AI coding agent sessions, skills, and MCP configs across devices and agents",
	Long: `agent-sync replicates coding-agent sessions (claude-code, opencode, codex)
across devices via a git remote you own, and hands off in-progress sessions
between agents when usage limits strike.`,
	SilenceUsage:  true,
	SilenceErrors: true,
	PersistentPreRunE: func(cmd *cobra.Command, args []string) error {
		lvl := slog.LevelInfo
		if flagVerbose {
			lvl = slog.LevelDebug
		}
		slog.SetDefault(slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: lvl})))
		return config.SetPath(flagConfig)
	},
}

// Execute runs the root command. Called once from main.
func Execute() error {
	return rootCmd.Execute()
}

// SetVersion wires the goreleaser-stamped version into `--version`.
func SetVersion(v string) {
	rootCmd.Version = v
}

func init() {
	rootCmd.PersistentFlags().BoolVarP(&flagVerbose, "verbose", "v", false, "enable debug logging")
	rootCmd.PersistentFlags().StringVar(&flagConfig, "config", "", "path to config file (default: $XDG_CONFIG_HOME/agent-sync/config.toml)")
}
