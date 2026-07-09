package cli

import (
	"fmt"
	"os"

	"github.com/spf13/cobra"

	"agent-sync/internal/engine"
)

func init() {
	skillsCmd := &cobra.Command{
		Use:   "skills",
		Short: "Sync agent skills across devices",
	}
	skillsCmd.AddCommand(
		&cobra.Command{
			Use:   "push",
			Short: "Replicate local user-level skill directories into the sync repo",
			RunE: func(cmd *cobra.Command, args []string) error {
				e, err := engine.Open()
				if err != nil {
					return err
				}
				rep, err := e.SkillsPush()
				if err != nil {
					return err
				}
				fmt.Printf("staged %d skill file(s)\n", rep.Files)
				for _, s := range rep.Skipped {
					fmt.Println("skipped", s)
				}
				return nil
			},
		},
		&cobra.Command{
			Use:   "pull",
			Short: "Materialize synced skill files into local agent directories",
			RunE: func(cmd *cobra.Command, args []string) error {
				e, err := engine.Open()
				if err != nil {
					return err
				}
				rep, err := e.SkillsPull()
				if err != nil {
					return err
				}
				fmt.Printf("placed %d skill file(s)\n", rep.Files)
				for _, s := range rep.Skipped {
					fmt.Println("skipped", s)
				}
				return nil
			},
		},
	)

	mcpCmd := &cobra.Command{
		Use:   "mcp",
		Short: "Sync and translate MCP server configs",
	}
	var importAgent, importPath string
	importCmd := &cobra.Command{
		Use:   "import",
		Short: "Parse an agent's MCP config into the canonical synced list (secrets stay local)",
		RunE: func(cmd *cobra.Command, args []string) error {
			e, err := engine.Open()
			if err != nil {
				return err
			}
			n, err := e.MCPImport(importAgent, importPath)
			if err != nil {
				return err
			}
			fmt.Printf("imported %d server(s) from %s config; secret values stored locally only\n", n, importAgent)
			return nil
		},
	}
	importCmd.Flags().StringVar(&importAgent, "agent", "claudecode", "source agent syntax (claudecode|opencode|codex)")
	importCmd.Flags().StringVar(&importPath, "path", ".mcp.json", "path to the agent's MCP config file")
	_ = importCmd.MarkFlagRequired("path")

	var emitAgent, emitOut string
	emitCmd := &cobra.Command{
		Use:   "emit",
		Short: "Render the canonical MCP list in an agent's native syntax",
		RunE: func(cmd *cobra.Command, args []string) error {
			e, err := engine.Open()
			if err != nil {
				return err
			}
			data, missing, err := e.MCPEmit(emitAgent)
			if err != nil {
				return err
			}
			if emitOut == "-" {
				fmt.Print(string(data))
			} else {
				if err := os.WriteFile(emitOut, data, 0o600); err != nil {
					return err
				}
				fmt.Printf("wrote %s config to %s\n", emitAgent, emitOut)
			}
			for _, m := range missing {
				fmt.Printf("warning: secret %q not in this device's local store — placeholder left in output\n", m)
			}
			return nil
		},
	}
	emitCmd.Flags().StringVar(&emitAgent, "agent", "claudecode", "target agent syntax (claudecode|opencode|codex)")
	emitCmd.Flags().StringVar(&emitOut, "out", "-", "output file (- for stdout)")
	mcpCmd.AddCommand(importCmd, emitCmd)

	rootCmd.AddCommand(skillsCmd, mcpCmd)
}
