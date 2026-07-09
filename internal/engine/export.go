package engine

import (
	"fmt"
	"sort"

	"agent-sync/internal/adapters"
	"agent-sync/internal/handoff"
	"agent-sync/internal/model"
	"agent-sync/internal/registry"
)

// Export builds a handoff document from a local session of the project at
// projectPath. sessionID empty selects the most recently updated session.
func (e *Engine) Export(projectPath, fromAgent, sessionID string, opts handoff.Options) (string, *model.Session, error) {
	dev := registry.DeviceID(e.Cfg.DeviceID)
	proj, ok, err := e.Reg.LookupByPath(dev, projectPath)
	if err != nil {
		return "", nil, err
	}
	if !ok {
		return "", nil, fmt.Errorf("project at %s is not enabled (run `agent-sync enable`)", projectPath)
	}
	adapter, err := adapters.Get(fromAgent)
	if err != nil {
		return "", nil, err
	}
	refs, err := adapter.ListSessions(proj)
	if err != nil {
		return "", nil, err
	}
	if len(refs) == 0 {
		return "", nil, fmt.Errorf("no %s sessions found for %s", fromAgent, proj.Name)
	}

	var ref *model.SessionRef
	if sessionID == "" {
		sort.Slice(refs, func(i, j int) bool { return refs[i].UpdatedAt.After(refs[j].UpdatedAt) })
		ref = &refs[0]
	} else {
		for i := range refs {
			if refs[i].ID == sessionID {
				ref = &refs[i]
				break
			}
		}
		if ref == nil {
			return "", nil, fmt.Errorf("session %s not found in %s storage", sessionID, fromAgent)
		}
	}

	s, err := adapter.ReadSession(*ref)
	if err != nil {
		return "", nil, err
	}
	return handoff.Build(s, opts), s, nil
}

// LaunchHint returns the copy-pasteable command that starts the target
// agent primed with the handoff document at docPath.
func LaunchHint(targetAgent, docPath string) string {
	switch targetAgent {
	case "opencode":
		return fmt.Sprintf(`opencode run "$(cat %s)"`, docPath)
	case "codex":
		return fmt.Sprintf(`codex "$(cat %s)"`, docPath)
	case "claudecode":
		return fmt.Sprintf(`claude "$(cat %s)"`, docPath)
	}
	return fmt.Sprintf("start %s with the contents of %s as the first message", targetAgent, docPath)
}
