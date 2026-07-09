// Package engine orchestrates sync operations. The CLI and (later) the
// daemon call the same APIs here — no divergent code paths (§1.1).
package engine

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"

	"agent-sync/internal/config"
	"agent-sync/internal/gitstore"
	"agent-sync/internal/registry"

	// Adapters register themselves; the engine reaches them by name only.
	_ "agent-sync/internal/adapters/claudecode"
)

// ErrNotInitialized is returned by Open before `agent-sync init` has run.
var ErrNotInitialized = errors.New("agent-sync is not initialized on this device (run `agent-sync init`)")

// Engine binds config, the sync repo store, and the registry.
type Engine struct {
	Cfg   config.Config
	Store *gitstore.Store
	Reg   *registry.Registry
}

// Open loads an initialized engine.
func Open() (*Engine, error) {
	cfg, err := config.Load()
	if err != nil {
		return nil, err
	}
	if cfg.DeviceID == "" {
		return nil, ErrNotInitialized
	}
	if _, err := os.Stat(cfg.RepoPath); err != nil {
		return nil, fmt.Errorf("%w: sync repo missing at %s", ErrNotInitialized, cfg.RepoPath)
	}
	store, err := gitstore.InitOrOpen(cfg.RepoPath, cfg.Remote, registry.DeviceID(cfg.DeviceID))
	if err != nil {
		return nil, err
	}
	return &Engine{Cfg: cfg, Store: store, Reg: registry.New(store)}, nil
}

// Init sets up this device: sync repo (cloned from remote when given),
// device identity, and saved config. Idempotent for re-runs on the same
// device.
func Init(remote string) (*Engine, error) {
	cfg, err := config.Load()
	if err != nil {
		return nil, err
	}
	if cfg.DeviceID == "" {
		cfg.DeviceID = newDeviceID()
	}
	if remote != "" {
		cfg.Remote = remote
	}

	store, err := gitstore.InitOrOpen(cfg.RepoPath, cfg.Remote, registry.DeviceID(cfg.DeviceID))
	if err != nil {
		return nil, err
	}
	e := &Engine{Cfg: cfg, Store: store, Reg: registry.New(store)}

	// Adopt existing remote state before writing the device file, so a
	// second device sees projects enabled elsewhere.
	if cfg.Remote != "" {
		if _, err := store.Pull(); err != nil && !errors.Is(err, gitstore.ErrNoRemote) {
			return nil, fmt.Errorf("initial pull: %w", err)
		}
	}

	host, _ := os.Hostname()
	if err := e.Reg.EnsureDevice(registry.DeviceID(cfg.DeviceID), host, runtime.GOOS); err != nil {
		return nil, err
	}
	if _, err := store.Commit(fmt.Sprintf("init: register device %s", cfg.DeviceID)); err != nil {
		return nil, err
	}
	if _, err := e.pushBestEffort(); err != nil {
		return nil, err
	}
	if err := config.Save(cfg); err != nil {
		return nil, err
	}
	return e, nil
}

// Enable opts projectPath into syncing with the given agents. If a project
// with the same display name already exists in the sync repo and is not yet
// mapped on this device, it is bound to projectPath instead of creating a
// duplicate — the cross-device flow (FR-5).
func (e *Engine) Enable(projectPath string, agents []string) (registry.Project, bool, error) {
	abs, err := filepath.Abs(projectPath)
	if err != nil {
		return registry.Project{}, false, err
	}
	dev := registry.DeviceID(e.Cfg.DeviceID)

	if p, ok, err := e.Reg.LookupByPath(dev, abs); err != nil {
		return registry.Project{}, false, err
	} else if ok {
		return p, false, nil // already enabled here
	}

	name := filepath.Base(abs)
	all, err := e.Reg.ListProjects()
	if err != nil {
		return registry.Project{}, false, err
	}
	var candidates []registry.Project
	for _, p := range all {
		if p.Name != name {
			continue
		}
		mapped, err := e.Reg.DeviceHasPath(dev, p.ID)
		if err != nil {
			return registry.Project{}, false, err
		}
		if !mapped {
			candidates = append(candidates, p)
		}
	}

	var proj registry.Project
	created := false
	if len(candidates) == 1 {
		proj = candidates[0]
	} else {
		proj, err = e.Reg.EnableProject(name, agents)
		if err != nil {
			return registry.Project{}, false, err
		}
		created = true
	}
	if err := e.Reg.SetPath(dev, proj.ID, abs); err != nil {
		return registry.Project{}, false, err
	}
	if _, err := e.Store.Commit(fmt.Sprintf("enable: %s on %s", name, e.Cfg.DeviceID)); err != nil {
		return registry.Project{}, false, err
	}
	if _, err := e.pushBestEffort(); err != nil {
		return registry.Project{}, false, err
	}
	proj.Path = abs
	if created && len(proj.Agents) == 0 {
		proj.Agents = agents
	}
	return proj, created, nil
}

// pushBestEffort pushes when a remote exists; a missing remote is fine
// (local-only mode). A non-fast-forward rejection means another device
// pushed first: integrate via Pull (fork-on-conflict, local placement
// included) and retry once. The integration report, when any, is returned
// for surfacing to the user.
func (e *Engine) pushBestEffort() (*PullReport, error) {
	err := e.Store.Push()
	if err == nil || errors.Is(err, gitstore.ErrNoRemote) {
		return nil, nil
	}
	if !gitstore.IsNonFastForward(err) {
		return nil, fmt.Errorf("push: %w", err)
	}
	rep, err := e.Pull()
	if err != nil {
		return nil, fmt.Errorf("integrate before push: %w", err)
	}
	if err := e.Store.Push(); err != nil {
		return &rep, fmt.Errorf("push after integration: %w", err)
	}
	return &rep, nil
}

var deviceIDUnsafe = regexp.MustCompile(`[^a-zA-Z0-9-]+`)

// newDeviceID derives a readable-but-unique device ID: sanitized hostname
// plus a random suffix (hostnames repeat across laptops).
func newDeviceID() string {
	host, err := os.Hostname()
	if err != nil || host == "" {
		host = "device"
	}
	host = strings.TrimSuffix(host, ".local")
	host = deviceIDUnsafe.ReplaceAllString(host, "-")
	host = strings.Trim(host, "-")
	if len(host) > 24 {
		host = host[:24]
	}
	var b [3]byte
	_, _ = rand.Read(b[:])
	return strings.ToLower(host) + "-" + hex.EncodeToString(b[:])
}
