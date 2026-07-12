package engine

import (
	"strings"

	"github.com/raman-0O7/baton/internal/adapters"
	"github.com/raman-0O7/baton/internal/registry"
)

// ProjectStatus is the per-project slice of a Status report.
type ProjectStatus struct {
	Project       registry.Project
	LocalSessions map[string]int // agent → session count in local storage
	SyncedCount   int            // session artifacts in the sync repo
	Forks         []string       // fork artifacts awaiting attention
}

// Status is the full `baton status` report.
type Status struct {
	DeviceID   string
	Remote     string
	RepoPath   string
	Ahead      int // local commits not on the remote
	AheadKnown bool
	Projects   []ProjectStatus
}

// Status inspects local agent storage and the sync repo. Read-only.
func (e *Engine) Status() (Status, error) {
	st := Status{DeviceID: e.Cfg.DeviceID, Remote: e.Cfg.Remote, RepoPath: e.Cfg.RepoPath}

	n, known, err := e.Store.Ahead()
	if err != nil {
		return st, err
	}
	st.Ahead, st.AheadKnown = n, known

	projects, err := e.Reg.ProjectsForDevice(registry.DeviceID(e.Cfg.DeviceID))
	if err != nil {
		return st, err
	}
	for _, proj := range projects {
		ps := ProjectStatus{Project: proj, LocalSessions: map[string]int{}}
		for _, agentName := range proj.Agents {
			adapter, err := adapters.Get(agentName)
			if err != nil {
				continue
			}
			refs, err := adapter.ListSessions(proj)
			if err != nil {
				continue
			}
			ps.LocalSessions[agentName] = len(refs)
		}
		artifacts, err := e.Store.PathsUnder("projects/" + string(proj.ID) + "/sessions/")
		if err != nil {
			return st, err
		}
		for _, a := range artifacts {
			if strings.Contains(a, ".fork-") {
				ps.Forks = append(ps.Forks, a)
			} else {
				ps.SyncedCount++
			}
		}
		st.Projects = append(st.Projects, ps)
	}
	return st, nil
}
