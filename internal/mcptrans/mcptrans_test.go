package mcptrans

import (
	"reflect"
	"strings"
	"testing"

	"github.com/raman-0O7/baton/internal/model"
)

func sample() []model.MCPServer {
	return []model.MCPServer{
		{
			Name: "github", Transport: model.MCPStdio,
			Command: "npx", Args: []string{"-y", "@modelcontextprotocol/server-github"},
			Env: map[string]string{"GITHUB_TOKEN": "$BATON_SECRET:github_GITHUB_TOKEN"},
		},
		{
			Name: "search", Transport: model.MCPHTTP,
			URL:     "https://mcp.example.com/v1",
			Headers: map[string]string{"X-Api-Key": "$BATON_SECRET:search_X_Api_Key"},
		},
	}
}

// Round-trip: canonical → agent syntax → canonical must be lossless for
// every agent (within each agent's expressible feature set).
func TestRoundTripAllAgents(t *testing.T) {
	want := sample()
	for _, agent := range []string{"claudecode", "opencode", "codex"} {
		t.Run(agent, func(t *testing.T) {
			data, err := EmitAgent(agent, want)
			if err != nil {
				t.Fatalf("emit: %v", err)
			}
			got, err := ParseAgent(agent, data)
			if err != nil {
				t.Fatalf("parse: %v\n%s", err, data)
			}
			if !reflect.DeepEqual(got, want) {
				t.Errorf("round-trip mismatch\n got: %+v\nwant: %+v\nemitted:\n%s", got, want, data)
			}
		})
	}
}

func TestCanonicalRoundTrip(t *testing.T) {
	want := sample()
	data, err := EmitCanonical(want)
	if err != nil {
		t.Fatal(err)
	}
	got, err := ParseCanonical(data)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("canonical round-trip mismatch\n got: %+v\nwant: %+v", got, want)
	}
}

// Secret-leak gate (SR-2): after Strip, no secret value may appear in any
// emitted form — canonical or agent syntax.
func TestStripKeepsSecretsOut(t *testing.T) {
	raw := []model.MCPServer{
		{
			Name: "github", Transport: model.MCPStdio, Command: "npx",
			Env: map[string]string{
				"GITHUB_TOKEN": "ghp_SEEDEDSECRETVALUE00000000000000000001",
				"LOG_LEVEL":    "debug", // not a secret key: must survive
			},
		},
		{
			Name: "api", Transport: model.MCPHTTP, URL: "https://x.example",
			Headers: map[string]string{"Authorization-Key": "seeded-header-secret-9911"},
		},
	}
	stripped, refs := Strip(raw)

	if len(refs) != 2 {
		t.Fatalf("refs = %+v", refs)
	}
	byName := map[string]string{}
	for _, r := range refs {
		byName[r.Name] = r.Value
	}
	if byName["github_GITHUB_TOKEN"] != "ghp_SEEDEDSECRETVALUE00000000000000000001" {
		t.Errorf("token ref wrong: %+v", refs)
	}

	if stripped[0].Env["LOG_LEVEL"] != "debug" {
		t.Errorf("non-secret env value damaged: %+v", stripped[0].Env)
	}
	if !strings.HasPrefix(stripped[0].Env["GITHUB_TOKEN"], PlaceholderPrefix) {
		t.Errorf("secret not placeholdered: %+v", stripped[0].Env)
	}

	// Grep gate across every emitted artifact.
	forms := [][]byte{}
	if c, err := EmitCanonical(stripped); err == nil {
		forms = append(forms, c)
	} else {
		t.Fatal(err)
	}
	for _, agent := range []string{"claudecode", "opencode", "codex"} {
		d, err := EmitAgent(agent, stripped)
		if err != nil {
			t.Fatal(err)
		}
		forms = append(forms, d)
	}
	for _, f := range forms {
		for _, secret := range []string{"ghp_SEEDEDSECRETVALUE00000000000000000001", "seeded-header-secret-9911"} {
			if strings.Contains(string(f), secret) {
				t.Errorf("secret leaked into emitted artifact:\n%s", f)
			}
		}
	}

	// Idempotence: stripping again externalizes nothing new.
	again, refs2 := Strip(stripped)
	if len(refs2) != 0 || !reflect.DeepEqual(again, stripped) {
		t.Errorf("Strip not idempotent: refs=%+v", refs2)
	}
}

func TestResolve(t *testing.T) {
	stripped, refs := Strip([]model.MCPServer{{
		Name: "s", Transport: model.MCPStdio, Command: "run",
		Env: map[string]string{"API_KEY": "topsecretvalue-123456"},
	}})
	secrets := map[string]string{}
	for _, r := range refs {
		secrets[r.Name] = r.Value
	}
	resolved, missing := Resolve(stripped, secrets)
	if len(missing) != 0 || resolved[0].Env["API_KEY"] != "topsecretvalue-123456" {
		t.Errorf("resolve failed: %+v missing=%v", resolved, missing)
	}

	_, missing = Resolve(stripped, nil)
	if len(missing) != 1 || missing[0] != "s_API_KEY" {
		t.Errorf("missing report wrong: %v", missing)
	}
}

func TestOpencodeRemoteMapping(t *testing.T) {
	// SSE has no distinct opencode type; it becomes remote and comes back
	// as http — the accepted lossy edge, asserted here so a future change
	// is a conscious one.
	in := []model.MCPServer{{Name: "s", Transport: model.MCPSSE, URL: "https://e/sse"}}
	data, err := EmitAgent("opencode", in)
	if err != nil {
		t.Fatal(err)
	}
	got, err := ParseAgent("opencode", data)
	if err != nil {
		t.Fatal(err)
	}
	if got[0].Transport != model.MCPHTTP {
		t.Errorf("sse→opencode→ transport = %s", got[0].Transport)
	}
}
