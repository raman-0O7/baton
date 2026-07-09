package engine

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"path"

	"agent-sync/internal/adapters"
	"agent-sync/internal/model"
	"agent-sync/internal/registry"
	"agent-sync/internal/scrub"
)

// PushReport summarizes one Push run.
type PushReport struct {
	Projects   int
	Sessions   int
	Redactions int
	Committed  bool
	Pushed     bool
	// Integrated is set when the push was initially rejected and a Pull
	// (fork-on-conflict) ran before the successful retry.
	Integrated *PullReport
}

// artifactPath is the sync-repo location of one session's scrubbed IR.
func artifactPath(pid registry.ProjectID, agent, sessionID string) string {
	return path.Join("projects", string(pid), "sessions", agent, sessionID+".json")
}

// sessionArtifact is the at-rest envelope for one session. The native
// payload travels as plaintext (raw_text), NOT as Session.Raw: []byte
// marshals to base64, which the scrubber would see as one giant
// high-entropy token (corrupting it), while secrets inside it would be
// invisible to the pattern layer. Plaintext keeps the artifact scrubbable
// and human-diffable.
type sessionArtifact struct {
	model.Session
	RawText string `json:"raw_text,omitempty"`
}

func marshalArtifact(s *model.Session) ([]byte, error) {
	a := sessionArtifact{Session: *s, RawText: string(s.Raw)}
	a.Session.Raw = nil
	return json.MarshalIndent(a, "", " ")
}

func unmarshalArtifact(data []byte) (*model.Session, error) {
	var a sessionArtifact
	if err := json.Unmarshal(data, &a); err != nil {
		return nil, err
	}
	s := a.Session
	if a.RawText != "" {
		s.Raw = []byte(a.RawText)
	}
	return &s, nil
}

// Push reads every session of every enabled project through its adapter,
// scrubs, stages, commits, and pushes.
//
// Scrubbing happens twice on purpose: once over the native Raw payload
// (secrets live in tool outputs there — inside the marshaled IR it would
// be base64 and invisible to the scanner), then once over the marshaled
// IR JSON as a belt for text fields (SR-1).
func (e *Engine) Push() (PushReport, error) {
	var rep PushReport
	dev := registry.DeviceID(e.Cfg.DeviceID)
	projects, err := e.Reg.ProjectsForDevice(dev)
	if err != nil {
		return rep, err
	}

	for _, proj := range projects {
		rep.Projects++
		for _, agentName := range proj.Agents {
			adapter, err := adapters.Get(agentName)
			if err != nil {
				slog.Warn("skipping unknown agent", "agent", agentName, "project", proj.Name)
				continue
			}
			refs, err := adapter.ListSessions(proj)
			if err != nil {
				return rep, fmt.Errorf("list %s sessions for %s: %w", agentName, proj.Name, err)
			}
			for _, ref := range refs {
				s, err := adapter.ReadSession(ref)
				if err != nil {
					slog.Warn("skipping unreadable session", "session", ref.ID, "err", err)
					continue // NFR-3: never fail the run on one bad session
				}
				s.ProjectID = string(proj.ID)
				s.Meta.DeviceID = e.Cfg.DeviceID

				rawRes, err := scrub.Scrub(s.Raw, scrub.Policy{})
				if err != nil {
					return rep, err
				}
				s.Raw = rawRes.Data()

				doc, err := marshalArtifact(s)
				if err != nil {
					return rep, err
				}
				res, err := scrub.Scrub(doc, scrub.Policy{})
				if err != nil {
					return rep, err
				}
				if err := e.Store.StageArtifact(artifactPath(proj.ID, agentName, s.ID), res); err != nil {
					return rep, err
				}
				rep.Sessions++
				rep.Redactions += len(rawRes.Redactions) + len(res.Redactions)
			}
		}
	}

	staged, err := e.Store.Commit(fmt.Sprintf("sync: push from %s", e.Cfg.DeviceID))
	if err != nil {
		return rep, err
	}
	rep.Committed = staged
	pullRep, err := e.pushBestEffort()
	if err != nil {
		return rep, err
	}
	rep.Integrated = pullRep
	rep.Pushed = e.Cfg.Remote != ""
	return rep, nil
}
