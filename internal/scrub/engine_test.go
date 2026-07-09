package scrub

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math/rand"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"agent-sync/internal/model"
)

type seed struct {
	Literal string        `json:"literal"`
	Type    RedactionType `json:"type"`
}

func loadManifest(t *testing.T) map[string][]seed {
	t.Helper()
	data, err := os.ReadFile("testdata/seeded/manifest.json")
	if err != nil {
		t.Fatal(err)
	}
	var m map[string][]seed
	if err := json.Unmarshal(data, &m); err != nil {
		t.Fatal(err)
	}
	return m
}

// TestSeededCorpus: every seeded secret literal must vanish, and its
// redaction type must be reported. 100% catch is the hard gate (SR-1).
func TestSeededCorpus(t *testing.T) {
	for file, seeds := range loadManifest(t) {
		t.Run(file, func(t *testing.T) {
			data, err := os.ReadFile(filepath.Join("testdata/seeded", file))
			if err != nil {
				t.Fatal(err)
			}
			res, err := Scrub(data, Policy{})
			if err != nil {
				t.Fatal(err)
			}
			gotTypes := map[RedactionType]bool{}
			for _, r := range res.Redactions {
				gotTypes[r.Type] = true
			}
			for _, s := range seeds {
				if bytes.Contains(res.Data(), []byte(s.Literal)) {
					t.Errorf("seeded secret survived scrub: %q", s.Literal)
				}
				if !gotTypes[s.Type] {
					t.Errorf("expected redaction type %s not reported (got %v)", s.Type, res.Redactions)
				}
			}
		})
	}
}

// TestCleanCorpus: UUIDs, git SHAs, import paths, file paths, and prose
// must produce ZERO redactions (hard zero-FP requirement).
func TestCleanCorpus(t *testing.T) {
	entries, err := os.ReadDir("testdata/clean")
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		t.Run(e.Name(), func(t *testing.T) {
			data, err := os.ReadFile(filepath.Join("testdata/clean", e.Name()))
			if err != nil {
				t.Fatal(err)
			}
			res, err := Scrub(data, Policy{})
			if err != nil {
				t.Fatal(err)
			}
			if len(res.Redactions) != 0 {
				t.Errorf("false positives on clean file: %+v\noutput:\n%s", res.Redactions, res.Data())
			}
			if !bytes.Equal(res.Data(), data) {
				t.Error("clean data was modified")
			}
		})
	}
}

// TestJSONValidity: scrubbing a Session-shaped JSON document keeps it
// parseable and removes the embedded secrets.
func TestJSONValidity(t *testing.T) {
	s := model.Session{
		ID:    "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
		Agent: "claudecode",
		Turns: []model.Turn{
			{Role: model.RoleUser, Text: "set GITHUB_TOKEN=ghp_AAAAbbbbCCCCddddEEEEffffGGGGhhhh1234 please"},
			{Role: model.RoleAssistant, Text: "Done. Also found key material:\n-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA7yn3bRHQ5FHMQnE0Xq5V\n-----END RSA PRIVATE KEY-----\n"},
		},
		ToolCalls: []model.ToolCall{
			{ID: "toolu_01", Name: "Bash", OutputSummary: "postgres://svc:Hunter2Hunter2@10.0.0.5/db ok"},
		},
	}
	doc, err := json.Marshal(s)
	if err != nil {
		t.Fatal(err)
	}
	res, err := Scrub(doc, Policy{})
	if err != nil {
		t.Fatal(err)
	}
	var back model.Session
	if err := json.Unmarshal(res.Data(), &back); err != nil {
		t.Fatalf("scrubbed JSON no longer parses: %v\n%s", err, res.Data())
	}
	for _, secret := range []string{"ghp_AAAAbbbbCCCCddddEEEEffffGGGGhhhh1234", "MIIEowIBAAKCAQEA7yn3bRHQ5FHMQnE0Xq5V", "Hunter2Hunter2"} {
		if bytes.Contains(res.Data(), []byte(secret)) {
			t.Errorf("secret survived in JSON: %q", secret)
		}
	}
	// The session UUID must survive untouched (zero-FP shape).
	if back.ID != s.ID {
		t.Errorf("session ID damaged: %q", back.ID)
	}
}

// TestOffsets: every Redaction must exactly locate its marker in the output.
func TestOffsets(t *testing.T) {
	in := []byte("a AKIAIOSFODNN7EXAMPLE b xoxb-1234567890-abcdefghijklmnop c")
	res, err := Scrub(in, Policy{})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Redactions) != 2 {
		t.Fatalf("redactions = %d, want 2: %+v", len(res.Redactions), res.Redactions)
	}
	for _, r := range res.Redactions {
		got := string(res.Data()[r.Offset : r.Offset+r.Length])
		want := "[REDACTED:" + string(r.Type) + "]"
		if got != want {
			t.Errorf("offset mismatch: data[%d:%d] = %q, want %q", r.Offset, r.Offset+r.Length, got, want)
		}
	}
}

func TestPolicyKnobs(t *testing.T) {
	entropic := []byte("run Zx9Qw2Ee7Rt5Yu1Io3Pp8Aa6Sd4Fg0Hj now")
	res, err := Scrub(entropic, Policy{DisableEntropy: true})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Redactions) != 0 {
		t.Errorf("DisableEntropy ignored: %+v", res.Redactions)
	}

	res, err = Scrub([]byte("internal ticket JIRA-9911 mention"), Policy{ExtraPatterns: []string{`JIRA-\d+`}})
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Redactions) != 1 || bytes.Contains(res.Data(), []byte("JIRA-9911")) {
		t.Errorf("extra pattern not applied: %+v %s", res.Redactions, res.Data())
	}

	if _, err := Scrub([]byte("x"), Policy{ExtraPatterns: []string{"("}}); err == nil {
		t.Error("invalid extra pattern accepted")
	}
}

// BenchmarkScrub over a synthetic ~5MB transcript. Soft target: < 2s.
func BenchmarkScrub(b *testing.B) {
	rng := rand.New(rand.NewSource(42))
	words := []string{"refactor", "session", "adapter", "gitstore", "handoff", "compile", "test", "commit"}
	var sb strings.Builder
	for sb.Len() < 5<<20 {
		for range 30 {
			sb.WriteString(words[rng.Intn(len(words))])
			sb.WriteByte(' ')
		}
		fmt.Fprintf(&sb, "\n{\"tool\":\"Bash\",\"output\":\"line %d ok\"}\n", rng.Int())
		if rng.Intn(50) == 0 {
			sb.WriteString("AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\n")
		}
	}
	data := []byte(sb.String())
	b.SetBytes(int64(len(data)))
	b.ResetTimer()
	var elapsed time.Duration
	for b.Loop() {
		start := time.Now()
		if _, err := Scrub(data, Policy{}); err != nil {
			b.Fatal(err)
		}
		elapsed = time.Since(start)
	}
	b.ReportMetric(float64(len(data))/(1<<20)/elapsed.Seconds(), "MB/s")
}
