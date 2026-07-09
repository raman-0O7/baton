package gitstore_test

import (
	"errors"
	"io/fs"
	"path/filepath"
	"reflect"
	"regexp"
	"testing"

	git "github.com/go-git/go-git/v5"
	"github.com/go-git/go-git/v5/plumbing"
	"github.com/go-git/go-git/v5/plumbing/object"

	"agent-sync/internal/gitstore"
	"agent-sync/internal/registry"
	"agent-sync/internal/scrub"
)

// newBareOrigin creates the temp bare repo standing in for the user's git
// remote. go-git defaults bare HEAD to master; point it at main to match
// the branch our stores create.
func newBareOrigin(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	repo, err := git.PlainInit(dir, true)
	if err != nil {
		t.Fatalf("init bare origin: %v", err)
	}
	if err := repo.Storer.SetReference(plumbing.NewSymbolicReference(plumbing.HEAD, plumbing.Main)); err != nil {
		t.Fatalf("set origin HEAD: %v", err)
	}
	return dir
}

func newStore(t *testing.T, remoteURL string, dev registry.DeviceID) *gitstore.Store {
	t.Helper()
	s, err := gitstore.InitOrOpen(filepath.Join(t.TempDir(), "repo"), remoteURL, dev)
	if err != nil {
		t.Fatalf("InitOrOpen(%s): %v", dev, err)
	}
	return s
}

func mustScrub(t *testing.T, data string) scrub.Result {
	t.Helper()
	res, err := scrub.Scrub([]byte(data), scrub.Policy{})
	if err != nil {
		t.Fatalf("scrub: %v", err)
	}
	return res
}

// stageCommit stages content at rel and commits, asserting work happened.
func stageCommit(t *testing.T, s *gitstore.Store, rel, content, msg string) {
	t.Helper()
	if err := s.StageArtifact(rel, mustScrub(t, content)); err != nil {
		t.Fatalf("stage %s: %v", rel, err)
	}
	staged, err := s.Commit(msg)
	if err != nil {
		t.Fatalf("commit %q: %v", msg, err)
	}
	if !staged {
		t.Fatalf("commit %q: nothing staged", msg)
	}
}

func readString(t *testing.T, s *gitstore.Store, rel string) string {
	t.Helper()
	data, err := s.ReadArtifact(rel)
	if err != nil {
		t.Fatalf("read %s: %v", rel, err)
	}
	return string(data)
}

// headCommit opens the store's clone directly with go-git and returns its
// HEAD commit, so tests can assert on raw history (parents, hashes).
func headCommit(t *testing.T, s *gitstore.Store) *object.Commit {
	t.Helper()
	repo, err := git.PlainOpen(s.RepoPath())
	if err != nil {
		t.Fatalf("open %s: %v", s.RepoPath(), err)
	}
	ref, err := repo.Head()
	if err != nil {
		t.Fatalf("head of %s: %v", s.RepoPath(), err)
	}
	c, err := repo.CommitObject(ref.Hash())
	if err != nil {
		t.Fatalf("head commit of %s: %v", s.RepoPath(), err)
	}
	return c
}

