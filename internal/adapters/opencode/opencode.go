// Package opencode implements the AgentAdapter for opencode, whose
// sessions live in a SQLite database. Format findings are documented in
// docs/formats/opencode.md.
package opencode

import (
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	_ "modernc.org/sqlite"

	"github.com/raman-0O7/baton/internal/adapters"
	"github.com/raman-0O7/baton/internal/model"
	"github.com/raman-0O7/baton/internal/registry"
)

const formatVersion = "2026-07-db"

// dbPathOverride redirects the database location in tests.
var dbPathOverride string

func init() {
	adapters.Register(&adapter{})
}

type adapter struct{}

var _ adapters.AgentAdapter = (*adapter)(nil)

func (a *adapter) Name() string          { return "opencode" }
func (a *adapter) FormatVersion() string { return formatVersion }

func dbPath() (string, error) {
	if dbPathOverride != "" {
		return dbPathOverride, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".local", "share", "opencode", "opencode.db"), nil
}

// open returns a read-write handle with sane concurrency settings for a
// database that opencode itself may hold open (WAL + busy timeout).
func open() (*sql.DB, error) {
	p, err := dbPath()
	if err != nil {
		return nil, err
	}
	if _, err := os.Stat(p); err != nil {
		return nil, fmt.Errorf("opencode: database not found at %s: %w", p, err)
	}
	db, err := sql.Open("sqlite", p+"?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)")
	if err != nil {
		return nil, err
	}
	return db, nil
}

// StorageRoots returns the directory holding the database: the daemon
// watches the whole dir because SQLite writes hit -wal/-shm siblings.
func (a *adapter) StorageRoots(project registry.Project) ([]string, error) {
	p, err := dbPath()
	if err != nil {
		return nil, err
	}
	return []string{filepath.Dir(p)}, nil
}

func (a *adapter) ListSessions(project registry.Project) ([]model.SessionRef, error) {
	if project.Path == "" {
		return nil, errors.New("opencode: project has no path")
	}
	p, err := dbPath()
	if err != nil {
		return nil, err
	}
	if _, err := os.Stat(p); errors.Is(err, os.ErrNotExist) {
		return nil, nil // opencode never ran here: no sessions, not an error
	}
	db, err := open()
	if err != nil {
		return nil, err
	}
	defer db.Close()

	rows, err := db.Query(
		`SELECT id, time_updated FROM session WHERE directory = ? ORDER BY id`,
		filepath.Clean(project.Path))
	if err != nil {
		return nil, fmt.Errorf("opencode: query sessions: %w", err)
	}
	defer rows.Close()

	var refs []model.SessionRef
	for rows.Next() {
		var id string
		var updatedMs int64
		if err := rows.Scan(&id, &updatedMs); err != nil {
			return nil, err
		}
		refs = append(refs, model.SessionRef{
			Agent:     a.Name(),
			ID:        id,
			Path:      p,
			UpdatedAt: time.UnixMilli(updatedMs).UTC(),
		})
	}
	return refs, rows.Err()
}
