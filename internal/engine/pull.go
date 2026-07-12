package engine

import (
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/raman-0O7/baton/internal/adapters"
	"github.com/raman-0O7/baton/internal/crypt"
	"github.com/raman-0O7/baton/internal/gitstore"
	"github.com/raman-0O7/baton/internal/registry"
)

// activeWriteWindow: a local session file updated more recently than this
// is treated as possibly mid-conversation and never overwritten (NFR-4's
// "never write while the agent holds the session", by heuristic).
const activeWriteWindow = 30 * time.Second

// PullReport summarizes one Pull run.
type PullReport struct {
	Git gitstore.PullReport
	// Placed lists sessions written into local agent storage as
	// "<agent>/<session-id>".
	Placed []string
	// Skipped lists artifacts not placed, with reasons.
	Skipped []string
}

// Pull integrates the remote (fork-on-conflict per FR-6) and places new or
// updated session artifacts into local agent storage via the adapters,
// rewriting locations through this device's path map (FR-5).
//
// Placement candidates are the union of what this Pull integrated and a
// reconciliation sweep over mapped projects: artifacts can predate the
// mapping (initial clone, sessions skipped while the project was
// unmapped), so "changed just now" alone would miss them.
func (e *Engine) Pull() (PullReport, error) {
	var rep PullReport
	gitRep, err := e.Store.Pull()
	if err != nil {
		return rep, err
	}
	rep.Git = gitRep

	dev := registry.DeviceID(e.Cfg.DeviceID)
	projects, err := e.Reg.ProjectsForDevice(dev)
	if err != nil {
		return rep, err
	}
	byID := map[registry.ProjectID]registry.Project{}
	for _, p := range projects {
		byID[p.ID] = p
	}

	paths := append([]string{}, gitRep.NewPaths...)
	for _, f := range gitRep.Forks {
		paths = append(paths, f.ForkPath)
	}
	seen := map[string]bool{}
	for _, p := range paths {
		seen[p] = true
	}
	// Reconciliation sweep: artifacts of mapped projects missing locally.
	for pid, proj := range byID {
		artifacts, err := e.Store.PathsUnder("projects/" + string(pid) + "/sessions/")
		if err != nil {
			return rep, err
		}
		local := map[string]bool{}
		for _, agentName := range proj.Agents {
			if adapter, err := adapters.Get(agentName); err == nil {
				if refs, err := adapter.ListSessions(proj); err == nil {
					for _, r := range refs {
						local[agentName+"/"+r.ID] = true
					}
				}
			}
		}
		for _, artifact := range artifacts {
			if seen[artifact] {
				continue
			}
			_, agentName, sessionFile, ok := splitArtifactPath(artifact)
			if !ok {
				continue
			}
			if local[agentName+"/"+strings.TrimSuffix(sessionFile, ".json")] {
				continue // already present locally
			}
			paths = append(paths, artifact)
			seen[artifact] = true
		}
	}

	for _, artifact := range paths {
		pid, agentName, sessionFile, ok := splitArtifactPath(artifact)
		if !ok {
			continue // registry/meta files etc.
		}
		proj, mapped := byID[pid]
		if !mapped {
			rep.Skipped = append(rep.Skipped, artifact+" (project not mapped on this device — run `baton enable` in its directory)")
			continue
		}
		adapter, err := adapters.Get(agentName)
		if err != nil {
			rep.Skipped = append(rep.Skipped, artifact+" (no adapter "+agentName+")")
			continue
		}

		data, err := e.Store.ReadArtifact(artifact)
		if err != nil {
			return rep, err
		}
		if crypt.IsEncrypted(data) {
			idPath, err := crypt.DefaultIdentityPath()
			if err != nil {
				return rep, err
			}
			plain, err := crypt.Decrypt(data, idPath)
			if err != nil {
				rep.Skipped = append(rep.Skipped, artifact+" (encrypted; decrypt failed: "+err.Error()+")")
				continue
			}
			data = plain
		}
		s, err := unmarshalArtifact(data)
		if err != nil {
			rep.Skipped = append(rep.Skipped, artifact+" (unparseable artifact)")
			slog.Warn("unparseable session artifact", "path", artifact, "err", err)
			continue
		}
		// Fork artifacts keep their fork filename as the local session ID
		// so they land beside the canonical session instead of over it.
		s.ID = strings.TrimSuffix(sessionFile, ".json")

		if reason, active := e.sessionActive(adapter, proj, s.ID); active {
			rep.Skipped = append(rep.Skipped, artifact+" ("+reason+")")
			continue
		}
		if err := adapter.WriteSession(proj, s); err != nil {
			rep.Skipped = append(rep.Skipped, artifact+" (write failed: "+err.Error()+")")
			slog.Warn("write session", "session", s.ID, "err", err)
			continue
		}
		rep.Placed = append(rep.Placed, agentName+"/"+s.ID)
	}
	return rep, nil
}

// sessionActive reports whether the local copy of sessionID looks like it
// is being written right now.
func (e *Engine) sessionActive(adapter adapters.AgentAdapter, proj registry.Project, sessionID string) (string, bool) {
	refs, err := adapter.ListSessions(proj)
	if err != nil {
		return "", false
	}
	for _, ref := range refs {
		if ref.ID == sessionID && time.Since(ref.UpdatedAt) < activeWriteWindow {
			return fmt.Sprintf("local session active %s ago", time.Since(ref.UpdatedAt).Round(time.Second)), true
		}
	}
	return "", false
}

// splitArtifactPath decomposes projects/<pid>/sessions/<agent>/<file>.json.
func splitArtifactPath(p string) (registry.ProjectID, string, string, bool) {
	parts := strings.Split(p, "/")
	if len(parts) != 5 || parts[0] != "projects" || parts[2] != "sessions" || !strings.HasSuffix(parts[4], ".json") {
		return "", "", "", false
	}
	return registry.ProjectID(parts[1]), parts[3], parts[4], true
}
