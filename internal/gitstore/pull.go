package gitstore

import (
	"errors"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"time"

	git "github.com/go-git/go-git/v5"
	"github.com/go-git/go-git/v5/plumbing"
	"github.com/go-git/go-git/v5/plumbing/object"
	"github.com/go-git/go-git/v5/plumbing/transport"

	"agent-sync/internal/registry"
)

// sessionGlob matches session artifacts (§1.4), which fork rather than
// conflict on divergence. path.Match's `*` never crosses `/`.
const sessionGlob = "projects/*/sessions/*/*"

// forkTimestamp is the UTC timestamp layout in fork sibling names
// (the trailing Z is literal).
const forkTimestamp = "20060102T150405Z"

// Fork records one session file preserved during a divergent pull: the
// canonical path now holds the remote version, ForkPath holds the local one.
type Fork struct {
	Original string
	ForkPath string
}

// PullReport describes what a Pull integrated.
type PullReport struct {
	// FastForward is true when local history simply advanced to the
	// remote head (no merge commit).
	FastForward bool
	// Forks lists session files that diverged on both sides (FR-6).
	Forks []Fork
	// Conflicts lists canonical paths of non-session files changed on both
	// sides; the local version survives at "<path>.conflict-<device-id>".
	Conflicts []string
	// NewPaths lists paths added or updated from the remote, excluding
	// forked/conflicted paths (reported above) and their siblings.
	NewPaths []string
}

// Pull fetches origin and integrates the remote branch into the local one.
//
//   - No origin remote           → ErrNoRemote.
//   - Empty remote / no branches → no-op report.
//   - Local up to date or ahead  → no-op report.
//   - Local strictly behind      → fast-forward, no merge commit.
//   - Diverged                   → fork-on-conflict merge (FR-6): the merged
//     tree starts from the remote tree; paths only the local side changed
//     are overlaid back; paths both sides changed keep the remote blob at
//     the canonical name while the local blob is preserved as a fork
//     sibling (session files) or ".conflict-<device>" sibling (everything
//     else). The merge commit carries both parents (local, remote).
func (s *Store) Pull() (PullReport, error) {
	var rep PullReport

	if _, err := s.repo.Remote(remoteName); err != nil {
		if errors.Is(err, git.ErrRemoteNotFound) {
			return rep, ErrNoRemote
		}
		return rep, err
	}

	err := s.repo.Fetch(&git.FetchOptions{RemoteName: remoteName})
	switch {
	case err == nil, errors.Is(err, git.NoErrAlreadyUpToDate):
	case errors.Is(err, transport.ErrEmptyRemoteRepository):
		return rep, nil
	default:
		return rep, fmt.Errorf("gitstore: fetch: %w", err)
	}

	remoteHash, ok := s.remoteHead()
	if !ok {
		return rep, nil // remote has no branches yet
	}

	headRef, err := s.repo.Head()
	if errors.Is(err, plumbing.ErrReferenceNotFound) {
		return s.adoptRemote(remoteHash) // unborn local branch
	}
	if err != nil {
		return rep, err
	}
	localHash := headRef.Hash()
	if localHash == remoteHash {
		return rep, nil // already up to date
	}

	localC, err := s.repo.CommitObject(localHash)
	if err != nil {
		return rep, err
	}
	remoteC, err := s.repo.CommitObject(remoteHash)
	if err != nil {
		return rep, err
	}

	if ahead, err := remoteC.IsAncestor(localC); err != nil {
		return rep, err
	} else if ahead {
		return rep, nil // local strictly ahead; nothing to integrate
	}

	if behind, err := localC.IsAncestor(remoteC); err != nil {
		return rep, err
	} else if behind {
		// Fast-forward.
		localTree, err := localC.Tree()
		if err != nil {
			return rep, err
		}
		remoteTree, err := remoteC.Tree()
		if err != nil {
			return rep, err
		}
		rep.NewPaths = changedPaths(treeMap(localTree), treeMap(remoteTree))
		if err := s.resetHard(remoteHash); err != nil {
			return rep, err
		}
		rep.FastForward = true
		return rep, nil
	}

	return s.mergeForkOnConflict(localC, remoteC)
}

