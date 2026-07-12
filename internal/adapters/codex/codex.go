// Package codex implements the AgentAdapter for the OpenAI Codex CLI,
// whose sessions are date-sharded rollout JSONL files. Format basis and
// confidence notes live in docs/formats/codex.md.
package codex

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"agent-sync/internal/adapters"
	"agent-sync/internal/model"
	"agent-sync/internal/registry"
)

const formatVersion = "2026-07-rollout"

// sessionsBaseOverride redirects ~/.codex/sessions in tests.
var sessionsBaseOverride string

func init() {
	adapters.Register(&adapter{})
}

type adapter struct{}

var _ adapters.AgentAdapter = (*adapter)(nil)

func (a *adapter) Name() string          { return "codex" }
func (a *adapter) FormatVersion() string { return formatVersion }

func sessionsBase() (string, error) {
	if sessionsBaseOverride != "" {
		return sessionsBaseOverride, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".codex", "sessions"), nil
}

// StorageRoots returns the global sessions root: codex shards by date,
// not by project, so project filtering happens per-file via cwd.
func (a *adapter) StorageRoots(project registry.Project) ([]string, error) {
	base, err := sessionsBase()
	if err != nil {
		return nil, err
	}
	return []string{base}, nil
}

// ListSessions walks the date shards and keeps rollouts whose
// session_meta cwd is the project path or under it.
func (a *adapter) ListSessions(project registry.Project) ([]model.SessionRef, error) {
	if project.Path == "" {
		return nil, errors.New("codex: project has no path")
	}
	base, err := sessionsBase()
	if err != nil {
		return nil, err
	}
	want := filepath.Clean(project.Path)

	var refs []model.SessionRef
	err = filepath.WalkDir(base, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				return nil
			}
			return err
		}
		if d.IsDir() || !strings.HasPrefix(d.Name(), "rollout-") || !strings.HasSuffix(d.Name(), ".jsonl") {
			return nil
		}
		cwd, ok := peekCWD(p)
		if !ok {
			return nil // not a recognizable rollout; skip silently here
		}
		if cwd != want && !strings.HasPrefix(cwd, want+string(filepath.Separator)) {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return nil
		}
		refs = append(refs, model.SessionRef{
			Agent:     a.Name(),
			ID:        rolloutID(d.Name()),
			Path:      p,
			UpdatedAt: info.ModTime(),
		})
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("codex: walk sessions: %w", err)
	}
	sort.Slice(refs, func(i, j int) bool { return refs[i].ID < refs[j].ID })
	return refs, nil
}

// WriteSession restores the original rollout bytes. The target path is
// derived from the session's meta timestamp so the file lands in the
// shard codex expects; the original filename is preserved via Raw's meta.
func (a *adapter) WriteSession(project registry.Project, s *model.Session) error {
	if s == nil || s.ID == "" {
		return errors.New("codex: invalid session")
	}
	if len(s.Raw) == 0 {
		return fmt.Errorf("codex: session %s has no raw payload: %w", s.ID, adapters.ErrNotSupported)
	}
	base, err := sessionsBase()
	if err != nil {
		return err
	}
	ts := s.Meta.CreatedAt
	if ts.IsZero() {
		ts = time.Now().UTC()
	}
	name := fmt.Sprintf("rollout-%s-%s.jsonl", ts.UTC().Format("2006-01-02T15-04-05"), s.ID)
	path := filepath.Join(base,
		fmt.Sprintf("%04d", ts.Year()), fmt.Sprintf("%02d", ts.Month()), fmt.Sprintf("%02d", ts.Day()),
		name)
	if err := adapters.AtomicWrite(path, s.Raw); err != nil {
		return fmt.Errorf("codex: write session %s: %w", s.ID, err)
	}
	return nil
}

// rolloutID extracts the uuid tail of rollout-<date>T<time>-<uuid>.jsonl.
// The date-time prefix is fixed-width, so the uuid starts at a known offset;
// fall back to the whole stem when the name deviates.
func rolloutID(name string) string {
	stem := strings.TrimSuffix(strings.TrimPrefix(name, "rollout-"), ".jsonl")
	// len("2006-01-02T15-04-05") == 19, plus the separating '-'.
	if len(stem) > 20 {
		return stem[20:]
	}
	return stem
}
