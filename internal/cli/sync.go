package cli

import (
	"fmt"
	"os"
	"strings"

	"github.com/spf13/cobra"

	"agent-sync/internal/engine"
)

func init() {
	var initRemote string
	var initEncrypt bool
	initCmd := &cobra.Command{
		Use:   "init",
		Short: "Create or clone the sync repo and register this device",
		RunE: func(cmd *cobra.Command, args []string) error {
			e, err := engine.Init(initRemote)
			if err != nil {
				return err
			}
			fmt.Printf("device %s ready\nsync repo: %s\n", e.Cfg.DeviceID, e.Cfg.RepoPath)
			if e.Cfg.Remote == "" {
				fmt.Println("no remote configured (local-only) — rerun with --remote <url> to sync across devices")
			} else {
				fmt.Println("remote:", e.Cfg.Remote)
			}
			if initEncrypt {
				recipient, err := engine.EnableEncryption()
				if err != nil {
					return err
				}
				fmt.Println("encryption enabled; age recipient:", recipient)
				fmt.Println("BACK UP the identity file — without it synced data is unrecoverable.")
				fmt.Println("Add this recipient to age_recipients in the config of every other device.")
			}
			return nil
		},
	}
	initCmd.Flags().StringVar(&initRemote, "remote", "", "git remote URL for the sync repo")
	initCmd.Flags().BoolVar(&initEncrypt, "encrypt", false, "generate an age identity and encrypt session artifacts (SR-3)")

	var enableAgents []string
	enableCmd := &cobra.Command{
		Use:   "enable",
		Short: "Opt the current project directory into syncing",
		RunE: func(cmd *cobra.Command, args []string) error {
			e, err := engine.Open()
			if err != nil {
				return err
			}
			cwd, err := os.Getwd()
			if err != nil {
				return err
			}
			proj, created, err := e.Enable(cwd, enableAgents)
			if err != nil {
				return err
			}
			verb := "bound to existing project"
			if created {
				verb = "enabled as new project"
			}
			fmt.Printf("%s %s (%s)\nagents: %s\n", proj.Name, verb, proj.ID, strings.Join(proj.Agents, ", "))
			return nil
		},
	}
	enableCmd.Flags().StringSliceVar(&enableAgents, "agents", []string{"claudecode"}, "agent adapters to sync for this project")

	pushCmd := &cobra.Command{
		Use:   "push",
		Short: "Scrub, commit, and push enabled projects' sessions",
		RunE: func(cmd *cobra.Command, args []string) error {
			e, err := engine.Open()
			if err != nil {
				return err
			}
			rep, err := e.Push()
			if err != nil {
				return err
			}
			fmt.Printf("staged %d session(s) across %d project(s), %d redaction(s)\n",
				rep.Sessions, rep.Projects, rep.Redactions)
			switch {
			case !rep.Committed:
				fmt.Println("nothing new to commit")
			case rep.Pushed:
				fmt.Println("committed and pushed")
			default:
				fmt.Println("committed (local-only: no remote configured)")
			}
			if rep.Integrated != nil {
				for _, f := range rep.Integrated.Git.Forks {
					fmt.Printf("fork: %s diverged — local timeline preserved as %s\n", f.Original, f.ForkPath)
				}
				for _, p := range rep.Integrated.Placed {
					fmt.Println("placed", p)
				}
			}
			return nil
		},
	}

	pullCmd := &cobra.Command{
		Use:   "pull",
		Short: "Fetch remote sessions and place them into local agent storage",
		RunE: func(cmd *cobra.Command, args []string) error {
			e, err := engine.Open()
			if err != nil {
				return err
			}
			rep, err := e.Pull()
			if err != nil {
				return err
			}
			for _, p := range rep.Placed {
				fmt.Println("placed", p)
			}
			for _, s := range rep.Skipped {
				fmt.Println("skipped", s)
			}
			for _, f := range rep.Git.Forks {
				fmt.Printf("fork: %s diverged — local timeline preserved as %s\n", f.Original, f.ForkPath)
			}
			if len(rep.Placed) == 0 && len(rep.Skipped) == 0 {
				fmt.Println("up to date")
			}
			return nil
		},
	}

	statusCmd := &cobra.Command{
		Use:   "status",
		Short: "Show enabled projects, unpushed commits, and forks",
		RunE: func(cmd *cobra.Command, args []string) error {
			e, err := engine.Open()
			if err != nil {
				return err
			}
			st, err := e.Status()
			if err != nil {
				return err
			}
			fmt.Printf("device: %s\nrepo:   %s\n", st.DeviceID, st.RepoPath)
			if st.Remote == "" {
				fmt.Println("remote: (none — local only)")
			} else {
				fmt.Println("remote:", st.Remote)
				if st.AheadKnown {
					fmt.Printf("unpushed commits: %d\n", st.Ahead)
				}
			}
			if len(st.Projects) == 0 {
				fmt.Println("no projects enabled on this device")
				return nil
			}
			for _, ps := range st.Projects {
				fmt.Printf("\n%s (%s)\n  path: %s\n  synced artifacts: %d\n",
					ps.Project.Name, ps.Project.ID, ps.Project.Path, ps.SyncedCount)
				for agent, n := range ps.LocalSessions {
					fmt.Printf("  local %s sessions: %d\n", agent, n)
				}
				for _, f := range ps.Forks {
					fmt.Println("  fork awaiting review:", f)
				}
			}
			return nil
		},
	}

	rootCmd.AddCommand(initCmd, enableCmd, pushCmd, pullCmd, statusCmd)
}
