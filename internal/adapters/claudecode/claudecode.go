// Package claudecode implements the AgentAdapter for Claude Code, whose
// sessions live as JSONL transcripts under ~/.claude/projects/<path-slug>/.
// Format findings are documented in docs/formats/claudecode.md.
package claudecode

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"unicode/utf16"

	"github.com/raman-0O7/baton/internal/adapters"
	"github.com/raman-0O7/baton/internal/model"
	"github.com/raman-0O7/baton/internal/registry"
)

// formatVersion identifies the native schema this parser targets: the JSONL
// shape observed in Claude Code 2.1.x as of 2026-07.
const formatVersion = "2026-07"

// maxSlugLen mirrors Claude Code's 200-char cap before hash-suffixing.
const maxSlugLen = 200

// projectsBaseOverride redirects the ~/.claude/projects base directory in
// tests. Empty means "derive from the user's home directory".
var projectsBaseOverride string

func init() {
	adapters.Register(&adapter{})
}

type adapter struct{}

var _ adapters.AgentAdapter = (*adapter)(nil)

func (a *adapter) Name() string { return "claudecode" }

func (a *adapter) FormatVersion() string { return formatVersion }

func projectsBase() (string, error) {
	if projectsBaseOverride != "" {
		return projectsBaseOverride, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("claudecode: resolve home dir: %w", err)
	}
	return filepath.Join(home, ".claude", "projects"), nil
}

// StorageRoots returns the single per-project session directory.
func (a *adapter) StorageRoots(project registry.Project) ([]string, error) {
	if project.Path == "" {
		return nil, errors.New("claudecode: project has no path")
	}
	base, err := projectsBase()
	if err != nil {
		return nil, err
	}
	return []string{filepath.Join(base, pathSlug(project.Path))}, nil
}

// ListSessions enumerates top-level *.jsonl files in the project's slug dir.
// Sub-agent transcripts live in per-session subdirectories and are not
// listed. A missing slug dir means "no sessions yet", not an error.
func (a *adapter) ListSessions(project registry.Project) ([]model.SessionRef, error) {
	roots, err := a.StorageRoots(project)
	if err != nil {
		return nil, err
	}
	root := roots[0]
	entries, err := os.ReadDir(root)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, fmt.Errorf("claudecode: list %s: %w", root, err)
	}
	var refs []model.SessionRef
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || !strings.HasSuffix(name, ".jsonl") || strings.HasPrefix(name, ".") {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue // raced with deletion; skip
		}
		refs = append(refs, model.SessionRef{
			Agent:     a.Name(),
			ID:        strings.TrimSuffix(name, ".jsonl"),
			Path:      filepath.Join(root, name),
			UpdatedAt: info.ModTime(),
		})
	}
	sort.Slice(refs, func(i, j int) bool { return refs[i].ID < refs[j].ID })
	return refs, nil
}

// WriteSession places the session's original JSONL payload back into local
// storage so `claude --resume` sees it. Only Raw round-trip is supported:
// synthesizing native JSONL from the IR alone would be lossy and is not a
// v1 capability.
func (a *adapter) WriteSession(project registry.Project, s *model.Session) error {
	if s == nil {
		return errors.New("claudecode: nil session")
	}
	if s.ID == "" {
		return errors.New("claudecode: session has no ID")
	}
	if len(s.Raw) == 0 {
		return fmt.Errorf("claudecode: session %s has no raw payload to write: %w",
			s.ID, adapters.ErrNotSupported)
	}
	roots, err := a.StorageRoots(project)
	if err != nil {
		return err
	}
	path := filepath.Join(roots[0], s.ID+".jsonl")
	if err := adapters.AtomicWrite(path, s.Raw); err != nil {
		return fmt.Errorf("claudecode: write session %s: %w", s.ID, err)
	}
	return nil
}

// pathSlug reproduces Claude Code's project-directory naming (verified
// against the 2.1.205 CLI): every character outside [a-zA-Z0-9] becomes "-",
// operating per UTF-16 code unit exactly like the JS regex; results longer
// than 200 chars are truncated and suffixed with a base36 hash of the
// original path.
func pathSlug(path string) string {
	units := utf16.Encode([]rune(path))
	b := make([]byte, len(units))
	for i, u := range units {
		switch {
		case u >= '0' && u <= '9', u >= 'A' && u <= 'Z', u >= 'a' && u <= 'z':
			b[i] = byte(u)
		default:
			b[i] = '-'
		}
	}
	slug := string(b)
	if len(slug) <= maxSlugLen {
		return slug
	}
	h := int64(jsStringHash(path))
	if h < 0 {
		h = -h
	}
	return slug[:maxSlugLen] + "-" + strconv.FormatInt(h, 36)
}

// jsStringHash is the CLI's 32-bit wrapping string hash:
// h = (h<<5) - h + charCodeAt(i) | 0, over UTF-16 code units.
func jsStringHash(s string) int32 {
	var h int32
	for _, u := range utf16.Encode([]rune(s)) {
		h = h*31 + int32(u)
	}
	return h
}
