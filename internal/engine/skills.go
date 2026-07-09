package engine

import (
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"strings"

	"agent-sync/internal/adapters"
	"agent-sync/internal/scrub"
)

// skillRoots maps agent → user-level skill/prompt directories, relative to
// $HOME. Project-level skills (.claude/skills in a repo) are deliberately
// out of scope: they live in the project's own git history already.
//
// Whole config dirs are never synced — they mix in credentials and machine
// state; only the prompt/skill subtrees replicate.
var skillRoots = map[string][]string{
	"claudecode": {".claude/skills"},
	"opencode":   {".config/opencode/command", ".config/opencode/agent"},
	"codex":      {".codex/prompts"},
}

// skillsRepoPrefix is the sync-repo home of user-level skills:
// userskills/<agent>/<root-index>/<relpath>. The index keeps multiple
// roots per agent (opencode) apart.
const skillsRepoPrefix = "userskills"

// SkillsReport summarizes a skills push or pull.
type SkillsReport struct {
	Files   int
	Skipped []string
}

// SkillsPush replicates local user-level skill trees into the sync repo
// (scrubbed, like everything else) and pushes.
func (e *Engine) SkillsPush() (SkillsReport, error) {
	var rep SkillsReport
	home, err := os.UserHomeDir()
	if err != nil {
		return rep, err
	}
	for agent, roots := range skillRoots {
		for i, root := range roots {
			localRoot := filepath.Join(home, root)
			err := filepath.WalkDir(localRoot, func(p string, d fs.DirEntry, err error) error {
				if err != nil || d.IsDir() {
					return nil // missing roots and racy entries are fine
				}
				if strings.HasPrefix(d.Name(), ".") {
					return nil
				}
				rel, err := filepath.Rel(localRoot, p)
				if err != nil {
					return err
				}
				data, err := os.ReadFile(p)
				if err != nil {
					rep.Skipped = append(rep.Skipped, p+" (unreadable)")
					return nil
				}
				res, err := scrub.Scrub(data, scrub.Policy{})
				if err != nil {
					return err
				}
				repoPath := path.Join(skillsRepoPrefix, agent, fmt.Sprint(i), filepath.ToSlash(rel))
				if err := e.Store.StageArtifact(repoPath, res); err != nil {
					return err
				}
				rep.Files++
				return nil
			})
			if err != nil {
				return rep, err
			}
		}
	}
	if _, err := e.Store.Commit(fmt.Sprintf("skills: push from %s", e.Cfg.DeviceID)); err != nil {
		return rep, err
	}
	_, err = e.pushBestEffort()
	return rep, err
}

// SkillsPull pulls the sync repo and materializes user-level skill files
// locally. Existing files are overwritten atomically with a backup
// (adapters.AtomicWrite), never deleted: removal doesn't propagate in v1.
func (e *Engine) SkillsPull() (SkillsReport, error) {
	var rep SkillsReport
	if _, err := e.Store.Pull(); err != nil {
		return rep, err
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return rep, err
	}
	artifacts, err := e.Store.PathsUnder(skillsRepoPrefix + "/")
	if err != nil {
		return rep, err
	}
	for _, artifact := range artifacts {
		parts := strings.SplitN(artifact, "/", 4) // userskills/<agent>/<idx>/<rel>
		if len(parts) != 4 {
			continue
		}
		agent, idx, rel := parts[1], parts[2], parts[3]
		roots := skillRoots[agent]
		var rootIdx int
		if _, err := fmt.Sscanf(idx, "%d", &rootIdx); err != nil || rootIdx < 0 || rootIdx >= len(roots) {
			rep.Skipped = append(rep.Skipped, artifact+" (unknown root)")
			continue
		}
		data, err := e.Store.ReadArtifact(artifact)
		if err != nil {
			return rep, err
		}
		target := filepath.Join(home, roots[rootIdx], filepath.FromSlash(rel))
		if existing, err := os.ReadFile(target); err == nil && string(existing) == string(data) {
			continue // unchanged
		}
		if err := adapters.AtomicWrite(target, data); err != nil {
			rep.Skipped = append(rep.Skipped, artifact+" ("+err.Error()+")")
			continue
		}
		rep.Files++
	}
	return rep, nil
}
