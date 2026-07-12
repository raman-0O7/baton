package engine

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	git "github.com/go-git/go-git/v5"

	"github.com/raman-0O7/baton/internal/adapters"
	"github.com/raman-0O7/baton/internal/registry"
)

// device is one simulated machine: its own HOME and config.
type device struct {
	t    *testing.T
	home string
}

func newDevice(t *testing.T) *device {
	return &device{t: t, home: t.TempDir()}
}

// use points the process environment at this device. Engines hold absolute
// repo paths, but adapters resolve agent storage from $HOME lazily, so the
// right device must be active around every engine call.
func (d *device) use() {
	d.t.Setenv("HOME", d.home)
	d.t.Setenv("XDG_CONFIG_HOME", filepath.Join(d.home, ".config"))
}

// plantSession copies a fixture transcript into this device's claude-code
// storage for proj, backdating mtime so the active-write guard stays quiet.
func (d *device) plantSession(proj registry.Project, fixture, sessionID string) string {
	d.t.Helper()
	d.use()
	a, err := adapters.Get("claudecode")
	if err != nil {
		d.t.Fatal(err)
	}
	roots, err := a.StorageRoots(proj)
	if err != nil {
		d.t.Fatal(err)
	}
	data, err := os.ReadFile(fixture)
	if err != nil {
		d.t.Fatal(err)
	}
	path := filepath.Join(roots[0], sessionID+".jsonl")
	if err := os.MkdirAll(roots[0], 0o755); err != nil {
		d.t.Fatal(err)
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		d.t.Fatal(err)
	}
	backdate(d.t, path)
	return path
}

func backdate(t *testing.T, path string) {
	t.Helper()
	old := time.Now().Add(-2 * time.Minute)
	if err := os.Chtimes(path, old, old); err != nil {
		t.Fatal(err)
	}
}

