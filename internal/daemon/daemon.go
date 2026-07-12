// Package daemon watches agent storage and auto-commits settled changes
// (FR-14). It is a trigger source only: every operation it performs is a
// public engine API the CLI also calls (§1.1).
package daemon

import (
	"context"
	"log/slog"
	"path/filepath"
	"strings"
	"time"

	"github.com/fsnotify/fsnotify"

	"agent-sync/internal/adapters"
	"agent-sync/internal/config"
	"agent-sync/internal/engine"
	"agent-sync/internal/registry"
)

// Options tunes the daemon. Zero values take config/schedule defaults.
type Options struct {
	// Debounce is the settle window after the last write before a commit.
	Debounce time.Duration
	// Rescan is how often watch roots are re-enumerated (projects enabled
	// mid-run, storage dirs created by the agent's first session).
	Rescan time.Duration
}

func (o Options) withDefaults(cfg config.Config) Options {
	if o.Debounce <= 0 {
		o.Debounce = time.Duration(cfg.DebounceSeconds) * time.Second
		if o.Debounce <= 0 {
			o.Debounce = 5 * time.Second
		}
	}
	if o.Rescan <= 0 {
		o.Rescan = 30 * time.Second
	}
	return o
}

// Run watches until ctx is cancelled. Push cadence follows
// cfg.Push.Mode: every-commit pushes with each commit; interval pushes on
// a timer; manual and session-end (no reliable end signal exists across
// agents, documented limitation) commit locally only.
func Run(ctx context.Context, e *engine.Engine, opts Options) error {
	opts = opts.withDefaults(e.Cfg)

	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		return err
	}
	defer watcher.Close()

	watched := map[string]bool{}
	addRoots(e, watcher, watched)

	var debounce *time.Timer
	debounceC := make(chan struct{}, 1)
	armDebounce := func() {
		if debounce == nil {
			debounce = time.AfterFunc(opts.Debounce, func() {
				select {
				case debounceC <- struct{}{}:
				default:
				}
			})
			return
		}
		debounce.Reset(opts.Debounce)
	}

	rescan := time.NewTicker(opts.Rescan)
	defer rescan.Stop()

	var pushTick <-chan time.Time
	if e.Cfg.Push.Mode == config.PushInterval && e.Cfg.Remote != "" {
		iv := time.Duration(e.Cfg.Push.IntervalMinutes) * time.Minute
		if iv <= 0 {
			iv = 15 * time.Minute
		}
		t := time.NewTicker(iv)
		defer t.Stop()
		pushTick = t.C
	}

	slog.Info("daemon watching", "roots", len(watched), "debounce", opts.Debounce, "push_mode", e.Cfg.Push.Mode)

	for {
		select {
		case <-ctx.Done():
			return nil

		case ev, ok := <-watcher.Events:
			if !ok {
				return nil
			}
			if ignorable(ev.Name) {
				continue
			}
			if ev.Op&(fsnotify.Create|fsnotify.Write|fsnotify.Rename) != 0 {
				armDebounce()
			}

		case err, ok := <-watcher.Errors:
			if !ok {
				return nil
			}
			slog.Warn("watcher error", "err", err)

		case <-debounceC:
			commit := e.CommitOnly
			if e.Cfg.Push.Mode == config.PushEveryCommit {
				commit = e.Push
			}
			rep, err := commit()
			switch {
			case err != nil:
				slog.Error("auto-commit failed", "err", err)
			case rep.Committed:
				slog.Info("auto-committed", "sessions", rep.Sessions, "redactions", rep.Redactions, "pushed", rep.Pushed)
			}

		case <-pushTick:
			if _, err := e.Push(); err != nil {
				slog.Error("scheduled push failed", "err", err)
			}

		case <-rescan.C:
			addRoots(e, watcher, watched)
		}
	}
}

// addRoots (re-)registers every enabled project's storage roots that exist.
func addRoots(e *engine.Engine, watcher *fsnotify.Watcher, watched map[string]bool) {
	projects, err := e.Reg.ProjectsForDevice(registry.DeviceID(e.Cfg.DeviceID))
	if err != nil {
		slog.Warn("daemon: list projects", "err", err)
		return
	}
	for _, proj := range projects {
		for _, agentName := range proj.Agents {
			adapter, err := adapters.Get(agentName)
			if err != nil {
				continue
			}
			roots, err := adapter.StorageRoots(proj)
			if err != nil {
				continue
			}
			for _, root := range roots {
				if watched[root] {
					continue
				}
				if err := watcher.Add(root); err != nil {
					continue // root may not exist yet; retried on next rescan
				}
				watched[root] = true
				slog.Debug("watching", "root", root)
			}
		}
	}
}

// ignorable filters our own write mechanics and editor noise out of the
// event stream: backups, temp files, hidden files.
func ignorable(path string) bool {
	base := filepath.Base(path)
	return strings.HasPrefix(base, ".") ||
		strings.Contains(base, ".bak-") ||
		strings.HasSuffix(base, ".tmp") ||
		strings.HasSuffix(base, "~")
}
