package engine

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	git "github.com/go-git/go-git/v5"
)

// TestSkillsAndMCPTwoDevices: skills and MCP configs written on device A
// appear on device B; secret values never reach the sync repo.
func TestSkillsAndMCPTwoDevices(t *testing.T) {
	remoteDir := t.TempDir()
	if _, err := git.PlainInit(remoteDir, true); err != nil {
		t.Fatal(err)
	}

	devA, devB := newDevice(t), newDevice(t)

	// --- Device A: a skill file and an MCP config with a secret.
	devA.use()
	engA, err := Init(remoteDir)
	if err != nil {
		t.Fatal(err)
	}
	skillPath := filepath.Join(devA.home, ".claude", "skills", "greet", "SKILL.md")
	if err := os.MkdirAll(filepath.Dir(skillPath), 0o755); err != nil {
		t.Fatal(err)
	}
	skillBody := "---\nname: greet\n---\nAlways greet the user warmly.\n"
	if err := os.WriteFile(skillPath, []byte(skillBody), 0o644); err != nil {
		t.Fatal(err)
	}
	rep, err := engA.SkillsPush()
	if err != nil || rep.Files != 1 {
		t.Fatalf("A skills push: %+v err=%v", rep, err)
	}

	mcpPath := filepath.Join(devA.home, ".mcp.json")
	mcpBody := `{"mcpServers":{"github":{"command":"npx","args":["-y","server-github"],"env":{"GITHUB_TOKEN":"ghp_SEEDEDSECRET000000000000000000000001","LOG_LEVEL":"info"}}}}`
	if err := os.WriteFile(mcpPath, []byte(mcpBody), 0o600); err != nil {
		t.Fatal(err)
	}
	if n, err := engA.MCPImport("claudecode", mcpPath); err != nil || n != 1 {
		t.Fatalf("A mcp import: n=%d err=%v", n, err)
	}

	// Secret-leak gate: nothing under the sync repo tree may contain the
	// seeded token (SR-2 grep gate).
	var leaked []string
	err = filepath.Walk(engA.Cfg.RepoPath, func(p string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() {
			return nil
		}
		data, err := os.ReadFile(p)
		if err == nil && strings.Contains(string(data), "ghp_SEEDEDSECRET000000000000000000000001") {
			leaked = append(leaked, p)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(leaked) > 0 {
		t.Fatalf("secret leaked into sync repo: %v", leaked)
	}

	// --- Device B: pull skills, emit MCP config.
	devB.use()
	engB, err := Init(remoteDir)
	if err != nil {
		t.Fatal(err)
	}
	repB, err := engB.SkillsPull()
	if err != nil || repB.Files != 1 {
		t.Fatalf("B skills pull: %+v err=%v", repB, err)
	}
	got, err := os.ReadFile(filepath.Join(devB.home, ".claude", "skills", "greet", "SKILL.md"))
	if err != nil || string(got) != skillBody {
		t.Fatalf("B skill content: %q err=%v", got, err)
	}

	data, missing, err := engB.MCPEmit("opencode")
	if err != nil {
		t.Fatalf("B mcp emit: %v", err)
	}
	// B has no local secret for the token: placeholder must survive, and
	// be reported missing.
	if len(missing) != 1 || !strings.Contains(missing[0], "GITHUB_TOKEN") {
		t.Fatalf("missing secrets report: %v", missing)
	}
	out := string(data)
	if strings.Contains(out, "ghp_SEEDEDSECRET000000000000000000000001") {
		t.Fatal("secret value materialized on a device that never had it")
	}
	if !strings.Contains(out, "$BATON_SECRET:github_GITHUB_TOKEN") || !strings.Contains(out, `"github"`) {
		t.Fatalf("emitted opencode config unexpected:\n%s", out)
	}
	// Non-secret env survives translation.
	if !strings.Contains(out, `"LOG_LEVEL": "info"`) {
		t.Fatalf("non-secret env lost:\n%s", out)
	}

	// --- A, holding the secret locally, emits a fully resolved config.
	devA.use()
	dataA, missingA, err := engA.MCPEmit("codex")
	if err != nil || len(missingA) != 0 {
		t.Fatalf("A mcp emit: missing=%v err=%v", missingA, err)
	}
	if !strings.Contains(string(dataA), "ghp_SEEDEDSECRET000000000000000000000001") {
		t.Fatalf("A emit should resolve its local secret:\n%s", dataA)
	}
}
