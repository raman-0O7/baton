// Package gitstore wraps go-git around the local sync-repo clone (§1.4).
// It is the only component that writes into the sync repo, and its write
// entrypoint StageArtifact requires a scrub.Result — making it a
// compile-time error to commit unscrubbed data (SR-1, §1.1).
//
// Conflict handling implements fork-on-conflict (FR-6): divergent histories
// are merged mechanically with the remote side keeping every canonical
// filename and the local side preserved as fork/conflict siblings. No data
// is ever lost and nothing blocks on locks.
package gitstore

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"time"

	git "github.com/go-git/go-git/v5"
	"github.com/go-git/go-git/v5/config"
	"github.com/go-git/go-git/v5/plumbing"
	"github.com/go-git/go-git/v5/plumbing/object"
	"github.com/go-git/go-git/v5/plumbing/transport"

	"agent-sync/internal/registry"
	"agent-sync/internal/scrub"
)

// ErrNoRemote is returned by Push and Pull when no "origin" remote is
// configured on the local sync repo.
var ErrNoRemote = errors.New("gitstore: no origin remote configured")

const (
	remoteName = "origin"
	// syncRepoMeta is committed on first init (repo format version "1").
	syncRepoMetaPath = "syncrepo.toml"
	syncRepoMetaBody = "# agent-sync sync-repo metadata. Do not edit by hand.\nformat = \"1\"\n"
)

// Store is bound to the local sync-repo clone at repoPath and knows which
// device it acts for (used in fork/conflict sibling naming and commit
// signatures).
type Store struct {
	repo     *git.Repository
	repoPath string
	device   registry.DeviceID
}

// Compile-time proof that *Store satisfies the registry persistence backend.
var _ registry.Backend = (*Store)(nil)

// InitOrOpen binds a Store to repoPath, creating the clone if needed:
//
//  1. an existing repository at repoPath is opened as-is;
//  2. otherwise, when remoteURL is set and non-empty, the remote is cloned;
//  3. otherwise a fresh repository is initialized (default branch "main"),
//     with origin configured when remoteURL != "". A fresh repository gets
//     syncrepo.toml (format version "1") written and committed.
func InitOrOpen(repoPath, remoteURL string, device registry.DeviceID) (*Store, error) {
	if device == "" {
		return nil, errors.New("gitstore: device ID must not be empty")
	}
	if err := os.MkdirAll(repoPath, 0o755); err != nil {
		return nil, fmt.Errorf("gitstore: create repo dir: %w", err)
	}

	repo, err := git.PlainOpen(repoPath)
	if err == nil {
		return &Store{repo: repo, repoPath: repoPath, device: device}, nil
	}
	if !errors.Is(err, git.ErrRepositoryNotExists) {
		return nil, fmt.Errorf("gitstore: open %s: %w", repoPath, err)
	}

	if remoteURL != "" {
		repo, err = git.PlainClone(repoPath, false, &git.CloneOptions{
			URL:        remoteURL,
			RemoteName: remoteName,
		})
		if err == nil {
			return &Store{repo: repo, repoPath: repoPath, device: device}, nil
		}
		if !errors.Is(err, transport.ErrEmptyRemoteRepository) {
			return nil, fmt.Errorf("gitstore: clone %s: %w", remoteURL, err)
		}
		// Remote exists but is empty: fall through to a fresh init that
		// will seed it on first push.
	}

	repo, err = git.PlainInitWithOptions(repoPath, &git.PlainInitOptions{
		InitOptions: git.InitOptions{DefaultBranch: plumbing.Main},
	})
	if errors.Is(err, git.ErrRepositoryAlreadyExists) {
		// A failed clone attempt may have left an initialized repo behind.
		repo, err = git.PlainOpen(repoPath)
	}
	if err != nil {
		return nil, fmt.Errorf("gitstore: init %s: %w", repoPath, err)
	}

	if remoteURL != "" {
		_, err = repo.CreateRemote(&config.RemoteConfig{
			Name:  remoteName,
			URLs:  []string{remoteURL},
			Fetch: []config.RefSpec{config.RefSpec("+refs/heads/*:refs/remotes/" + remoteName + "/*")},
		})
		if err != nil && !errors.Is(err, git.ErrRemoteExists) {
			return nil, fmt.Errorf("gitstore: configure origin: %w", err)
		}
	}

	s := &Store{repo: repo, repoPath: repoPath, device: device}
	if _, err := repo.Head(); errors.Is(err, plumbing.ErrReferenceNotFound) {
		if err := s.writeInitialCommit(); err != nil {
			return nil, err
		}
	}
	return s, nil
}

// writeInitialCommit stages and commits syncrepo.toml on a freshly
// initialized (empty-history) repository.
func (s *Store) writeInitialCommit() error {
	res, err := scrub.Scrub([]byte(syncRepoMetaBody), scrub.Policy{})
	if err != nil {
		return fmt.Errorf("gitstore: scrub repo metadata: %w", err)
	}
	if err := s.StageArtifact(syncRepoMetaPath, res); err != nil {
		return err
	}
	staged, err := s.Commit("agent-sync: initialize sync repo (format version 1)")
	if err != nil {
		return err
	}
	if !staged {
		return errors.New("gitstore: initial commit staged nothing")
	}
	return nil
}

// RepoPath returns the local clone's root directory.
func (s *Store) RepoPath() string { return s.repoPath }

// Device returns the device this store acts for.
func (s *Store) Device() registry.DeviceID { return s.device }

