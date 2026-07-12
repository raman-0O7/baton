package daemon

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	git "github.com/go-git/go-git/v5"
	"github.com/go-git/go-git/v5/plumbing/object"

	"agent-sync/internal/adapters"
	"agent-sync/internal/engine"
)

// countCommits walks HEAD's history and counts commits whose message has
// the given prefix.
func countCommits(t *testing.T, repoPath, prefix string) int {
	t.Helper()
	repo, err := git.PlainOpen(repoPath)
	if err != nil {
		t.Fatal(err)
	}
	head, err := repo.Head()
	if err != nil {
		t.Fatal(err)
	}
	iter, err := repo.Log(&git.LogOptions{From: head.Hash()})
	if err != nil {
		t.Fatal(err)
	}
	n := 0
	err = iter.ForEach(func(c *object.Commit) error {
		if strings.HasPrefix(c.Message, prefix) {
			n++
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return n
}

// TestDaemonCoalescesWrites: a burst of session writes produces ONE commit
// after the settle window, not a commit storm (NFR-2).
func TestDaemonCoalescesWrites(t *testing.T) {
	remoteDir := t.TempDir()
	if _, err := git.PlainInit(remoteDir, true); err != nil {
		t.Fatal(err)
	}
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(home, ".config"))

	eng, err := engine.Init(remoteDir)
	if err != nil {
		t.Fatal(err)
	}
	projPath := filepath.Join(home, "work", "proj")
	if err := os.MkdirAll(projPath, 0o755); err != nil {
		t.Fatal(err)
	}
	proj, _, err := eng.Enable(projPath, []string{"claudecode"})
	if err != nil {
		t.Fatal(err)
	}

	// Storage root must exist before the watcher registers it.
	a, err := adapters.Get("claudecode")
	if err != nil {
		t.Fatal(err)
	}
	roots, err := a.StorageRoots(proj)
	if err != nil {
		t.Fatal(err)
	}
	root := roots[0]
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- Run(ctx, eng, Options{Debounce: 500 * time.Millisecond, Rescan: time.Hour}) }()
	time.Sleep(300 * time.Millisecond) // let the watcher arm

	// Burst: 10 rapid writes to one session file (simulates a streaming
	// turn), then age the file past the engine's active-write guard before
	// the debounce fires.
	fixture, err := os.ReadFile("../../testdata/fixtures/claudecode/2026-07/session-basic.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(root, "aaaa0000-0000-4000-8000-000000000001.jsonl")
	for i := 0; i < 10; i++ {
		if err := os.WriteFile(target, fixture, 0o600); err != nil {
			t.Fatal(err)
		}
		time.Sleep(20 * time.Millisecond)
	}
	old := time.Now().Add(-2 * time.Minute)
	if err := os.Chtimes(target, old, old); err != nil {
		t.Fatal(err)
	}
	time.Sleep(1200 * time.Millisecond)

	cancel()
	if err := <-done; err != nil {
		t.Fatalf("daemon exited with error: %v", err)
	}

	if n := countCommits(t, eng.Cfg.RepoPath, "sync: push from"); n != 1 {
		t.Fatalf("expected exactly 1 auto-commit, got %d", n)
	}
}

// TestIgnorable covers the noise filter.
func TestIgnorable(t *testing.T) {
	cases := map[string]bool{
		"/x/session.jsonl":                 false,
		"/x/.hidden":                       true,
		"/x/file.jsonl.bak-20260709":       true,
		"/x/.agent-sync-tmp123":            true,
		"/x/file.tmp":                      true,
		"/x/editor-swap~":                  true,
		"/x/rollout-2026-07-09-uuid.jsonl": false,
	}
	for path, want := range cases {
		if got := ignorable(path); got != want {
			t.Errorf("ignorable(%q) = %v, want %v", path, got, want)
		}
	}
}
