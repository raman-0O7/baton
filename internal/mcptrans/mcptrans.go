// Package mcptrans translates MCP server configurations between the
// canonical model and each agent's native syntax (FR-13):
//
//	claudecode: .mcp.json / ~/.claude.json  {"mcpServers":{...}}
//	opencode:   opencode.json               {"mcp":{...}}
//	codex:      ~/.codex/config.toml        [mcp_servers.*]
//
// Secret env/header values never enter the canonical form: they are
// replaced by placeholder references resolved from the device-local
// secrets file at emit time (SR-2).
package mcptrans

import (
	"fmt"
	"sort"
	"strings"

	"github.com/raman-0O7/baton/internal/model"
)

// PlaceholderPrefix marks a value that must be resolved from the local
// secrets store: "$BATON_SECRET:<server>_<key>".
const PlaceholderPrefix = "$BATON_SECRET:"

// secretKeyHints flag env/header keys whose values are credentials.
var secretKeyHints = []string{"key", "token", "secret", "password", "passwd", "auth", "credential"}

// isSecretKey reports whether an env/header key looks credential-bearing.
func isSecretKey(k string) bool {
	lk := strings.ToLower(k)
	for _, h := range secretKeyHints {
		if strings.Contains(lk, h) {
			return true
		}
	}
	return false
}

// SecretRef names one externalized secret.
type SecretRef struct {
	Name  string // "<server>_<key>", the secrets-file key
	Value string // the actual secret, destined for the local store only
}

// Strip externalizes credential values from servers: each flagged value is
// replaced with a placeholder and returned in refs for local storage.
// Already-placeholder values pass through untouched.
func Strip(servers []model.MCPServer) ([]model.MCPServer, []SecretRef) {
	var refs []SecretRef
	out := make([]model.MCPServer, len(servers))
	for i, s := range servers {
		c := s
		c.Env = stripMap(s.Name, s.Env, &refs)
		c.Headers = stripMap(s.Name, s.Headers, &refs)
		out[i] = c
	}
	return out, refs
}

func stripMap(server string, m map[string]string, refs *[]SecretRef) map[string]string {
	if len(m) == 0 {
		return nil
	}
	out := make(map[string]string, len(m))
	for k, v := range m {
		if !isSecretKey(k) || strings.HasPrefix(v, PlaceholderPrefix) || v == "" {
			out[k] = v
			continue
		}
		name := sanitizeRefName(server + "_" + k)
		*refs = append(*refs, SecretRef{Name: name, Value: v})
		out[k] = PlaceholderPrefix + name
	}
	return out
}

// Resolve replaces placeholders with values from secrets (name → value).
// Unresolvable placeholders are left in place and reported.
func Resolve(servers []model.MCPServer, secrets map[string]string) ([]model.MCPServer, []string) {
	var missing []string
	out := make([]model.MCPServer, len(servers))
	for i, s := range servers {
		c := s
		c.Env = resolveMap(s.Env, secrets, &missing)
		c.Headers = resolveMap(s.Headers, secrets, &missing)
		out[i] = c
	}
	sort.Strings(missing)
	return out, missing
}

func resolveMap(m map[string]string, secrets map[string]string, missing *[]string) map[string]string {
	if len(m) == 0 {
		return nil
	}
	out := make(map[string]string, len(m))
	for k, v := range m {
		name, ok := strings.CutPrefix(v, PlaceholderPrefix)
		if !ok {
			out[k] = v
			continue
		}
		if val, found := secrets[name]; found {
			out[k] = val
		} else {
			out[k] = v
			*missing = append(*missing, name)
		}
	}
	return out
}

func sanitizeRefName(s string) string {
	var b strings.Builder
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '_':
			b.WriteRune(r)
		default:
			b.WriteRune('_')
		}
	}
	return b.String()
}

// sortServers gives deterministic emission order.
func sortServers(servers []model.MCPServer) []model.MCPServer {
	out := append([]model.MCPServer(nil), servers...)
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

// ParseAgent parses an agent-native config into canonical servers.
func ParseAgent(agent string, data []byte) ([]model.MCPServer, error) {
	switch agent {
	case "claudecode":
		return parseClaude(data)
	case "opencode":
		return parseOpencode(data)
	case "codex":
		return parseCodex(data)
	}
	return nil, fmt.Errorf("mcptrans: unknown agent %q", agent)
}

// EmitAgent renders canonical servers in an agent's native syntax.
func EmitAgent(agent string, servers []model.MCPServer) ([]byte, error) {
	servers = sortServers(servers)
	switch agent {
	case "claudecode":
		return emitClaude(servers)
	case "opencode":
		return emitOpencode(servers)
	case "codex":
		return emitCodex(servers)
	}
	return nil, fmt.Errorf("mcptrans: unknown agent %q", agent)
}
