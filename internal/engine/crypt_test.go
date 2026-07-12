package engine

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	git "github.com/go-git/go-git/v5"

	"github.com/raman-0O7/baton/internal/adapters"
	"github.com/raman-0O7/baton/internal/crypt"
)

// TestEncryptedPushPull: with encryption on, session artifacts in the sync
// repo are age ciphertexts (remote host learns nothing), and a device
// holding the identity decrypts on pull.
func TestEncryptedPushPull(t *testing.T) {
	remoteDir := t.TempDir()
	if _, err := git.PlainInit(remoteDir, true); err != nil {
		t.Fatal(err)
	}
	fixture, err := filepath.Abs("../../testdata/fixtures/claudecode/2026-07/session-tools.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	const sid = "e2ecrypt-1111-4222-8333-444455556666"

	// Device A with encryption enabled.
	devA := newDevice(t)
	devA.use()
	engA, err := Init(remoteDir)
	if err != nil {
		t.Fatal(err)
	}
	recipient, err := EnableEncryption()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(recipient, "age1") {
		t.Fatalf("recipient = %q", recipient)
	}
	// Re-open to pick up the saved config.
	engA, err = Open()
	if err != nil {
		t.Fatal(err)
	}
	if !engA.Cfg.Encrypt {
		t.Fatal("config did not persist Encrypt")
	}

	projPath := filepath.Join(devA.home, "work", "secretproj")
	if err := os.MkdirAll(projPath, 0o755); err != nil {
		t.Fatal(err)
	}
	proj, _, err := engA.Enable(projPath, []string{"claudecode"})
	if err != nil {
		t.Fatal(err)
	}
	devA.plantSession(proj, fixture, sid)
	if _, err := engA.Push(); err != nil {
		t.Fatalf("A push: %v", err)
	}

	// The staged artifact must be an age ciphertext with no plaintext leak.
	artifact := filepath.Join(engA.Cfg.RepoPath, "projects", string(proj.ID), "sessions", "claudecode", sid+".json")
	data, err := os.ReadFile(artifact)
	if err != nil {
		t.Fatal(err)
	}
	if !crypt.IsEncrypted(data) {
		t.Fatal("artifact is not encrypted")
	}
	if strings.Contains(string(data), "greet.go") {
		t.Fatal("plaintext visible in encrypted artifact")
	}

	// Same device, wiped local claude storage → pull restores the session
	// by decrypting with the local identity.
	slug := filepath.Join(devA.home, ".claude", "projects")
	if err := os.RemoveAll(slug); err != nil {
		t.Fatal(err)
	}
	rep, err := engA.Pull()
	if err != nil {
		t.Fatalf("pull: %v", err)
	}
	if len(rep.Placed) != 1 {
		t.Fatalf("pull placed = %+v", rep)
	}
	a, _ := adapters.Get("claudecode")
	refs, err := a.ListSessions(proj)
	if err != nil || len(refs) != 1 {
		t.Fatalf("restored refs: %+v err=%v", refs, err)
	}
	s, err := a.ReadSession(refs[0])
	if err != nil || len(s.Turns) == 0 {
		t.Fatalf("restored session unreadable: %+v err=%v", s, err)
	}

	// A device WITHOUT the identity skips gracefully, never crashes.
	devB := newDevice(t)
	devB.use()
	engB, err := Init(remoteDir)
	if err != nil {
		t.Fatal(err)
	}
	projPathB := filepath.Join(devB.home, "elsewhere", "secretproj")
	if err := os.MkdirAll(projPathB, 0o755); err != nil {
		t.Fatal(err)
	}
	if _, _, err := engB.Enable(projPathB, []string{"claudecode"}); err != nil {
		t.Fatal(err)
	}
	repB, err := engB.Pull()
	if err != nil {
		t.Fatalf("B pull must not fail on undecryptable artifacts: %v", err)
	}
	if len(repB.Placed) != 0 || len(repB.Skipped) == 0 {
		t.Fatalf("B without identity: %+v", repB)
	}
}
