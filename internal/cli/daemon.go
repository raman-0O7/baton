package cli

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/spf13/cobra"

	"agent-sync/internal/daemon"
	"agent-sync/internal/engine"
)

func init() {
	var debounceSec int
	daemonCmd := &cobra.Command{
		Use:   "daemon",
		Short: "Run the auto-commit watcher daemon",
		Long: `Watches enabled projects' agent storage and auto-commits after writes
settle. Push cadence follows the [push] mode in config.toml:
every-commit, interval, session-end, or manual. Runs in the foreground;
use the printed launchd/systemd template to install it as a service.`,
		RunE: func(cmd *cobra.Command, args []string) error {
			e, err := engine.Open()
			if err != nil {
				return err
			}
			ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
			defer stop()
			var opts daemon.Options
			if debounceSec > 0 {
				opts.Debounce = time.Duration(debounceSec) * time.Second
			}
			fmt.Println("daemon running (ctrl-c to stop)")
			return daemon.Run(ctx, e, opts)
		},
	}
	daemonCmd.Flags().IntVar(&debounceSec, "debounce", 0, "settle window in seconds (default from config, 5)")

	daemonCmd.AddCommand(&cobra.Command{
		Use:   "install-template",
		Short: "Print a launchd (macOS) or systemd (Linux) unit for the daemon",
		RunE: func(cmd *cobra.Command, args []string) error {
			exe, err := os.Executable()
			if err != nil {
				return err
			}
			fmt.Printf(serviceTemplate, exe)
			return nil
		},
	})

	rootCmd.AddCommand(daemonCmd)
}

const serviceTemplate = `# macOS: save as ~/Library/LaunchAgents/dev.agent-sync.daemon.plist
# then: launchctl load ~/Library/LaunchAgents/dev.agent-sync.daemon.plist
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>dev.agent-sync.daemon</string>
  <key>ProgramArguments</key><array>
    <string>%[1]s</string><string>daemon</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict></plist>

# Linux: save as ~/.config/systemd/user/agent-sync.service
# then: systemctl --user enable --now agent-sync
[Unit]
Description=agent-sync auto-commit daemon

[Service]
ExecStart=%[1]s daemon
Restart=on-failure

[Install]
WantedBy=default.target
`
