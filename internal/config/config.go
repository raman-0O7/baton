// Package config loads the tool's own configuration (not agent configs).
// Location: $XDG_CONFIG_HOME/baton/config.toml, overridable via --config.
package config

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"

	"github.com/BurntSushi/toml"
)

// PushMode controls when the daemon pushes committed changes.
type PushMode string

const (
	PushEveryCommit PushMode = "every-commit"
	PushInterval    PushMode = "interval"
	PushSessionEnd  PushMode = "session-end"
	PushManual      PushMode = "manual"
)

// Config is the on-disk tool configuration.
type Config struct {
	// RepoPath is the local clone of the sync repo. Default: ~/.baton/repo.
	RepoPath string `toml:"repo_path"`
	// Remote is the git remote URL for the sync repo.
	Remote string `toml:"remote"`
	// DeviceID identifies this machine in the sync repo. Set by `init`.
	DeviceID string `toml:"device_id"`
	// Push configures daemon push behavior.
	Push PushConfig `toml:"push"`
	// Encrypt enables age encryption of staged artifacts (SR-3).
	Encrypt bool `toml:"encrypt"`
	// AgeRecipients are age public keys used when Encrypt is true.
	AgeRecipients []string `toml:"age_recipients"`
	// DebounceSeconds is the daemon's write-settle window.
	DebounceSeconds int `toml:"debounce_seconds"`
}

type PushConfig struct {
	Mode            PushMode `toml:"mode"`
	IntervalMinutes int      `toml:"interval_minutes"`
}

var overridePath string

// SetPath sets an explicit config file path (from --config). Empty resets to default.
func SetPath(p string) error {
	overridePath = p
	return nil
}

// Path returns the effective config file location.
func Path() (string, error) {
	if overridePath != "" {
		return overridePath, nil
	}
	base := os.Getenv("XDG_CONFIG_HOME")
	if base == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		base = filepath.Join(home, ".config")
	}
	return filepath.Join(base, "baton", "config.toml"), nil
}

// Defaults returns a Config with defaults applied.
func Defaults() (Config, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return Config{}, err
	}
	return Config{
		RepoPath:        filepath.Join(home, ".baton", "repo"),
		Push:            PushConfig{Mode: PushSessionEnd, IntervalMinutes: 15},
		DebounceSeconds: 5,
	}, nil
}

// Load reads the config file, applying defaults for absent fields.
// A missing file returns defaults, not an error: every command must work
// before `init` has ever run.
func Load() (Config, error) {
	cfg, err := Defaults()
	if err != nil {
		return Config{}, err
	}
	p, err := Path()
	if err != nil {
		return Config{}, err
	}
	if _, err := toml.DecodeFile(p, &cfg); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return cfg, nil
		}
		return Config{}, fmt.Errorf("parse %s: %w", p, err)
	}
	return cfg, nil
}

// Save writes cfg to the config path, creating parent dirs 0700.
func Save(cfg Config) error {
	p, err := Path()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		return err
	}
	f, err := os.OpenFile(p+".tmp", os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	if err := toml.NewEncoder(f).Encode(cfg); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Rename(p+".tmp", p)
}