// StageArtifact writes scrubbed data at relPath inside the worktree
// (creating parent directories) and adds it to the index. It is the ONLY
// write path into the sync repo: requiring scrub.Result makes committing
// unscrubbed bytes a compile-time error.
func (s *Store) StageArtifact(relPath string, r scrub.Result) error {
	rel, full, err := s.paths(relPath)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		return fmt.Errorf("gitstore: create dirs for %s: %w", rel, err)
	}
	if err := os.WriteFile(full, r.Data(), 0o644); err != nil {
		return fmt.Errorf("gitstore: write %s: %w", rel, err)
	}
	wt, err := s.repo.Worktree()
	if err != nil {
		return err
	}
	if _, err := wt.Add(rel); err != nil {
		return fmt.Errorf("gitstore: stage %s: %w", rel, err)
	}
	return nil
}

// StageRemoval removes relPath from both the worktree and the index
// (equivalent of `git rm`).
func (s *Store) StageRemoval(relPath string) error {
	rel, _, err := s.paths(relPath)
	if err != nil {
		return err
	}
	wt, err := s.repo.Worktree()
	if err != nil {
		return err
	}
	if _, err := wt.Remove(rel); err != nil {
		return fmt.Errorf("gitstore: remove %s: %w", rel, err)
	}
	return nil
}

// Commit commits everything staged. When nothing is staged it skips
// cleanly, returning staged == false and no error.
func (s *Store) Commit(msg string) (staged bool, err error) {
	wt, err := s.repo.Worktree()
	if err != nil {
		return false, err
	}
	status, err := wt.Status()
	if err != nil {
		return false, fmt.Errorf("gitstore: status: %w", err)
	}
	for _, fst := range status {
		if fst.Staging != git.Unmodified && fst.Staging != git.Untracked {
			staged = true
			break
		}
	}
	if !staged {
		return false, nil
	}
	if _, err := wt.Commit(msg, &git.CommitOptions{Author: s.signature()}); err != nil {
		return false, fmt.Errorf("gitstore: commit: %w", err)
	}
	return true, nil
}

// Push pushes local branches to origin. Returns ErrNoRemote when origin is
// not configured; being already up to date is not an error.
func (s *Store) Push() error {
	err := s.repo.Push(&git.PushOptions{RemoteName: remoteName})
	switch {
	case err == nil, errors.Is(err, git.NoErrAlreadyUpToDate):
		return nil
	case errors.Is(err, git.ErrRemoteNotFound):
		return ErrNoRemote
	default:
		return fmt.Errorf("gitstore: push: %w", err)
	}
}

// ReadArtifact returns the current worktree content at relPath (staged
// writes included). The error satisfies errors.Is(err, fs.ErrNotExist)
// when the artifact does not exist.
func (s *Store) ReadArtifact(relPath string) ([]byte, error) {
	_, full, err := s.paths(relPath)
	if err != nil {
		return nil, err
	}
	return os.ReadFile(full)
}

// PathsUnder lists all artifact paths (slash-separated, repo-relative)
// under the given directory prefix, sorted. A missing prefix yields an
// empty list; an empty prefix lists the whole repo (minus .git).
func (s *Store) PathsUnder(prefix string) ([]string, error) {
	root := s.repoPath
	if prefix != "" && prefix != "." {
		rel, full, err := s.paths(prefix)
		if err != nil {
			return nil, err
		}
		info, err := os.Stat(full)
		if errors.Is(err, fs.ErrNotExist) {
			return nil, nil
		}
		if err != nil {
			return nil, err
		}
		if !info.IsDir() {
			return []string{rel}, nil
		}
		root = full
	}
	var out []string
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if d.Name() == git.GitDirName {
				return filepath.SkipDir
			}
			return nil
		}
		rel, err := filepath.Rel(s.repoPath, p)
		if err != nil {
			return err
		}
		out = append(out, filepath.ToSlash(rel))
		return nil
	})
	if err != nil {
		return nil, err
	}
	sort.Strings(out)
	return out, nil
}

// paths validates relPath and returns its cleaned slash form plus the
// absolute filesystem location inside the worktree.
func (s *Store) paths(relPath string) (rel, full string, err error) {
	if relPath == "" {
		return "", "", errors.New("gitstore: empty artifact path")
	}
	rel = path.Clean(filepath.ToSlash(relPath))
	if path.IsAbs(rel) || rel == "." || rel == ".." || strings.HasPrefix(rel, "../") {
		return "", "", fmt.Errorf("gitstore: artifact path %q escapes repo", relPath)
	}
	if rel == git.GitDirName || strings.HasPrefix(rel, git.GitDirName+"/") {
		return "", "", fmt.Errorf("gitstore: artifact path %q targets the git dir", relPath)
	}
	return rel, filepath.Join(s.repoPath, filepath.FromSlash(rel)), nil
}

// signature identifies this device as commit author.
func (s *Store) signature() *object.Signature {
	return &object.Signature{
		Name:  "agent-sync (" + string(s.device) + ")",
		Email: string(s.device) + "@agent-sync.local",
		When:  time.Now(),
	}
}

// blobBytes reads the full content of a blob object.
func (s *Store) blobBytes(h plumbing.Hash) ([]byte, error) {
	blob, err := s.repo.BlobObject(h)
	if err != nil {
		return nil, err
	}
	r, err := blob.Reader()
	if err != nil {
		return nil, err
	}
	defer r.Close()
	return io.ReadAll(r)
}