// TestM1TwoDeviceSync is the M1 done-criterion: a session created on device
// A continues on device B (different project path), and divergent edits
// fork rather than clobber.
func TestM1TwoDeviceSync(t *testing.T) {
	remoteDir := t.TempDir()
	if _, err := git.PlainInit(remoteDir, true); err != nil {
		t.Fatal(err)
	}

	fixture, err := filepath.Abs("../../testdata/fixtures/claudecode/2026-07/session-tools.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	const sid = "e2e00000-1111-4222-8333-444455556666"

	// --- Device A: init, enable, plant a session, push.
	devA := newDevice(t)
	devA.use()
	engA, err := Init(remoteDir)
	if err != nil {
		t.Fatalf("A init: %v", err)
	}
	projPathA := filepath.Join(devA.home, "work", "myproj")
	if err := os.MkdirAll(projPathA, 0o755); err != nil {
		t.Fatal(err)
	}
	projA, created, err := engA.Enable(projPathA, []string{"claudecode"})
	if err != nil || !created {
		t.Fatalf("A enable: created=%v err=%v", created, err)
	}
	devA.plantSession(projA, fixture, sid)

	rep, err := engA.Push()
	if err != nil {
		t.Fatalf("A push: %v", err)
	}
	if rep.Sessions != 1 || !rep.Committed || !rep.Pushed {
		t.Fatalf("A push report: %+v", rep)
	}

	// --- Device B: init (adopts remote), pull before enable → skip note,
	// enable binds to the existing project by name, pull places the session.
	devB := newDevice(t)
	devB.use()
	engB, err := Init(remoteDir)
	if err != nil {
		t.Fatalf("B init: %v", err)
	}
	pullRep, err := engB.Pull()
	if err != nil {
		t.Fatalf("B pull (unmapped): %v", err)
	}
	if len(pullRep.Placed) != 0 {
		t.Fatalf("unmapped pull must place nothing, got %+v", pullRep)
	}

	projPathB := filepath.Join(devB.home, "somewhere", "else", "myproj") // different path (FR-5)
	if err := os.MkdirAll(projPathB, 0o755); err != nil {
		t.Fatal(err)
	}
	projB, created, err := engB.Enable(projPathB, []string{"claudecode"})
	if err != nil {
		t.Fatalf("B enable: %v", err)
	}
	if created || projB.ID != projA.ID {
		t.Fatalf("B enable must bind to A's project: created=%v idA=%s idB=%s", created, projA.ID, projB.ID)
	}

	pullRep, err = engB.Pull()
	if err != nil {
		t.Fatalf("B pull: %v", err)
	}
	if len(pullRep.Placed) != 1 {
		t.Fatalf("B pull placed = %+v", pullRep)
	}
	a, _ := adapters.Get("claudecode")
	refsB, err := a.ListSessions(projB)
	if err != nil || len(refsB) != 1 || refsB[0].ID != sid {
		t.Fatalf("B agent storage after pull: refs=%+v err=%v", refsB, err)
	}
	sessB, err := a.ReadSession(refsB[0])
	if err != nil {
		t.Fatalf("B read placed session: %v", err)
	}
	if len(sessB.Turns) == 0 || len(sessB.FileOps) == 0 {
		t.Fatalf("placed session lost content: %+v", sessB)
	}

	// --- Divergence: both devices extend the same session, A pushes first.
	pathB := filepath.Join(devB.home, ".claude", "projects")
	entries, err := filepath.Glob(filepath.Join(pathB, "*", sid+".jsonl"))
	if err != nil || len(entries) != 1 {
		t.Fatalf("locate B session file: %v %v", entries, err)
	}
	sessionFileB := entries[0]

	devA.use()
	entries, err = filepath.Glob(filepath.Join(devA.home, ".claude", "projects", "*", sid+".jsonl"))
	if err != nil || len(entries) != 1 {
		t.Fatalf("locate A session file: %v %v", entries, err)
	}
	sessionFileA := entries[0]
	appendLine(t, sessionFileA, `{"type":"last-prompt","leafUuid":"aaaa9999-0000-4000-8000-00000000000a","sessionId":"`+sid+`"}`)
	backdate(t, sessionFileA)
	if _, err := engA.Push(); err != nil {
		t.Fatalf("A push (divergent): %v", err)
	}

	devB.use()
	appendLine(t, sessionFileB, `{"type":"last-prompt","leafUuid":"bbbb9999-0000-4000-8000-00000000000b","sessionId":"`+sid+`"}`)
	backdate(t, sessionFileB)
	pushRep, err := engB.Push()
	if err != nil {
		t.Fatalf("B push (divergent, should auto-integrate): %v", err)
	}
	if pushRep.Integrated == nil || len(pushRep.Integrated.Git.Forks) != 1 {
		t.Fatalf("B push should have integrated a fork: %+v", pushRep)
	}
	fork := pushRep.Integrated.Git.Forks[0]
	if !strings.Contains(fork.ForkPath, ".fork-"+engB.Cfg.DeviceID) {
		t.Fatalf("fork path lacks device marker: %s", fork.ForkPath)
	}

	// Fork must land in B's local storage as a separate session file.
	refsB, err = a.ListSessions(projB)
	if err != nil || len(refsB) != 2 {
		t.Fatalf("B should hold canonical + fork sessions: %+v err=%v", refsB, err)
	}

	// --- A pulls and receives B's preserved timeline without losing its own.
	devA.use()
	backdate(t, sessionFileA)
	pullRep, err = engA.Pull()
	if err != nil {
		t.Fatalf("A pull (fork sibling): %v", err)
	}
	if len(pullRep.Placed) == 0 {
		t.Fatalf("A pull should place the fork sibling: %+v", pullRep)
	}
	refsA, err := a.ListSessions(projA)
	if err != nil || len(refsA) != 2 {
		t.Fatalf("A should hold canonical + fork sessions: %+v err=%v", refsA, err)
	}

	// --- Status sanity on A.
	st, err := engA.Status()
	if err != nil {
		t.Fatalf("A status: %v", err)
	}
	if len(st.Projects) != 1 || st.Projects[0].SyncedCount < 1 || len(st.Projects[0].Forks) != 1 {
		t.Fatalf("A status unexpected: %+v", st.Projects)
	}
}

func appendLine(t *testing.T, path, line string) {
	t.Helper()
	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if _, err := f.WriteString(line + "\n"); err != nil {
		t.Fatal(err)
	}
}