// mergeForkOnConflict builds the merged tree per FR-6 and commits it with
// both parents. go-git has no native merge, so the integration is manual:
// hard-reset the worktree to the remote tree, then overlay local-only
// changes and fork/conflict siblings, then commit with explicit parents.
func (s *Store) mergeForkOnConflict(localC, remoteC *object.Commit) (PullReport, error) {
	var rep PullReport

	base := map[string]plumbing.Hash{}
	bases, err := localC.MergeBase(remoteC)
	if err != nil {
		return rep, fmt.Errorf("gitstore: merge-base: %w", err)
	}
	if len(bases) > 0 {
		baseTree, err := bases[0].Tree()
		if err != nil {
			return rep, err
		}
		base = treeMap(baseTree)
	}
	localTree, err := localC.Tree()
	if err != nil {
		return rep, err
	}
	remoteTree, err := remoteC.Tree()
	if err != nil {
		return rep, err
	}
	local, remote := treeMap(localTree), treeMap(remoteTree)

	union := map[string]struct{}{}
	for p := range base {
		union[p] = struct{}{}
	}
	for p := range local {
		union[p] = struct{}{}
	}
	for p := range remote {
		union[p] = struct{}{}
	}

	// overlays: paths to write on top of the remote tree, from local blobs.
	overlays := map[string]plumbing.Hash{}
	var removals []string
	now := time.Now()

	for p := range union {
		lh, rh, bh := local[p], remote[p], base[p] // zero hash = absent
		if lh == rh {
			continue // identical on both sides (or absent from both)
		}
		switch {
		case lh == bh:
			// Only the remote side changed p: remote tree is already right.
			if rh != plumbing.ZeroHash {
				rep.NewPaths = append(rep.NewPaths, p)
			}
		case rh == bh:
			// Only the local side changed p: carry the local change over.
			if lh == plumbing.ZeroHash {
				removals = append(removals, p)
			} else {
				overlays[p] = lh
			}
		default:
			// Both sides changed p with different results.
			if lh == plumbing.ZeroHash {
				// Local deleted, remote modified: remote wins, nothing
				// local left to preserve.
				rep.NewPaths = append(rep.NewPaths, p)
				continue
			}
			// Remote keeps the canonical name (or its deletion); the local
			// blob survives as a sibling.
			if isSessionPath(p) {
				sib := forkSiblingName(p, s.device, now)
				overlays[sib] = lh
				rep.Forks = append(rep.Forks, Fork{Original: p, ForkPath: sib})
			} else {
				sib := conflictSiblingName(p, s.device)
				overlays[sib] = lh
				rep.Conflicts = append(rep.Conflicts, p)
			}
		}
	}

	// Materialize: remote tree first, then overlays and removals.
	if err := s.resetHard(remoteC.Hash); err != nil {
		return rep, err
	}
	wt, err := s.repo.Worktree()
	if err != nil {
		return rep, err
	}
	for _, dst := range sortedKeys(overlays) {
		data, err := s.blobBytes(overlays[dst])
		if err != nil {
			return rep, fmt.Errorf("gitstore: read local blob for %s: %w", dst, err)
		}
		full := filepath.Join(s.repoPath, filepath.FromSlash(dst))
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			return rep, err
		}
		if err := os.WriteFile(full, data, 0o644); err != nil {
			return rep, err
		}
		if _, err := wt.Add(dst); err != nil {
			return rep, fmt.Errorf("gitstore: stage %s: %w", dst, err)
		}
	}
	sort.Strings(removals)
	for _, p := range removals {
		if _, err := wt.Remove(p); err != nil {
			return rep, fmt.Errorf("gitstore: remove %s: %w", p, err)
		}
	}

	msg := fmt.Sprintf("agent-sync: merge origin (fork-on-conflict) on %s [forks: %d, conflicts: %d]",
		s.device, len(rep.Forks), len(rep.Conflicts))
	_, err = wt.Commit(msg, &git.CommitOptions{
		Author:            s.signature(),
		Parents:           []plumbing.Hash{localC.Hash, remoteC.Hash},
		AllowEmptyCommits: true, // a merge may resolve to exactly the remote tree
	})
	if err != nil {
		return rep, fmt.Errorf("gitstore: merge commit: %w", err)
	}

	sort.Strings(rep.NewPaths)
	sort.Strings(rep.Conflicts)
	sort.Slice(rep.Forks, func(i, j int) bool { return rep.Forks[i].Original < rep.Forks[j].Original })
	return rep, nil
}

