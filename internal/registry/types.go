// Package registry tracks enabled projects, device identity, and the
// per-device path map. Storage layout lives in the sync repo (§1.4):
//
//	devices/<device-id>.toml
//	projects/<project-id>/meta.toml
//
// Types here are part of the P1 contract freeze; persistence lands in P2.
package registry

// ProjectID is a stable UUID assigned at `enable` time. It, not the path,
// keys the project in the sync repo — paths differ per device.
type ProjectID string

// DeviceID identifies one machine. Assigned at `init`.
type DeviceID string

// Project is a sync-enabled project as seen on this device.
type Project struct {
	ID ProjectID
	// Path is the absolute project root on this device (from the path map).
	Path string
	// Name is the human-readable display name (defaults to base of Path).
	Name string
	// Agents lists adapter names enabled for this project.
	Agents []string
}
