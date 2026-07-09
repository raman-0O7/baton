package model

// MCPTransport is how an MCP server is reached.
type MCPTransport string

const (
	MCPStdio MCPTransport = "stdio"
	MCPHTTP  MCPTransport = "http"
	MCPSSE   MCPTransport = "sse"
)

// MCPServer is the canonical, agent-independent description of one MCP
// server. Per-agent syntaxes (.mcp.json, opencode config, codex config.toml)
// are emitted from / parsed into this by internal/mcptrans.
//
// Secret values never appear here: Env values are placeholder references
// (e.g. "$AGENT_SYNC_SECRET:openai_api_key") resolved from the device-local
// secrets file at emit time (SR-2).
type MCPServer struct {
	Name      string            `json:"name" toml:"name"`
	Transport MCPTransport      `json:"transport" toml:"transport"`
	Command   string            `json:"command,omitempty" toml:"command,omitempty"` // stdio
	Args      []string          `json:"args,omitempty" toml:"args,omitempty"`
	URL       string            `json:"url,omitempty" toml:"url,omitempty"` // http/sse
	Env       map[string]string `json:"env,omitempty" toml:"env,omitempty"`
	Headers   map[string]string `json:"headers,omitempty" toml:"headers,omitempty"`
}

// Skill is one replicable skill/prompt artifact (a file tree entry).
// Replication is same-agent only in v1 (FR-12).
type Skill struct {
	Agent string `json:"agent"`
	// RelPath under the agent's skill root, e.g. "grilling/SKILL.md".
	RelPath string `json:"rel_path"`
	Content []byte `json:"content"`
}
