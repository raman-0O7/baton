package registry

import (
	"bytes"
	"errors"
	"fmt"
	"io/fs"
	"path/filepath"
	"sort"
	"time"

	"github.com/BurntSushi/toml"
	"github.com/google/uuid"

	"agent-sync/internal/scrub"
)

// Backend is the persistence surface the registry needs from the sync
// repo. *gitstore.Store implements it (asserted there); registry cannot
// import gitstore directly because gitstore consumes registry types.
//
// StageArtifact requiring scrub.Result keeps the mandated chokepoint:
// every registry write is scrubbed before it can reach the repo.
type Backend interface {
	StageArtifact(relPath string, r scrub.Result) error
	// ReadArtifact returns worktree content (staged writes included); the
	// error satisfies errors.Is(err, fs.ErrNotExist) for missing paths.
	ReadArtifact(relPath string) ([]byte, error)
	PathsUnder(prefix string) ([]string, error)
}

// Registry persists device identity, enabled projects, and the per-device
// path map in the sync repo (§1.4):
//
//	devices/<device-id>.toml           hostname, os, created, [pathmap]
//	projects/<project-id>/meta.toml    name, created, agents
//
// Writes are staged only; committing (and pushing) is the caller's job via
// the Store.
type Registry struct {
	store Backend
}

// New binds a Registry to the sync repo store.
func New(store Backend) *Registry { return &Registry{store: store} }

// deviceFile is the on-disk shape of devices/<device-id>.toml.
type deviceFile struct {
	Hostname string            `toml:"hostname"`
	OS       string            `toml:"os"`
	Created  string            `toml:"created"` // RFC3339
	PathMap  map[string]string `toml:"pathmap"` // ProjectID → absolute path on this device
}

// metaFile is the on-disk shape of projects/<project-id>/meta.toml.
type metaFile struct {
	Name    string   `toml:"name"`
	Created string   `toml:"created"` // RFC3339
	Agents  []string `toml:"agents"`
}

func devicePath(id DeviceID) string { return "devices/" + string(id) + ".toml" }
func metaPath(id ProjectID) string  { return "projects/" + string(id) + "/meta.toml" }
func nowRFC3339() string            { return time.Now().UTC().Format(time.RFC3339) }

// EnsureDevice registers a device file if absent. Idempotent: an existing
// registration (including its path map) is left untouched.
func (r *Registry) EnsureDevice(id DeviceID, hostname, osName string) error {
	if id == "" {
		return errors.New("registry: device ID must not be empty")
	}
	if _, err := r.store.ReadArtifact(devicePath(id)); err == nil {
		return nil
	} else if !errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("registry: read device %s: %w", id, err)
	}
	return r.stageTOML(devicePath(id), deviceFile{
		Hostname: hostname,
		OS:       osName,
		Created:  nowRFC3339(),
		PathMap:  map[string]string{},
	})
}

// EnableProject creates a new project (fresh UUID) and stages its
// meta.toml. The returned Project has no Path yet — pair with SetPath to
// map it on a device.
func (r *Registry) EnableProject(name string, agents []string) (Project, error) {
	if name == "" {
		return Project{}, errors.New("registry: project name must not be empty")
	}
	id := ProjectID(uuid.NewString())
	err := r.stageTOML(metaPath(id), metaFile{
		Name:    name,
		Created: nowRFC3339(),
		Agents:  append([]string(nil), agents...),
	})
	if err != nil {
		return Project{}, err
	}
	return Project{ID: id, Name: name, Agents: append([]string(nil), agents...)}, nil
}

// SetPath records where project id lives on device dev (the per-device
// path map, FR-5). The device must already be registered and the project
// enabled.
func (r *Registry) SetPath(dev DeviceID, id ProjectID, absPath string) error {
	if !filepath.IsAbs(absPath) {
		return fmt.Errorf("registry: project path %q is not absolute", absPath)
	}
	if _, err := r.readMeta(id); err != nil {
		return err
	}
	df, err := r.readDevice(dev)
	if err != nil {
		return err
	}
	if df.PathMap == nil {
		df.PathMap = map[string]string{}
	}
	df.PathMap[string(id)] = filepath.Clean(absPath)
	return r.stageTOML(devicePath(dev), df)
}

