package registry

import (
	"io/fs"
	"sort"
	"strings"
	"testing"

	"github.com/raman-0O7/baton/internal/scrub"
)

// fakeBackend is an in-memory Backend for unit tests.
type fakeBackend struct {
	files map[string][]byte
}

func newFakeBackend() *fakeBackend { return &fakeBackend{files: map[string][]byte{}} }

func (f *fakeBackend) StageArtifact(relPath string, r scrub.Result) error {
	f.files[relPath] = r.Data()
	return nil
}

func (f *fakeBackend) ReadArtifact(relPath string) ([]byte, error) {
	data, ok := f.files[relPath]
	if !ok {
		return nil, fs.ErrNotExist
	}
	return data, nil
}

func (f *fakeBackend) PathsUnder(prefix string) ([]string, error) {
	var out []string
	for p := range f.files {
		if strings.HasPrefix(p, prefix) {
			out = append(out, p)
		}
	}
	sort.Strings(out)
	return out, nil
}

func TestDeviceAndProjectLifecycle(t *testing.T) {
	r := New(newFakeBackend())

	if err := r.EnsureDevice("dev-a", "hostA", "darwin"); err != nil {
		t.Fatalf("EnsureDevice: %v", err)
	}
	if err := r.EnsureDevice("dev-b", "hostB", "linux"); err != nil {
		t.Fatalf("EnsureDevice dev-b: %v", err)
	}

	proj, err := r.EnableProject("myapp", []string{"claudecode"})
	if err != nil {
		t.Fatalf("EnableProject: %v", err)
	}
	if proj.ID == "" || proj.Name != "myapp" {
		t.Fatalf("unexpected project: %+v", proj)
	}

	// Same project, different absolute path per device (FR-5).
	if err := r.SetPath("dev-a", proj.ID, "/Volumes/ext/code/myapp"); err != nil {
		t.Fatalf("SetPath dev-a: %v", err)
	}
	if err := r.SetPath("dev-b", proj.ID, "/home/user/myapp"); err != nil {
		t.Fatalf("SetPath dev-b: %v", err)
	}

	pa, err := r.ProjectsForDevice("dev-a")
	if err != nil {
		t.Fatalf("ProjectsForDevice dev-a: %v", err)
	}
	if len(pa) != 1 || pa[0].Path != "/Volumes/ext/code/myapp" || pa[0].ID != proj.ID {
		t.Fatalf("dev-a projects wrong: %+v", pa)
	}
	pb, err := r.ProjectsForDevice("dev-b")
	if err != nil {
		t.Fatalf("ProjectsForDevice dev-b: %v", err)
	}
	if len(pb) != 1 || pb[0].Path != "/home/user/myapp" {
		t.Fatalf("dev-b projects wrong: %+v", pb)
	}

	got, ok, err := r.LookupByPath("dev-b", "/home/user/myapp/")
	if err != nil || !ok {
		t.Fatalf("LookupByPath: ok=%v err=%v", ok, err)
	}
	if got.ID != proj.ID || len(got.Agents) != 1 || got.Agents[0] != "claudecode" {
		t.Fatalf("LookupByPath project wrong: %+v", got)
	}
	if _, ok, _ := r.LookupByPath("dev-b", "/nope"); ok {
		t.Fatal("LookupByPath matched a path that was never mapped")
	}
}

func TestEnsureDeviceIdempotentKeepsPathMap(t *testing.T) {
	r := New(newFakeBackend())
	if err := r.EnsureDevice("dev-a", "hostA", "darwin"); err != nil {
		t.Fatal(err)
	}
	proj, err := r.EnableProject("p", nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := r.SetPath("dev-a", proj.ID, "/x/y"); err != nil {
		t.Fatal(err)
	}
	// Re-registering must not wipe the path map.
	if err := r.EnsureDevice("dev-a", "hostA-renamed", "darwin"); err != nil {
		t.Fatal(err)
	}
	ps, err := r.ProjectsForDevice("dev-a")
	if err != nil {
		t.Fatal(err)
	}
	if len(ps) != 1 || ps[0].Path != "/x/y" {
		t.Fatalf("path map lost after re-EnsureDevice: %+v", ps)
	}
}

func TestErrorsAndValidation(t *testing.T) {
	r := New(newFakeBackend())

	if err := r.EnsureDevice("", "h", "o"); err == nil {
		t.Fatal("empty device ID accepted")
	}
	if _, err := r.EnableProject("", nil); err == nil {
		t.Fatal("empty project name accepted")
	}

	if err := r.EnsureDevice("dev-a", "h", "darwin"); err != nil {
		t.Fatal(err)
	}
	proj, err := r.EnableProject("p", nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := r.SetPath("dev-a", proj.ID, "relative/path"); err == nil {
		t.Fatal("relative path accepted")
	}
	if err := r.SetPath("dev-a", "not-enabled", "/abs"); err == nil {
		t.Fatal("SetPath for unknown project accepted")
	}
	if err := r.SetPath("ghost", proj.ID, "/abs"); err == nil {
		t.Fatal("SetPath for unregistered device accepted")
	}
	if _, err := r.ProjectsForDevice("ghost"); err == nil {
		t.Fatal("ProjectsForDevice for unregistered device accepted")
	}
}