// TestTwoDeviceForkE2E is the core P2 acceptance test: two clones simulate
// two devices editing the same session file; the divergence must be
// preserved as a fork sibling on both devices with nothing lost (FR-6).
func TestTwoDeviceForkE2E(t *testing.T) {
	t.Parallel()
	origin := newBareOrigin(t)
	const rel = "projects/p1/sessions/claudecode/s1.json"
	const base = `{"v":"base"}`
	const vA = `{"v":"edited-on-device-a"}`
	const vB = `{"v":"edited-on-device-b"}`

	// Device A: empty remote → init fallback, seed origin.
	a := newStore(t, origin, "dev-a")
	if err := a.Push(); err != nil {
		t.Fatalf("A initial push: %v", err)
	}
	stageCommit(t, a, rel, base, "A: add s1")
	if err := a.Push(); err != nil {
		t.Fatalf("A push s1: %v", err)
	}

	// Device B: clones via InitOrOpen and sees A's content.
	b := newStore(t, origin, "dev-b")
	rep, err := b.Pull()
	if err != nil {
		t.Fatalf("B pull (fresh clone): %v", err)
	}
	if rep.FastForward || len(rep.Forks) != 0 || len(rep.Conflicts) != 0 || len(rep.NewPaths) != 0 {
		t.Fatalf("B pull after clone: want no-op report, got %+v", rep)
	}
	if got := readString(t, b, rel); got != base {
		t.Fatalf("B sees %q, want %q", got, base)
	}

	// Divergence: both devices edit the same session.
	stageCommit(t, a, rel, vA, "A: edit s1")
	stageCommit(t, b, rel, vB, "B: edit s1")
	if err := a.Push(); err != nil {
		t.Fatalf("A push edit: %v", err)
	}

	aHead := headCommit(t, a).Hash
	bHeadBefore := headCommit(t, b).Hash

	// B pulls → fork-on-conflict merge.
	rep, err = b.Pull()
	if err != nil {
		t.Fatalf("B pull (diverged): %v", err)
	}
	if rep.FastForward {
		t.Fatal("diverged pull must not be a fast-forward")
	}
	if len(rep.Conflicts) != 0 {
		t.Fatalf("unexpected conflicts: %v", rep.Conflicts)
	}
	if len(rep.Forks) != 1 {
		t.Fatalf("want 1 fork, got %+v", rep.Forks)
	}
	fork := rep.Forks[0]
	if fork.Original != rel {
		t.Fatalf("fork original = %q, want %q", fork.Original, rel)
	}
	wantFork := regexp.MustCompile(`^projects/p1/sessions/claudecode/s1\.fork-dev-b-\d{8}T\d{6}Z\.json$`)
	if !wantFork.MatchString(fork.ForkPath) {
		t.Fatalf("fork path %q does not match %s", fork.ForkPath, wantFork)
	}
	// Canonical filename keeps the remote (A) bytes; local (B) bytes live
	// in the fork sibling.
	if got := readString(t, b, rel); got != vA {
		t.Fatalf("canonical after merge = %q, want remote version %q", got, vA)
	}
	if got := readString(t, b, fork.ForkPath); got != vB {
		t.Fatalf("fork sibling = %q, want local version %q", got, vB)
	}
	if len(rep.NewPaths) != 0 {
		t.Fatalf("NewPaths should exclude forked paths, got %v", rep.NewPaths)
	}

	// The merge commit records both timelines as parents.
	merge := headCommit(t, b)
	if len(merge.ParentHashes) != 2 {
		t.Fatalf("merge commit has %d parents, want 2", len(merge.ParentHashes))
	}
	parents := map[plumbing.Hash]bool{merge.ParentHashes[0]: true, merge.ParentHashes[1]: true}
	if !parents[bHeadBefore] || !parents[aHead] {
		t.Fatalf("merge parents %v, want {%s, %s}", merge.ParentHashes, bHeadBefore, aHead)
	}

	// Round-trip: B pushes the merge, A fast-forwards onto it. Converged,
	// nothing lost.
	if err := b.Push(); err != nil {
		t.Fatalf("B push merge: %v", err)
	}
	repA, err := a.Pull()
	if err != nil {
		t.Fatalf("A pull merge: %v", err)
	}
	if !repA.FastForward {
		t.Fatalf("A pull should fast-forward onto the merge, got %+v", repA)
	}
	if len(repA.Forks) != 0 || len(repA.Conflicts) != 0 {
		t.Fatalf("A fast-forward must not re-detect forks: %+v", repA)
	}
	if got := readString(t, a, rel); got != vA {
		t.Fatalf("A canonical = %q, want %q", got, vA)
	}
	if got := readString(t, a, fork.ForkPath); got != vB {
		t.Fatalf("A fork sibling = %q, want %q", got, vB)
	}
	found := false
	for _, p := range repA.NewPaths {
		if p == fork.ForkPath {
			found = true
		}
	}
	if !found {
		t.Fatalf("A NewPaths %v missing fork sibling %s", repA.NewPaths, fork.ForkPath)
	}

	// Both devices agree on the full artifact set.
	pathsA, err := a.PathsUnder("projects")
	if err != nil {
		t.Fatalf("A PathsUnder: %v", err)
	}
	pathsB, err := b.PathsUnder("projects")
	if err != nil {
		t.Fatalf("B PathsUnder: %v", err)
	}
	want := []string{fork.ForkPath, rel}
	if !reflect.DeepEqual(pathsA, want) || !reflect.DeepEqual(pathsB, want) {
		t.Fatalf("converged paths mismatch:\n  A: %v\n  B: %v\n  want: %v", pathsA, pathsB, want)
	}
}

