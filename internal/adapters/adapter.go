// Package adapters defines the AgentAdapter plugin interface and the
// name-keyed registry. Core packages depend only on this interface; agent
// specifics live in subpackages (claudecode, opencode, codex).
package adapters

import (
	"errors"
	"fmt"
	"sort"
	"sync"

	"github.com/raman-0O7/baton/internal/model"
	"github.com/raman-0O7/baton/internal/registry"
)

// ErrNotSupported is returned by adapters for operations they legitimately
// cannot perform (e.g. WriteSession on a read-only v1 adapter, per FR-11).
var ErrNotSupported = errors.New("operation not supported by this adapter")

// ErrUnknownFormat is returned when a session file's format version is not
// recognized. Callers must skip-and-warn, never fail the whole run (NFR-3).
var ErrUnknownFormat = errors.New("unknown session format version")

// AgentAdapter converts between one agent's native session storage and the
// canonical IR. Implementations must be safe for concurrent use.
type AgentAdapter interface {
	// Name is the stable adapter identifier: "claudecode" | "opencode" | "codex".
	Name() string
	// StorageRoots returns the absolute directories holding this agent's
	// data for the project — the dirs the daemon watches and sync reads.
	StorageRoots(project registry.Project) ([]string, error)
	// ListSessions enumerates sessions for the project without full parsing.
	ListSessions(project registry.Project) ([]model.SessionRef, error)
	// ReadSession parses one session into the IR. Returns ErrUnknownFormat
	// (wrapped) for unrecognized format versions.
	ReadSession(ref model.SessionRef) (*model.Session, error)
	// WriteSession places a session into local storage so the agent's own
	// resume/session-list sees it. Must write atomically (temp+rename) and
	// back up any file it replaces (NFR-4). May return ErrNotSupported.
	WriteSession(project registry.Project, s *model.Session) error
	// FormatVersion identifies the native format this adapter targets.
	// Bumped when the parser is updated for a new agent release.
	FormatVersion() string
}

var (
	mu          sync.RWMutex
	registryMap = map[string]AgentAdapter{}
)

// Register adds an adapter. Called from adapter package init(); duplicate
// names panic — that is a programmer error, not a runtime condition.
func Register(a AgentAdapter) {
	mu.Lock()
	defer mu.Unlock()
	if _, dup := registryMap[a.Name()]; dup {
		panic(fmt.Sprintf("adapters: duplicate registration for %q", a.Name()))
	}
	registryMap[a.Name()] = a
}

// Get returns the adapter for name.
func Get(name string) (AgentAdapter, error) {
	mu.RLock()
	defer mu.RUnlock()
	a, ok := registryMap[name]
	if !ok {
		return nil, fmt.Errorf("adapters: no adapter named %q (available: %v)", name, namesLocked())
	}
	return a, nil
}

// Names lists registered adapters, sorted.
func Names() []string {
	mu.RLock()
	defer mu.RUnlock()
	return namesLocked()
}

func namesLocked() []string {
	out := make([]string, 0, len(registryMap))
	for n := range registryMap {
		out = append(out, n)
	}
	sort.Strings(out)
	return out
}