// adoptRemote points an unborn local branch at the remote head.
func (s *Store) adoptRemote(remote plumbing.Hash) (PullReport, error) {
	var rep PullReport
	branch := s.branchName()
	if err := s.repo.Storer.SetReference(plumbing.NewHashReference(branch, remote)); err != nil {
		return rep, err
	}
	if err := s.resetHard(remote); err != nil {
		return rep, err
	}
	c, err := s.repo.CommitObject(remote)
	if err != nil {
		return rep, err
	}
	t, err := c.Tree()
	if err != nil {
		return rep, err
	}
	rep.FastForward = true
	rep.NewPaths = changedPaths(nil, treeMap(t))
	return rep, nil
}

// branchName returns the local branch HEAD points at (symbolic target),
// falling back to main.
func (s *Store) branchName() plumbing.ReferenceName {
	ref, err := s.repo.Storer.Reference(plumbing.HEAD)
	if err == nil && ref.Type() == plumbing.SymbolicReference {
		return ref.Target()
	}
	return plumbing.Main
}

// remoteHead resolves the remote-tracking head to integrate: the tracking
// ref matching the local branch, else the sole remote-tracking branch.
func (s *Store) remoteHead() (plumbing.Hash, bool) {
	name := plumbing.NewRemoteReferenceName(remoteName, s.branchName().Short())
	if ref, err := s.repo.Reference(name, true); err == nil {
		return ref.Hash(), true
	}
	iter, err := s.repo.References()
	if err != nil {
		return plumbing.ZeroHash, false
	}
	prefix := "refs/remotes/" + remoteName + "/"
	var found []plumbing.Hash
	_ = iter.ForEach(func(r *plumbing.Reference) error {
		if r.Type() == plumbing.HashReference && strings.HasPrefix(r.Name().String(), prefix) {
			found = append(found, r.Hash())
		}
		return nil
	})
	if len(found) == 1 {
		return found[0], true
	}
	return plumbing.ZeroHash, false
}

// resetHard moves the current branch to h and resets index + worktree.
func (s *Store) resetHard(h plumbing.Hash) error {
	wt, err := s.repo.Worktree()
	if err != nil {
		return err
	}
	return wt.Reset(&git.ResetOptions{Commit: h, Mode: git.HardReset})
}

// isSessionPath reports whether p is a session artifact (fork on
// divergence) as opposed to any other artifact (conflict sibling).
func isSessionPath(p string) bool {
	ok, err := path.Match(sessionGlob, p)
	return err == nil && ok
}

// forkSiblingName derives the fork sibling for a diverged session file:
// name minus extension + ".fork-<device>-<UTC timestamp>" + extension,
// e.g. s1.json → s1.fork-dev-b-20260709T121314Z.json (§1.4).
func forkSiblingName(p string, dev registry.DeviceID, t time.Time) string {
	ext := path.Ext(p)
	return strings.TrimSuffix(p, ext) + ".fork-" + string(dev) + "-" + t.UTC().Format(forkTimestamp) + ext
}

// conflictSiblingName derives the sibling for a diverged non-session file.
func conflictSiblingName(p string, dev registry.DeviceID) string {
	return p + ".conflict-" + string(dev)
}

// treeMap flattens a git tree into path → blob hash.
func treeMap(t *object.Tree) map[string]plumbing.Hash {
	m := map[string]plumbing.Hash{}
	if t == nil {
		return m
	}
	_ = t.Files().ForEach(func(f *object.File) error {
		m[f.Name] = f.Hash
		return nil
	})
	return m
}

// changedPaths returns sorted paths present in new with a different blob
// than in old (additions and modifications; deletions excluded).
func changedPaths(old, new map[string]plumbing.Hash) []string {
	var out []string
	for p, h := range new {
		if old[p] != h {
			out = append(out, p)
		}
	}
	sort.Strings(out)
	return out
}

// sortedKeys returns the map's keys in sorted order for deterministic
// staging.
func sortedKeys(m map[string]plumbing.Hash) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