// TestFastForwardPull: no divergence → FastForward true, no forks.
func TestFastForwardPull(t *testing.T) {
	t.Parallel()
	origin := newBareOrigin(t)
	const rel = "projects/p1/sessions/claudecode/s2.json"
	const content = `{"v":"only-from-a"}`

	a := newStore(t, origin, "dev-a")
	if err := a.Push(); err != nil {
		t.Fatalf("A initial push: %v", err)
	}
	b := newStore(t, origin, "dev-b") // clone at the initial commit

	stageCommit(t, a, rel, content, "A: add s2")
	if err := a.Push(); err != nil {
		t.Fatalf("A push: %v", err)
	}

	rep, err := b.Pull()
	if err != nil {
		t.Fatalf("B pull: %v", err)
	}
	if !rep.FastForward {
		t.Fatalf("want fast-forward, got %+v", rep)
	}
	if len(rep.Forks) != 0 || len(rep.Conflicts) != 0 {
		t.Fatalf("fast-forward must not fork/conflict: %+v", rep)
	}
	if !reflect.DeepEqual(rep.NewPaths, []string{rel}) {
		t.Fatalf("NewPaths = %v, want [%s]", rep.NewPaths, rel)
	}
	if got := readString(t, b, rel); got != content {
		t.Fatalf("B content = %q, want %q", got, content)
	}
	if len(headCommit(t, b).ParentHashes) != 1 {
		t.Fatal("fast-forward must not create a merge commit")
	}
}

// TestNonSessionConflict: both-changed paths outside projects/*/sessions/*/*
// keep the remote version canonical and save the local one as a
// ".conflict-<device>" sibling.
func TestNonSessionConflict(t *testing.T) {
	t.Parallel()
	origin := newBareOrigin(t)
	const rel = "devices/shared.toml"
	const base = "v = \"base\"\n"
	const vA = "v = \"a\"\n"
	const vB = "v = \"b\"\n"

	a := newStore(t, origin, "dev-a")
	if err := a.Push(); err != nil {
		t.Fatalf("A initial push: %v", err)
	}
	stageCommit(t, a, rel, base, "A: add shared")
	if err := a.Push(); err != nil {
		t.Fatalf("A push shared: %v", err)
	}

	b := newStore(t, origin, "dev-b")
	stageCommit(t, a, rel, vA, "A: edit shared")
	stageCommit(t, b, rel, vB, "B: edit shared")
	if err := a.Push(); err != nil {
		t.Fatalf("A push edit: %v", err)
	}

	rep, err := b.Pull()
	if err != nil {
		t.Fatalf("B pull: %v", err)
	}
	if len(rep.Forks) != 0 {
		t.Fatalf("non-session path must not fork: %+v", rep.Forks)
	}
	if !reflect.DeepEqual(rep.Conflicts, []string{rel}) {
		t.Fatalf("Conflicts = %v, want [%s]", rep.Conflicts, rel)
	}
	if got := readString(t, b, rel); got != vA {
		t.Fatalf("canonical = %q, want remote version %q", got, vA)
	}
	sibling := rel + ".conflict-dev-b"
	if got := readString(t, b, sibling); got != vB {
		t.Fatalf("conflict sibling %s = %q, want local version %q", sibling, got, vB)
	}
	if len(headCommit(t, b).ParentHashes) != 2 {
		t.Fatal("conflict merge must carry both parents")
	}
}

