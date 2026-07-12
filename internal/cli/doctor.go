package cli

import (
	"errors"
	"fmt"
	"os"
	"os/exec"

	"github.com/spf13/cobra"

	"github.com/raman-0O7/baton/internal/adapters"
	"github.com/raman-0O7/baton/internal/config"
	"github.com/raman-0O7/baton/internal/crypt"
	"github.com/raman-0O7/baton/internal/engine"
	"github.com/raman-0O7/baton/internal/registry"
)

func init() {
	doctorCmd := &cobra.Command{
		Use:   "doctor",
		Short: "Check agent installs, repo health, and configuration",
		RunE: func(cmd *cobra.Command, args []string) error {
			ok := func(cond bool, label string, detail string) {
				mark := "✓"
				if !cond {
					mark = "✗"
				}
				fmt.Printf("%s %-28s %s\n", mark, label, detail)
			}

			// Agent binaries on PATH (informational — adapters read files,
			// not binaries, so a missing binary only limits `import`).
			for agent, bin := range map[string]string{
				"claudecode": "claude", "opencode": "opencode", "codex": "codex",
			} {
				p, err := exec.LookPath(bin)
				ok(err == nil, agent+" binary", p)
			}
			ok(true, "adapters registered", fmt.Sprint(adapters.Names()))

			cfg, err := config.Load()
			if err != nil {
				return err
			}
			initialized := cfg.DeviceID != ""
			ok(initialized, "device initialized", cfg.DeviceID)
			if !initialized {
				fmt.Println("\nrun `baton init` to set up this device")
				return nil
			}

			e, err := engine.Open()
			if err != nil {
				ok(false, "sync repo", err.Error())
				return nil
			}
			ok(true, "sync repo", e.Cfg.RepoPath)
			if e.Cfg.Remote == "" {
				ok(true, "remote", "(none — local only)")
			} else {
				ok(true, "remote", e.Cfg.Remote)
			}

			projects, err := e.Reg.ProjectsForDevice(registry.DeviceID(e.Cfg.DeviceID))
			if err != nil {
				ok(false, "path map", err.Error())
				return nil
			}
			stale := 0
			for _, p := range projects {
				if _, err := os.Stat(p.Path); errors.Is(err, os.ErrNotExist) {
					stale++
					fmt.Printf("  ! %s maps to missing path %s\n", p.Name, p.Path)
				}
			}
			ok(stale == 0, "path map", fmt.Sprintf("%d project(s), %d stale", len(projects), stale))

			if e.Cfg.Encrypt {
				idPath, _ := crypt.DefaultIdentityPath()
				_, err := os.Stat(idPath)
				ok(err == nil, "age identity", idPath)
				ok(len(e.Cfg.AgeRecipients) > 0, "age recipients", fmt.Sprint(len(e.Cfg.AgeRecipients)))
			} else {
				ok(true, "encryption", "disabled (enable with init --encrypt)")
			}
			return nil
		},
	}
	rootCmd.AddCommand(doctorCmd)
}