// ProjectsForDevice joins the device's path map with project metadata,
// returning every project mapped on dev (sorted by name, then ID).
func (r *Registry) ProjectsForDevice(dev DeviceID) ([]Project, error) {
	df, err := r.readDevice(dev)
	if err != nil {
		return nil, err
	}
	out := make([]Project, 0, len(df.PathMap))
	for pid, p := range df.PathMap {
		id := ProjectID(pid)
		meta, err := r.readMeta(id)
		if err != nil {
			return nil, err
		}
		out = append(out, Project{ID: id, Path: p, Name: meta.Name, Agents: meta.Agents})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Name != out[j].Name {
			return out[i].Name < out[j].Name
		}
		return out[i].ID < out[j].ID
	})
	return out, nil
}

// LookupByPath finds the project mapped at absPath on device dev.
// The second return is false when no mapping matches.
func (r *Registry) LookupByPath(dev DeviceID, absPath string) (Project, bool, error) {
	df, err := r.readDevice(dev)
	if err != nil {
		return Project{}, false, err
	}
	want := filepath.Clean(absPath)
	for pid, p := range df.PathMap {
		if filepath.Clean(p) != want {
			continue
		}
		id := ProjectID(pid)
		meta, err := r.readMeta(id)
		if err != nil {
			return Project{}, false, err
		}
		return Project{ID: id, Path: p, Name: meta.Name, Agents: meta.Agents}, true, nil
	}
	return Project{}, false, nil
}

// readDevice loads and decodes devices/<dev>.toml.
func (r *Registry) readDevice(dev DeviceID) (deviceFile, error) {
	var df deviceFile
	data, err := r.store.ReadArtifact(devicePath(dev))
	if errors.Is(err, fs.ErrNotExist) {
		return df, fmt.Errorf("registry: device %s not registered (run EnsureDevice first): %w", dev, err)
	}
	if err != nil {
		return df, fmt.Errorf("registry: read device %s: %w", dev, err)
	}
	if err := toml.Unmarshal(data, &df); err != nil {
		return df, fmt.Errorf("registry: decode device %s: %w", dev, err)
	}
	return df, nil
}

// readMeta loads and decodes projects/<id>/meta.toml.
func (r *Registry) readMeta(id ProjectID) (metaFile, error) {
	var mf metaFile
	data, err := r.store.ReadArtifact(metaPath(id))
	if errors.Is(err, fs.ErrNotExist) {
		return mf, fmt.Errorf("registry: project %s not enabled: %w", id, err)
	}
	if err != nil {
		return mf, fmt.Errorf("registry: read project %s: %w", id, err)
	}
	if err := toml.Unmarshal(data, &mf); err != nil {
		return mf, fmt.Errorf("registry: decode project %s: %w", id, err)
	}
	return mf, nil
}

// stageTOML encodes v, runs it through the mandatory scrub chokepoint, and
// stages it in the sync repo. The caller commits via the Store.
func (r *Registry) stageTOML(relPath string, v any) error {
	var buf bytes.Buffer
	if err := toml.NewEncoder(&buf).Encode(v); err != nil {
		return fmt.Errorf("registry: encode %s: %w", relPath, err)
	}
	res, err := scrub.Scrub(buf.Bytes(), scrub.Policy{})
	if err != nil {
		return fmt.Errorf("registry: scrub %s: %w", relPath, err)
	}
	return r.store.StageArtifact(relPath, res)
}

// ListProjects returns every enabled project in the sync repo, regardless
// of device mapping. Path is left empty — join with a device's path map
// via ProjectsForDevice for local paths.
func (r *Registry) ListProjects() ([]Project, error) {
	paths, err := r.store.PathsUnder("projects/")
	if err != nil {
		return nil, err
	}
	var out []Project
	for _, p := range paths {
		if filepath.Base(p) != "meta.toml" {
			continue
		}
		id := ProjectID(filepath.Base(filepath.Dir(p)))
		meta, err := r.readMeta(id)
		if err != nil {
			return nil, err
		}
		out = append(out, Project{ID: id, Name: meta.Name, Agents: meta.Agents})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out, nil
}

// DeviceHasPath reports whether the device already maps project id.
func (r *Registry) DeviceHasPath(dev DeviceID, id ProjectID) (bool, error) {
	df, err := r.readDevice(dev)
	if err != nil {
		return false, err
	}
	_, ok := df.PathMap[string(id)]
	return ok, nil
}