// TestNoRemote: Push and Pull surface the typed sentinel when origin is
// missing.
func TestNoRemote(t *testing.T) {
	t.Parallel()
	s := newStore(t, "", "dev-x")
	if err := s.Push(); !errors.Is(err, gitstore.ErrNoRemote) {
		t.Fatalf("Push err = %v, want ErrNoRemote", err)
	}
	if _, err := s.Pull(); !errors.Is(err, gitstore.ErrNoRemote) {
		t.Fatalf("Pull err = %v, want ErrNoRemote", err)
	}
}

// TestEmptyRemotePullNoop: origin exists but has no commits → Pull is a
// clean no-op.
func TestEmptyRemotePullNoop(t *testing.T) {
	t.Parallel()
	origin := newBareOrigin(t)
	s := newStore(t, origin, "dev-x")
	rep, err := s.Pull()
	if err != nil {
		t.Fatalf("pull from empty remote: %v", err)
	}
	if rep.FastForward || len(rep.Forks) != 0 || len(rep.Conflicts) != 0 || len(rep.NewPaths) != 0 {
		t.Fatalf("want no-op report, got %+v", rep)
	}
}

// TestInitWritesSyncRepoMeta: first init commits syncrepo.toml with format
// version 1; reopening does not re-init.
func TestInitWritesSyncRepoMeta(t *testing.T) {
	t.Parallel()
	dir := filepath.Join(t.TempDir(), "repo")
	s, err := gitstore.InitOrOpen(dir, "", "dev-x")
	if err != nil {
		t.Fatalf("init: %v", err)
	}
	meta := readString(t, s, "syncrepo.toml")
	if !regexp.MustCompile(`format\s*=\s*"1"`).MatchString(meta) {
		t.Fatalf("syncrepo.toml missing format version: %q", meta)
	}
	firstHead := headCommit(t, s).Hash

	s2, err := gitstore.InitOrOpen(dir, "", "dev-x")
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	if headCommit(t, s2).Hash != firstHead {
		t.Fatal("reopening an existing repo must not create commits")
	}
}

// TestCommitSkipsWhenNothingStaged and removal round-trip.
func TestCommitSkipAndRemoval(t *testing.T) {
	t.Parallel()
	s := newStore(t, "", "dev-x")

	staged, err := s.Commit("empty")
	if err != nil {
		t.Fatalf("empty commit: %v", err)
	}
	if staged {
		t.Fatal("Commit reported staged work on a clean tree")
	}

	const rel = "projects/p1/sessions/claudecode/tmp.json"
	stageCommit(t, s, rel, `{}`, "add tmp")

	// Re-staging identical content stages nothing new.
	if err := s.StageArtifact(rel, mustScrub(t, `{}`)); err != nil {
		t.Fatalf("restage: %v", err)
	}
	if staged, err = s.Commit("identical"); err != nil || staged {
		t.Fatalf("identical restage: staged=%v err=%v, want false,nil", staged, err)
	}

	if err := s.StageRemoval(rel); err != nil {
		t.Fatalf("stage removal: %v", err)
	}
	if staged, err = s.Commit("remove tmp"); err != nil || !staged {
		t.Fatalf("removal commit: staged=%v err=%v, want true,nil", staged, err)
	}
	if _, err := s.ReadArtifact(rel); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("read after removal: err = %v, want fs.ErrNotExist", err)
	}
	paths, err := s.PathsUnder("projects")
	if err != nil {
		t.Fatalf("PathsUnder: %v", err)
	}
	if len(paths) != 0 {
		t.Fatalf("paths after removal = %v, want none", paths)
	}
}

// TestStageArtifactPathValidation: the write chokepoint refuses escapes.
func TestStageArtifactPathValidation(t *testing.T) {
	t.Parallel()
	s := newStore(t, "", "dev-x")
	for _, bad := range []string{"", ".", "..", "../evil", "a/../../evil", "/abs/path", ".git/config"} {
		if err := s.StageArtifact(bad, mustScrub(t, "x")); err == nil {
			t.Errorf("StageArtifact(%q) accepted an invalid path", bad)
		}
	}
}
